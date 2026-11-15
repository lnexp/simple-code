import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@simple-code/core'
import { openStore } from '@simple-code/core'
import { describe, expect, it, vi } from 'vitest'
import { type BridgeDeps, createBridge } from '../src/bridge.ts'
import type { ToWebview, TurnQueueView } from '../src/protocol.ts'

vi.mock('@simple-code/core', async (original) => ({
  ...(await original<typeof import('@simple-code/core')>()),
  logRun: vi.fn(),
}))

/**
 * 排队发送的接线（docs/proposals/queued-sends.md）：bridge send / tasks runLoop
 * 的 finally 有没有带着结局通知排队中心、发出走的是不是现有路径、发完用户
 * 消息有没有上屏。纯逻辑在 turn-queue.test.ts。
 *
 * 既有 harness 的假 session 每一轮结局相同，这里要逐轮控制（正常/出错/
 * 被停），所以自带：每次 send 挂住，用例 finish() 才放行
 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const settleN = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await settle()
}

type How = 'done' | 'error'

/** 一串挂住的轮：send 一次排一个，finish 按序放行 */
function turns() {
  const waiting: Array<(how: How) => void> = []
  return {
    wait: (): Promise<How> => new Promise((r) => waiting.push(r)),
    finish: (how: How = 'done'): void => waiting.shift()?.(how),
  }
}

function fakeSession(opts: {
  id: string
  log: string[]
  sent: string[]
  ctl: ReturnType<typeof turns>
}): Session {
  const { id, log, sent, ctl } = opts
  let floor: number | null = null
  return {
    root: '/tmp/x',
    owner: id,
    memoryRoot: '/tmp/x',
    setMemoryRoot: () => {},
    setFloor: (f: number | null) => {
      floor = f
    },
    messages: () => [],
    historyRows: () => [],
    historyPage: () => ({ rows: [], next: null }),
    historyRowsWindowed: () => ({ rows: [], floor }),
    lastTurnError: () => null,
    isRunning: () => false,
    takeTaskResults: () => 0,
    // 停止：放行挂着的轮（结局由宿主的 stopRequested 判成 stopped）
    interrupt: () => ctl.finish('done'),
    bgSnapshot: () => [],
    terminateBg: () => [],
    setModel: () => {},
    setEffort: () => {},
    effortState: () => ({ effort: 'high', overridden: false }),
    presetState: () => ({ current: undefined, available: [] }),
    summarizeIdle: async () => false,
    summaryDebt: () => false,
    close: async () => {
      log.push(`close:${id}`)
    },
    send: (text: string) => {
      sent.push(text)
      return (async function* () {
        const how = await ctl.wait()
        yield how === 'error'
          ? { type: 'error', message: '炸了' }
          : { type: 'text_delta', text: '好' }
      })()
    },
    config: {
      config: {
        provider: 'p',
        model: 'm',
        providers: { p: { models: { m: {} } } },
        memory: { idleSummarizeDelayMs: 0 },
        taskModels: [],
      },
      model: { effort: 'high', capabilities: { images: true }, contextWindow: 200_000 },
      request: { effort: 'high' },
    },
    defaultModel: { provider: 'p', model: 'm' },
  } as unknown as Session
}

function harness() {
  const posted: ToWebview[] = []
  const log: string[] = []
  const mainSent: string[] = []
  const taskSent: string[] = []
  const main = turns()
  const task = turns()
  let builds = 0
  const folder = mkdtempSync(join(tmpdir(), 'sc-turnqueue-'))
  openStore(folder).close() // 建任务要主库（createTask 复制主干摘要）
  const deps = {
    post: (m: ToWebview) => {
      posted.push(m)
    },
    session: async () => {
      builds++
      log.push(`build:main#${builds}`)
      return fakeSession({ id: `main#${builds}`, log, sent: mainSent, ctl: main })
    },
    taskSession: async () => fakeSession({ id: 'task', log, sent: taskSent, ctl: task }),
    folder,
    openExternal: async () => true,
    openFile: async () => {},
    savedChoice: () => null,
    saveChoice: () => {},
    clearChoice: () => {},
    setTimer: () => () => {},
  } satisfies BridgeDeps
  const bridge = createBridge(deps)
  /** 最近一次推给 webview 的排队快照 */
  const queueView = (): { main: TurnQueueView; tasks: Record<string, TurnQueueView> } => {
    const last = posted
      .filter((m): m is Extract<ToWebview, { type: 'turnQueue' }> => m.type === 'turnQueue')
      .at(-1)
    if (last === undefined) throw new Error('没推过 turnQueue')
    return { main: last.main, tasks: last.tasks }
  }
  const texts = (v: TurnQueueView | undefined): string[] => (v?.items ?? []).map((x) => x.text)
  return { bridge, posted, log, mainSent, taskSent, main, task, queueView, texts }
}

/** ready + 发第一句，主任务停在「在跑」 */
async function runningMain() {
  const h = harness()
  h.bridge.handle({ type: 'ready' })
  await settleN()
  h.bridge.handle({ type: 'send', text: '第一问' })
  await settleN()
  expect(h.mainSent).toEqual(['第一问']) // 前提：真的在跑
  return h
}

describe('排队发送·主任务', () => {
  it('在跑时只入队；这一轮正常结束发出，并补推基线让它上屏', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'A' })
    await settleN()
    expect(h.mainSent).toEqual(['第一问'])
    expect(h.texts(h.queueView().main)).toEqual(['A'])
    const before = h.posted.length
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', 'A'])
    expect(h.texts(h.queueView().main)).toEqual([])
    const hydrate = h.posted
      .slice(before)
      .find((m): m is Extract<ToWebview, { type: 'hydrate' }> => m.type === 'hydrate')
    expect(hydrate?.items).toContainEqual({ kind: 'user', text: 'A' })
  })

  it('串行：一次只发一条，下一轮正常结束才发下一条', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'A' })
    h.bridge.handle({ type: 'turnQueueAdd', text: 'B' })
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', 'A'])
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', 'A', 'B'])
  })

  it('停止后暂停；闹钟开的轮正常结束不发；手动发话那一轮正常结束才发', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'B' })
    h.bridge.handle({ type: 'interrupt' })
    await settleN()
    expect(h.mainSent).toEqual(['第一问'])
    expect(h.queueView().main.paused).toBe(true)
    h.bridge.wakeFire('', '〔wake〕到点')
    await settleN()
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', '〔wake〕到点'])
    h.bridge.handle({ type: 'send', text: '继续' })
    await settleN()
    expect(h.queueView().main.paused).toBe(false)
    expect(h.mainSent.at(-1)).toBe('继续')
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', '〔wake〕到点', '继续', 'B'])
  })

  it('出错结束同样暂停，不发', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'B' })
    h.main.finish('error')
    await settleN()
    expect(h.mainSent).toEqual(['第一问'])
    expect(h.queueView().main).toMatchObject({ paused: true, items: [{ text: 'B' }] })
  })

  it('对照：同样的轮正常结束就发（上一条的「不发」是结局判出来的）', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'B' })
    h.main.finish('done')
    await settleN()
    expect(h.mainSent).toEqual(['第一问', 'B'])
  })

  it('空闲时 Ctrl+Enter 立刻发', async () => {
    const h = harness()
    h.bridge.handle({ type: 'ready' })
    await settleN()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'A' })
    await settleN()
    expect(h.mainSent).toEqual(['A'])
    expect(h.texts(h.queueView().main)).toEqual([])
  })

  it('按 id 取消：取消的那条不发，其余照发', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'A' })
    h.bridge.handle({ type: 'turnQueueAdd', text: 'B' })
    const a = h.queueView().main.items[0]
    expect(a?.text).toBe('A')
    h.bridge.handle({ type: 'turnQueueCancel', id: a?.id as number })
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', 'B'])
  })

  it('面板关着也照发：旧 session 关完才建新的', async () => {
    const h = await runningMain()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'A' })
    h.bridge.detach() // 跑着关面板 = releaseAfterTurn
    h.main.finish()
    await settleN()
    expect(h.mainSent).toEqual(['第一问', 'A'])
    expect(h.log).toEqual(['build:main#1', 'close:main#1', 'build:main#2'])
  })

  it('排给不存在的任务：报错，不排进主任务', async () => {
    const h = harness()
    h.bridge.handle({ type: 'ready' })
    await settleN()
    h.bridge.handle({ type: 'turnQueueAdd', text: 'A', task: '没这个' })
    await settleN()
    expect(h.mainSent).toEqual([])
    expect(h.posted).toContainEqual({ type: 'fatal', message: '没有任务「没这个」' })
  })
})

/** 「+ 任务」开「甲」（第一条消息即开），任务停在「在跑」 */
async function runningTask() {
  const h = harness()
  h.bridge.handle({ type: 'ready' })
  await settleN()
  h.bridge.handle({ type: 'task_create', name: '甲', text: '开工' })
  await settleN()
  expect(h.taskSent).toHaveLength(1) // 前提：任务真的在跑
  expect(h.taskSent[0]?.endsWith('开工')).toBe(true)
  return h
}

describe('排队发送·任务', () => {
  it('任务在跑时排队，正常结束发给该任务并上屏；主任务不受影响', async () => {
    const h = await runningTask()
    h.bridge.handle({ type: 'turnQueueAdd', text: '接着', task: '甲' })
    await settleN()
    expect(h.texts(h.queueView().tasks['甲'])).toEqual(['接着'])
    expect(h.texts(h.queueView().main)).toEqual([])
    const before = h.posted.length
    h.task.finish()
    await settleN()
    expect(h.taskSent.at(-1)).toBe('接着')
    expect(h.mainSent).toEqual([])
    expect(h.queueView().tasks).toEqual({})
    // 取最后一份：前面那份是上一轮 finally 定稿推的（不含这条）
    const hydrate = h.posted
      .slice(before)
      .filter((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
      .at(-1)
    expect(hydrate?.items).toContainEqual({ kind: 'user', text: '接着' })
  })

  it('任务被停暂停；task_send 手动发话解除，那一轮正常结束才发', async () => {
    const h = await runningTask()
    h.bridge.handle({ type: 'turnQueueAdd', text: '接着', task: '甲' })
    h.bridge.handle({ type: 'task_stop', name: '甲' })
    await settleN()
    expect(h.taskSent).toHaveLength(1)
    expect(h.queueView().tasks['甲']?.paused).toBe(true)
    h.bridge.handle({ type: 'task_send', task: '甲', text: '继续' })
    await settleN()
    h.task.finish()
    await settleN()
    expect(h.taskSent.slice(1)).toEqual(['继续', '接着'])
  })

  it('任务关闭：它的排队跟着丢，不发', async () => {
    const h = await runningTask()
    h.bridge.handle({ type: 'turnQueueAdd', text: '接着', task: '甲' })
    await settleN()
    expect(h.texts(h.queueView().tasks['甲'])).toEqual(['接着'])
    h.bridge.handle({ type: 'task_close', name: '甲' })
    await settleN(20)
    expect(h.queueView().tasks).toEqual({})
    expect(h.taskSent).toHaveLength(1)
  })
})
