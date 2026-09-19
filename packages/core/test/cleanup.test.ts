import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MEMORY_RELATIVE, openStore } from '../src/session/store.ts'

/**
 * 写放大清洗迁移（`cleanup.ts`）。
 *
 * **每条都配对照组**：这个迁移删 86% 的行，"跑完之后行数少了"这种断言
 * 一个乱删的实现也能通过。真正要证的是**删对了哪些、没删哪些**。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const NOTICE = '\n[已卸载，完整内容见 .simple-code/memory/turns/turn-000001.jsonl]'

const msg = (text: string) => JSON.stringify({ role: 'user', parts: [{ type: 'text', text }] })

/**
 * 直接建库造脏数据，不走 `openStore`——迁移要测的就是「老库开进来会怎样」，
 * 用当前代码去写只会写出干净的库。
 */
async function dirtyDb(seed: (db: DatabaseSync) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-cleanup-'))
  dirs.push(dir)
  const path = join(dir, MEMORY_RELATIVE, 'state.db')
  // 先用 openStore 建表（schema 是它的私有知识），关掉再灌脏数据
  openStore(dir).close()
  const db = new DatabaseSync(path)
  // openStore 建库时清洗已经空跑过一遍并留下标记，删掉才是「没洗过的老库」
  db.exec(`DELETE FROM migrations`)
  db.exec(`INSERT INTO turns(started_at) VALUES('t1')`)
  db.exec(`INSERT INTO turns(started_at) VALUES('t2')`)
  seed(db)
  db.close()
  return dir
}

const rows = (dir: string) => {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
  const out = db
    .prepare(`SELECT id, turn_id, state, content_json FROM messages ORDER BY id`)
    .all() as { id: number; turn_id: number; state: string; content_json: string }[]
  db.close()
  return out
}

const insert = (db: DatabaseSync, turn: number, state: string, text: string) => {
  db.prepare(
    `INSERT INTO messages(turn_id, role, content_json, state) VALUES(?, 'user', ?, ?)`,
  ).run(turn, msg(text), state)
}

describe('写放大清洗迁移', () => {
  it('**同 turn 内重复的 unloaded 行只留最早一条**', async () => {
    const dir = await dirtyDb((db) => {
      for (let i = 0; i < 5; i++) insert(db, 1, 'unloaded', '重复的内容')
      insert(db, 1, 'unloaded', '另一条')
    })
    expect(rows(dir).length).toBe(6) // 前提：确实灌进去了 6 条

    openStore(dir).close()

    const after = rows(dir)
    expect(after.length).toBe(2)
    expect(after[0]?.id).toBe(1) // 留最早那条，不是最晚
    expect(after.map((r) => JSON.parse(r.content_json).parts[0].text)).toEqual([
      '重复的内容',
      '另一条',
    ])
  })

  it('**对照：live 行一条都不删**——哪怕内容完全相同', async () => {
    const dir = await dirtyDb((db) => {
      for (let i = 0; i < 4; i++) insert(db, 1, 'live', '继续')
    })
    expect(rows(dir).length).toBe(4)

    openStore(dir).close()

    // 用户连发两次「继续」是真实的，删掉就是真丢数据。live 只有几百行、
    // 删了没收益，所以这里的规则是「一条不碰」
    expect(rows(dir).length).toBe(4)
  })

  it('**对照：跨 turn 的相同内容不合并**——那是 turn 归属的 bug，不在这里掩盖', async () => {
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'unloaded', '同样一句话')
      insert(db, 2, 'unloaded', '同样一句话')
    })
    openStore(dir).close()
    expect(rows(dir).map((r) => r.turn_id)).toEqual([1, 2])
  })

  it('**叠加的卸载标记折叠成一个**', async () => {
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'live', `正文${NOTICE.repeat(10)}`)
    })
    const before = rows(dir)[0]?.content_json ?? ''
    // 前提：脏数据真的叠了 10 个，否则下面测的是空集
    expect(before.split('已卸载').length - 1).toBe(10)

    openStore(dir).close()

    const after = rows(dir)[0]?.content_json ?? ''
    expect(after.split('已卸载').length - 1).toBe(1)
    // 折叠不能改正文，也不能把标记删光——存根丢了标记就变成「一条很短的
    // 正常消息」，模型再也不知道后面还有内容
    const text = JSON.parse(after).parts[0].text as string
    expect(text.startsWith('正文')).toBe(true)
    expect(text.endsWith(NOTICE)).toBe(true)
  })

  it('**正文中间的通知不动，只折叠结尾那串**——`$` 锚点', async () => {
    // 模型 cat 归档、或 grep 卸载标记时，工具输出的**正文里**就会带着真通知
    // （真换行开头）。判据来自 clip 的行为：它只往末尾追加，所以只有结尾
    // 那一串才是通知，中间的是内容
    const mid = `第一段${NOTICE}\n第二段还在后面`
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'unloaded', mid)
      insert(db, 2, 'unloaded', `${mid}${NOTICE.repeat(3)}`)
    })

    openStore(dir).close()

    const text = (i: number) => JSON.parse(rows(dir)[i]?.content_json ?? '{}').parts[0].text
    expect(text(0)).toBe(mid) // 中间那个一个字没动
    expect(text(1)).toBe(`${mid}${NOTICE}`) // 结尾三个折成一个，中间的还在
  })

  it('**正文里引用了通知的源码文本时，不能把行写坏**——解码后再匹配', async () => {
    // 真库里的原样一行：grep unload.ts 的输出。正文里的 `\n` 是**字面两字符**
    // （反斜杠 + n），存进 JSON 就是 `\\n`。第一版在 content_json 原文上跑
    // 正则，`\\n` 被吃掉一半，留下半个转义序列——在真库副本上开库当场
    // `Bad escaped character in JSON`，6 天的历史直接打不开
    const src = '82:  const notice = `\\n[已卸载，完整内容见 ${archive}]`'
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'unloaded', src)
    })
    // 前提：存进去的 JSON 里确实有双反斜杠可供切坏
    expect(rows(dir)[0]?.content_json).toContain('\\\\n[已卸载')

    openStore(dir).close()

    // 能解析出来 + 逐字相等，两条都要——只断言「能解析」的话，一个把整行
    // 替换成 `{}` 的实现也能过
    expect(JSON.parse(rows(dir)[0]?.content_json ?? '').parts[0].text).toBe(src)
  })

  it('**对照：只有一个标记的行逐字不变**', async () => {
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'live', `正文${NOTICE}`)
      insert(db, 1, 'live', '完全没有标记的一行')
    })
    const before = rows(dir).map((r) => r.content_json)
    openStore(dir).close()
    expect(rows(dir).map((r) => r.content_json)).toEqual(before)
  })

  it('**只差归档路径的两行算重复**——这正是 DISTINCT 认不出来的那批', async () => {
    const other = '\n[已卸载，完整内容见 .simple-code/memory/turns/turn-000050.jsonl]'
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'unloaded', `正文${NOTICE}`)
      insert(db, 1, 'unloaded', `正文${other}`)
    })

    // **前提：两行各只有一个标记，所以折叠对它们是恒等的**——差异一路活到
    // 去重那一步，能去掉就只可能是 stripMarkers 干的。
    //
    // 第一版拿「标记数量不同」造差异，这条前提就不成立：collapseStackedMarkers
    // 先跑，把两行都折叠成一个标记之后它们逐字相等，普通 DISTINCT 也能去掉。
    // 断言当时是绿的（灌数据时两行确实不等），但测的是空集。**变异检验把
    // stripMarkers 拿掉、这条仍然绿**，才暴露出来
    const before = rows(dir)
    expect(before.map((r) => r.content_json.match(/已卸载/g)?.length)).toEqual([1, 1])
    expect(before[0]?.content_json).not.toBe(before[1]?.content_json)

    openStore(dir).close()
    expect(rows(dir).length).toBe(1)
  })

  it('**对照：被截断的存根不当成原文的重复**——两者内容不同，都留着', async () => {
    const dir = await dirtyDb((db) => {
      insert(db, 1, 'unloaded', '完整的很长的一段正文，后面还有很多内容')
      insert(db, 1, 'unloaded', `完整的很长${NOTICE}`)
    })
    openStore(dir).close()
    // 剥标记后一个是另一个的前缀，不是相等。按前缀合并要判断"谁是谁的截断"，
    // 判错就是真丢原文——这一版不做，留在库里
    expect(rows(dir).length).toBe(2)
  })

  it('**对照：清洗跑过之后，压实迁移仍然能跑**——两个一次性迁移不许互相挡', async () => {
    // 我把清洗的标记写成 `PRAGMA user_version = 4` 时，空的新库一开就把
    // compactLegacyBacklog 的 `>= 3` 闸关死了：后者在没积压时**故意不置版本
    // 号**，等库真攒出积压，它已经被我推高的数字挡在门外，而且不报错。
    // 一个单调整数扛不住两个互相独立的迁移，所以换成具名 migrations 表
    //
    // 功能上的覆盖在 `store.test.ts` 的四条压实用例——把标记改回
    // `PRAGMA user_version = 4`，那四条会红。这里守的是更直接的不变量：
    // **清洗一个字都不许动 user_version**
    const dir = await dirtyDb((db) => {
      for (let i = 0; i < 3; i++) insert(db, 1, 'unloaded', '重复')
    })
    const version = () => {
      const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
      const v = (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version
      db.close()
      return v
    }
    const before = version()

    openStore(dir).close()

    expect(rows(dir).length).toBe(1) // 前提：这一次清洗真的干活了
    expect(version()).toBe(before)
  })

  it('**幂等：第二次开库不再动任何行**', async () => {
    const dir = await dirtyDb((db) => {
      for (let i = 0; i < 3; i++) insert(db, 1, 'unloaded', '重复')
    })
    openStore(dir).close()
    const after = rows(dir)
    expect(after.length).toBe(1) // 前提：第一次确实洗了

    openStore(dir).close()
    expect(rows(dir)).toEqual(after)
  })
})
