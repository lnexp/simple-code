import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import { listBucketFiles, resolveBucketFile } from '../src/session/buckets.ts'
import { MEMORY_RELATIVE, openStore, type Store } from '../src/session/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-store-'))
  dirs.push(dir)
  return dir
}

const userSays = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })
const assistantSays = (text: string): Message => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
})
const callsTool = (id: string, command: string): Message => ({
  role: 'assistant',
  parts: [{ type: 'tool_call', id, name: 'bash', input: { command } }],
})
const toolReturns = (id: string, output: string): Message => ({
  role: 'tool',
  parts: [{ type: 'tool_result', toolCallId: id, output, isError: false }],
})

/** 关掉再开，模拟进程重启。**不复用对象**——复用的话读的是内存不是磁盘 */
function reopen(dir: string, store: Store): Store {
  store.close()
  return openStore(dir)
}

/**
 * 直接查 turn_id。Store 接口不暴露它——它是第 3 步的东西，第 2 步只要保证
 * 存对了。开一个只读连接查，不走 Store
 */
/**
 * turns 表的行数。
 *
 * 跟 `readTurnIds` 查的**不是一张表**：那个查 messages，看不见没有任何消息的
 * 空 turn——而「凭空建了空 turn」正是要防的那个 bug（惰性创建那条注释）。
 */
function countTurnRows(dir: string): number {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db.prepare('SELECT id FROM turns').all()
  db.close()
  return rows.length
}

function readTurnIds(dir: string): number[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db.prepare('SELECT turn_id FROM messages ORDER BY id').all() as {
    turn_id: number
  }[]
  db.close()
  return rows.map((r) => r.turn_id)
}

describe('落盘与读回', () => {
  it('重启后历史一字不差', async () => {
    const dir = await workspace()
    const before: Message[] = [
      userSays('统计一下行数'),
      callsTool('t1', 'wc -l **/*.ts'),
      toolReturns('t1', '  1234 total'),
      assistantSays('一共 1234 行。'),
    ]

    let store = openStore(dir)
    store.save(before)
    store = reopen(dir, store)

    expect(store.load()).toEqual(before)
    store.close()
  })

  it('对照组：没存过就是空的', async () => {
    // 没有这条的话，load() 永远返回 [] 的实现也能让上面那条通过——
    // 不，上面那条会红。但反过来「load 返回硬编码内容」这种错要靠它挡
    const dir = await workspace()
    const store = openStore(dir)

    expect(store.load()).toEqual([])
    store.close()
  })

  it('重启兜底：lastRespondedAt 读最后一个 step 的开始时刻', async () => {
    // 提案 §12。正常计时走 session 闭包的 lastResponseAt（响应结束时刻），
    // 只有重启后那份丢了才读这里。空库返回 null——「没有响应过」和
    // 「响应过但时刻未知」要能区分，后者不存在，前者不能是 0（epoch 零点）
    const dir = await workspace()
    const empty = openStore(dir)
    expect(empty.lastRespondedAt()).toBeNull()
    empty.close()

    const store = openStore(dir)
    store.save([userSays('一'), assistantSays('二')])
    const at = store.lastRespondedAt()
    // 口径是 step 开始时刻，只比现在早、且早不了太多（测试里就几毫秒）。
    // null 先用 typeof 挡掉：null 参与大小比较会被强转成 0，比较断言挡不住它
    expect(typeof at).toBe('number')
    const when = at as number
    expect(when).toBeLessThanOrEqual(Date.now())
    expect(when).toBeGreaterThan(Date.now() - 60_000)
    store.close()
  })

  it('多次 save 是替换不是追加', async () => {
    // normalizeHistory 每轮重建整个数组，**条数会变少也会变多**。
    // 按「新增了几条」做增量追加必然错位，现象是某条消息永远没落盘且不报错
    const dir = await workspace()
    let store = openStore(dir)

    store.save([userSays('一'), assistantSays('二')])
    store.save([userSays('一'), assistantSays('二'), userSays('三')])
    store = reopen(dir, store)

    expect(store.load()).toHaveLength(3)
    store.close()
  })

  it('normalize 把消息删掉之后，磁盘上也得少一条', async () => {
    // 这是上一条的反向：条数变**少**。孤儿 tool_result 被 removeOrphanOutputs
    // 删掉就是这种情况。只会追加的实现在这里会留下已删除的消息
    const dir = await workspace()
    let store = openStore(dir)

    store.save([userSays('一'), assistantSays('二'), toolReturns('orphan', 'x')])
    store.save([userSays('一'), assistantSays('二')]) // 孤儿被 normalize 删了
    store = reopen(dir, store)

    const loaded = store.load()
    expect(loaded).toHaveLength(2)
    expect(JSON.stringify(loaded)).not.toContain('orphan')
    store.close()
  })

  it('存的是 canonical 格式，不是某一家的 wire 格式', async () => {
    // 存 wire 的话换 provider 之后旧历史读不回来，而"能换 provider"
    // 正是这个项目的前提（CLAUDE.md §3.2）。
    //
    // 断言归档文件而不是 state.db：WAL 模式下刚写的数据还在 -wal 里，
    // 主库文件是空的——读它会得到一串二进制，测了个寂寞
    const dir = await workspace()
    const store = openStore(dir)
    store.save([callsTool('t1', 'ls')])

    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
    const text = await readFile(files[0] as string, 'utf8')
    expect(text).toContain('"parts"') // canonical 的字段名
    expect(text).toContain('"tool_call"')
    expect(text).not.toContain('"tool_use"') // Anthropic 的 wire 叫法
    expect(text).not.toContain('"content"') // wire 的字段名
    store.close()
  })
})

describe('turns/ 归档', () => {
  it('消息同时写进 jsonl，模型能 cat', async () => {
    // §9.8：「模型要用 cat 读它们——放进 SQLite 就 cat 不出来了」
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('查一下'), assistantSays('好的')])

    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
    expect(files).toHaveLength(1)
    expect(basename(files[0] as string)).toMatch(/^turn-\d{6}\.jsonl$/)

    const lines = (await readFile(files[0] as string, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] as string)).toEqual(userSays('查一下'))
    store.close()
  })

  it('归档只追加，同一条不重复写', async () => {
    // save 是全量替换（SQLite 那边），但归档是 append-only。
    // 每次 save 都整个重写的话，一轮十次 save 就是十份重复
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })

    store.save([userSays('一')])
    store.save([userSays('一'), assistantSays('二')])
    store.save([userSays('一'), assistantSays('二'), assistantSays('三')])

    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
    const lines = (await readFile(files[0] as string, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3) // 不是 1+2+3=6
    store.close()
  })

  it('开 store 不建空 turn —— 没存消息就没有归档文件', async () => {
    // 踩过：open 的时候无条件 createTurn，每启动一次就在库里留一个孤儿 turn。
    // 第 3 步按 turn 做合并边界（§9.5），空 turn 会让「10 个 turn 合并成
    // 1 条」的计数虚高。现象只在查库时才看得出来，跑起来一切正常
    const dir = await workspace()
    let store = openStore(dir)
    store = reopen(dir, store)
    store = reopen(dir, store) // 开了三次，一条消息都没存

    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
    expect(files).toEqual([])
    store.close()
  })

  it('上一轮的消息不会被改嫁到新 turn', async () => {
    // 真实跑出来的 bug：replaceLive 全量 DELETE 再重插，重插时一律用**当前**
    // turn，于是每开一轮，之前所有消息的 turn_id 都被改写成最新的那个。
    // 归档文件是对的（append-only 写完就不动），只有 SQLite 错——
    // 跑起来一切正常，第 3 步按 turn 合并（§9.5）时才会炸
    const dir = await workspace()
    const store = openStore(dir)

    const first = [userSays('第一轮'), assistantSays('答一')]
    store.save(first)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([...first, userSays('第二轮'), assistantSays('答二')])
    store.close()

    const rows = readTurnIds(dir)
    expect(rows).toHaveLength(4)
    // 前两条属于第一个 turn，后两条属于第二个
    expect(rows[0]).toBe(rows[1])
    expect(rows[2]).toBe(rows[3])
    expect(rows[0]).not.toBe(rows[2])
  })

  it('重启之后也不改嫁 —— turn 归属跟着历史一起读回来', async () => {
    // 上一条测的是同一个 store 实例内的记忆。重启后 turnOf 是从磁盘重建的，
    // 不读回来的话，新进程第一次 save 就把全部历史改嫁到新 turn——
    // 而这正是真实跑 CLI 时发生的情况（两条命令 = 两个进程）
    const dir = await workspace()
    let store = openStore(dir)
    store.save([userSays('第一轮'), assistantSays('答一')])
    store = reopen(dir, store)

    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮'), assistantSays('答一'), userSays('第二轮')])
    store.close()

    const rows = readTurnIds(dir)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toBe(rows[1]) // 老的两条还在一起
    expect(rows[2]).not.toBe(rows[0]) // 新的那条属于新 turn
  })

  it('每个 turn 一个文件', async () => {
    const dir = await workspace()
    const store = openStore(dir)

    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮')])
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮'), userSays('第二轮')])

    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
    expect(files).toHaveLength(2)
    store.close()
  })
})

/** 归档文件里所有消息的文本，按写入顺序 */
async function archiveTexts(dir: string): Promise<string[]> {
  const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
  const out: string[] = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const line of text.trim().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { parts: { text?: string }[] }
      out.push(msg.parts[0]?.text ?? '')
    }
  }
  return out
}

/** 直接查每行的 state 和内容长度，Store 接口不暴露它们 */
function readRows(dir: string): { state: string; json: string }[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db.prepare('SELECT state, content_json FROM messages ORDER BY id').all() as {
    state: string
    content_json: string
  }[]
  db.close()
  return rows.map((r) => ({ state: r.state, json: r.content_json }))
}

describe('历史分页（historyPage）', () => {
  it('historyPage 带出每轮的 meta（模型/档位快照，按轮不漂移）', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: 'p/old', effort: 'high' })
    store.save([userSays('一'), assistantSays('二')])
    store.unload([0, 1])
    store.close()

    const reopened = openStore(dir)
    const page = reopened.historyPage(null, 10)
    expect(page.rows.map((r) => r.meta)).toEqual([
      { model: 'p/old', effort: 'high' },
      { model: 'p/old', effort: 'high' },
    ])
    reopened.close()
  })

  it('finishTurn 落盘耗时，historyPage 带出 turnId/elapsedMs（页脚恢复的数据源）', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const turn = store.beginTurn({ model: 'p/m1', effort: null })
    store.save([userSays('问'), assistantSays('答')])
    store.finishTurn(turn, 4321)
    store.unload([0, 1])
    store.close()

    const reopened = openStore(dir)
    const page = reopened.historyPage(null, 10)
    expect(page.rows.map((r) => [r.turnId, r.elapsedMs])).toEqual([
      [turn, 4321],
      [turn, 4321],
    ])
    reopened.close()
  })

  it('turnsInfo 批查多轮 meta/耗时——重启后基线补页脚的数据源', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const t1 = store.beginTurn({ model: 'p/m1', effort: 'high' })
    const t2 = store.beginTurn({ model: 'p/m2', effort: null })
    store.finishTurn(t1, 1111)
    store.close()

    const reopened = openStore(dir)
    const info = reopened.turnsInfo([t1, t2, 99999])
    const done = info.get(t1)
    // finishedAt = started_at + elapsed（页脚渲染开关，App.tsx 以它判有无）
    expect(done?.elapsedMs).toBe(1111)
    expect(done?.finishedAt).toBeGreaterThan(Date.now() - 60_000)
    // t2 没定稿：elapsed/finishedAt 都是 null；99999 不存在：Map 里没有
    expect(info.get(t2)?.elapsedMs).toBeNull()
    expect(info.get(t2)?.finishedAt).toBeNull()
    expect(info.has(99999)).toBe(false)
    reopened.close()
  })

  it('第一页从最新 unloaded 起往上翻，返回正序，next 指向下一页', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.save([
      userSays('老1'),
      assistantSays('老2'),
      userSays('老3'),
      assistantSays('老4'),
      userSays('新1'), // 不卸载：留在 live
    ])
    store.unload([0, 1, 2, 3])
    store.close()

    const reopened = openStore(dir)
    const page1 = reopened.historyPage(null, 2)
    // 最新 unloaded 是「老4」，第一页取它和「老3」，翻回正序
    expect(page1.rows.map((r) => r.parts[0])).toEqual([
      { type: 'text', text: '老3' },
      { type: 'text', text: '老4' },
    ])
    expect(page1.next).toBe(3) // 老3 的 id，下一页从它之下起

    const page2 = reopened.historyPage(page1.next, 2)
    expect(page2.rows.map((r) => (r.parts[0] as { text: string }).text)).toEqual(['老1', '老2'])
    expect(page2.next).toBeNull() // 到底了
    reopened.close()
  })

  it('live 行不进历史页——它由基线（hydrate）负责，两路不重叠', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('卸掉的'), userSays('还活着的')])
    store.unload([0])
    store.close()

    const reopened = openStore(dir)
    const page = reopened.historyPage(null, 50)
    expect(page.rows.map((r) => (r.parts[0] as { text: string }).text)).toEqual(['卸掉的'])
    reopened.close()
  })

  it('一页没有更早的了就返回 next=null，哪怕整页都是（hasMore 在 SQL 里数，不看返回条数）', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('唯一')])
    store.unload([0])
    store.close()

    const reopened = openStore(dir)
    const page = reopened.historyPage(null, 10)
    expect(page.rows).toHaveLength(1)
    expect(page.next).toBeNull()
    reopened.close()
  })

  it('没有 unloaded 行时返回空页', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('都活着')])
    store.close()

    const reopened = openStore(dir)
    expect(reopened.historyPage(null, 10)).toEqual({ rows: [], next: null })
    reopened.close()
  })
})

describe('卸载', () => {
  it('标记为 unloaded 之后 load 就读不到了', async () => {
    const dir = await workspace()
    let store = openStore(dir)
    store.save([userSays('第一条'), assistantSays('第二条'), userSays('第三条')])

    store.unload([0, 1])
    store = reopen(dir, store)

    // 重启后读回的只有没卸的那条——卸载要能扛住重启，否则重开就"复活"了
    expect(store.load()).toEqual([userSays('第三条')])
    store.close()
  })

  it('**原文留在库里**，不是被改写掉', async () => {
    // 这是选「原行标记 + 另存截断版」而不是「就地改写」的全部理由：
    // §9.10 承认归档文件挡不住模型 rm -f，不能让原文只剩那一个副本
    const dir = await workspace()
    const store = openStore(dir)
    const longText = 'x'.repeat(5000)
    store.save([{ role: 'user', parts: [{ type: 'text', text: longText }] }])

    store.unload([0])
    store.close()

    const rows = readRows(dir)
    const unloaded = rows.find((r) => r.state === 'unloaded')
    expect(unloaded).toBeDefined() // 前提：确实标记成功了
    expect(unloaded?.json).toContain(longText) // 原文一字不少
  })

  it('返回的归档路径指向真实存在的文件', async () => {
    // 路径拼错不会报错，只是模型 cat 不到——而那时已经离卸载很远了
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), assistantSays('二')])

    const [ref] = store.unload([0])
    store.close()

    expect(ref).toBeDefined()
    const text = await readFile(join(dir, ref?.archivePath ?? ''), 'utf8')
    expect(text).toContain('一') // cat 得到原文
  })

  it('卸载后再 save，截断版作为新的 live 行进库', async () => {
    // 卸载 → 内存里换成截断版 → 下一次 save 落盘，全流程
    const dir = await workspace()
    let store = openStore(dir)
    store.save([{ role: 'user', parts: [{ type: 'text', text: 'x'.repeat(5000) }] }])

    const [path] = store.unload([0])
    store.save([{ role: 'user', parts: [{ type: 'text', text: `xxx[已卸载，见 ${path}]` }] }])
    store = reopen(dir, store)

    const live = store.load()
    expect(live).toHaveLength(1)
    expect(JSON.stringify(live[0])).toContain('已卸载')
    // 而原文那行还在，没被 save 的 DELETE 清掉
    expect(readRows(dir).filter((r) => r.state === 'unloaded')).toHaveLength(1)
    store.close()
  })

  it('卸载之后 turn 归属不错位', async () => {
    // turnOf 按下标对齐 live 集合，卸载会让集合变短。不同步缩的话，
    // 下一次 save 的归属整体错一格——跟第 2 步修过的那个 bug 同类
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('一'), assistantSays('二')])
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), assistantSays('二'), userSays('三')])

    store.unload([0]) // 卸掉第一条
    store.save([assistantSays('二'), userSays('三'), assistantSays('四')])
    store.close()

    // 剩下的 live 行里，第二个 turn 的消息不能被算到第一个 turn 名下
    const ids = readTurnIds(dir)
    expect(new Set(ids).size).toBeGreaterThan(1) // 前提：确实跨了两个 turn
  })

  it('卸载之后继续对话，归档里不出现重复', async () => {
    // **真实跑出来的 bug。** 原来用「已写条数」这个下标游标去重，卸载让
    // live 集合变短之后游标偏小，已经写过的又被追加一遍。
    //
    // 症状只在归档文件里——SQLite 和 context 全都正常，只有 cat 归档的
    // 模型会看到同一段对话出现两次
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), userSays('二'), userSays('三'), userSays('四')])

    store.unload([0, 1])
    store.save([
      userSays('一截断'),
      userSays('二截断'),
      userSays('三'),
      userSays('四'),
      userSays('五'),
    ])
    store.close()

    const texts = await archiveTexts(dir)
    expect(new Set(texts).size).toBe(texts.length) // 无重复
    expect(texts).toContain('三') // 老的还在
    expect(texts).toContain('五') // 新的也写进去了
  })

  it('卸载让 live 缩得比归档还短时，新消息不能被跳过', async () => {
    // 同一个游标 bug 的另一面：游标偏大 → 新消息被当成"已归档"**静默跳过**，
    // 归档里缺一段。跳过是不报错的，比重复更难发现
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), userSays('二'), userSays('三'), userSays('四')])

    store.unload([0, 1, 2]) // live 只剩 1 条，比已归档的 4 条短
    store.save([userSays('四'), userSays('五')])
    store.close()

    expect(await archiveTexts(dir)).toContain('五')
  })

  it('下标越界不抛异常', async () => {
    // 调用方算错范围时，卸载少几条是可接受的降级；抛异常会打断整个 loop
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('只有一条')])

    expect(() => store.unload([0, 5, 99])).not.toThrow()
    store.close()
  })
})

describe('摘要（3b-1）', () => {
  const draft = (over: Partial<Parameters<Store['addSummary']>[0]> = {}) => ({
    level: 0,
    coversFrom: 1,
    coversTo: 1,
    name: '',
    text: '占位：前 300 字 + 归档路径',
    status: 'pending' as const,
    inContext: true,
    supersededBy: null,
    head: null,
    archivePath: null,
    ...over,
  })

  it('写进去读得回来，字段一个不错', async () => {
    const dir = await workspace()
    let store = openStore(dir)
    const id = store.addSummary(draft({ level: 2, coversFrom: 3, coversTo: 12 }))
    store = reopen(dir, store)

    const [row] = store.summaries()
    expect(row).toEqual({
      id,
      level: 2,
      coversFrom: 3,
      coversTo: 12,
      name: '',
      text: '占位：前 300 字 + 归档路径',
      // reopen 时 pending 不受重置影响
      status: 'pending',
      inContext: true,
      supersededBy: null,
      // 这两列卸载时才填
      head: null,
      archivePath: null,
    })
    store.close()
  })

  it('inContext 存 0/1 但读出来是布尔', async () => {
    // SQLite 没有布尔类型。漏了这层转换的话 `if (summary.inContext)` 对 0 也
    // 成立不了、对 1 永远成立——拼装会整个错，而且不报错
    const dir = await workspace()
    const store = openStore(dir)
    store.addSummary(draft({ inContext: false }))
    store.addSummary(draft({ coversFrom: 2, coversTo: 2, inContext: true }))

    const flags = store.summaries().map((s) => s.inContext)
    expect(flags).toEqual([false, true])
    store.close()
  })

  it('生成完成后 status 变 ready、text 被替换', async () => {
    const dir = await workspace()
    let store = openStore(dir)
    const id = store.addSummary(draft())

    store.startSummary(id)
    store.finishSummary(id, '真正的摘要', '真标题')
    store = reopen(dir, store)

    const [row] = store.summaries()
    expect(row?.status).toBe('ready')
    expect(row?.text).toBe('真正的摘要')
    // **标题跟描述一起落库。** 两样是模型一次生成的，分两条 UPDATE 写的话
    // 中间崩溃会留下「描述换成真的了、标题还是占位」的行——不报错，
    // 只是温区那一行前半截是上一次的
    expect(row?.name).toBe('真标题')
    store.close()
  })

  it('**老库补 name 列**：迁移之前存的行读出来是空标题，不是 undefined', async () => {
    // `CREATE TABLE IF NOT EXISTS` 对已存在的表一个字段都不加，而且不报错
    // ——老库会一直缺列到某个 SELECT 炸掉。这条钉的是 MIGRATIONS 那一行
    // 真的跑了，而且老行读出来是可用的空串
    const dir = await workspace()
    const store = openStore(dir)
    const id = store.addSummary(draft())
    store.close()

    // 直接把列删掉，模拟迁移之前的库
    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
    db.exec('ALTER TABLE summaries DROP COLUMN name')
    db.close()

    const reopened = openStore(dir)
    const row = reopened.summaries().find((s) => s.id === id)
    expect(row).toBeDefined() // 前提：列删了之后还读得出来，即迁移确实补回了
    expect(row?.name).toBe('')
    reopened.close()
  })

  it('**启动时把没生成完的行删掉，不是退回 pending**', async () => {
    // 摘要跑到一半进程没了（/exit、崩溃、runOnce 跑完就退）会留下这种行。
    //
    // **原来是退回 pending，那是错的**（2026-09-03 真机验证照出来的）：退回
    // 之后没有任何代码会再挑到它——`nextSegment` 算「已覆盖」时不看 status，
    // 那一行永久占着它盖的 step。归档掉的真库里 213 条 pending 就是这么攒的，
    // 它们在 covers 上打的洞让 pickMergeGroup 的连续性判断一直断着。
    //
    // 当时不删的理由是「占位文本正在 context 里用着」，**那个前提不成立**：
    // activateSummary 的 SQL 写死 status='ready'，没生成完的行进不了 context
    const dir = await workspace()
    let store = openStore(dir)
    // inContext: false 才是真实状态——没生成完的行进不了 context（上面那条
    // 理由）。draft() 默认的 true 是这个文件早年的夹具，跟生产状态对不上
    const id = store.addSummary(draft({ inContext: false }))
    store.startSummary(id)
    expect(store.summaries()[0]?.status).toBe('generating') // 前提：确实卡住了

    store = reopen(dir, store)

    expect(store.summaries()).toEqual([])
    store.close()
  })

  it('对照：生效中的行即使没 ready 也不删', async () => {
    // 正常流程到不了这个状态（activateSummary 只认 ready），这条守卫是防御。
    // 没有它的话，将来哪个 bug 让一行「in_context 但没 ready」，这行历史会在
    // 下次启动时**凭空消失**——不报错，只是那一段没了
    const dir = await workspace()
    let store = openStore(dir)
    store.startSummary(store.addSummary(draft({ inContext: true })))

    store = reopen(dir, store)

    expect(store.summaries()).toHaveLength(1)
    store.close()
  })

  it('**删完那一段要重新成为候选**——这才是删它的目的', async () => {
    // 上一条只证明行没了。行没了但候选不回来的话，那段历史照样没人摘，
    // 只是从「卡着一行 pending」变成「一行都没有」，一样是洞
    const dir = await workspace()
    let store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('问一'), assistantSays('答一')])
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('问一'), assistantSays('答一'), userSays('问二')])

    const first = store.nextSegmentToSummarize(1_000_000, null)
    expect(first).not.toBeNull() // 前提：本来就有候选
    const id = store.addSummary(
      draft({ coversFrom: first?.from ?? 0, coversTo: first?.to ?? 0, inContext: false }),
    )
    store.startSummary(id)
    // 卡住期间这一段被那行盖着，挑不到（挑得到就是在重复摘同一段）
    expect(store.nextSegmentToSummarize(1_000_000, null)?.from).not.toBe(first?.from)

    store = reopen(dir, store)

    expect(store.nextSegmentToSummarize(1_000_000, null)?.from).toBe(first?.from)
    store.close()
  })

  it('对照组：ready 的行不会被删', async () => {
    // 没有这条的话，「启动时把 summaries 清空」也能让上面两条通过——
    // 那会把已经生成好的摘要全部作废，每次启动重算一遍
    const dir = await workspace()
    let store = openStore(dir)
    const id = store.addSummary(draft())
    store.finishSummary(id, '已经好了', '')

    store = reopen(dir, store)

    const [row] = store.summaries()
    expect(row?.status).toBe('ready')
    expect(row?.text).toBe('已经好了')
    store.close()
  })

  it('**load() 不拼摘要，只还 live 原样**', async () => {
    // 提案 §4.1 原本要求在这里拼，实测是错的：session 拿 load() 的结果当内存
    // 历史，之后每轮 save() 原样写回库。在这里拼的话摘要文本会作为**真的 live
    // 消息**入库，下次 load() 又给它拼一次——重启一次多一份，全程不报错。
    // 下面那条往返测试就是这个 bug 的复现
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('第一轮')])
    const turns = readTurnIds(dir)
    store.addSummary(
      draft({ coversFrom: turns[0] as number, coversTo: turns[0] as number, text: '摘要顶替' }),
    )

    expect(store.load()).toEqual([userSays('第一轮')])
    store.close()
  })

  it('**load → save 往返之后摘要不会增殖**', async () => {
    // 上一条的行为保证。session 每轮都在做这个往返，摘要一旦回流进 live，
    // 每重启一次 context 里就多一份，而且不报错——发现时已经烧了很多 token
    const dir = await workspace()
    let store = openStore(dir)
    store.save([userSays('第一轮')])
    const turns = readTurnIds(dir)
    store.addSummary(
      draft({ coversFrom: turns[0] as number, coversTo: turns[0] as number, text: '摘要顶替' }),
    )

    for (let i = 0; i < 3; i++) {
      store.save(store.load()) // session 每轮干的事
      store = reopen(dir, store)
    }

    expect(store.load()).toEqual([userSays('第一轮')])
    expect(store.summaries()).toHaveLength(1)
    store.close()
  })

  it('withTurns 给内存历史配 turn 归属', async () => {
    // 拼装点要的输入。归属跟 save 共用一份算法，否则摘要会盖错 turn
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('第一轮')])
    const first = readTurnIds(dir)[0] as number
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮'), userSays('第二轮')])

    const withTurns = store.withTurns([userSays('第一轮'), userSays('第二轮')])
    expect(withTurns[0]?.turnId).toBe(first) // 老消息留在原 turn
    expect(withTurns[1]?.turnId).not.toBe(first) // 新消息算当前 turn
    store.close()
  })

  it('withTurns 是只读的，不会凭空建 turn', async () => {
    // save 里那句 `currentTurn ??= createTurn` 照抄过来的话，每次拼装都多一个
    // 空 turn 行——跟惰性创建那个坑同一个形状，查库才看得出来。
    //
    // **必须在 save 之前调**：save 过之后 currentTurn 已经非 null，`??=` 本来
    // 就不会建，照抄与否都测不出差别（第一版这么写，变异检验存活才发现）
    const dir = await workspace()
    const store = openStore(dir)
    // **查 turns 表，不是 messages 表**：空 turn 没有任何消息，readTurnIds
    // （它 SELECT messages）永远看不见它，用那个的话建了空 turn 也测不出来
    expect(countTurnRows(dir)).toBe(0) // 前提：一个 turn 都还没有

    store.withTurns([userSays('还没落盘的消息')])
    store.withTurns([userSays('还没落盘的消息')])

    expect(countTurnRows(dir)).toBe(0)
    store.close()
  })

  it('**卸载一个有 ready 摘要的 turn → 摘要生效，带上头部和路径**', async () => {
    // 3b-1 的主线：摘要生成 → 卸载 → 生效。前面那些测试各测一段，
    // 中间的接缝（谁调 activateSummary、参数从哪来）一条都没覆盖——
    // 变异检验里「没 ready 也启用」「头部取自改写后的消息」都存活了
    const dir = await workspace()
    const store = openStore(dir)
    // **中间那条 tool_call 必须比用户那句长。** headOfStep 原来是「取最长
    // 那条」，而第 0 层只裁工具 I/O 之后，step 里最长的几乎必然是几万字符的
    // bash 命令，头部于是全退化成 `(tool_call)`（§1.2 那 15% 垃圾）。
    // 夹具里两条一样长的话，「取最长」和「优先取带文本的」给同一个答案，
    // 这条测试就分不出实现对不对——变异检验实测确认过它会存活
    // **长的那条必须和用户那句在同一个 step 里。** save 按 assistant 边界切
    // step，放成 assistant 消息的话它自己单独一个 step，headOfStep 看的还是
    // 只有用户那句的那个 step——「取最长」和「优先取带文本的」给同一答案，
    // 测试分不出对错（变异检验实测存活）。用 role:'tool' 就落在同一段里
    store.save([
      userSays('把 auth 中间件补上 JWT 校验'),
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', toolCallId: 'c1', output: 'x'.repeat(5_000), isError: false },
        ],
      },
      assistantSays('好的'),
    ])
    const turn = readTurnIds(dir)[0] as number

    const id = store.addSummary(draft({ coversFrom: turn, coversTo: turn, inContext: false }))
    store.finishSummary(id, '写入 src/auth.ts 约 500 行', '')
    const [ref] = store.unload([0, 1, 2])

    expect(store.activateSummary(turn)).toBe(true)
    const [row] = store.summaries()
    expect(row?.inContext).toBe(true)
    // **head 由 store 自己从这个 step 的消息里取，不从调用方收。**
    // 第 0 层改成只裁工具 I/O 之后（提案 §4.2），run.ts 那边能拿到的只有
    // 被卸载的工具消息，取出来是 `(tool_call)` ——§1.2 那 15% 垃圾的来源
    expect(row?.head).toContain('把 auth 中间件补上 JWT')
    expect(row?.head).not.toContain('(tool_call)') // 不是「取最长那条」的结果
    expect(row?.head).not.toContain('已卸载') // 取的是原文，不是刚写好的存根
    expect(row?.archivePath).toContain('turn-')
    expect(ref?.archivePath).toContain('turn-') // 前提：确实卸载过
    store.close()
  })

  it('**对照：摘要还没 ready 时不生效**（§9.7 的降级路径）', async () => {
    // 没有这条的话，「一律生效」也能让上面那条通过——而一律生效的后果是
    // context 里出现一条写着「（摘要生成中）」的占位，原文却已经被顶掉了
    const dir = await workspace()
    const store = openStore(dir)
    store.save([userSays('第一轮')])
    const turn = readTurnIds(dir)[0] as number
    store.addSummary(draft({ coversFrom: turn, coversTo: turn, inContext: false }))
    // 故意不 finishSummary，停在 pending

    expect(store.activateSummary(turn)).toBe(false)
    expect(store.summaries()[0]?.inContext).toBe(false)
    store.close()
  })
})

describe('原始输出落盘', () => {
  it('未截断的完整输出进 raw/<id>.log', async () => {
    // §9.3 第 ① 层：进 context 的 tool_result 是截断过的，
    // 完整版留在这里给模型 cat
    const dir = await workspace()
    const store = openStore(dir)
    const sink = store.rawSink('toolu_abc123')
    sink.write('第一块\n')
    sink.write('第二块\n')
    sink.close()

    await new Promise((r) => setTimeout(r, 20)) // 流是异步的
    const text = await readFile(
      resolveBucketFile(join(dir, MEMORY_RELATIVE), 'raw', 'toolu_abc123.log'),
      'utf8',
    )
    expect(text).toBe('第一块\n第二块\n')
    store.close()
  })

  it('toolCallId 里的路径穿越被挡掉', async () => {
    // id 来自模型，直接当文件名能写到 memory/ 外面去
    const dir = await workspace()
    const store = openStore(dir)
    const sink = store.rawSink('../../../etc/evil')
    sink.write('x')
    sink.close()

    await new Promise((r) => setTimeout(r, 20))
    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'raw', '.log')
    expect(files).toHaveLength(1)
    // listBucketFiles 给绝对路径，穿越检查看文件名本身
    expect(basename(files[0] as string)).not.toContain('/')
    expect(basename(files[0] as string)).not.toContain('..')
    store.close()
  })
})

/** steps 表的 unloaded 标志。Store 接口只暴露单个查询，测试要看全貌 */
function readStepFlags(dir: string): { id: number; unloaded: number }[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db.prepare('SELECT id, unloaded FROM steps ORDER BY id').all() as {
    id: number
    unloaded: number
  }[]
  db.close()
  return rows
}

/** 还留着 live 行的 step（存根也算——它正是摘要要顶掉的东西） */
function stepsWithLiveRows(dir: string): number[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db
    .prepare("SELECT DISTINCT step_id FROM messages WHERE state = 'live' AND step_id IS NOT NULL")
    .all() as { step_id: number }[]
  db.close()
  return rows.map((r) => r.step_id)
}

/**
 * 抹掉 step 语义，模拟「steps 表出现之前就已经跑了很久」的老库。
 *
 * 真实库就是这么来的：卸载发生在 steps 表存在之前，`unload()` 里翻标志那句
 * 一次都没跑过，重启后 backfillSteps 给这些历史新建 step 行——全是默认值 0。
 */
function stripSteps(dir: string): void {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  db.exec('UPDATE messages SET step_id = NULL; DELETE FROM steps;')
  db.close()
}

describe('回填出来的 step 认领 unloaded 标志', () => {
  it('原文早已卸空的 step，重启后 stepUnloaded 为 true', async () => {
    // **真实库里的病灶：6260 个 step（92%）中招。** 标志留在 0 的后果不报错
    // ——stepUnloaded 恒 false，补摘完永远不翻 in_context，摘要生成了也顶不掉
    // 存根，context 里滞留 1151 条存根 ≈ 250k token
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), assistantSays('二'), userSays('三')])
    store.unload([0, 1]) // 前两条原文离开 context
    store.save([userSays('一截断'), assistantSays('二截断'), userSays('三')])
    stripSteps(dir)
    store.close()

    const reopened = openStore(dir)
    const flags = readStepFlags(dir)
    // 前提断言：确实回填出了 step，否则下面全是空转
    expect(flags.length).toBeGreaterThan(0)

    const cleared = flags.filter((f) => f.unloaded === 1)
    expect(cleared.length).toBeGreaterThan(0) // 修复前这里是 0
    for (const f of cleared)
      expect(reopened.segmentHeadUnloaded({ from: f.id, to: f.id, turn: 1 })).toBe(true)
    reopened.close()
  })

  it('对照：还有 live 原文的 step 不能被误标', async () => {
    // 没有这个对照，上一个用例把 unloaded 无脑全置 1 也会绿——那样一来
    // 摘要会给还在 context 里的原文直接翻 in_context，历史凭空消失
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), assistantSays('二')])
    stripSteps(dir)
    store.close()

    const reopened = openStore(dir)
    const flags = readStepFlags(dir)
    expect(flags.length).toBeGreaterThan(0) // 前提：有 step 可判
    for (const f of flags)
      expect(reopened.segmentHeadUnloaded({ from: f.id, to: f.id, turn: 1 })).toBe(false)
    reopened.close()
  })
})

describe('摘要候选优先给还占着 context 的 turn', () => {
  it('一条 live 行都不剩的老 turn 排在占着 context 的后面', async () => {
    // 光按 id 升序的话，队首是 6187 个「摘了也顶不掉任何东西」的老 step，
    // 一次空闲一段要几千次 tick 才轮到真正占地方的那个
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('老一'), assistantSays('老二')])
    store.unload([0, 1])
    // 存根被合并剪掉：老 turn 的行全是 `unloaded`，一条 live 都不剩。这是
    // 「摘了也顶不掉任何东西」的那种 turn，也是造出它的唯一途径——存根还在
    // 的话老 turn 照样占着 context。**归属数组要跟着缩**，所以走 pruneMessages
    // 而不是直接 save 一个短数组（后者会让新消息认领老 step，一条 stale 都不剩）
    store.pruneMessages([0, 1])
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('新一'), assistantSays('新二')])
    store.close()

    const reopened = openStore(dir)
    const segment = reopened.nextSegmentToSummarize(1_000_000, null)
    expect(segment).not.toBeNull()

    // **判据是「有没有 live 行」，不是 unloaded 标志。** 两者不等价：真实库里
    // 541 个 step 既是 unloaded=1（原文已走）又还留着 live 存根——而存根正是
    // 摘要要顶掉的东西，所以它们算「占着 context」。拿 flag 当判据的话，这个
    // 断言在合成数据上照样绿，却测的是另一回事
    const inContext = new Set(stepsWithLiveRows(dir))
    expect(inContext.size).toBeGreaterThan(0) // 前提：确实有占着 context 的
    const stale = readStepFlags(dir)
      .map((f) => f.id)
      .filter((id) => !inContext.has(id))
    expect(stale.length).toBeGreaterThan(0) // 前提：确实有卸空的老 step

    // 挑中的段落属于还占着 context 的那个 turn
    expect(inContext).toContain(segment?.from)

    // 对照：卸空的老 step 仍然是候选，只是排在后面——排除它们会让 covers
    // 出洞，L1 合并再也接不上（提案 §4.3 的候选枯竭、§6.6 同一个坑）
    for (const id of stale) expect(id).toBeLessThan(segment?.from ?? 0)
    reopened.close()
  })
})

describe('摘要碰头即上岗', () => {
  /** 一个 turn 两个 step，外加一条覆盖 1-2 的 ready 摘要 */
  const twoStepTurn = (dir: string) => {
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), assistantSays('二')])
    store.addSummary({
      level: 0,
      coversFrom: 1,
      coversTo: 2,
      name: '',
      text: '这一轮的摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    return store
  }

  it('**段头卸了、段尾还 live 就生效**——卸载按 token 刹车常停在段中间', async () => {
    // turn-28 的真库病案：推进线停在段中间（段头两个 step 卸了、段尾还 live），
    // 旧的「整段卸空才生效」条件永远凑不齐，300 字符存根一直顶班。现在两层
    // 各管各的：floorTokens 管「裁多少」（卸载后的 16k），段边界管「顶替多少」
    // （按卸载前的 16k 切的段，整段换一行摘要）。段尾被顶掉是设计内的——原文
    // 都在库里，路径写在摘要行里
    const dir = await workspace()
    const store = twoStepTurn(dir)

    store.markCold([1]) // 只有段头冷
    // 前提：段尾确实还 live——否则测的还是「整段都冷」的老路径
    expect(readStepFlags(dir).find((f) => f.id === 2)?.unloaded).toBe(0)
    expect(store.segmentHeadUnloaded({ from: 1, to: 2, turn: 1 })).toBe(true)

    expect(store.activateSummary(1)).toBe(true)
    store.close()
    expect(readSummaryRows(dir)[0]?.in_context).toBe(1)
  })

  it('**对照：段头还 live 就不生效**——判头不判任一，非前缀 bug 退回存根顶着而不是吞史', async () => {
    // 正常流程到不了「段尾冷、段头 live」（挑选严格从最老开始，§11.5）。这条
    // 守卫防的是将来哪个 bug 让挑选跳着来：没有它，「判任一卸载」也能让上一条
    // 通过，而那种实现会把推进线还没扫到的历史直接顶掉——不报错，那截历史
    // 就静默消失了
    const dir = await workspace()
    const store = twoStepTurn(dir)

    expect(store.segmentHeadUnloaded({ from: 1, to: 2, turn: 1 })).toBe(false) // 全 live
    store.markCold([2]) // 段尾冷、段头 live——非前缀
    expect(store.segmentHeadUnloaded({ from: 1, to: 2, turn: 1 })).toBe(false)

    expect(store.activateSummary(2)).toBe(false)
    store.close()
    expect(readSummaryRows(dir)[0]?.in_context).toBe(0)
  })
})

/** summaries 表原样读出来，测试要看 covers / level / in_context */
function readSummaryRows(dir: string): {
  level: number
  covers_from: number
  covers_to: number
  text: string
  in_context: number
  archive_path: string | null
}[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db
    .prepare(
      'SELECT level, covers_from, covers_to, text, in_context, archive_path FROM summaries ORDER BY covers_from',
    )
    .all() as never
  db.close()
  return rows
}

/** step id 连它属于哪个 turn。Store 接口不暴露 step 表，开只读连接查 */
function stepIdsOf(dir: string): { id: number; turn_id: number }[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
  const rows = db.prepare('SELECT id, turn_id FROM steps ORDER BY id').all() as never
  db.close()
  return rows
}

function userVersion(dir: string): number {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const v = (db.prepare('PRAGMA user_version').all() as { user_version: number }[])[0]?.user_version
  db.close()
  return v ?? 0
}

/**
 * 造一个「积压了很多无摘要老 step」的库：n 轮对话，全部卸载过。
 *
 * 逐轮 save 才会真的长出 n 个 step——一次性 save 一大把消息只会按 assistant
 * 边界切，且都算在当前 turn 名下。
 *
 * **不额外调 beginStep**：save 自己会按 assistant 边界建 step，再手工开一个
 * 就多出一个没有任何消息的空 step，covers 里凭空多出洞——真实库里空 step
 * 是 0 个，那种洞是夹具造的假象，不是被测行为
 */
function buildBacklog(dir: string, rounds: number): Store {
  const store = openStore(dir)
  const history: Message[] = []
  for (let i = 1; i <= rounds; i++) {
    store.beginTurn({ model: "p/m", effort: null })
    history.push(
      userSays(`问题${i}`.padEnd(60, '内容')),
      assistantSays(`回答${i}`.padEnd(60, '内容')),
    )
    store.save(history)
  }
  // 把除最后两条外的全部卸掉，模拟「原文早已离开 context」
  const indices = history.slice(0, -2).map((_, i) => i)
  if (indices.length > 0) store.unload(indices)
  store.close()
  // 重开一次才跑得到迁移（compactLegacyBacklog 在开库路径上）
  return openStore(dir)
}

describe('一次性压实积压（compactLegacyBacklog）', () => {
  it('cutoff 之前的无摘要 step 被卸原文 + 成段落一条 L2，一次模型都不调', async () => {
    // 真实库的病灶：6524 个「原文早已离开 context、却没有任何摘要覆盖」的
    // step 会正常进候选队列——重启后空闲摘要连调 6524 次模型（≈1160 万
    // input token），而它们摘出来顶不掉任何东西
    const dir = await workspace()
    const store = buildBacklog(dir, 130) // > COMPACT_KEEP_STEPS(100)
    const total = readStepFlags(dir).length
    expect(total).toBeGreaterThan(100) // 前提：真的攒够了才谈得上压实

    const rows = readSummaryRows(dir)
    expect(rows.length).toBeGreaterThan(0) // 修复前这里是 0
    const cutoff = total - 100
    for (const r of rows) {
      expect(r.covers_to).toBeLessThanOrEqual(cutoff) // 只碰 cutoff 之前的
      expect(r.in_context).toBe(1) // 直接生效——原文已不在 context，不用等下次卸载
      expect(r.level).toBe(2) // 成段的行不能写成 L0，否则后续合并按单点凑连续段
    }
    // **成段而不是一 step 一条。** 一条 L0 只有几十 token，但 6524 条就是
    // 50 万——比它要替换掉的 1151 条存根还糟（实测：一 step 一条 → 528k，
    // 分成 642 条 L1 → 120k，成 L2 段 → 3k）
    expect(rows.length).toBeLessThan(cutoff / 10)
    store.close()
  })

  it('摘要行带得走归档路径 —— 没有它模型知道该展开却不知道去哪 cat', async () => {
    const dir = await workspace()
    const store = buildBacklog(dir, 130)
    const rows = readSummaryRows(dir)
    expect(rows.length).toBeGreaterThan(0)
    // 存根正文里带着「[已卸载，完整内容见 …]」，混进摘要正文会很难读
    for (const r of rows) expect(r.text).not.toContain('已卸载')
    // 指的是**叶子**不是 raw 归档（原来这里断言 `turns/`）：raw 是几百 KB
    // 的逐字对话，模型顺着它 cat 等于把刚卸载掉的全读回来。叶子是同一段的
    // 结构化摘要，正是下一档分辨率；raw 从叶子 frontmatter 的 turn 再走一跳
    expect(rows.every((r) => r.archive_path?.includes('summaries/'))).toBe(true)
    expect(rows.every((r) => r.archive_path?.endsWith('.md'))).toBe(true)
    store.close()
  })

  it('**一个 turn 出一个候选，不是每个 step 一个**', async () => {
    // 2026-09-03 真机验证抓到的：跑一轮真实对话，turn 1 的 3 个 step 出了
    // **3 条摘要**（covers 1-1 / 2-2 / 3-3）。原因是候选只排除「最后一个
    // step」，而摘要是每个 step 跑完踢一脚的——那时除最后一个之外只剩刚跑完
    // 的那一个。切段预算一次都没机会起作用，退回了 §1.1 的「一个 turn 摘九遍」。
    //
    // 不报错，只是索引树的粒度整个错了：叶子数量 = step 数而不是 turn 数
    const dir = await workspace()
    const store = openStore(dir)
    const t1 = store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('问一'), assistantSays('答一')])
    store.save([userSays('问一'), assistantSays('答一'), assistantSays('再答')])
    const t2 = store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('问一'), assistantSays('答一'), assistantSays('再答'), userSays('问二')])

    const steps = stepIdsOf(dir)
    expect(new Set(steps.filter((s) => s.turn_id === t1).map((s) => s.id)).size).toBeGreaterThan(1)

    // turn 2 在跑：候选是**整个 turn 1**，一段盖住它全部的 step
    const segment = store.nextSegmentToSummarize(1_000_000, t2)
    const inT1 = steps.filter((s) => s.turn_id === t1).map((s) => s.id)
    expect(segment?.turn).toBe(t1)
    expect(segment?.from).toBe(Math.min(...inT1))
    expect(segment?.to).toBe(Math.max(...inT1))

    store.close()
  })

  it('**对照：idle 时（activeTurn=null）最后那个 turn 也摘得到**', async () => {
    // 排除整个 turn 不能顺手把「最后一个 turn」也排掉——空闲摘要正是为了摘
    // 刚结束的那一轮，够不着它的话这个功能就废了一半。所以排除谁由调用方说，
    // 不是 store 自己猜
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('问一'), assistantSays('答一')])
    const last = store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('问一'), assistantSays('答一'), userSays('问二'), assistantSays('答二')])

    // 跑着的时候够不着；空闲下来就够得着
    const whileRunning: number[] = []
    for (
      let seg = store.nextSegmentToSummarize(1_000_000, last), guard = 0;
      seg && guard < 5;
      guard++
    ) {
      whileRunning.push(seg.turn)
      store.addSummary({
        level: 0,
        coversFrom: seg.from,
        coversTo: seg.to,
        name: '',
        text: 'x',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: null,
        archivePath: null,
      })
      seg = store.nextSegmentToSummarize(1_000_000, last)
    }
    expect(whileRunning).not.toContain(last) // 前提：跑着的时候确实排除了它
    expect(store.nextSegmentToSummarize(1_000_000, null)?.turn).toBe(last)

    store.close()
  })

  it('covers 连续无洞 —— 有洞的话 L1 合并永远接不上', async () => {
    const dir = await workspace()
    const store = buildBacklog(dir, 130)
    const rows = readSummaryRows(dir)
    // 段与段首尾相接：上一段的 covers_to + 1 == 下一段的 covers_from
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.covers_from).toBe((rows[i - 1]?.covers_to ?? 0) + 1)
    }
    store.close()
  })

  it('压实之后候选队列大幅缩短 —— 这才是省下那几千次调用的地方', async () => {
    const dir = await workspace()
    const store = buildBacklog(dir, 130)
    // 剩下的候选只能是 cutoff 之后那批（近期上下文），不是全部 130 个
    const remaining: number[] = []
    const seen = new Set<number>()
    for (;;) {
      const segment = store.nextSegmentToSummarize(1_000_000, null)
      if (segment === null || seen.has(segment.from)) break
      seen.add(segment.from)
      remaining.push(segment.from)
      // 落一条假摘要让候选前进
      const sid = store.addSummary({
        level: 0,
        coversFrom: segment.from,
        coversTo: segment.to,
        name: '',
        text: 'x',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: null,
        archivePath: null,
      })
      void sid
    }
    const total = readStepFlags(dir).length
    expect(remaining.length).toBeLessThan(total / 2) // 修复前是全部
    store.close()
  })

  it('**对照：短会话一条都不动**——没有积压就没有要压实的', async () => {
    // 没有这个对照，「无条件卸掉 cutoff 之前的」在小库上会把刚说的话也卸了
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('一'), assistantSays('二')])
    store.close()

    const reopened = openStore(dir)
    expect(readSummaryRows(dir)).toHaveLength(0) // 一条都没造
    expect(reopened.load()).toHaveLength(2) // 原文原样都在
    reopened.close()
  })

  it('**对照：已有摘要覆盖的 step 不重复落行**', async () => {
    const dir = await workspace()
    const store = buildBacklog(dir, 130)
    const first = readSummaryRows(dir).length
    store.close()

    // 再开一次：user_version 已是 3，不该再进来
    const again = openStore(dir)
    expect(readSummaryRows(dir)).toHaveLength(first)
    expect(userVersion(dir)).toBe(3)
    again.close()
  })

  it('**对照：cutoff 之后的近期 step 原文保持 live**', async () => {
    // 压实错杀近期上下文的话，模型会突然看不到刚才在干什么
    const dir = await workspace()
    const store = buildBacklog(dir, 130)
    const inContext = stepsWithLiveRows(dir)
    const total = readStepFlags(dir).length
    expect(inContext.length).toBeGreaterThan(0)
    for (const id of inContext) expect(id).toBeGreaterThan(total - 100 - 1)
    store.close()
  })
})

// --------------------------------------------- 归属重排（提案 §1.5 补记）

describe('remapMessages：normalizeHistory 增删之后归属跟着走', () => {
  it('**中间插一条之后，插入点之后的归属不漂移**', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    // 两轮，各自的 turn 不同——只有一个 turn 的话「错一位」看不出来
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮问'), assistantSays('第一轮答')])
    store.beginTurn({ model: "p/m", effort: null })
    const history = [userSays('第一轮问'), assistantSays('第一轮答'), userSays('第二轮问')]
    store.save(history)
    const before = readTurnIds(dir)
    expect(new Set(before).size).toBe(2) // 前提：真的跨了两个 turn

    // 模拟 normalizeHistory 在下标 1 之后插了一条占位
    store.remapMessages([0, 1, null, 2])
    store.save([...history.slice(0, 2), userSays('补的占位'), history[2] as Message])

    const after = readTurnIds(dir)
    expect(after).toHaveLength(4)
    // 插入点之后那条仍然属于第二轮，不是被挤成第三个值
    expect(after[3]).toBe(before[2])
    // 补出来的占位继承前一条（它回答的是第一轮那个调用），不是当前 turn
    expect(after[2]).toBe(before[1])
  })

  it('**对照：不 remap 的话就整体错一位**——证明上面那条测的是真行为', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮问'), assistantSays('第一轮答')])
    store.beginTurn({ model: "p/m", effort: null })
    const history = [userSays('第一轮问'), assistantSays('第一轮答'), userSays('第二轮问')]
    store.save(history)
    const before = readTurnIds(dir)

    // 故意不调 remapMessages，直接存增补后的数组
    store.save([...history.slice(0, 2), userSays('补的占位'), history[2] as Message])

    const after = readTurnIds(dir)
    // **看下标 2，不是下标 3。** 漂移发生在插入点那一条：不 remap 时它拿到
    // previous[2]（第二轮），而它其实是第一轮那个调用的收尾。
    //
    // 下标 3 两种实现碰巧都得 2（一个来自 previous[2]，一个来自"当前
    // turn"），断在那里的话对照组永远是假绿——第一版就断错了位置
    expect(after[2]).not.toBe(before[1])
    expect(after[2]).toBe(before[2]) // 具体错成了「第二轮」
  })

  it('**对照：卸载改写内容之后归属不变**——挡「按内容指纹匹配」那个方案', async () => {
    // 评审时考虑过用 fingerprint 把新旧消息对应起来，一举摆脱下标。它在卸载
    // 面前就垮了：消息被裁之后内容变、指纹变，每条被裁的消息都会被当成
    // 「新插入」去继承前一条归属。而卸载每轮都在发生
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮问'), assistantSays('第一轮答')])
    store.beginTurn({ model: "p/m", effort: null })
    store.save([userSays('第一轮问'), assistantSays('第一轮答'), userSays('第二轮问')])
    const before = readTurnIds(dir)

    // 卸载不改条数，origin 是恒等映射；但内容会被改写成存根
    store.remapMessages([0, 1, 2])
    store.save([
      userSays('第一轮问[已卸载]'),
      assistantSays('第一轮答[已卸载]'),
      userSays('第二轮问'),
    ])

    expect(readTurnIds(dir)).toEqual(before)
  })
})

describe('regions.jsonl：四个区的诊断记录（提案 §13）', () => {
  it('一次一行，追加不覆盖', async () => {
    const dir = await workspace()
    const store = openStore(dir)

    store.recordRegions(
      { overhead: 900, cold: 40, warm: 100, hot: 160, stub: 1_200, floor: 2_000, live: 18_000 },
      238_000,
    )
    store.recordRegions(
      { overhead: 900, cold: 40, warm: 110, hot: 170, stub: 1_300, floor: 2_000, live: 19_000 },
      238_000,
    )

    const lines = (await readFile(join(dir, MEMORY_RELATIVE, 'regions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2) // 不是 1——第二次不能把第一次冲掉
    const first = JSON.parse(lines[0] as string)
    expect(first).toMatchObject({ overhead: 900, cold: 40, hot: 160, stub: 1_200, live: 18_000 })
    expect(first.budget).toBe(238_000) // 比例是拿它当基数算的，缺了这一列没法复算
    expect(typeof first.at).toBe('string') // 唯一能跟 turns/*.jsonl 对上的东西
    store.close()
  })
})
