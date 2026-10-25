import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/session/db.ts'
import { SCHEMA } from '../src/session/schema.sql.ts'
import { ftsSearch, matchExpr, reindexTurns, syncSearchIndex, toFtsText } from '../src/session/search-index.ts'
import { runSearch } from '../src/tools/memory.ts'

describe('toFtsText / matchExpr（中文分词）', () => {
  it('CJK 连续段切 bigram，字母↔汉字边界手切', () => {
    expect(toFtsText('卸载机制')).toBe(' 卸载 载机 机制 ')
    expect(toFtsText('webview缓存')).toBe('webview 缓存 ')
    expect(toFtsText('a token b')).toBe('a token b')
  })

  it('matchExpr：多词 AND、token 进 phrase、单字 CJK 加前缀、剥引号', () => {
    expect(matchExpr('卸载机制')).toBe('"卸载 载机 机制"')
    expect(matchExpr('pickOldestSteps 溯源')).toBe('"pickoldeststeps" AND "溯源"')
    // 前缀 * 必须在引号外（FTS5 引号内的 * 被分词器当分隔符丢掉）
    expect(matchExpr('图')).toBe('"图" *')
    expect(matchExpr('金丝雀')).toBe('"金丝 丝雀 雀" *')
    expect(matchExpr('say "hi"')).toBe('"say" AND "hi"')
    expect(matchExpr('')).toBeNull()
  })

  it('matchExpr：顶层 OR 分组，组内 AND，小写 or 不分组', () => {
    // 猜词检索：同一件事当时的用词未必记得准，一次多试几个候选词
    expect(matchExpr('越权 OR 误弹 OR 抢戏')).toBe('"越权" OR "误弹" OR "抢戏"')
    // 组内保持 AND：a b OR c = (a AND b) OR c（FTS5 里 AND 绑定更紧）
    expect(matchExpr('审批 误弹 OR 越权')).toBe('"审批" AND "误弹" OR "越权"')
    // 大小写敏感只认大写 OR——小写 or 是普通词，不误伤英文查询
    expect(matchExpr('for or while')).toBe('"for" AND "or" AND "while"')
    // 尾随 OR 忽略——空组滤掉，不因残组报「查不出」
    expect(matchExpr('a OR ')).toBe('"a"')
    expect(matchExpr(' OR ')).toBeNull()
  })
})

describe('syncSearchIndex + ftsSearch（真库）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-fts-'))
  const db = openDb(join(dir, 'state.db'))
  db.exec(SCHEMA)

  const insert = (turn: number, step: number, role: string, text: string) => {
    db.run(`INSERT INTO turns(id, started_at) VALUES(?, '2026-01-01') ON CONFLICT(id) DO NOTHING`, turn)
    db.run(`INSERT INTO steps(id, turn_id, started_at) VALUES(?, ?, '2026-01-01')`, step, turn)
    db.run(
      `INSERT INTO messages(turn_id, role, content_json, state, step_id) VALUES(?, ?, ?, 'live', ?)`,
      turn,
      role,
      JSON.stringify({ role, parts: [{ type: 'text', text }] }),
      step,
    )
  }
  // 往已存在的 step 追加一条消息（工具结果在 assistant 之后才落库）
  const append = (turn: number, step: number, text: string) =>
    db.run(
      `INSERT INTO messages(turn_id, role, content_json, state, step_id) VALUES(?, 'tool', ?, 'live', ?)`,
      turn,
      JSON.stringify({ role: 'tool', parts: [{ type: 'text', text }] }),
      step,
    )
  const rowsOf = (turn: number) =>
    db.all<{ c: number }>(`SELECT COUNT(*) c FROM search_fts WHERE turn_no = ?`, turn)[0]!.c

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('同步 → 命中（2 字中文词、跨 step 定位）→ 幂等', () => {
    insert(1, 1, 'user', '我们来聊聊卸载机制的粒度')
    insert(1, 2, 'assistant', 'pickOldestSteps 在 run.ts 里')
    syncSearchIndex(db)
    expect(ftsSearch(db, '卸载', 10)).toEqual([{ turn: 1, step: 1 }])
    expect(ftsSearch(db, '卸载机制', 10)).toEqual([{ turn: 1, step: 1 }]) // phrase=子串语义
    expect(ftsSearch(db, 'pickoldeststeps', 10)).toEqual([{ turn: 1, step: 2 }])
    expect(ftsSearch(db, '完全不相关的词组', 10)).toEqual([])
    // 幂等：再同步无新 step，命中不重复
    syncSearchIndex(db)
    expect(ftsSearch(db, '卸载', 10)).toHaveLength(1)
  })

  it('增量：新 step 只补新游标', () => {
    insert(2, 3, 'user', '另一个话题：审批矩阵')
    syncSearchIndex(db)
    expect(ftsSearch(db, '审批', 10)).toEqual([{ turn: 2, step: 1 }])
    expect(ftsSearch(db, '卸载', 10)).toEqual([{ turn: 1, step: 1 }])
  })

  it('ftsSearch：OR 一次命中任一候选词（猜词检索）', () => {
    // 放在末尾：增量游标假设 step id 单调，先让前面用例的小 id 过完，
    // 再插 id 10/11（step_no 是 turn 内序号，这里为 2、3）
    insert(2, 10, 'user', '这次误弹的原因是省略号')
    insert(2, 11, 'assistant', '越权问题出在 root 判定')
    syncSearchIndex(db)
    // 三个候选词两个（误弹/越权）写在了 turn 2——OR 应命中两条 step
    const hits = ftsSearch(db, '越权 OR 误弹 OR 抢戏', 10)
    expect(hits).toContainEqual({ turn: 2, step: 2 })
    expect(hits).toContainEqual({ turn: 2, step: 3 })
    expect(hits.every((h) => h.turn === 2)).toBe(true)
  })

  it('ftsSearch：BM25 相关性排——提词多次的 step 排在顺带一提的前面', () => {
    // rowid 序 = 插入序：先插只提 1 次的，后插提 3 次的。BM25 应让后者
    // 反超（若还是 rowid 序，这个断言就翻了）。两文档长度要相近——
    // BM25 有长度归一化，5 字提 1 次（密度 20%）会压过 30 字提 3 次
    // （密度 10%），那就测不出词频主导了
    insert(3, 20, 'user', '这个问题和误弹有关，先把背景信息记录一下再说')
    insert(3, 21, 'assistant', '误弹的根因是省略号。误弹触发在 echo 参数。修完误弹就收口')
    syncSearchIndex(db)
    const hits = ftsSearch(db, '误弹', 10)
    // 只锁最前排位：库里还有 OR 用例留下的短文档（「这次误弹的原因」
    // 11 字，长度归一化抬分），后续顺序受它影响、不值得锁死
    expect(hits[0]).toEqual({ turn: 3, step: 2 }) // 提词 3 次的排最前
    expect(hits).toContainEqual({ turn: 3, step: 1 })
  })

  it('游标所在 step 后补的消息（工具结果）下次同步补进，不重复', () => {
    // 实案 2026-10-23：save 时 step 只有 assistant 就入了索引、游标越过，
    // 随后落库的工具输出永远搜不到（只有关任务的全量重灌顺手补上）
    insert(4, 30, 'assistant', '我来跑一下命令')
    syncSearchIndex(db)
    append(4, 30, '输出里有端口号六万三')
    syncSearchIndex(db)
    expect(ftsSearch(db, '端口号六', 10)).toEqual([{ turn: 4, step: 1 }])
    expect(ftsSearch(db, '命令', 10)).toEqual([{ turn: 4, step: 1 }])
    expect(rowsOf(4)).toBe(1)
    // 再同步（无新消息）仍是一行
    syncSearchIndex(db)
    expect(rowsOf(4)).toBe(1)
  })

  it('reindexTurns：游标之下的 turn（任务段）只重做这些 turn，先删后灌不重复', () => {
    // 任务先存了一部分（step 40 已入索引，只有半截），之后对话写到 50、游标越过
    insert(5, 40, 'assistant', '任务前半截')
    syncSearchIndex(db)
    insert(6, 50, 'user', '对话继续往前走')
    syncSearchIndex(db)
    append(5, 40, '任务后半截的结论')
    insert(5, 41, 'assistant', '任务第二步发现')
    syncSearchIndex(db) // 增量看不到游标之下的东西
    expect(ftsSearch(db, '二步发现', 10)).toEqual([])
    const cursor = db.all<{ v: string }>(`SELECT v FROM search_fts_meta WHERE k = 'last_step_id'`)[0]!.v
    reindexTurns(db, [5])
    expect(ftsSearch(db, '后半截的', 10)).toEqual([{ turn: 5, step: 1 }])
    expect(ftsSearch(db, '二步发现', 10)).toEqual([{ turn: 5, step: 2 }])
    expect(rowsOf(5)).toBe(2)
    reindexTurns(db, [5])
    expect(rowsOf(5)).toBe(2)
    // 别的 turn 不动，游标不动
    expect(ftsSearch(db, '继续往前', 10)).toEqual([{ turn: 6, step: 1 }])
    expect(db.all<{ v: string }>(`SELECT v FROM search_fts_meta WHERE k = 'last_step_id'`)[0]!.v).toBe(cursor)
    // 游标 step 恰在被重做的 turn 里：指针要跟到新行，下次同步不留双份
    append(6, 50, '对话那步的工具输出')
    reindexTurns(db, [6])
    syncSearchIndex(db)
    expect(rowsOf(6)).toBe(1)
    expect(ftsSearch(db, '工具输出', 10)).toContainEqual({ turn: 6, step: 1 })
  })

  it('奇数字中文词在汉字段中间也能命中（2026-10-23：「金丝雀」只在段尾才中）', () => {
    insert(7, 70, 'user', '我们讨论金丝雀发布的流程')
    syncSearchIndex(db)
    expect(ftsSearch(db, '金丝雀', 10)).toEqual([{ turn: 7, step: 1 }])
    expect(ftsSearch(db, '讨论金丝雀发', 10)).toEqual([{ turn: 7, step: 1 }]) // 偶数照旧
  })
})

describe('runSearch：FTS 优先、0 命中回退老扫描（端到端）', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-runsearch-'))
  const turnsDir = join(root, '.simple-code/memory/turns')
  mkdirSync(turnsDir, { recursive: true })
  writeFileSync(
    join(turnsDir, 'turn-000001.jsonl'),
    [
      JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '卸载机制的讨论' }] }),
      JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: 'pickOldestSteps 落在 run.ts' }] }),
    ].join('\n'),
  )
  // db 与文件 step 对齐：step1=user 行，step2=assistant 行
  const db = openDb(join(root, '.simple-code/memory/state.db'))
  db.exec(SCHEMA)
  db.run(`INSERT INTO turns(id, started_at) VALUES(1, '2026-01-01')`)
  db.run(`INSERT INTO steps(id, turn_id, started_at) VALUES(1, 1, '2026-01-01')`)
  db.run(
    `INSERT INTO messages(turn_id, role, content_json, state, step_id) VALUES(1, 'user', ?, 'live', 1)`,
    JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '卸载机制的讨论' }] }),
  )
  db.run(`INSERT INTO steps(id, turn_id, started_at) VALUES(2, 1, '2026-01-01')`)
  db.run(
    `INSERT INTO messages(turn_id, role, content_json, state, step_id) VALUES(1, 'assistant', ?, 'live', 2)`,
    JSON.stringify({ role: 'assistant', parts: [{ type: 'text', text: 'pickOldestSteps 落在 run.ts' }] }),
  )
  syncSearchIndex(db)
  db.close()

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('FTS 路径：2 字中文词命中 + where 带 step + --ctx 渲染', async () => {
    const hits = await runSearch(root, '卸载机制')
    expect(hits.map((h) => h.where)).toContain('turn-000001:step1')
    expect(hits[0]?.excerpt).toContain('卸载机制')
    const withCtx = await runSearch(root, '卸载机制', { ctx: true })
    expect(withCtx[0]?.context?.[0]).toBe('── step 1（1 行，user）')
  })

  it('FTS 0 命中回退老扫描：英文子串（oldest 命中 pickoldeststeps 内部）', async () => {
    const hits = await runSearch(root, 'oldest')
    // FTS 词匹配搜不到 token 内部 → null → 老扫描 indexOf 兜住
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.where).toBe('turn-000001:step2')
  })
})
