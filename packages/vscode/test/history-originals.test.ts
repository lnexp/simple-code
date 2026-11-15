import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Message } from '@simple-code/core'
import { createTask, openStore, scopeOf } from '@simple-code/core'
import { afterEach, expect, it } from 'vitest'
import { getSession } from '../../core/src/session/session.ts'
import { createBridge } from '../src/bridge.ts'
import type { ToWebview } from '../src/protocol.ts'
import { FOLD_RECENT_STEPS } from '../src/tasks.ts'
import { groupItems, hydrateItems, splitTurns } from '../webview/events.ts'
import { buildSteps, stepStats } from '../webview/steps.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const text = (role: 'user' | 'assistant', text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})
const call = (id: string): Message => ({
  role: 'assistant',
  parts: [
    { type: 'reasoning', text: `思考 ${id}` },
    { type: 'tool_call', id, name: 'bash', input: { desc: `命令 ${id}`, command: `echo ${id}` } },
  ],
})
const result = (id: string, output: string): Message => ({
  role: 'tool',
  parts: [{ type: 'tool_result', toolCallId: id, output, isError: false }],
})
const marker = '\n[已卸载，完整内容见 .simple-code/memory/turns/001/turn-001001.jsonl]'

function setup() {
  mkdirSync('.simple-code/tmp/history-tests', { recursive: true })
  const root = mkdtempSync(resolve('.simple-code/tmp/history-tests/case-'))
  roots.push(root)
  const config = join(root, 'settings.json')
  writeFileSync(
    config,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      providers: {
        p: {
          protocol: 'openai-chat',
          baseUrl: 'https://example.invalid',
          apiKey: 'test',
          models: { m: { contextWindow: 100000 } },
        },
      },
    }),
  )
  return { root, config, store: openStore(root) }
}

function fixture() {
  const { root, config, store } = setup()
  store.beginTurn({ model: 'p/m', effort: null })
  store.save([text('user', '旧问题'), text('assistant', '旧回答')])
  store.pruneMessages([0, 1])
  store.save([])
  store.beginTurn({ model: 'p/m', effort: null })
  const originals = [
    text('user', '开始'),
    call('a'),
    result('a', '输出 a'),
    call('b'),
    result('b', '输出 b'),
    text('assistant', '完成'),
  ]
  store.save(originals)
  // a 两侧卸载；b 只有输出卸载（本次真库确有这种形态）。
  store.unload([1, 2, 4])
  const stubs = structuredClone(originals)
  stubs[1] = {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '思考 a' },
      {
        type: 'tool_call',
        id: 'a',
        name: 'bash',
        input: { desc: '命令 a', command: `echo${marker}` },
      },
    ],
  }
  stubs[2] = result('a', `输${marker}`)
  stubs[4] = result('b', `输${marker}`)
  store.markStubs(stubs)
  store.save(stubs)
  store.close()
  return { root, config }
}

it('重开面板恢复夹在思考之间的 bash 原文，分页不重放，模型上下文仍是存根', async () => {
  const { root, config } = fixture()
  const session = await getSession(root, { globalPath: config, skipLock: true })
  try {
    const before = JSON.stringify(session.messages())
    expect(before).toContain('已卸载')
    const items = hydrateItems(session.historyRows())
    const tools = items.filter((i) => i.kind === 'tool')
    expect(tools.map((i) => i.id)).toEqual(['a', 'b'])
    expect(tools.map((i) => i.output)).toEqual(['输出 a', '输出 b'])
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'reasoning',
      'tool',
      'reasoning',
      'tool',
      'assistant',
    ])
    const folded = splitTurns(groupItems(items), true).find((s) => s.kind === 'process')
    const blocks = folded?.kind === 'process' ? folded.blocks : []
    expect(stepStats(buildSteps(blocks.map((block, at) => ({ block, at })))).tools).toBe(2)
    const page = await session.historyPage(null, 1)
    expect(page.next).not.toBeNull()
    const next = await session.historyPage(page.next, 1)
    const past = hydrateItems([...next.rows, ...page.rows])
    expect(past.filter((i) => i.kind === 'tool')).toHaveLength(0)
    expect(past).toContainEqual({ kind: 'user', text: '旧问题' })
    expect(next.next).toBeNull()
    expect(hydrateItems(session.historyRows())).toEqual(items)
    expect(JSON.stringify(session.messages())).toBe(before)
  } finally {
    await session.close()
  }
  const reopened = await getSession(root, { globalPath: config, skipLock: true })
  try {
    expect(hydrateItems(reopened.historyRows()).filter((i) => i.kind === 'tool')).toHaveLength(2)
    expect(
      hydrateItems((await reopened.historyPage(null, 100)).rows).filter((i) => i.kind === 'tool'),
    ).toHaveLength(0)
  } finally {
    await reopened.close()
  }
})

/**
 * 2026-11-10 真项目「中间消息丢失」：T1 三个 step（问一 / bash a 两侧卸载成
 * 存根 / 答一）→ TG 整轮 prune（live 里没有、夹在中间）→ T2 → T3。窗口 2 步
 * = 只有 T3。用户消息从不卸载、是 live 完整行——窗口外时既不在底稿也不在
 * 只查 unloaded 的分页里
 */
function windowFixture() {
  const { root, config, store } = setup()
  let live: Message[] = []
  const step = (...more: Message[]) => {
    store.beginStep()
    live = [...live, ...more]
    store.save(live)
  }
  const turn = () => store.beginTurn({ model: 'p/m', effort: null })
  turn()
  step(text('user', '问一'))
  step(call('a'), result('a', '输出 a'))
  step(text('assistant', '答一'))
  store.unload([1, 2])
  live = structuredClone(live)
  live[1] = {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '思考 a' },
      { type: 'tool_call', id: 'a', name: 'bash', input: { command: `echo${marker}` } },
    ],
  }
  live[2] = result('a', `输${marker}`)
  store.markStubs(live)
  store.save(live)
  turn()
  step(text('user', '问G'), text('assistant', '答G'))
  store.pruneMessages([live.length - 2, live.length - 1])
  live = live.slice(0, -2)
  store.save(live)
  turn()
  step(text('user', '问二'))
  step(text('assistant', '答二'))
  turn()
  step(text('user', '问三'))
  step(text('assistant', '答三'))
  store.close()
  return { root, config }
}

it('窗口外的用户消息与回复往上翻按序出现，整轮卸载的 turn 不错位', async () => {
  const { root, config } = windowFixture()
  const session = await getSession(root, { globalPath: config, skipLock: true })
  try {
    const windowed = session.historyRowsWindowed(2)
    const base = hydrateItems(windowed.rows)
    expect(base.map((i) => i.kind)).toEqual(['user', 'assistant'])
    // 页大小 1：逐行翻，走到「整页都是存根被滤空」那一步
    const rows: Awaited<ReturnType<typeof session.historyPage>>['rows'] = []
    // 第一页从 floor 起（bridge 把 webview 的 cursor=null 换成它）
    let cursor: number | null = windowed.floor
    expect(cursor).not.toBeNull()
    do {
      const page = await session.historyPage(cursor, 1, { live: true })
      rows.unshift(...page.rows)
      cursor = page.next
    } while (cursor !== null)
    const all = [...hydrateItems(rows), ...base]
    const texts = (kind: string) =>
      all.flatMap((i) => (i.kind === kind && 'text' in i ? [i.text] : []))
    expect(texts('user')).toEqual(['问一', '问G', '问二', '问三'])
    expect(texts('assistant')).toEqual(['答一', '答G', '答二', '答三'])
    expect(all.flatMap((i) => (i.kind === 'tool' ? [i.output] : []))).toEqual(['输出 a'])
    expect(JSON.stringify(all)).not.toContain('已卸载')
  } finally {
    await session.close()
  }
})

/**
 * 2026-11-13「没到第一问就显示没有更早的了」：webview 拿到底稿后，起点
 * （postedFloor）是一条 live 行的 id。之后每落盘一次，replaceLive 把 live
 * 行全删重插、id 全换——旧起点指向不存在的行，第一页空、next=null
 */
it('拿到窗口起点后、翻到一半时各落盘一次，从旧游标往上翻仍能翻到第一问', async () => {
  const { root, config } = windowFixture()
  const session = await getSession(root, { globalPath: config, skipLock: true })
  try {
    const { floor } = session.historyRowsWindowed(2)
    expect(floor).not.toBeNull()
    // 游标交给 webview 之后又跑了一步（落盘 = live 行删了重插、id 全换）
    const runStep = (say: string) => {
      const store = openStore(root)
      store.beginTurn({ model: 'p/m', effort: null })
      store.beginStep()
      store.save([...store.load(), text('user', say)])
      store.close()
    }
    runStep('问四')
    const rows: Awaited<ReturnType<typeof session.historyPage>>['rows'] = []
    let cursor: number | null = floor
    let pages = 0
    do {
      const page = await session.historyPage(cursor, 1, { live: true })
      rows.unshift(...page.rows)
      cursor = page.next
      if (++pages === 1) runStep('问五') // 翻到一半：游标停在 live 行（答二）上
    } while (cursor !== null)
    const users = hydrateItems(rows).flatMap((i) => (i.kind === 'user' ? [i.text] : []))
    expect(users).toEqual(['问一', '问G', '问二'])
  } finally {
    await session.close()
  }
})

it('任务视图窗口化端到端：底稿截最近 FOLD_RECENT_STEPS 步，task_fetchHistory 从 floor 翻出窗口外 live 行与存根原文', async () => {
  const { root, config, store: mainStore } = setup()
  mainStore.beginTurn({ model: 'p/m', effort: null })
  mainStore.save([text('user', '主干无关问题'), text('assistant', '主干无关回答')])
  mainStore.close()

  const manifest = createTask(root, '长任务')
  const taskStore = openStore(root, { task: scopeOf(manifest) })
  let live: Message[] = []
  const step = (...more: Message[]) => {
    taskStore.beginStep()
    live = [...live, ...more]
    taskStore.save(live)
  }
  taskStore.beginTurn({ model: 'p/m', effort: null })
  step(text('user', '任务问一'))
  step(call('ta'), result('ta', '任务输出 a'))
  step(text('assistant', '任务答一'))
  taskStore.unload([1, 2])
  live = structuredClone(live)
  live[1] = {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '思考 ta' },
      { type: 'tool_call', id: 'ta', name: 'bash', input: { command: `echo${marker}` } },
    ],
  }
  live[2] = result('ta', `输${marker}`)
  taskStore.markStubs(live)
  taskStore.save(live)

  taskStore.beginTurn({ model: 'p/m', effort: null })
  step(text('user', '任务问G'), text('assistant', '任务答G'))
  taskStore.pruneMessages([live.length - 2, live.length - 1])
  live = live.slice(0, -2)
  taskStore.save(live)

  taskStore.beginTurn({ model: 'p/m', effort: null })
  for (let i = 1; i <= FOLD_RECENT_STEPS; i++) {
    step(text('user', `窗口问${i}`), text('assistant', `窗口答${i}`))
  }
  taskStore.close()

  const posted: ToWebview[] = []
  const bridge = createBridge({
    post: (m) => posted.push(m),
    session: (requestApproval) =>
      getSession(root, { globalPath: config, skipLock: true, requestApproval }),
    taskSession: (t, requestApproval) =>
      getSession(root, { globalPath: config, task: scopeOf(t), skipLock: true, requestApproval }),
    folder: root,
    openExternal: async () => true,
    openFile: async () => {},
    savedChoice: () => null,
    saveChoice: () => {},
    setTimer: () => () => {},
  })
  const tick = () => new Promise((r) => setTimeout(r, 10))
  try {
    bridge.handle({ type: 'ready' })
    bridge.handle({ type: 'task_open', task: '长任务' })
    // open 先同步推一条空基线，真 getSession 读盘建库异步完成后推第二条实基线
    for (
      let i = 0;
      i < 200 && !posted.some((m) => m.type === 'task_hydrate' && m.items.length > 0);
      i++
    )
      await tick()
    const base = posted
      .filter((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
      .at(-1)
    expect(base).toBeDefined()
    // 前提断言：底稿真的被窗口截断，不含窗口外的早期消息
    expect(JSON.stringify(base?.items)).not.toContain('任务问一')
    expect(JSON.stringify(base?.items)).toContain(`窗口问${FOLD_RECENT_STEPS}`)

    const paged: NonNullable<typeof base>['items'] = []
    let cursor: number | null = null
    do {
      posted.length = 0
      bridge.handle({ type: 'task_fetchHistory', task: '长任务', cursor })
      for (let i = 0; i < 200 && !posted.some((m) => m.type === 'task_historyPage'); i++)
        await tick()
      const pg = posted.find(
        (m): m is Extract<ToWebview, { type: 'task_historyPage' }> => m.type === 'task_historyPage',
      )
      expect(pg).toBeDefined()
      paged.unshift(...(pg?.items ?? []))
      cursor = pg?.next ?? null
    } while (cursor !== null)

    const all = [...paged, ...(base?.items ?? [])]
    const users = all.flatMap((i) => (i.kind === 'user' ? [i.text] : []))
    expect(users.slice(0, 3)).toEqual(['任务问一', '任务问G', '窗口问1'])
    expect(users.at(-1)).toBe(`窗口问${FOLD_RECENT_STEPS}`)
    expect(all.flatMap((i) => (i.kind === 'tool' ? [i.output] : []))).toEqual(['任务输出 a'])
    expect(JSON.stringify(all)).not.toContain('已卸载')
    expect(JSON.stringify(all)).not.toContain('主干无关')
  } finally {
    bridge.dispose()
    await tick()
  }
})
