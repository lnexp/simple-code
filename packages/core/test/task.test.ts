/**
 * 任务机制（task-trunk，docs/proposals/task-trunk.md「验证计划」）。锁定行为：
 *
 * - 号段：主任务与任务各在自己的段里取 step 号；只在轮开始切段
 * - 合回：full 且段内 step 全被摘要覆盖才合回；关闭即合回
 * - 拉摘要：只拉已合回、别人的、号比自己当前段低的；只在压缩点拉（前缀不变式）
 * - 跨缝：gapHasContent 按「不是自己」判；合回拉进来后能合
 * - 主干：段合回后拷入，超配额合并且立即生效；开任务复制主干在场行，不调模型
 * - 迁移：老库登记段，老任务的段与「已拉」照旧
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import type { Summary } from '../src/loop/assemble.ts'
import { pickMergeGroup } from '../src/loop/summarize.ts'
import { SEGMENT_FULL_STEPS, SEGMENT_WIDTH, TRUNK } from '../src/session/segments.ts'
import { MEMORY_RELATIVE, openStore, type Store } from '../src/session/store.ts'
import {
  createTask,
  finalizeTask,
  flipTaskLive,
  listTaskManifests,
  postTaskResult,
  readTaskManifest,
  scopeOf,
  type TaskManifest,
  taskResultText,
} from '../src/session/task.ts'

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

/** 一轮两个 step（user 一个、assistant 一个——save 按消息归属切 step） */
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

type Seg = { id: number; owner: string; floor: number; ceil: number; state: string; closed: number }
const segs = (dir: string): Seg[] =>
  query<Seg>(
    dir,
    `SELECT id, owner, step_floor AS floor, step_ceil AS ceil, state, closed FROM segments ORDER BY id`,
  )

/** 某会话写过的 step（有消息的），升序 */
const stepsOf = (dir: string, owner: string | null): number[] =>
  query<{ id: number }>(
    dir,
    `SELECT DISTINCT step_id AS id FROM messages WHERE owner IS ? ORDER BY step_id`,
    owner,
  ).map((r) => r.id)

/** 每个有消息的 step 一条 ready L0（真实链路是后台摘要器写的） */
function summarizeAll(store: Store, steps: number[], label: string, inContext = true): void {
  for (const s of steps)
    store.addSummary({
      level: 0,
      coversFrom: s,
      coversTo: s,
      name: `${label}${s}`,
      text: `${label}摘要${s}`,
      status: 'ready',
      inContext,
      supersededBy: null,
      head: `${label}开头${s}`,
      archivePath: `summaries/${s}.md`,
    })
}

/** 当前段写满：一轮里空跑够数的 step（真实路径 beginStep），下一轮开始就切段 */
function fillSegment(store: Store): void {
  store.beginTurn({ model: 'p/m', effort: null })
  for (let i = 0; i < SEGMENT_FULL_STEPS; i++) store.beginStep()
}

const texts = (rows: { text: string }[]): string[] => rows.map((r) => r.text)

describe('号段（规则 1–3）', () => {
  it('主任务与任务交错写，各自的 step 号在自己段里成块连续', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const ml: Message[] = []
    runTurn(main, ml, '主一', '答一')
    const m = createTask(dir, 'A')
    const task = openStore(dir, { task: scopeOf(m) })
    const tl: Message[] = []
    runTurn(task, tl, '任务一', '任答一')
    runTurn(main, ml, '主二', '答二')
    runTurn(task, tl, '任务二', '任答二')
    main.close()
    task.close()
    const [mainSeg, taskSeg] = segs(dir)
    expect(mainSeg?.owner).toBe('')
    expect(taskSeg?.owner).toBe(m.owner)
    const ms = stepsOf(dir, null)
    const ts = stepsOf(dir, m.owner)
    const run = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)
    expect(ms).toEqual(run(ms[0] ?? 0, 4)) // 交错写也连续
    expect(ts).toEqual(run((taskSeg?.floor ?? 0) + 1, 4))
    for (const s of ms) expect(s > (mainSeg?.floor ?? 0) && s <= (mainSeg?.ceil ?? 0)).toBe(true)
    expect(taskSeg?.floor).toBeGreaterThanOrEqual(mainSeg?.ceil ?? 0) // 新段落在一切已占号之上
  })

  it('只在轮开始切段：一轮写过阈值也不切（step 全在原段），下一轮开始才切', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    fillSegment(main)
    main.beginStep() // 同一轮里第 1001 个 step：仍在原段
    const [first] = segs(dir)
    expect(segs(dir)).toHaveLength(1)
    const inFirst = query<{ n: number }>(
      dir,
      `SELECT COUNT(*) AS n FROM steps WHERE id > ? AND id <= ?`,
      first?.floor ?? 0,
      first?.ceil ?? 0,
    )[0]?.n
    expect(inFirst).toBe(SEGMENT_FULL_STEPS + 1)
    const ml: Message[] = []
    runTurn(main, ml, '下一轮', '答')
    main.close()
    const after = segs(dir)
    expect(after.map((s) => s.state)).toEqual(['full', 'open'])
    expect(stepsOf(dir, null)[0]).toBeGreaterThan(after[1]?.floor ?? 0)
  })
})

describe('合回（规则 4）', () => {
  it('full 且全被摘要覆盖才合回；少一条覆盖不合（对照）；合回后主干拷入', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const ml: Message[] = []
    runTurn(main, ml, '问一', '答一')
    runTurn(main, ml, '问二', '答二')
    const steps = stepsOf(dir, null)
    fillSegment(main) // 写满（空 step 不算要覆盖的内容）
    runTurn(main, ml, '新段的问', '新段的答') // 切段：旧段 full
    expect(segs(dir)[0]?.state).toBe('full')
    summarizeAll(main, steps.slice(0, 1), '主')
    expect(main.mergeSegments()).toBe(0)
    expect(segs(dir)[0]?.state).toBe('full') // 对照：缺一条覆盖
    summarizeAll(main, steps.slice(1), '主')
    expect(main.mergeSegments()).toBe(steps.length)
    expect(segs(dir)[0]?.state).toBe('merged')
    expect(texts(main.trunk().summaries())).toEqual(steps.map((s) => `主摘要${s}`))
    expect(main.mergeSegments()).toBe(0) // 幂等：不重复拷
    // open 段不合回（规则 4 第一条）：新段的内容即便摘了也不进主干
    summarizeAll(main, stepsOf(dir, null).slice(2), '主')
    expect(main.mergeSegments()).toBe(0)
    main.close()
  })

  it('关闭：段即刻合回并标 closed，行的 owner 不变，manifest 删掉', async () => {
    const dir = await workspace()
    const m = createTask(dir, '关闭')
    const t = openStore(dir, { task: scopeOf(m) })
    runTurn(t, [], '任务问', '任务答')
    t.close()
    expect(flipTaskLive(dir, m.owner)).toBe(2)
    const counts = finalizeTask(dir, m.owner)
    expect(counts.segments).toBe(1)
    expect(segs(dir).find((s) => s.owner === m.owner)).toMatchObject({ state: 'merged', closed: 1 })
    expect(query(dir, `SELECT 1 FROM turns WHERE owner = ?`, m.owner)).toHaveLength(1)
    expect(query(dir, `SELECT 1 FROM messages WHERE owner = ?`, m.owner)).toHaveLength(2)
    expect(existsSync(join(dir, '.simple-code', 'tasks', `${m.owner}.json`))).toBe(false)
  })

  it('关闭：删掉它的拉段记录（开场从主干复制的）；主干与在开任务的不动（对照）', async () => {
    const dir = await workspace()
    openStore(dir).close() // 建库
    for (const id of [1, 2]) query(dir, `INSERT INTO segment_pulls VALUES(?, ?, 'x')`, TRUNK, id)
    const m = createTask(dir, '关的')
    const live = createTask(dir, '不关的')
    const pulls = (owner: string): number =>
      query(dir, `SELECT 1 FROM segment_pulls WHERE owner = ?`, owner).length
    expect(pulls(m.owner)).toBe(2)
    const t = openStore(dir, { task: scopeOf(m) })
    runTurn(t, [], '任务问', '任务答')
    t.close()
    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)
    expect(pulls(m.owner)).toBe(0)
    expect(pulls(TRUNK)).toBe(2)
    expect(pulls(live.owner)).toBe(2)
  })

  it('关闭：开场复制的主干摘要、跨着副本合出的行删掉；段内的行留下并解开收编，主干照样收到', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const ml: Message[] = []
    runTurn(main, ml, '老问', '老答')
    summarizeAll(main, stepsOf(dir, null), '老')
    fillSegment(main)
    runTurn(main, ml, '新段的问', '新段的答')
    main.mergeSegments()
    const trunkTexts = texts(main.trunk().summaries())
    expect(trunkTexts).toEqual(['老摘要1', '老摘要2'])
    const m = createTask(dir, '关')
    const t = openStore(dir, { task: scopeOf(m) })
    runTurn(t, [], '任务问', '任务答')
    const own = stepsOf(dir, m.owner)
    summarizeAll(t, own, '任')
    // 任务自己的压缩跨着副本合出一条 L1，收编了段内第一条
    const rows = t.summaries()
    const copy = rows.find((s) => s.text === '老摘要2')
    const first = rows.find((s) => s.text === `任摘要${own[0]}`)
    t.recordMerge(
      {
        level: 1,
        coversFrom: copy?.coversFrom ?? 0,
        coversTo: own[0] ?? 0,
        name: '',
        text: '跨副本的合并',
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: null,
      },
      [copy?.id ?? 0, first?.id ?? 0],
    )
    expect(query(dir, `SELECT 1 FROM summaries WHERE owner = ?`, m.owner)).toHaveLength(5) // 对照：删前都在
    t.close()
    flipTaskLive(dir, m.owner)
    const counts = finalizeTask(dir, m.owner)
    expect(counts.sumDeleted).toBe(3) // 两条副本 + 跨副本的 L1
    expect(
      query(
        dir,
        `SELECT text, superseded_by FROM summaries WHERE owner = ? ORDER BY covers_from`,
        m.owner,
      ),
    ).toEqual(own.map((s) => ({ text: `任摘要${s}`, superseded_by: null })))
    expect(main.mergeSegments()).toBe(own.length) // 段内两条都是链根，主干照收
    expect(texts(main.trunk().summaries())).toEqual([
      ...trunkTexts,
      ...own.map((s) => `任摘要${s}`),
    ])
    main.close()
  })
})

/** 主任务一轮 + 任务 A 一轮并关闭（A 的段 closed 合回），A 的 step 都有 L0 */
async function closedTaskA(
  dir: string,
): Promise<{ main: Store; ml: Message[]; m: TaskManifest; aSteps: number[] }> {
  const main = openStore(dir)
  const ml: Message[] = []
  runTurn(main, ml, '主问一', '主答一')
  const m = createTask(dir, 'A')
  const t = openStore(dir, { task: scopeOf(m) })
  runTurn(t, [], 'A 问', 'A 答')
  const aSteps = stepsOf(dir, m.owner)
  summarizeAll(t, aSteps, 'A')
  t.close()
  flipTaskLive(dir, m.owner)
  finalizeTask(dir, m.owner)
  return { main, ml, m, aSteps }
}

describe('拉摘要（规则 5）', () => {
  it('只拉号比自己当前段低的：A 的段在主任务段之上时不拉（对照），主任务切段后才拉', async () => {
    const dir = await workspace()
    const { main } = await closedTaskA(dir)
    // A 的段开在主任务当前段之上：现在拉，主任务之后的新消息会排到它前面
    expect(main.pullPending()).toBe(false)
    // 关掉的段在上方等着拉 → 主任务下一轮开始就切段（segment_full reason=pull_closed）
    main.beginTurn({ model: 'p/m', effort: null })
    expect(
      segs(dir)
        .filter((s) => s.owner === '')
        .map((s) => s.state),
    ).toEqual(['full', 'open'])
    expect(main.pullPending()).toBe(true)
    expect(main.pullSegments()).toBe(2)
    const pulled = main.summaries().filter((s) => s.text.startsWith('A摘要'))
    expect(pulled).toHaveLength(2)
    expect(pulled.every((s) => s.inContext && s.owner === null)).toBe(true) // 复制成自己的、在场
    expect(main.pullPending()).toBe(false) // 拉过一次就不再拉
    expect(main.pullSegments()).toBe(0)
    main.close()
  })

  it('没合回的段不拉（对照）；别人的 open 段号再低也不拉', async () => {
    const dir = await workspace()
    const m = createTask(dir, 'A')
    const t = openStore(dir, { task: scopeOf(m) })
    runTurn(t, [], 'A 问', 'A 答')
    summarizeAll(t, stepsOf(dir, m.owner), 'A')
    const main = openStore(dir) // 主任务的段开在 A 之上
    runTurn(main, [], '主问', '主答')
    expect(segs(dir).map((s) => s.owner)).toEqual([m.owner, ''])
    expect(main.pullPending()).toBe(false) // A 还 open
    expect(main.mergeSegments()).toBe(0)
    main.close()
    t.close()
  })

  it('拉进来的行在拼装里按段的号排在两段自己的历史之间', async () => {
    const dir = await workspace()
    const { main, ml } = await closedTaskA(dir)
    summarizeAll(main, stepsOf(dir, null), '主')
    const t = main.beginTurn({ model: 'p/m', effort: null })
    ml.push(userSays('主问二'), assistantSays('主答二'))
    main.save(ml)
    main.finishTurn(t, 1, 'done')
    main.pullSegments()
    const order = main
      .summaries()
      .filter((s) => s.inContext)
      .sort((a, b) => a.coversFrom - b.coversFrom)
      .map((s) => s.text.slice(0, 3))
    expect(order).toEqual(['主摘要', '主摘要', 'A摘要', 'A摘要'])
    const last = stepsOf(dir, null).at(-1) ?? 0
    expect(last).toBeGreaterThan(
      main.summaries().find((s) => s.text.startsWith('A'))?.coversTo ?? Infinity,
    )
    main.close()
  })
})

describe('跨缝合并（规则 6）', () => {
  const l0 = (id: number, step: number, owner: string | null = null): Summary => ({
    id,
    level: 0,
    coversFrom: step,
    coversTo: step,
    name: '',
    text: `s${step}`,
    status: 'ready',
    inContext: true,
    supersededBy: null,
    head: null,
    archivePath: null,
    owner,
  })

  it('gapHasContent 按「不是自己」判：主任务看 A 的 step、A 看主任务的 step 都挡', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const ml: Message[] = [] // live 要沿用同一份：save 按下标归属轮与 step
    runTurn(main, ml, '主一', '答')
    const m = createTask(dir, 'A')
    const a = openStore(dir, { task: scopeOf(m) })
    runTurn(a, [], 'A 一', '答')
    a.close()
    fillSegment(main)
    runTurn(main, ml, '主二', '答') // 主任务新段在 A 之上
    const ms = stepsOf(dir, null)
    const m1 = ms[1] // 第一段最后一个
    const m2 = ms[2] // 第二段第一个
    const [a1, a2] = stepsOf(dir, m.owner)
    expect(main.gapHasContent(m1 ?? 0, m2 ?? 0)).toBe(true) // 缝里有 A 的 step
    const last = ms.at(-1) ?? 0
    expect(main.gapHasContent(last, last + 5)).toBe(false) // 死号缝（对照）
    const aView = openStore(dir, { task: scopeOf(m) })
    // A 的视角：缝里只有主任务的 step。原判据 `owner IS NOT NULL` 看不见主任务
    expect(aView.gapHasContent(0, a1 ?? 0)).toBe(true)
    aView.close()
    // pickMergeGroup：两条主任务 L0 夹着 A 的 step → 不合
    const gap = (f: number, t: number) => main.gapHasContent(f, t)
    expect(pickMergeGroup([l0(1, m1 ?? 0), l0(2, m2 ?? 0)], 2, gap)).toBeNull()
    // A 合回、拉进来后缝里是 A 的副本（盖住 A 的整段）→ 三条连成一组
    const copy = { ...l0(3, a1 ?? 0), coversTo: a2 ?? 0 }
    const merged = pickMergeGroup([l0(1, m1 ?? 0), copy, l0(2, m2 ?? 0)], 3, gap)
    expect(merged?.members.map((s) => s.id)).toEqual([1, 3, 2])
    main.close()
  })
})

describe('开任务（规则 7）', () => {
  it('上下文只有主干在场摘要：没有 live、看不到主任务没合回的内容；不调模型（同步完成）', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const ml: Message[] = []
    runTurn(main, ml, '老问', '老答')
    summarizeAll(main, stepsOf(dir, null), '老')
    fillSegment(main)
    runTurn(main, ml, '最近在聊的', '还没合回') // 新段：open，摘了也不合回
    summarizeAll(main, stepsOf(dir, null).slice(2), '近')
    main.mergeSegments()
    // 主干里一条被合并收编、离场的行：不复制（对照）
    const trunk = main.trunk()
    const off = trunk.summaries()[0]
    expect(off).toBeDefined()
    const parent = trunk.recordMerge(
      {
        level: 1,
        coversFrom: off?.coversFrom ?? 0,
        coversTo: off?.coversTo ?? 0,
        name: '',
        text: '待生效的合并',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: null,
        archivePath: null,
      },
      [off?.id ?? 0],
    )
    expect(parent).toBeGreaterThan(0)
    const m = createTask(dir, '新任务') // 同步返回：开任务不经过任何模型调用
    const t = openStore(dir, { task: scopeOf(m) })
    expect(t.load()).toEqual([])
    expect(texts(t.summaries())).toEqual(['老摘要1', '老摘要2'])
    expect(t.summaries().every((s) => s.inContext && s.owner === m.owner)).toBe(true)
    expect(t.pullPending()).toBe(false) // 主干拷过的段记为已拉，不再拉一份
    // 新任务还没响应过：run.ts 靠它认「第一个请求」，有段可拉就拉（对照：主任务答过）
    expect(t.lastRespondedAt()).toBeNull()
    expect(main.lastRespondedAt()).not.toBeNull()
    t.close()
    main.close()
  })

  it('不等主任务静止：主任务一轮写到一半时开任务，两边的号互不干扰', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    const ml: Message[] = []
    const turn = main.beginTurn({ model: 'p/m', effort: null })
    ml.push(userSays('跑到一半'))
    main.save(ml)
    const m = createTask(dir, '中途开的')
    ml.push(assistantSays('接着跑完'))
    main.save(ml)
    main.finishTurn(turn, 1, 'done')
    const t = openStore(dir, { task: scopeOf(m) })
    runTurn(t, [], '任务问', '任务答')
    t.close()
    const ms = stepsOf(dir, null)
    expect(ms).toEqual([1, 2])
    expect(stepsOf(dir, m.owner).every((s) => s > (segs(dir)[0]?.ceil ?? 0))).toBe(true)
    main.close()
  })

  it('登记父任务：parent + callback=pending 写进 manifest；不传就没有（对照）', async () => {
    const dir = await workspace()
    const a = createTask(dir, '派的', { parent: '' })
    const b = createTask(dir, '人开的')
    expect(readTaskManifest(dir, a.owner)).toMatchObject({ parent: '', callback: 'pending' })
    expect(readTaskManifest(dir, b.owner).parent).toBeUndefined()
    // 只输名称开的空任务带标记（规则 13）；不传就没有（对照）
    const c = createTask(dir, '空的', { parent: '', awaitingFirstMessage: true })
    expect(readTaskManifest(dir, c.owner)).toMatchObject({
      awaitingFirstMessage: true,
      callback: 'pending',
    })
    expect(readTaskManifest(dir, a.owner).awaitingFirstMessage).toBeUndefined()
    expect(
      listTaskManifests(dir)
        .map((x) => x.owner)
        .sort(),
    ).toEqual([a.owner, b.owner, c.owner].sort())
  })

  it('owner 撞号就重抽：在开的（manifest）与关了但说过话的（turns）都不复用', async () => {
    const dir = await workspace()
    // 前 6 次抽到 'a'（task-aaaaaa），之后恒抽 then 对应的字母（0.5 → 's'，0.25 → 'j'）
    const drawFirst = (then: number): void => {
      let n = 0
      vi.spyOn(Math, 'random').mockImplementation(() => (n++ < 6 ? 0 : then))
    }
    try {
      drawFirst(0.5)
      const open = createTask(dir, '在开')
      expect(open.owner).toBe('task-aaaaaa')
      drawFirst(0.5)
      expect(createTask(dir, '撞在开的').owner).toBe('task-ssssss')
      // 关掉 task-aaaaaa（说过话）：manifest 没了，turns 还在
      const t = openStore(dir, { task: scopeOf(open) })
      runTurn(t, [], '问', '答')
      t.close()
      flipTaskLive(dir, open.owner)
      finalizeTask(dir, open.owner)
      drawFirst(0.25)
      expect(createTask(dir, '撞关了的').owner).toBe('task-jjjjjj')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('真 session：前缀与主干（规则 5、10）', () => {
  const settings = async (dir: string, memory: Record<string, unknown> = {}): Promise<string> => {
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
  const seen: string[] = []
  const stream = ((request: { messages: { parts: { type: string; text?: string }[] }[] }) => {
    seen.push(
      request.messages
        .map((m) => m.parts.map((p) => (p.type === 'text' ? (p.text ?? '') : p.type)).join(''))
        .join('\n'),
    )
    return (async function* () {
      yield { type: 'text_start' } as never
      yield { type: 'text_delta', text: '答' } as never
      yield { type: 'text_end' } as never
      yield {
        type: 'finish',
        reason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          reasoningTokens: 0,
        },
      } as never
    })()
  }) as never

  it('拉入在历史中段（主任务已在 A 之上的段里说过话）：只在压缩点拉，有段可拉不单独发车，前缀守卫不响', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir)
    seen.length = 0
    const open = (task?: TaskManifest) =>
      getSession(dir, {
        ...(task ? { task: scopeOf(task) } : {}),
        skipLock: true,
        globalPath,
        env: {},
        stream,
      } as never)

    let main = await open()
    for await (const ev of main.send('主问一')) void ev
    // 任务与主任务并行：开、跑、摘，主任务 session 一直开着（不等它静止）
    const m = createTask(dir, 't')
    const t = await open(m)
    for await (const ev of t.send('任务第一句')) void ev
    await t.close()
    const ts = openStore(dir, { task: scopeOf(m) })
    summarizeAll(ts, stepsOf(dir, m.owner), '任务经历')
    ts.close()
    // 主任务段写满 → 下一轮切到 A 之上的新段，在新段里说一句
    await main.close()
    const filler = openStore(dir)
    fillSegment(filler)
    filler.close()
    main = await open()
    for await (const ev of main.send('主问二')) void ev
    // A 关闭：它的段在主任务当前段之下，合回即可拉——插在「主问一」与「主问二」之间
    flipTaskLive(dir, m.owner)
    finalizeTask(dir, m.owner)
    const events: { type: string; message?: string }[] = []
    for await (const ev of main.send('关闭后主问')) events.push(ev as never)
    // 有段可拉不单独触发压缩（2026-10-30 订正）：缓存没过期，这一请求不拉
    expect(seen.at(-1) ?? '').not.toContain('任务经历摘要')
    expect(query(dir, `SELECT 1 FROM segment_pulls WHERE owner = ''`)).toHaveLength(0)
    // 压缩点到了才拉（这里用手动压缩；stale/预算同理）
    expect((await main.compactNow()).ok).toBe(true)
    for await (const ev of main.send('压缩后主问')) events.push(ev as never)
    await main.close()
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    const last = seen.at(-1) ?? ''
    const at = (x: string) => last.indexOf(x)
    expect(at('任务经历摘要')).toBeGreaterThanOrEqual(0)
    expect(at('关闭后主问')).toBeGreaterThan(at('任务经历摘要')) // 中段插入：靠压缩点放行
    expect(at('压缩后主问')).toBeGreaterThan(at('关闭后主问'))
    expect(query(dir, `SELECT 1 FROM segment_pulls WHERE owner = ''`)).toHaveLength(1)
  })

  it('只输名称的空任务（规则 13）：建时不开段；建后别人合回的段，第一个请求就拉进来', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir)
    seen.length = 0
    const b = createTask(dir, 'B', { awaitingFirstMessage: true })
    // 空任务零段：不留「open 却零 step」的段给别人的合并链跨过
    expect(segs(dir).filter((s) => s.owner === b.owner)).toEqual([])
    // B 建好、还没发第一条消息时：A 开、跑、摘、关——A 的段合回
    const a = createTask(dir, 'A')
    const as = openStore(dir, { task: scopeOf(a) })
    runTurn(as, [], 'A 问', 'A 答')
    summarizeAll(as, stepsOf(dir, a.owner), 'A经历')
    as.close()
    finalizeTask(dir, a.owner)
    const t = await getSession(dir, {
      task: scopeOf(b),
      skipLock: true,
      globalPath,
      env: {},
      stream,
    } as never)
    for await (const ev of t.send('B 第一句')) void ev
    await t.close()
    const segA = segs(dir).find((s) => s.owner === a.owner)
    const segB = segs(dir).find((s) => s.owner === b.owner)
    expect(segA?.state).toBe('merged')
    // 第一轮才开段，落在 A 之上；A 在它之下、合回了，第一个请求就拉（firstPull）
    expect(segB?.floor).toBeGreaterThanOrEqual(segA?.ceil ?? Number.POSITIVE_INFINITY)
    expect(seen.at(-1) ?? '').toContain('A经历摘要')
    expect(
      query(
        dir,
        `SELECT 1 FROM segment_pulls WHERE owner = ? AND segment_id = ?`,
        b.owner,
        segA?.id ?? 0,
      ),
    ).toHaveLength(1)
  })

  it('主干：合回的段拷进来，超配额就合并且立即生效；新任务拿到合并后的那条', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir, { mergeFactor: 2, indexRatio: 0.0001 })
    // 合并请求走摘要连接（fetchImpl），回一条带标记的文本
    const mergeFetch = (async () =>
      new Response(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"主干合并：两段任务经历"}}',
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
          '',
        ].join('\n'),
        { status: 200 },
      )) as unknown as typeof fetch
    // A 跑一轮、摘、关：它的段合回，主干还没拷
    const m = createTask(dir, 'A')
    const a = openStore(dir, { task: scopeOf(m) })
    runTurn(a, [], 'A 问', 'A 答')
    summarizeAll(a, stepsOf(dir, m.owner), 'A')
    a.close()
    finalizeTask(dir, m.owner)
    const main = await getSession(dir, {
      skipLock: true,
      globalPath,
      env: {},
      stream,
      fetchImpl: mergeFetch,
    } as never)
    await main.summarizeIdle() // 主任务没有 L0 债 → 顺手维护主干
    // 主干合并不挂在会话的 summarizing 上（不拖任务关闭），等它落地
    for (
      let i = 0;
      i < 50 &&
      query(dir, `SELECT 1 FROM summaries WHERE owner = 'trunk' AND level = 1`).length === 0;
      i++
    )
      await new Promise((r) => setTimeout(r, 10))
    await main.close()
    const store = openStore(dir)
    const inTrunk = store
      .trunk()
      .summaries()
      .filter((s) => s.inContext)
    expect(texts(inTrunk)).toEqual(['主干合并：两段任务经历']) // 合完即生效，不等压缩点
    store.close()
    const n = createTask(dir, '后来的')
    const t = openStore(dir, { task: scopeOf(n) })
    expect(texts(t.summaries())).toEqual(['主干合并：两段任务经历'])
    t.close()
    expect(query(dir, `SELECT 1 FROM summaries WHERE owner = ?`, TRUNK).length).toBe(3) // 两条副本 + 一条合并
  })
})

describe('完成回调（规则 12）', () => {
  const settings = async (dir: string): Promise<string> => {
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
        memory: { idleSummarizeDelayMs: 0 },
      }),
      'utf8',
    )
    return globalPath
  }
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningTokens: 0,
  }
  /** 第一次请求调一次 bash，之后回文字。onRequest(n) 在第 n 次请求时触发（投回调用） */
  const scripted = (seen: string[], onRequest: (n: number) => void) =>
    ((request: { messages: { parts: { type: string; text?: string }[] }[] }) => {
      seen.push(
        request.messages
          .map((m) => m.parts.map((p) => (p.type === 'text' ? (p.text ?? '') : p.type)).join(''))
          .join('\n'),
      )
      onRequest(seen.length)
      const first = seen.length === 1
      return (async function* () {
        if (first) {
          yield { type: 'tool_input_start', id: 'c1', name: 'bash' } as never
          yield {
            type: 'tool_input_end',
            id: 'c1',
            name: 'bash',
            input: { desc: '看', command: 'echo hi' },
          } as never
          yield { type: 'finish', reason: 'tool-calls', usage } as never
          return
        }
        yield { type: 'text_start' } as never
        yield { type: 'text_delta', text: '答完' } as never
        yield { type: 'text_end' } as never
        yield { type: 'finish', reason: 'stop', usage } as never
      })()
    }) as never

  it('登记者在跑：下一个请求前插到末尾（task_result 事件），前缀守卫不响；最后一个请求之后到的不唤醒、轮后取', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir)
    const seen: string[] = []
    const stream = scripted(seen, (n) => {
      if (n === 1) postTaskResult(dir, '', taskResultText('调研', '完成', '甲结果'))
      if (n === 2) postTaskResult(dir, '', taskResultText('调研二', '完成', '乙结果'))
    })
    const main = await getSession(dir, { skipLock: true, globalPath, env: {}, stream } as never)
    const events: { type: string; text?: string; message?: string }[] = []
    for await (const ev of main.send('开工')) events.push(ev as never)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(events.filter((e) => e.type === 'task_result').map((e) => e.text)).toEqual([
      '〔任务结果〕调研 · 完成\n甲结果',
    ])
    expect(seen).toHaveLength(2) // 乙没让模型多答一次（不唤醒）
    expect(seen[1]).toContain('甲结果')
    expect(seen[1]?.indexOf('甲结果')).toBeGreaterThan(seen[1]?.indexOf('tool_result') ?? 0)
    // 乙在轮后取：插到末尾，只取一次
    expect(main.takeTaskResults()).toBe(1)
    expect(main.takeTaskResults()).toBe(0)
    const last = main.messages().at(-1)
    expect(last?.role).toBe('user')
    expect(JSON.stringify(last)).toContain('乙结果')
    // 下一轮：带着它发，前缀守卫照样不响（插在末尾 = 追加）
    const next: { type: string }[] = []
    for await (const ev of main.send('接着说')) next.push(ev as never)
    expect(next.filter((e) => e.type === 'error')).toEqual([])
    expect(seen.at(-1)).toContain('乙结果')
    await main.close()
    // 落盘：重开库还在（对话侧 owner NULL）
    const store = openStore(dir)
    expect(JSON.stringify(store.load())).toContain('乙结果')
    store.close()
  })

  it('信箱积压（宿主没赶上空闲时取）：用户下一句排在回调之后，模型最后读到的是用户的话', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir)
    const seen: string[] = []
    postTaskResult(dir, '', taskResultText('丁', '完成', '积压的结果'))
    const stream = scripted(seen, () => {})
    const main = await getSession(dir, { skipLock: true, globalPath, env: {}, stream } as never)
    const events: { type: string }[] = []
    for await (const ev of main.send('用户的问题')) events.push(ev as never)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    // 第一个请求里：回调在前、用户的话在后（修前 loop 第 0 次迭代才取，排在用户的话之后）
    expect(seen[0]?.indexOf('积压的结果')).toBeGreaterThanOrEqual(0)
    expect(seen[0]?.indexOf('积压的结果')).toBeLessThan(seen[0]?.indexOf('用户的问题') ?? -1)
    expect(main.takeTaskResults()).toBe(0) // 只取一次
    await main.close()
  })

  it('信箱按 owner 分：投给任务的主任务取不到（对照）；在跑时 takeTaskResults 不插', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const dir = await workspace()
    const globalPath = await settings(dir)
    const seen: string[] = []
    const m = createTask(dir, '子')
    postTaskResult(dir, m.owner, taskResultText('孙', '完成', '给子的'))
    let duringRun = -1
    let main: Awaited<ReturnType<typeof getSession>> | null = null
    const stream = scripted(seen, (n) => {
      if (n === 1) {
        postTaskResult(dir, '', taskResultText('丙', '完成', '给主的'))
        duringRun = main?.takeTaskResults() ?? -1
      }
    })
    main = await getSession(dir, { skipLock: true, globalPath, env: {}, stream } as never)
    for await (const ev of main.send('开工')) void ev
    expect(duringRun).toBe(0) // 在跑：宿主那条路不插，留给 loop
    expect(seen[1]).toContain('给主的')
    expect(seen.join('\n')).not.toContain('给子的')
    expect(main.takeTaskResults()).toBe(0)
    await main.close()
    const t = openStore(dir, { task: scopeOf(m) })
    expect(t.takeTaskResults()).toEqual(['〔任务结果〕孙 · 完成\n给子的'])
    t.close()
  })

  it('取走记 runlog（task_result_take，与投递的 task_callback 配对）；信箱空不记', async () => {
    const dir = await workspace()
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      postTaskResult(dir, '', taskResultText('甲', '完成', '一'))
      postTaskResult(dir, '', taskResultText('乙', '完成', '二'))
      const s = openStore(dir)
      expect(s.takeTaskResults()).toHaveLength(2)
      expect(s.takeTaskResults()).toEqual([])
      s.close()
    } finally {
      spy.mockRestore()
    }
    const takes = calls.filter((c) => c.ev === 'task_result_take')
    expect(takes).toMatchObject([{ owner: '' }])
    expect(takes[0]?.ids).toHaveLength(2)
  })
})

describe('老库迁移（task-trunk.md「旧数据迁移」）', () => {
  it('开着的 v3 老任务：它的号段登记为它的 open 段，主任务在两侧各一段；低段记为它已拉；幂等', async () => {
    const dir = await workspace()
    // 造一个 v3 形态的库：主任务 step 1..3，老任务段 (3, 50003]，之后主任务 50004..
    const main = openStore(dir)
    const ml: Message[] = []
    runTurn(main, ml, '老一', '答')
    main.close()
    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
    db.exec(
      `DELETE FROM segments; DELETE FROM segment_pulls; DELETE FROM migrations WHERE name = 'task-trunk-segments'`,
    )
    db.exec(`INSERT INTO turns(id, started_at, owner) VALUES(50, '2026-10-28', 'task-legacy')`)
    db.exec(`INSERT INTO steps(id, turn_id, started_at) VALUES(10, 50, '2026-10-28')`)
    db.exec(
      `INSERT INTO messages(turn_id, role, content_json, step_id, owner) VALUES(50, 'user', '{"role":"user","parts":[{"type":"text","text":"老任务的话"}]}', 10, 'task-legacy')`,
    )
    db.exec(`INSERT INTO turns(id, started_at, owner) VALUES(60, '2026-10-28', NULL)`)
    db.exec(`INSERT INTO steps(id, turn_id, started_at) VALUES(50010, 60, '2026-10-28')`)
    db.close()
    mkdirSync(join(dir, '.simple-code', 'tasks'), { recursive: true })
    writeFileSync(
      join(dir, '.simple-code', 'tasks', 'task-legacy.json'),
      JSON.stringify({
        owner: 'task-legacy',
        name: '老任务',
        createdAt: '2026-10-28',
        forkTurn: 1,
        turnCeil: 1001,
        stepFloor: 2,
        stepCeil: 50002,
        msgFloor: 0,
        msgCeil: 1,
        sumFloor: 0,
        sumCeil: 1,
      }),
    )
    const s1 = openStore(dir)
    const after = segs(dir).map(({ owner, floor, ceil, state }) => ({ owner, floor, ceil, state }))
    expect(after).toEqual([
      { owner: '', floor: 0, ceil: 2, state: 'full' },
      { owner: '', floor: 50002, ceil: 50010 + SEGMENT_WIDTH, state: 'open' },
      { owner: 'task-legacy', floor: 2, ceil: 50002, state: 'open' },
    ])
    const low = segs(dir).find((g) => g.owner === '' && g.floor === 0)
    expect(
      query(dir, `SELECT segment_id AS id FROM segment_pulls WHERE owner = 'task-legacy'`),
    ).toEqual([{ id: low?.id }])
    s1.close()
    const s2 = openStore(dir) // 再开：不重复登记
    expect(segs(dir)).toHaveLength(3)
    s2.close()
    // 老任务的 scope：继承上界照旧，step 接着在自己的段里取
    const legacy = readTaskManifest(dir, 'task-legacy')
    expect(scopeOf(legacy)).toEqual({ owner: 'task-legacy', forkTurn: 1, inheritCeil: 2 })
    const t = openStore(dir, { task: scopeOf(legacy) })
    t.beginTurn({ model: 'p/m', effort: null })
    expect(t.beginStep()).toBe(11)
    t.close()
  })

  /** 一个有内容、但还没登记段的老库（同上：删段表与迁移标记） */
  const legacyDb = async (): Promise<string> => {
    const dir = await workspace()
    const main = openStore(dir)
    runTurn(main, [], '老一', '答')
    main.close()
    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
    db.exec(
      `DELETE FROM segments; DELETE FROM segment_pulls; DELETE FROM migrations WHERE name = 'task-trunk-segments'`,
    )
    db.close()
    return dir
  }

  it('runlog：迁移成功记一行 segment_migrate（耗时、备份耗时、段数），再开不记', async () => {
    const dir = await legacyDb()
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      openStore(dir).close()
      openStore(dir).close()
    } finally {
      spy.mockRestore()
    }
    const lines = calls.filter((c) => c.ev === 'segment_migrate')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ legacyTasks: 0, segments: 1 })
    expect(typeof lines[0]?.ms).toBe('number')
    expect(typeof lines[0]?.backupMs).toBe('number')
    expect(lines[0]?.error).toBeUndefined()
    expect(existsSync(join(dir, MEMORY_RELATIVE, 'state.db.pre-task-trunk'))).toBe(true)
  })

  it('runlog：迁移失败（备份写不出）记 segment_migrate 带 error，照旧抛给建会话的人', async () => {
    const dir = await legacyDb()
    // 备份位置是个指向不存在目录的悬空链接：existsSync 认为没有，VACUUM INTO 打不开
    symlinkSync(join(dir, 'nope', 'x.db'), join(dir, MEMORY_RELATIVE, 'state.db.pre-task-trunk'))
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      expect(() => openStore(dir)).toThrow()
    } finally {
      spy.mockRestore()
    }
    const lines = calls.filter((c) => c.ev === 'segment_migrate')
    expect(lines).toHaveLength(1)
    expect(typeof lines[0]?.error).toBe('string')
  })
})
