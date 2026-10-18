/**
 * 任务机制（task-v3，docs/proposals/task-v3.md）。锁定行为：
 *
 * - fork：一个事务写 reserved 锚 + 三轴跳段 + manifest；对话下一个 id 落段之上
 * - 域：任务 session 读写只落自己段；对话读不见任务段
 * - 关闭：flipTaskLive → 债清零判定（nextSegmentToSummarize）→ finalizeTask 还俗 + FTS 重灌
 * - 恢复：listTaskManifests = manifest 即真相
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import {
  forkTask,
  finalizeTask,
  flipTaskLive,
  listTaskManifests,
  readTaskManifest,
  scopeOf,
  type TaskManifest,
} from '../src/session/task.ts'
import { MEMORY_RELATIVE, openStore, type Store } from '../src/session/store.ts'
import { assembleContext } from '../src/loop/assemble.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-task-'))
  dirs.push(dir)
  return dir
}

const userSays = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })
const assistantSays = (text: string): Message => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
})

function runTurn(store: Store, live: Message[], user: string, reply: string): number {
  const t = store.beginTurn({ model: 'p/m', effort: null })
  live.push(userSays(user), assistantSays(reply))
  store.save(live)
  store.finishTurn(t, 111, 'done')
  return t
}

function query<T>(dir: string, sql: string, ...params: (string | number | null)[]): T[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
  const rows = db.prepare(sql).all(...params) as T[]
  db.close()
  return rows
}

describe('forkTask', () => {
  it('reserved 锚顶高 turns，manifest 四轴齐全', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const live: Message[] = []
    runTurn(main, live, 'u1', 'r1')
    runTurn(main, live, 'u2', 'r2')
    main.close()

    const before = query<{ m: number }>(dir, 'SELECT MAX(id) AS m FROM turns')[0]!.m
    const m = forkTask(dir, '试跑')
    expect(m.forkTurn).toBe(before)
    expect(m.turnCeil).toBe(before + 1000)
    // 锚行存在、state=reserved、owner 还是对话侧的 NULL
    const anchor = query<{ state: string; owner: string | null }>(
      dir,
      'SELECT state, owner FROM turns WHERE id = ?',
      m.turnCeil,
    )
    expect(anchor[0]!).toEqual({ state: 'reserved', owner: null })
    // 三轴 sqlite_sequence 顶到段尾
    const seq = query<{ name: string; seq: number }>(dir, 'SELECT name, seq FROM sqlite_sequence')
    const byName = Object.fromEntries(seq.map((r) => [r.name, r.seq]))
    expect(byName.steps).toBe(m.stepCeil)
    expect(byName.messages).toBe(m.msgCeil)
    expect(byName.summaries).toBe(m.sumCeil)
    // manifest 落盘且可回读
    expect(existsSync(join(dir, '.simple-code/tasks', `${m.owner}.json`))).toBe(true)
    expect(readTaskManifest(dir, m.owner).name).toBe('试跑')
  })

  it('fork 后对话的下一个 id 自然落在任务段之上——不撞段', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const live: Message[] = []
    runTurn(main, live, 'u1', 'r1')
    const m = forkTask(dir, 'x')
    // fork 后对话继续跑：turn id > turnCeil，msg/step 同理
    const t2 = runTurn(main, live, 'u2', 'r2')
    expect(t2).toBeGreaterThan(m.turnCeil)
    const msgs = query<{ minId: number }>(
      dir,
      'SELECT MIN(id) AS minId FROM messages WHERE turn_id = ?',
      t2,
    )
    expect(msgs[0]!.minId).toBeGreaterThan(m.msgCeil)
    main.close()
  })
})

describe('任务会话域（TaskScope）', () => {
  const setup = async (): Promise<{ dir: string; m: TaskManifest; mainLive: Message[] }> => {
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, 'u1', 'r1')
    main.close()
    const m = forkTask(dir, 't')
    return { dir, m, mainLive }
  }

  it('任务轮落在段内、owner 归任务；对话读不见它', async () => {
    const { dir, m } = await setup()
    const task = openStore(dir, { task: scopeOf(m) })
    // 真实链路：session 的 ctx.messages 从 load() 起步（含继承的对话 live），
    // save 全量对齐——不从 load() 起步会把继承消息错嫁给旧轮
    const live: Message[] = [...task.load()]
    const t = runTurn(task, live, '任务问题', '任务回答')
    expect(t).toBe(m.forkTurn + 1)
    expect(t).toBeLessThan(m.turnCeil)
    const owner = query<{ owner: string }>(dir, 'SELECT owner FROM turns WHERE id = ?', t)
    expect(owner[0]!.owner).toBe(m.owner)
    // 对话视角：可见的轮（owner IS NULL 且非 reserved）仍是 fork 前的轮
    const mainTurns = query<{ m: number }>(
      dir,
      "SELECT MAX(id) AS m FROM turns WHERE owner IS NULL AND state != 'reserved'",
    )
    expect(mainTurns[0]!.m).toBe(m.forkTurn)
    // 任务视角：继承的对话 live + 自己的（顺序 = 先继承后自己）
    const back = openStore(dir, { task: scopeOf(m) })
    const mine = back.load()
    expect(mine.length).toBe(4)
    expect((mine[0]!.parts[0] as { type: string; text: string }).text).toBe('u1')
    expect((mine[2]!.parts[0] as { type: string; text: string }).text).toBe('任务问题')
    task.close()
    back.close()
  })

  it('任务的摘要 id 落在 sum 段内', async () => {
    const { dir, m } = await setup()
    const task = openStore(dir, { task: scopeOf(m) })
    const live: Message[] = [...task.load()]
    const t = runTurn(task, live, 'q', 'a')
    const steps = query<{ id: number }>(dir, 'SELECT id FROM steps WHERE turn_id = ?', t)
    const su = task.addSummary({
      level: 0,
      coversFrom: steps[0]!.id,
      coversTo: steps[steps.length - 1]!.id,
      name: 'L0',
      text: '摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: '# 摘要\n\n摘要',
      archivePath: 'summaries/x.md',
    })
    expect(su).toBeGreaterThan(m.sumFloor)
    expect(su).toBeLessThanOrEqual(m.sumCeil)
    task.close()
  })
})

describe('写域隔离', () => {
  it('连开两个任务（中间主任务没说话）：B 的号段不与 A 重叠，两边并行写不撞号', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    runTurn(main, [], 'u1', 'r1')
    main.close()
    const a = forkTask(dir, 'A')
    // A 跑一轮：A 段内写入 turn/step/message（kick 压缩还会写私有摘要）
    const ta = openStore(dir, { task: scopeOf(a) })
    runTurn(ta, [...ta.load()], 'A 问', 'A 答')
    // 主任务没说话，紧接着开 B（任务条上限 3，连开是常见操作）
    const b = forkTask(dir, 'B')
    for (const [floor, ceil] of [
      ['stepFloor', 'stepCeil'],
      ['msgFloor', 'msgCeil'],
      ['sumFloor', 'sumCeil'],
    ] as const) {
      // B 的段必须整体在 A 的段之上
      expect(b[floor], `${floor} 落进了 A 的段`).toBeGreaterThanOrEqual(a[ceil])
    }
    // 两边接着写：不撞主键
    const tb = openStore(dir, { task: scopeOf(b) })
    runTurn(tb, [...tb.load()], 'B 问', 'B 答')
    runTurn(ta, [...ta.load()], 'A 再问', 'A 再答')
    ta.close()
    tb.close()
  })

  it('任务的 save 不删不重插对话的 live 行；对话重存后任务视图顺序仍对', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, 'u1', 'r1')
    main.close()
    const convRowsBefore = query<{ id: number; turn_id: number }>(
      dir,
      "SELECT id, turn_id FROM messages WHERE state = 'live'",
    )
    const m = forkTask(dir, 't')

    // 任务跑一轮（live 从 load() 起步——真实链路）
    const task = openStore(dir, { task: scopeOf(m) })
    const live: Message[] = [...task.load()]
    runTurn(task, live, 'q', 'a')
    task.close()

    // 对话的 live 行原封不动（没被删、没有被搬进任务段重插）
    const convRowsAfter = query<{ id: number; turn_id: number }>(
      dir,
      "SELECT id, turn_id FROM messages WHERE state = 'live' AND owner IS NULL AND turn_id IN (SELECT id FROM turns WHERE owner IS NULL)",
    )
    expect(convRowsAfter).toEqual(convRowsBefore)

    // 对话在任务存活期间继续跑：它重存 live（DELETE+INSERT，id 变大）
    const main2 = openStore(dir)
    runTurn(main2, mainLive, 'u2', 'r2')
    main2.close()
    const taskIds = query<{ id: number }>(
      dir,
      "SELECT id FROM messages WHERE turn_id IN (SELECT id FROM turns WHERE owner = ?)",
      m.owner,
    ).map((r) => r.id)
    expect(taskIds.every((id) => id > m.msgFloor && id <= m.msgCeil)).toBe(true)
    // 任务重开：视图 = 继承（u1,r1）+ 自己（q,a），顺序先继承后自己
    const back = openStore(dir, { task: scopeOf(m) })
    const texts = back
      .load()
      .map((msg) => (msg.parts[0] as { type: string; text: string }).text)
    expect(texts).toEqual(['u1', 'r1', 'q', 'a'])
    back.close()
  })

  it('剪掉继承段之后库的 live 仍与内存逐条对齐（2026-10-08 PrefixBroken 实锤）', async () => {
    // 某项目任务：合并收编继承段 → 内存剪掉那些消息，库里的复制
    // 行却按「继承的不删」留着 live → liveTurnModels 比内存长、下标错位，
    // 刚由 opus 签的 reasoning 被认成更早 glm 轮的、当别家签名剥掉，改写前缀
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, 'u1', 'r1')
    runTurn(main, mainLive, 'u2', 'r2')
    main.close()
    const m = forkTask(dir, 't')
    const task = openStore(dir, { task: scopeOf(m) })
    const live: Message[] = [...task.load()]
    const t = task.beginTurn({ model: 'p/opus', effort: null })
    live.push(userSays('q'), assistantSays('a'))
    task.save(live)
    task.finishTurn(t, 1, 'done')
    // applyPendingMerges：继承的第一轮被合并收编，内存剪掉并通知 store
    live.splice(0, 2)
    task.pruneMessages([0, 1])
    expect(task.liveTurnModels()).toEqual(['p/m', 'p/m', 'p/opus', 'p/opus'])
    expect(task.load().length).toBe(live.length)
    task.close()
  })
})

describe('私有摘要（任务压缩继承段）', () => {
  /** 对话跑两轮 + fork + 任务跑一轮，返回可复用的现场 */
  const setup = async (): Promise<{ dir: string; m: TaskManifest }> => {
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, '对话问题一', '对话回答一')
    runTurn(main, mainLive, '对话问题二', '对话回答二')
    main.close()
    const m = forkTask(dir, 't')
    const task = openStore(dir, { task: scopeOf(m) })
    const live: Message[] = [...task.load()]
    runTurn(task, live, '任务问题', '任务回答')
    task.close()
    return { dir, m }
  }

  /** 任务视角给继承段写一条 ready 的私有 L0 并进场（模拟 idle 压缩走完） */
  const compressInherited = (dir: string, m: TaskManifest, opts: { activate?: boolean } = {}): number => {
    const task = openStore(dir, { task: scopeOf(m) })
    // 继承段的 step：对话的 turn 1（最老优先，摘的就是它）
    const convSteps = query<{ id: number }>(
      dir,
      `SELECT id FROM steps WHERE turn_id IN (SELECT id FROM turns WHERE owner IS NULL AND state != 'reserved') ORDER BY id`,
    )
    const id = task.addSummary({
      level: 0,
      coversFrom: convSteps[0]!.id,
      coversTo: convSteps[convSteps.length - 1]!.id,
      name: '',
      text: '继承段摘要：对话在测试里跑了两轮',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    // 进场：私有摘要允许顶继承段（段头没卸也行——那是任务的顶替目标）。
    // opts.activate=false 模拟「刚生成、还没过进场闸」的中间态
    if (opts.activate !== false) expect(task.activateSummary(convSteps[0]!.id)).toBe(true)
    task.close()
    return id
  }

  it('私有摘要：任务视角顶替继承段原文，对话视角照发原文', async () => {
    const { dir, m } = await setup()
    compressInherited(dir, m)

    // 任务视角组装：继承段两轮原文（4 条）被一行私有摘要顶替
    const task = openStore(dir, { task: scopeOf(m) })
    const out = assembleContext(task.liveWithTurns(), task.summaries())
    // 摘要以 renderSummary 的包裹形态出现（标签 + 摘要行），判据用包含
    const joined = out
      .map((msg) => (msg.parts[0] as { type: string; text: string }).text)
      .join('\n')
    expect(joined).toContain('继承段摘要：对话在测试里跑了两轮')
    const texts = joined.split('\n')
    expect(texts).not.toContain('对话回答一')
    // 自己的轮不受影响
    expect(texts).toContain('任务回答')
    // 行的 state 没动——继承段的 4 条还是 live（对话的账本原样）
    const liveCount = query<{ c: number }>(
      dir,
      "SELECT COUNT(*) AS c FROM messages WHERE state = 'live' AND owner IS NULL AND turn_id IN (SELECT id FROM turns WHERE owner IS NULL)",
    )[0]!.c
    expect(liveCount).toBe(4)
    task.close()

    // 对话视角：看不见私有摘要，原文照发
    const main = openStore(dir)
    const mainOut = assembleContext(main.liveWithTurns(), main.summaries())
    const mainTexts = mainOut.map((msg) => (msg.parts[0] as { type: string; text: string }).text)
    expect(mainTexts).toContain('对话回答一')
    expect(mainTexts).not.toContain('继承段摘要：对话在测试里跑了两轮')
    main.close()
  })

  it('fork 之后对话产生的摘要任务一律看不见；fork 时已有的摘要任务有自己的一份', async () => {
    // 真机 2026-09-23：对话 fork 后跑了几十轮、摘出 L0/L1 并进场，任务视角
    // 把它们当继承摘要按 covers 排在自己的轮之后，对话一进场任务前缀就变。
    // 上下文隔离之后更严：哪怕摘的是 fork 前的 step，只要是 fork 之后才
    // 产生/进场的，都是主任务自己的压缩动作，任务看不见
    const dir = await workspace()
    const main0 = openStore(dir)
    const live0: Message[] = []
    runTurn(main0, live0, '对话问题一', '对话回答一')
    const first = query<{ id: number }>(dir, `SELECT MIN(id) AS id FROM steps`)[0]!.id
    main0.addSummary({
      level: 0,
      coversFrom: first,
      coversTo: first,
      name: '',
      text: 'fork 时已在场的摘要',
      status: 'ready',
      inContext: true,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    main0.close()
    const m = forkTask(dir, 't')

    const main = openStore(dir)
    const mainLive = [...main.load()]
    runTurn(main, mainLive, 'fork 后对话问', 'fork 后对话答')
    const after = query<{ id: number }>(dir, 'SELECT MAX(id) AS id FROM steps')[0]!.id
    expect(after).toBeGreaterThan(m.stepCeil) // 前提：对话跳段了
    for (const [from, text] of [
      [after, 'fork 后对话的摘要'],
      [first, 'fork 后才补的 fork 前摘要'],
    ] as const) {
      main.addSummary({
        level: 0,
        coversFrom: from,
        coversTo: from,
        name: '',
        text,
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: null,
      })
    }
    main.close()

    const task = openStore(dir, { task: scopeOf(m) })
    const rows = task.summaries()
    task.close()
    expect(rows.map((x) => x.text)).toEqual(['fork 时已在场的摘要'])
    expect(rows[0]!.owner).toBe(m.owner) // 是任务自己的副本，不是主任务那行
  })

  it('对话的 ready 摘要，任务不能替它进场（in_context 是共享列）', async () => {
    const { dir, m } = await setup()
    // 对话视角写一条 ready 的 L0（还没进场）
    const main = openStore(dir)
    const convSteps = query<{ id: number }>(
      dir,
      `SELECT id FROM steps WHERE turn_id IN (SELECT id FROM turns WHERE owner IS NULL AND state != 'reserved') ORDER BY id`,
    )
    main.addSummary({
      level: 0,
      coversFrom: convSteps[0]!.id,
      coversTo: convSteps[convSteps.length - 1]!.id,
      name: '',
      text: '对话自己的摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    main.close()
    // 任务视角进场：candidate 是 owner=me 的行——对话的这条翻不了
    const task = openStore(dir, { task: scopeOf(m) })
    expect(task.activateSummary(convSteps[0]!.id)).toBe(false)
    const row = query<{ in_context: number }>(
      dir,
      `SELECT in_context FROM summaries WHERE text = '对话自己的摘要'`,
    )[0]!
    expect(row.in_context).toBe(0)
    task.close()
  })

  it('finalize：继承段私有摘要删掉，自己段的还俗', async () => {
    const { dir, m } = await setup()
    compressInherited(dir, m)
    // 任务自己段也写一条私有摘要（模拟跑久了摘要化）
    const task = openStore(dir, { task: scopeOf(m) })
    const ownSteps = query<{ id: number }>(
      dir,
      `SELECT id FROM steps WHERE turn_id IN (SELECT id FROM turns WHERE owner = ?) ORDER BY id`,
      m.owner,
    )
    task.addSummary({
      level: 0,
      coversFrom: ownSteps[0]!.id,
      coversTo: ownSteps[ownSteps.length - 1]!.id,
      name: '',
      text: '任务自己的摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    task.close()

    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)
    // 继承段私有摘要：删（脚手架）
    const gone = query<{ c: number }>(
      dir,
      `SELECT COUNT(*) AS c FROM summaries WHERE text = '继承段摘要：对话在测试里跑了两轮'`,
    )[0]!.c
    expect(gone).toBe(0)
    // 自己段摘要：还俗（owner→NULL），对话可见
    const main = openStore(dir)
    const texts = main.summaries().map((s) => s.text)
    expect(texts).toContain('任务自己的摘要')
    main.close()
  })

  it('flip/finalize 回报各步改动行数（task_close 的对账数据，2026-09-30 补观测）', async () => {
    const { dir, m } = await setup()
    compressInherited(dir, m)
    const n = (sql: string, ...p: (string | number)[]): number => query<{ c: number }>(dir, sql, ...p)[0]!.c
    const own = `(SELECT id FROM turns WHERE owner = '${m.owner}')`
    const liveOwn = n(`SELECT COUNT(*) AS c FROM messages WHERE state = 'live' AND turn_id IN ${own}`)
    expect(liveOwn).toBeGreaterThan(0)
    expect(flipTaskLive(dir, m.owner)).toBe(liveOwn)
    // finalize 前按同一判据数一遍，回报必须逐项对上
    const want = {
      sumDeleted: n(`SELECT COUNT(*) AS c FROM summaries WHERE owner = ? AND covers_from <= ?`, m.owner, m.stepFloor),
      sumPromoted: n(`SELECT COUNT(*) AS c FROM summaries WHERE owner = ? AND covers_from > ?`, m.owner, m.stepFloor),
      msgDeleted: n(`SELECT COUNT(*) AS c FROM messages WHERE owner = ? AND turn_id NOT IN ${own}`, m.owner),
      msgPromoted: n(`SELECT COUNT(*) AS c FROM messages WHERE owner = ? AND turn_id IN ${own}`, m.owner),
      turnsPromoted: n(`SELECT COUNT(*) AS c FROM turns WHERE owner = ?`, m.owner),
    }
    expect(want.sumDeleted + want.msgPromoted + want.turnsPromoted).toBeGreaterThan(0)
    expect(finalizeTask(dir, m.owner)).toEqual(want)
  })

  it('合并不越界：对话的 L0 和任务的私有 L0 连续也不合并', async () => {
    const { pickMergeGroup } = await import('../src/loop/summarize.ts')
    const mk = (owner: string | null, coversFrom: number): Parameters<typeof pickMergeGroup>[0][number] =>
      ({
        id: coversFrom,
        owner,
        level: 0,
        name: '',
        coversFrom,
        coversTo: coversFrom,
        text: 'x',
        status: 'ready' as const,
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: null,
      }) as never
    // 三条连续：对话、对话、任务私有——最后两条不能并入对话那条的组
    const group = pickMergeGroup([mk(null, 1), mk('task-a', 2), mk('task-a', 3)], 2)
    expect(group?.members.map((s) => s.owner)).toEqual(['task-a', 'task-a'])
    // 全对话：照常合并（回归）
    const group2 = pickMergeGroup([mk(null, 1), mk(null, 2)], 2)
    expect(group2?.members.every((s) => s.owner === null)).toBe(true)
  })

  it('关闭任务留下的尾巴：原文全卸、摘要不在场 → 主任务下一次压缩就进场（2026-09-24/25 两个任务的孤儿段）', async () => {
    const { activateBeyondStubZone } = await import('../src/loop/summarize.ts')
    const { dir, m } = await setup()
    // 任务跑了一轮，关闭时这一轮还是原文——它的 L0 写好了但没进过场
    const task = openStore(dir, { task: scopeOf(m) })
    const live: Message[] = [...task.load()]
    const t = runTurn(task, live, '尾巴的问题', '尾巴的回答')
    const steps = query<{ id: number }>(dir, 'SELECT id FROM steps WHERE turn_id = ? ORDER BY id', t)
    task.addSummary({
      level: 0,
      coversFrom: steps[0]!.id,
      coversTo: steps[steps.length - 1]!.id,
      name: '',
      text: '任务尾巴的摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    task.close()
    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)

    // 主任务压缩点：存根区给得很宽（装得下全部 live）——旧规则下尾巴段
    // 没有 live 可判，永远不进场；孤儿通道不看存根区
    const main = openStore(dir)
    const mainLive = main.liveWithTurns()
    activateBeyondStubZone({
      live: mainLive,
      floorStart: mainLive.length,
      stubSteps: 1000,
      stubTokens: 1_000_000,
      summaries: () => main.summaries(),
      activateSummary: (stepId) => main.activateSummary(stepId),
    })
    const text = JSON.stringify(assembleContext(main.liveWithTurns(), main.summaries()))
    expect(text).toContain('任务尾巴的摘要')
    main.close()
  })

  it('进场走真实闸：activateBeyondStubZone 的区外含继承段，私有 L0 自动进场', async () => {
    const { activateBeyondStubZone } = await import('../src/loop/summarize.ts')
    const { dir, m } = await setup()
    // 私有 L0 就绪但未进场（kick 压缩刚生成的状态）
    compressInherited(dir, m, { activate: false })

    const task = openStore(dir, { task: scopeOf(m) })
    const liveBefore = task.liveWithTurns()
    // 激活前先量好——summaries() 读的是活库，激活后再取两边就一样了
    const beforeAssembled = assembleContext(liveBefore, task.summaries()).length
    // 压缩点包一层：floorStart 只圈最后一条，存根区两界压到极小——
    // 继承段整段落在区外（它本来就在最老端）
    activateBeyondStubZone({
      live: liveBefore,
      floorStart: liveBefore.length - 1,
      stubSteps: 1,
      stubTokens: 1,
      summaries: () => task.summaries(),
      activateSummary: (stepId) => task.activateSummary(stepId),
    })
    // 进场后：装配里继承段原文被私有摘要顶替
    const liveAfter = task.liveWithTurns()
    const after = assembleContext(liveAfter, task.summaries())
    expect(after.length).toBeLessThan(beforeAssembled)
    const activated = query<{ c: number }>(
      dir,
      `SELECT COUNT(*) AS c FROM summaries WHERE owner = ? AND in_context = 1`,
      m.owner,
    )[0]!.c
    expect(activated).toBe(1)
    task.close()
  })

  it('markCold 不碰继承 step（unloaded 是对话的账本）', async () => {
    const { dir, m } = await setup()
    const task = openStore(dir, { task: scopeOf(m) })
    const allSteps = query<{ id: number; turn_id: number }>(dir, `SELECT id, turn_id FROM steps`)
    // 卸载循环的模拟：把继承 step 和自己的 step 一起交出去
    task.markCold(allSteps.map((s) => s.id))
    task.close()
    const rows = query<{ id: number; unloaded: number }>(dir, `SELECT id, unloaded FROM steps`)
    const byId = new Map(rows.map((r) => [r.id, r.unloaded]))
    for (const s of allSteps) {
      const isOwn = s.turn_id > m.forkTurn && s.turn_id < m.turnCeil
      expect(byId.get(s.id)).toBe(isOwn ? 1 : 0)
    }
  })
})

describe('任务会话的真 session 链路（2026-09-23 真机两连炸）', () => {
  const settings = async (dir: string, memory: Record<string, unknown> = {}): Promise<string> => {
    const { writeFile } = await import('node:fs/promises')
    const globalPath = join(dir, 'settings.json')
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'p',
        model: 'm',
        providers: {
          p: {
            protocol: 'anthropic-messages',
            baseUrl: 'https://example.invalid',
            apiKey: 'k',
            models: { m: { contextWindow: 100_000 } },
          },
        },
        memory: { idleSummarizeDelayMs: 0, ...memory },
      }),
      'utf8',
    )
    return globalPath
  }

  it('对话 fork 后重存（继承行 id 跳到任务段之上）→ 任务重开再存，自己的消息不被继承行顶替', async () => {
    // 真机 2026-09-23 task-uo518x：load() 按 (turn_id, id) 排，归属数组按 id
    // 排。对话每次 save 都 DELETE+INSERT 自己的 live 行，fork 后新 id 落在
    // 任务段之上——任务自己的行 id 反而更小，两种排序错位：任务重开后一存，
    // 最老的几条继承消息被当成自己的写进任务段、自己的真消息被当继承跳过
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, '老问题一', '老回答一')
    runTurn(main, mainLive, '老问题二', '老回答二')
    main.close()
    const m = forkTask(dir, 't')
    const t1 = openStore(dir, { task: scopeOf(m) })
    const tl = [...t1.load()]
    runTurn(t1, tl, '任务问', '任务答')
    t1.close()
    // 对话接着说一句：重存全部 live，继承行的 id 跳到任务段之上
    const main2 = openStore(dir)
    const ml = [...main2.load()]
    runTurn(main2, ml, '对话新问', '对话新答')
    main2.close()

    const t2 = openStore(dir, { task: scopeOf(m) })
    const live = [...t2.load()]
    const texts = (xs: Message[]) => xs.map((x) => (x.parts[0] as { text: string }).text)
    expect(texts(live)).toEqual(['老问题一', '老回答一', '老问题二', '老回答二', '任务问', '任务答'])
    runTurn(t2, live, '任务再问', '任务再答')
    t2.close()

    const t3 = openStore(dir, { task: scopeOf(m) })
    expect(texts(t3.load())).toEqual([
      '老问题一', '老回答一', '老问题二', '老回答二', '任务问', '任务答', '任务再问', '任务再答',
    ])
    t3.close()
    const own = query<{ c: string }>(
      dir,
      `SELECT content_json AS c FROM messages WHERE turn_id IN (SELECT id FROM turns WHERE owner = ?) ORDER BY id`,
      m.owner,
    ).map((r) => (JSON.parse(r.c) as Message).parts[0] as { text: string })
    expect(own.map((p) => p.text)).toEqual(['任务问', '任务答', '任务再问', '任务再答'])
  })

  it('fork 后对话接着说话（跳到段上方）→ 任务照常能发消息，不误报「段已满」', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, '对话问题', '对话回答')
    main.close()
    const m = forkTask(dir, 't')
    // 对话在 fork 后又说了一句：它的 turn 落在 turnCeil 之上
    const main2 = openStore(dir)
    const live2: Message[] = [...main2.load()]
    const after = runTurn(main2, live2, 'fork 后对话又问', '又答')
    main2.close()
    expect(after).toBeGreaterThan(m.turnCeil)

    const globalPath = await settings(dir)
    const session = await getSession(dir, {
      task: scopeOf(m),
      skipLock: true,
      globalPath,
      env: {},
      stream: () =>
        (async function* () {
          yield { type: 'text_start' } as never
          yield { type: 'text_delta', text: '任务答' } as never
          yield { type: 'text_end' } as never
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
          } as never
        })(),
    } as never)
    const events: { type: string; message?: string }[] = []
    for await (const ev of session.send('任务的第一句')) events.push(ev as never)
    await session.close()
    expect(events.filter((e) => e.type === 'error').map((e) => e.message)).toEqual([])
    // 任务轮落在自己段内
    const own = query<{ id: number }>(dir, 'SELECT id FROM turns WHERE owner = ?', m.owner)
    expect(own).toHaveLength(1)
    expect(own[0]!.id).toBeGreaterThan(m.forkTurn)
    expect(own[0]!.id).toBeLessThan(m.turnCeil)
  })

  it('继承段滞留超线、却无摘可摘也无摘要可顶 → summarizeIdle 收敛，不空转饿死事件循环', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, '对话问题一'.repeat(200), '对话回答一'.repeat(200))
    runTurn(main, mainLive, '对话问题二'.repeat(200), '对话回答二'.repeat(200))
    // 对话的已卸段 + 一条它自己的 ready 摘要（未进场）覆盖全部：任务视角
    // 下这段滞留、没有可摘的段（已被覆盖）、那条摘要任务又没权进场——
    // 真机上就是这个组合让 drain 与 kick 无限互踢
    const steps = query<{ id: number }>(dir, 'SELECT id FROM steps ORDER BY id').map((r) => r.id)
    main.markCold(steps)
    main.addSummary({
      level: 0,
      coversFrom: steps[0]!,
      coversTo: steps[steps.length - 1]!,
      name: '',
      text: '对话自己的摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    main.close()
    const m = forkTask(dir, 't')

    const globalPath = await settings(dir, { stubTokens: 1 })
    const session = await getSession(dir, {
      task: scopeOf(m),
      skipLock: true,
      globalPath,
      env: {},
    } as never)
    // 活锁是纯微任务的：summarizeIdle 本身会 resolve，空转的是 finally 里
    // 踢出去的下一个 kick——之后任何宏任务（计时器、I/O、vitest 超时）都
    // 永远轮不到。检测靠 SQL 调用量（每圈都查库）：微任务 watchdog 与被测
    // 代码交替执行，量爆了就判活锁并关 store 打断（关了之后 drain 里的调用
    // 抛错、被既有 catch 收掉）。watchdog 自己也是微任务链，按墙钟限时，
    // 不然正常情况也会被它饿死
    const proto = DatabaseSync.prototype as unknown as { prepare: (...a: unknown[]) => unknown }
    const realPrepare = proto.prepare
    let queries = 0
    proto.prepare = function (this: unknown, ...a: unknown[]) {
      queries += 1
      return realPrepare.apply(this, a)
    }
    let livelocked = false
    try {
      await session.summarizeIdle()
      const base = queries
      const until = Date.now() + 300
      const watchdog = (): void => {
        if (queries - base > 5_000) {
          livelocked = true
          void session.close()
          return
        }
        if (Date.now() < until) queueMicrotask(watchdog)
      }
      queueMicrotask(watchdog)
      // 能等到这个宏任务 = 事件循环活着
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      proto.prepare = realPrepare
    }
    expect(livelocked).toBe(false)
    await session.close()
  })

  it('合并还俗改写主任务前缀：下一次请求搭压缩车放行，不报 PrefixBrokenError（2026-09-23 真机 13:24:21）', async () => {
    // 真机：点了合并，主任务下一句被前缀守卫拦下（messages 第 44 条起不同
    // 295→302）——任务的经历摘要进了主任务上下文，是合法改写但没有压缩点
    // 放行。定死规则：合法改写只搭压缩的车，合并落「压缩车票」
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir)
    const seen: string[] = []
    const stream = ((request: {
      messages: { parts: { type: string; text?: string }[] }[]
    }) => {
      seen.push(
        request.messages
 .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text ?? '' : p.type)).join(''))
          .join('\n'),
      )
      return (async function* () {
        yield { type: 'text_start' } as never
        yield { type: 'text_delta', text: '答' } as never
        yield { type: 'text_end' } as never
        yield {
          type: 'finish',
          reason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
        } as never
      })()
    }) as never
    const open = (task?: TaskManifest) =>
      getSession(dir, {
        ...(task ? { task: scopeOf(task) } : {}),
        skipLock: true,
        globalPath,
        env: {},
        stream,
      } as never)

    // 主任务先跑一轮：前缀基线落下来
    const main1 = await open()
    for await (const ev of main1.send('主问一')) void ev
    await main1.close()

    // 任务跑一轮，再挂一条已进场的私有摘要（真实链路：任务的压缩点进场）
    const m = forkTask(dir, 't')
    const t1 = await open(m)
    for await (const ev of t1.send('任务第一句')) void ev
    await t1.close()
    const t2 = openStore(dir, { task: scopeOf(m) })
    t2.addSummary({
      level: 0,
      coversFrom: m.stepFloor + 1,
      coversTo: m.stepFloor + 1,
      name: 'L0',
      text: '任务经历摘要',
      status: 'ready',
      inContext: true,
      supersededBy: null,
      head: '任务第一句',
      archivePath: `summaries/${m.stepFloor + 1}.md`,
    })
    t2.close()

    // 合并（真实关闭末两步）
    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)

    // 主任务接着说话：任务摘要进了上下文、前缀守卫不响、车票已用掉
    const main2 = await open()
    const events: { type: string; message?: string }[] = []
    for await (const ev of main2.send('合并后主问')) events.push(ev as never)
    await main2.close()
    expect(events.some((e) => e.type === 'error' && (e.message ?? '').includes('前缀'))).toBe(false)
    const last = seen[seen.length - 1] ?? ''
    expect(last).toContain('主问一')
    expect(last).toContain('任务经历摘要')
    expect(last).toContain('合并后主问')
    const main3 = openStore(dir)
    expect(main3.consumeMergePending()).toBe(false)
    main3.close()
  })
})

describe('关闭', () => {
  it('flip → 还债 → 还俗后对话自然看见任务段', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, 'u1', 'r1')
    main.close()
    const m = forkTask(dir, 't')
    const task = openStore(dir, { task: scopeOf(m) })
    const live: Message[] = [...task.load()]
    runTurn(task, live, 'q1', 'a1')
    runTurn(task, live, 'q2', 'a2')
    task.close()

    // 债存在：段内 step 有消息、无摘要覆盖（债 = nextSegmentToSummarize
    // 挑得出段——与 session.summaryDebt 同一判据，2026-09-23 合一）
    const probe = openStore(dir, { task: scopeOf(m) })
    let debt = probe.nextSegmentToSummarize(10_000, null) !== null
    probe.close()
    expect(debt).toBe(true)
    // 还债：任务视角把段摘掉（直接用任务的 nextSegment 路径最小化）
    flipTaskLive(dir, m.owner)
    const t2 = openStore(dir, { task: scopeOf(m) })
    // 真实关闭流程循环摘到没有候选（这里可能不止一段）
    for (let i = 0; i < 10; i++) {
      const seg = t2.nextSegmentToSummarize(10_000, null)
      if (seg === null) break
      t2.addSummary({
        level: 0,
        coversFrom: seg.from,
        coversTo: seg.to,
        name: 'L0-task',
        text: '任务经历',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: '# 任务经历\n\n任务经历',
        archivePath: `summaries/${seg.from}.md`,
      })
    }
    debt = t2.nextSegmentToSummarize(10_000, null) !== null
    expect(debt).toBe(false)
    t2.close()

    // 还俗：owner 全 NULL、manifest 删除、对话视角看见任务轮
    finalizeTask(dir, m.owner)
    const owners = query<{ owner: string | null }>(
      dir,
      'SELECT DISTINCT owner FROM turns WHERE owner IS NOT NULL',
    )
    expect(owners).toEqual([])
    expect(existsSync(join(dir, '.simple-code/tasks', `${m.owner}.json`))).toBe(false)
    const mainTurns2 = query<{ m: number }>(
      dir,
      "SELECT MAX(id) AS m FROM turns WHERE owner IS NULL AND state != 'reserved'",
    )
    expect(mainTurns2[0]!.m).toBeGreaterThan(m.forkTurn)
  })
})

describe('恢复扫描', () => {
  it('listTaskManifests = manifest 即真相', async () => {
    const dir = await workspace()
    expect(listTaskManifests(dir)).toEqual([])
    const main = openStore(dir)
    main.close()
    const m = forkTask(dir, 'a')
    const m2 = forkTask(dir, 'b')
    const names = listTaskManifests(dir).map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['a', 'b']))
    expect(m.owner).not.toBe(m2.owner)
  })
})

describe('上下文隔离（note task-context-isolation）', () => {
  // 任务视角要发给模型的那份（摘要 + live 原文），按渲染文本比
  const taskView = (dir: string, m: TaskManifest): string[] => {
    const s = openStore(dir, { task: scopeOf(m) })
    const out = assembleContext(s.liveWithTurns(), s.summaries()).map((msg) =>
      msg.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join('|'),
    )
    s.close()
    return out
  }

  const setup = async (): Promise<{ dir: string; m: TaskManifest; mainLive: Message[] }> => {
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, '对话问题一', '对话回答一')
    runTurn(main, mainLive, '对话问题二', '对话回答二')
    main.close()
    const m = forkTask(dir, 't')
    const task = openStore(dir, { task: scopeOf(m) })
    runTurn(task, [...task.load()], '任务问题', '任务回答')
    task.close()
    return { dir, m, mainLive }
  }

  it('任务开着时主任务压缩（卸载原文 + 摘要进场 + 继续跑），任务的请求一个字不变', async () => {
    const { dir, m, mainLive } = await setup()
    const before = taskView(dir, m)
    expect(before.join('\n')).toContain('对话回答一')

    const main = openStore(dir)
    const first = query<{ id: number }>(dir, 'SELECT MIN(id) AS id FROM steps')[0]!.id
    // 卸载第一轮的两条原文、换进一条已生效摘要——主任务一次完整的压缩
    main.unload([0, 1])
    mainLive.splice(0, 2)
    main.addSummary({
      level: 0,
      coversFrom: first,
      coversTo: first,
      name: '',
      text: '主任务压缩出的摘要',
      status: 'ready',
      inContext: true,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    main.save(mainLive)
    // 再跑一轮：主任务整份重存 live，行号全换
    runTurn(main, mainLive, '对话问题三', '对话回答三')
    const mainOut = assembleContext(main.liveWithTurns(), main.summaries())
      .map((msg) => (msg.parts[0] as { text: string }).text)
      .join('\n')
    main.close()
    // 前提：主任务这边确实压了
    expect(mainOut).not.toContain('对话回答一')
    expect(mainOut).toContain('主任务压缩出的摘要')

    expect(taskView(dir, m)).toEqual(before)
  })

  it('反过来：任务压缩继承段，主任务的行与摘要不受影响', async () => {
    const { dir, m } = await setup()
    const mainBefore = query(dir, "SELECT id, content_json, state FROM messages WHERE owner IS NULL ORDER BY id")
    const task = openStore(dir, { task: scopeOf(m) })
    const first = query<{ id: number }>(dir, 'SELECT MIN(id) AS id FROM steps')[0]!.id
    const id = task.addSummary({
      level: 0,
      coversFrom: first,
      coversTo: first,
      name: '',
      text: '任务压缩出的摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    task.flipSummary(id)
    task.close()
    expect(query(dir, "SELECT id, content_json, state FROM messages WHERE owner IS NULL ORDER BY id")).toEqual(
      mainBefore,
    )
    const main = openStore(dir)
    expect(main.summaries().map((s) => s.text)).not.toContain('任务压缩出的摘要')
    main.close()
  })

  it('主任务算好但未生效的合并（等压缩点）不会被任务的压缩点顺手生效', async () => {
    // 2026-09-23 真机（35732d3 之前的代码）：主任务 idle 时合出 L1（66889/
    // 66890，等自己下个压缩点生效），任务的 stale 压缩点 applyMerges 看得见
    // 主任务的行，替它把 L1 翻进场、L0 翻出场——主任务下一次请求前缀第 34
    // 条起变了（prefix-breaks/2026-09-23T12-28-49-136Z.json）
    const dir = await workspace()
    const main0 = openStore(dir)
    const live0: Message[] = []
    runTurn(main0, live0, '对话问题一', '对话回答一')
    runTurn(main0, live0, '对话问题二', '对话回答二')
    const steps = query<{ id: number }>(dir, 'SELECT id FROM steps ORDER BY id').map((r) => r.id)
    const l0 = steps.map((sid) =>
      main0.addSummary({
        level: 0,
        coversFrom: sid,
        coversTo: sid,
        name: '',
        text: `L0-${sid}`,
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: null,
      }),
    )
    main0.close()
    const m = forkTask(dir, 't')
    // fork 之后主任务合出 L1，未生效
    const main = openStore(dir)
    main.recordMerge(
      {
        level: 1,
        coversFrom: steps[0]!,
        coversTo: steps[steps.length - 1]!,
        name: '',
        text: '主任务的 L1',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: null,
        archivePath: null,
      },
      l0,
    )
    main.close()
    const snapshot = (): unknown =>
      query(dir, 'SELECT id, in_context, superseded_by FROM summaries WHERE owner IS NULL ORDER BY id')
    const before = snapshot()

    const task = openStore(dir, { task: scopeOf(m) })
    task.applyMerges()
    task.close()
    expect(snapshot()).toEqual(before)
  })

  it('按 step 读原文（摘要输入）不读成双份——复制行被排除', async () => {
    const { dir, m } = await setup()
    const first = query<{ id: number }>(dir, 'SELECT MIN(id) AS id FROM steps')[0]!.id
    const copies = query<{ c: number }>(dir, 'SELECT COUNT(*) AS c FROM messages WHERE step_id = ?', first)[0]!.c
    expect(copies).toBe(2) // 前提：库里这个 step 有原行 + 副本
    const task = openStore(dir, { task: scopeOf(m) })
    const msgs = task.segmentMessages({ from: first, to: first, turn: 0 })
    task.close()
    expect(msgs).toHaveLength(1)
  })

  it('隔离之前开的老任务：开库时补一次复制，视图与之前一致', async () => {
    const { dir, m } = await setup()
    const before = taskView(dir, m)
    // 退回老库形态：删副本与标记（老任务从没复制过）
    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
    db.prepare(
      'DELETE FROM messages WHERE owner = ? AND turn_id NOT IN (SELECT id FROM turns WHERE owner = ?)',
    ).run(m.owner, m.owner)
    db.prepare('DELETE FROM migrations WHERE name = ?').run(`task-context-copy:${m.owner}`)
    db.close()
    expect(taskView(dir, m)).toEqual(before)
    const marks = query(dir, 'SELECT name FROM migrations WHERE name = ?', `task-context-copy:${m.owner}`)
    expect(marks).toHaveLength(1)
  })

  it('关闭任务：副本删掉，任务自己的行还俗，库里不留 owner', async () => {
    const { dir, m } = await setup()
    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)
    expect(query(dir, 'SELECT id FROM messages WHERE owner IS NOT NULL')).toEqual([])
    expect(query(dir, 'SELECT id FROM summaries WHERE owner IS NOT NULL')).toEqual([])
    expect(query(dir, "SELECT name FROM migrations WHERE name LIKE 'task-context-copy:%'")).toEqual([])
    // 同一句对话在库里只剩一份
    const dup = query<{ c: number }>(dir, "SELECT COUNT(*) AS c FROM messages WHERE content_json LIKE '%对话回答一%'")
    expect(dup[0]!.c).toBe(1)
  })

  it('合并落「压缩车票」：主任务一次取走，任务视角不吃（2026-09-23 真机 13:24:21）', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const mainLive: Message[] = []
    runTurn(main, mainLive, 'u1', 'r1')
    main.close()
    const m = forkTask(dir, 't')
    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)

    expect(
      query(dir, "SELECT 1 FROM migrations WHERE name = 'merge-rewrite-pending'"),
    ).toHaveLength(1)
    // 任务视角取不走——吃了就是把主任务的压缩车票撕了
    const m2 = forkTask(dir, 't2')
    const t = openStore(dir, { task: scopeOf(m2) })
    expect(t.consumeMergePending()).toBe(false)
    t.close()
    expect(
      query(dir, "SELECT 1 FROM migrations WHERE name = 'merge-rewrite-pending'"),
    ).toHaveLength(1)
    // 主任务一次取走、之后没有
    const main2 = openStore(dir)
    expect(main2.consumeMergePending()).toBe(true)
    expect(main2.consumeMergePending()).toBe(false)
    main2.close()
  })
})

describe('手动压缩（compactNow，2026-10-17）：主任务与任务各压各的', () => {
  const settingsAt = async (dir: string): Promise<string> => {
    const { writeFile } = await import('node:fs/promises')
    const globalPath = join(dir, 'settings.json')
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'p',
        model: 'm',
        providers: {
          p: {
            protocol: 'anthropic-messages',
            baseUrl: 'https://example.invalid',
            apiKey: 'k',
            // 大窗口：自动车一趟不开，视图的变化只可能来自按钮
            models: { m: { contextWindow: 200_000 } },
          },
        },
        memory: { idleSummarizeDelayMs: 0, unloadTargetRatio: 0.001, clipThresholdChars: 0, keepHeadChars: 40 },
      }),
      'utf8',
    )
    return globalPath
  }
  const usage = { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 }
  // 每次 send = 调一次工具（大段输出，卸得动）+ 答一句
  const open = async (dir: string, globalPath: string, m?: TaskManifest) => {
    const { getSession } = await import('../src/session/session.ts')
    let call = 0
    return getSession(dir, {
      ...(m ? { task: scopeOf(m) } : {}),
      skipLock: true,
      globalPath,
      env: {},
      tools: [
        {
          name: 'echo',
          definition: { name: 'echo', description: 'd', parameters: { type: 'object' } },
          execute: async () => ({ output: '工具的大段输出。'.repeat(200), exitCode: 0, isError: false }),
        },
      ],
      stream: () => {
        call++
        const id = `c${call}`
        const events =
          call % 2 === 1
            ? [
                { type: 'tool_input_start', id, name: 'echo' },
                { type: 'tool_input_delta', id, partial: '{}' },
                { type: 'tool_input_end', id, name: 'echo', input: {} },
                { type: 'finish', reason: 'tool-calls', usage },
              ]
            : [{ type: 'text_start' }, { type: 'text_delta', text: '好了' }, { type: 'text_end' }, { type: 'finish', reason: 'stop', usage }]
        return (async function* () {
          for (const ev of events) yield ev
        })()
      },
    } as never)
  }
  // 发给模型的那份，逐条全量比（存根改的是工具结果，只比 text 看不出来）
  const view = (dir: string, m?: TaskManifest): string[] => {
    const s = m ? openStore(dir, { task: scopeOf(m) }) : openStore(dir)
    const out = assembleContext(s.liveWithTurns(), s.summaries()).map((msg) => JSON.stringify(msg))
    s.close()
    return out
  }
  const send = async (s: { send(text: string): AsyncIterable<unknown> }, text: string): Promise<string[]> => {
    const errors: string[] = []
    for await (const ev of s.send(text) as AsyncIterable<{ type: string; message?: string }>)
      if (ev.type === 'error') errors.push(ev.message ?? '')
    return errors
  }

  it('任务压缩不动主任务的视图、主任务压缩不动任务的视图；放行票各归各的', async () => {
    const dir = await workspace()
    const globalPath = await settingsAt(dir)
    const main = await open(dir, globalPath)
    for (let i = 1; i <= 3; i++) expect(await send(main, `对话问题${i}`)).toEqual([])
    await main.close()
    const m = forkTask(dir, 't')

    const task = await open(dir, globalPath, m)
    for (let i = 1; i <= 3; i++) expect(await send(task, `任务问题${i}`)).toEqual([])
    const mainBefore = view(dir)
    const r = await task.compactNow()
    expect(r.ok && r.unloaded).toBeGreaterThan(0) // 前提：任务这边确实压了
    expect(view(dir)).toEqual(mainBefore)
    const tickets = () =>
      query<{ name: string }>(dir, "SELECT name FROM migrations WHERE name LIKE 'prefix-rewrite-allowed%'").map((x) => x.name)
    expect(tickets()).toEqual([`prefix-rewrite-allowed:${m.owner}`])
    expect(await send(task, '任务压完再问')).toEqual([])
    expect(tickets()).toEqual([])
    await task.close()

    const taskBefore = view(dir, m)
    const main2 = await open(dir, globalPath)
    const r2 = await main2.compactNow()
    expect(r2.ok && r2.unloaded).toBeGreaterThan(0)
    expect(view(dir)).not.toEqual(mainBefore) // 前提：主任务这边确实压了
    expect(view(dir, m)).toEqual(taskBefore)
    expect(tickets()).toEqual(['prefix-rewrite-allowed'])
    expect(await send(main2, '对话压完再问')).toEqual([])
    await main2.close()
  })
})
