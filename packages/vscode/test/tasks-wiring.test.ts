/**
 * 任务的 bridge 接线（task-v3）。
 *
 * 引擎本身（owner 分治、号段、关闭流程）在 core 的 task.test.ts；
 * 这里只测宿主侧：派活闸门、task_agent 镜像、停止/关闭的 session
 * 生命周期、失败路径任务保留可重试、reload 恢复。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Session, SetTimer } from '@simple-code/core'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../src/bridge.ts'
import { MEMORY_RELATIVE, openStore } from '@simple-code/core'
import type { ToWebview } from '../src/protocol.ts'
import type { BridgeDeps } from '../src/bridge.ts'
import type { ChatItem } from '../webview/events.ts'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 分身的假 session：send 产事件，interrupt/close 记调用 */
function fakeTaskSession(
  events: { type: string; text?: string; message?: string }[],
  hang?: () => Promise<void>,
) {
  const calls: string[] = []
  const session = {
    root: '/tmp/x',
    // 会话身份（regions 行归属）。探针行带同一个 owner——get_regions
    // 按 session.owner 过滤，不按人起的任务名
    owner: 'task-分区探针',
    // v3 里任务与对话同一个 root/memoryRoot。get_regions 探针用
    // setMemoryRoot 把它指到探针目录（路由断言用）
    memoryRoot: '/tmp/x' + '-task',
    setMemoryRoot: (dir: string) => {
      ;(session as Record<string, unknown>).memoryRoot = dir
    },
    messages: () => [],
    historyRows: () => [],
    isRunning: () => false,
    takeTaskResults: () => 0,
    interrupt: () => {
      calls.push('interrupt')
    },
    bgSnapshot: () => [],
    terminateBg: () => [],
    setModel: (c: unknown) => {
      calls.push(`setModel:${JSON.stringify(c)}`)
    },
    setEffort: (e: unknown) => {
      calls.push(`setEffort:${e}`)
    },
    effortState: () => ({ effort: 'high', overridden: false }),
    presetState: () => ({ current: undefined, available: [] }),
    summarizeIdle: async () => {
      calls.push('summarizeIdle')
      return false
    },
    summaryDebt: () => false,
    close: async () => {
      calls.push('close')
    },
    send: (text: string) => {
      calls.push(`send:${text}`)
      return (async function* () {
        for (const ev of events) yield ev as never
        if (hang) await hang()
      })()
    },
    get config() {
      return {
        config: {
          provider: 'p',
          model: 'm',
          providers: { p: { models: { m: {} } } },
          memory: { idleSummarizeDelayMs: 0 },
        },
        model: { effort: 'high', capabilities: { images: false }, contextWindow: 200_000 },
        request: { effort: 'high' },
      }
    },
  } as unknown as Session
  return { session, calls }
}

const neverTimer: SetTimer = () => () => {}

function taskHarness(options: {
  mainEvents?: { type: string; text?: string }[]
  mainHang?: () => Promise<void>
  taskEvents?: { type: string; text?: string; message?: string }[]
  /** 任务的 send 产完事件后挂住，直到它 resolve（测停止） */
  taskHang?: () => Promise<void>
  /** 复用这个目录建 bridge（恢复测试：第一次留下的 task- 目录要被第二次
   *  扫到）。不传 = 独立临时目录 */
  folder?: string
  /** 造最小真主库（fork/merge 走真路径——纯 fake 环境里 merge 第一击
   *  就 fatal「主干还没有记忆」，测不了成功路径） */
  realStore?: boolean
  /** taskSession 工厂按次抛这些错（shift 取用），耗尽后返回正常 session。
   *  测 ensureSession 的 BUSY 重试与终态可见（2026-09-23 卡死回归） */
  taskSessionErrors?: Error[]
  /** 主任务配置里的 taskModels（agent 派任务 --model，规则 14） */
  taskModels?: { provider: string; model: string; effort?: string; use: string }[]
  /** 主任务建会话时的配置默认；不给 = 与 config 的 p/m 相同（没切过模型） */
  mainDefault?: { provider: string; model: string }
}) {
  const posted: ToWebview[] = []
  const mainCalls: string[] = []
  /** 主任务 takeTaskResults 被调次数（回调戳主任务的观测点） */
  let mainTakes = 0
  const mainTaken = (): number => {
    mainTakes++
    return 0
  }
  const taskFake = fakeTaskSession(options.taskEvents ?? [{ type: 'text_delta', text: '分身在干活' }], options.taskHang)
  const built: string[] = []
  const choiceStore = {
    stored: new Map<string, unknown>(),
    get: (dir: string) => (choiceStore.stored.get(dir) as never) ?? null,
    set: (dir: string, choice: unknown) => choiceStore.stored.set(dir, choice),
  }
  const deps = {
    post: (m: ToWebview) => {
      posted.push(m)
    },
    session: async () => {
      built.push('main')
      const session = {
        root: '/tmp/x',
        messages: () => [],
        historyRows: () => [],
        isRunning: () => false,
        takeTaskResults: () => mainTaken(),
        interrupt: () => {},
        bgSnapshot: () => [],
        terminateBg: () => [],
        setModel: () => {},
        setEffort: () => {},
        effortState: () => ({ effort: 'high', overridden: false }),
        presetState: () => ({ current: undefined, available: [] }),
        summarizeIdle: async () => {
          mainCalls.push('summarizeIdle')
          return false
        },
        close: async () => {},
        send: (_t: string) =>
          (async function* () {
            for (const ev of options.mainEvents ?? []) yield ev as never
            if (options.mainHang) await options.mainHang()
          })(),
        get config() {
          return {
            config: {
              provider: 'p',
              model: 'm',
              providers: { p: { models: { m: {} } } },
              memory: { idleSummarizeDelayMs: 0 },
              taskModels: options.taskModels ?? [],
            },
            model: { effort: 'high', capabilities: { images: false }, contextWindow: 200_000 },
            request: { effort: 'high' },
          }
        },
        defaultModel: options.mainDefault ?? { provider: 'p', model: 'm' },
      } as unknown as Session
      return session
    },
    taskSession: async (_manifest, _requestApproval) => {
      built.push('task')
      const err = options.taskSessionErrors?.shift()
      if (err !== undefined) throw err
      return taskFake.session
    },
    choiceStore,
    folder: options.folder ?? mkdtempSync(join(tmpdir(), 'sc-taskwiring-')),
    openExternal: async () => true,
    openFile: async () => {},
    savedChoice: () => null,
    saveChoice: () => {},
    clearChoice: () => {},
    setTimer: neverTimer,
  } satisfies BridgeDeps
  if (options.realStore) {
    const store = openStore(deps.folder)
    const live: never[] = []
    const t = store.beginTurn({ model: 'p/m', effort: null })
    ;(live as unknown[]).push(
      { role: 'user', parts: [{ type: 'text', text: '主干问题' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '主干回答' }] },
    )
    store.save(live as never)
    store.finishTurn(t, 1, 'done')
    store.close()
  }
  const bridge = createBridge(deps)
  return {
    bridge,
    posted,
    taskFake,
    built,
    choiceStore,
    depsFolder: deps.folder as string,
    mainCalls,
    mainTakes: () => mainTakes,
  }
}
const choiceStoreOf = (h: ReturnType<typeof taskHarness>): Map<string, unknown> =>
  h.choiceStore.stored

describe('分身任务接线', () => {
  it('派活 → tasks 快照 + task_agent 镜像 + 跑完置 idle', async () => {
    const h = taskHarness({ taskEvents: [{ type: 'text_delta', text: '分身说' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.posted.length = 0
    h.bridge.handle({ type: 'task_dispatch', brief: '调研某库\n细节' })
    await settle()
    await settle()
    // find 会拿到 dispatch 时的第一份（running）——终态看最后一份
    const snapshot = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snapshot).toBeDefined()
    expect(snapshot?.tasks).toHaveLength(1)
    // idle = 可继续输入的空闲（2026-09-22 拍板：分支可交互，done 改 idle）
    expect(snapshot?.tasks[0]?.status).toBe('idle')
    // 分身的流事件以 task_agent 转发，不混进主对话的 agent
    expect(h.posted.some((m) => m.type === 'task_agent')).toBe(true)
    expect(h.posted.some((m) => m.type === 'agent')).toBe(false)
    // 任务目录在主干文件夹下 fork 出来（manifest 写进去才算派成）
  })

  it('任务轮末收尾分段计时：记一行 turn_end_host（带 owner）', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../../core/src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    const h = taskHarness({ taskEvents: [{ type: 'text_delta', text: '分身说' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '调研某库\n细节' })
    await settle()
    await settle()
    spy.mockRestore()
    const rows = calls.filter((c) => c.ev === 'turn_end_host')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      owner: expect.stringMatching(/^task-/),
      foldMs: expect.any(Number),
      items: expect.any(Number),
      postMs: expect.any(Number),
      tailMs: expect.any(Number),
    })
  })

  it('dispatch 撞 database is locked → 退避重试后自愈（不卡 running）', async () => {
    // 2026-09-23 实测回归：派任务撞上对话空闲摘要器写库，任务 session 建立
    // 炸 database is locked，被吞错后任务无声卡死在 running（零 turn 零报错）
    const h = taskHarness({
      taskEvents: [{ type: 'text_delta', text: '第二轮建立成功' }],
      taskSessionErrors: [
        new Error('database is locked'),
        new Error('database is locked'),
      ],
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '撞锁任务' })
    // 重试退避 150/450ms——等过第三次尝试（真 setTimeout）
    await new Promise((r) => setTimeout(r, 700))
    for (let i = 0; i < 6; i++) await settle()
    const tasks = h.posted.filter((m) => m.type === 'tasks').at(-1) as
      | { tasks: { name: string; status: string; error?: string }[] }
      | undefined
    const t = tasks?.tasks.find((x) => x.name === '撞锁任务')
    expect(t?.status).toBe('idle') // 重试后跑完一轮，不是 running 也不是 error
    expect(h.posted.some((m) => m.type === 'task_agent')).toBe(true)
  })

  it('session 建立连续失败 → 任务进 error 态可见（不再无声 running）', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../../core/src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    const h = taskHarness({
      taskSessionErrors: Array.from({ length: 6 }, () => new Error('database is locked')),
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '永远撞锁' })
    await new Promise((r) => setTimeout(r, 900))
    for (let i = 0; i < 6; i++) await settle()
    spy.mockRestore()
    // runlog 也有一行（任务条的错误 reload 后就没了）
    expect(calls.filter((c) => c.ev === 'task_session_fail')).toMatchObject([
      { task: '永远撞锁', error: expect.stringContaining('database is locked') },
    ])
    const tasks = h.posted.filter((m) => m.type === 'tasks').at(-1) as
      | { tasks: { name: string; status: string; error?: string }[] }
      | undefined
    const t = tasks?.tasks.find((x) => x.name === '永远撞锁')
    expect(t?.status).toBe('error')
    expect(t?.error).toContain('会话建立失败')
    expect(t?.error).toContain('database is locked')
    // 错误进任务视图（原来只在 tab 的 hover 里，切进去一片空白）
    const hydrate = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
      .at(-1)
    const notice = hydrate?.items.find((i) => i.kind === 'notice')
    expect(notice).toMatchObject({ kind: 'notice', errorKind: '任务出错' })
    expect((notice as { text: string }).text).toContain('database is locked')
  })

  it('轮内 error 事件（如 PrefixBrokenError）→ 轮末 hydrate 后仍在任务视图', async () => {
    // 2026-09-23 真机：core 把轮内错误作为 error 事件产出、不抛；轮末 fold
    // 清空 replay，错误跟着消失，视图上就是「发了没反应」
    const h = taskHarness({ taskEvents: [{ type: 'error', message: 'PrefixBrokenError: 前缀被改写' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '会出错' })
    await settle()
    await settle()
    const lastHydrate = () =>
      h.posted
        .filter((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
        .at(-1)
    const notice = lastHydrate()?.items.find((i) => i.kind === 'notice')
    expect(notice).toMatchObject({ kind: 'notice', errorKind: '任务出错' })
    expect((notice as { text: string }).text).toContain('PrefixBrokenError')
    // 重开视图（task_open 补基线）照样在
    h.bridge.handle({ type: 'task_open', task: '会出错' })
    await settle()
    expect(lastHydrate()?.items.some((i) => i.kind === 'notice')).toBe(true)
  })

  it('第一轮跑着时：任务视图里有用户发的那条（ensureSession 的 fold 不许清掉待定气泡）', async () => {
    // 2026-09-23 真机：+任务 发 brief 后切进任务，看得到继承历史和任务的
    // 工具调用，唯独没有自己发的那条。ensureSession 建好会话就 fold 一次
    // 刷继承基线，fold 顺手清了 pendingTexts——而此刻 send 还没开始，用户
    // 消息既不在 historyRows 也不在 replay，第一轮全程消失
    const h = taskHarness({})
    let release: () => void = () => {}
    ;(h.taskFake.session as unknown as { send: unknown }).send = () =>
      (async function* () {
        yield { type: 'text_delta', text: '干活中' } as never
        await new Promise<void>((r) => (release = r))
      })()
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '看看这个库' })
    await settle()
    await settle()
    h.bridge.handle({ type: 'task_open', task: '看看这个库' })
    await settle()
    const hydrates = h.posted.filter(
      (m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate',
    )
    expect(hydrates.length).toBeGreaterThan(0)
    // 每一份基线（含建会话后 fold 推的那份）都得有这条用户消息
    for (const hy of hydrates)
      expect(hy.items.some((i) => i.kind === 'user' && (i as { text: string }).text === '看看这个库')).toBe(true)
    release()
    await settle()
  })

  it('派活时主干在跑 → 照样开成（task-trunk 去掉主任务静止闸；对照：v3 这里 fatal 拒）', async () => {
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const h = taskHarness({
      mainEvents: [{ type: 'text_delta', text: '主干在跑' }],
      mainHang: () => blocked,
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.posted.length = 0
    h.bridge.handle({ type: 'send', text: '问题' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '新任务' })
    await settle()
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(false)
    expect(h.posted.some((m) => m.type === 'tasks')).toBe(true)
    release()
    await settle()
  })

  // task-trunk（2026-10-29 用户拍板）：开/关任务只写自己的行和段表，不再等主任务静止
  const taskNames = (h: ReturnType<typeof taskHarness>) =>
    h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)?.tasks.map((t) => t.name) ?? []
  const manifests = (h: ReturnType<typeof taskHarness>) =>
    readdirSync(join(h.depsFolder, '.simple-code', 'tasks')).filter((f) => f.endsWith('.json'))

  it('主任务在跑时点关闭：照样关掉（对照：v3 这里拒绝）', async () => {
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const h = taskHarness({ mainEvents: [{ type: 'text_delta', text: '主干在跑' }], mainHang: () => blocked })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '跑着也能关' })
    await settle()
    const name = taskNames(h)[0] as string
    h.bridge.handle({ type: 'send', text: '主任务开跑' })
    await settle()
    h.posted.length = 0
    h.bridge.handle({ type: 'task_close', name })
    for (let i = 0; i < 4; i++) await settle()
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(false)
    expect(manifests(h)).toHaveLength(0)
    expect(h.taskFake.calls).toContain('close')
    release()
    await settle()
  })

  it('fork 撞锁（主任务摘要器在写库）→ 退避重试后开成', async () => {
    const h = taskHarness({ realStore: true })
    h.bridge.handle({ type: 'ready' })
    await settle()
    // 另一连接持写锁 = 对话空闲摘要器的写事务
    const holder = new DatabaseSync(join(h.depsFolder, MEMORY_RELATIVE, 'state.db'))
    holder.exec('BEGIN IMMEDIATE')
    h.bridge.handle({ type: 'task_dispatch', brief: '撞锁开任务' })
    await new Promise((r) => setTimeout(r, 200))
    holder.exec('COMMIT')
    holder.close()
    await new Promise((r) => setTimeout(r, 500))
    for (let i = 0; i < 6; i++) await settle()
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(false)
    const last = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(last?.tasks.map((t) => t.name)).toContain('撞锁开任务')
  })

  it('fork 一直撞锁 → fatal「开任务失败」，不留半个任务', async () => {
    const h = taskHarness({ realStore: true })
    h.bridge.handle({ type: 'ready' })
    await settle()
    const holder = new DatabaseSync(join(h.depsFolder, MEMORY_RELATIVE, 'state.db'))
    holder.exec('BEGIN IMMEDIATE')
    h.bridge.handle({ type: 'task_dispatch', brief: '永远锁着' })
    await new Promise((r) => setTimeout(r, 1100))
    holder.exec('ROLLBACK')
    holder.close()
    for (let i = 0; i < 4; i++) await settle()
    const fatal = h.posted.find((m): m is Extract<ToWebview, { type: 'fatal' }> => m.type === 'fatal')
    expect(fatal?.message).toContain('开任务失败')
    expect(fatal?.message).toContain('database is locked')
    expect(h.posted.some((m) => m.type === 'tasks' && m.tasks.length > 0)).toBe(false)
    // 重试期间占的名字已释放：锁放开后同名能再开
    h.bridge.handle({ type: 'task_dispatch', brief: '永远锁着' })
    for (let i = 0; i < 6; i++) await settle()
    const last = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(last?.tasks.map((t) => t.name)).toContain('永远锁着')
  })

  it('插话失败 → 撤掉气泡、任务视图出常驻提示，下次发话清掉', async () => {
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const h = taskHarness({ taskEvents: [] })
    let n = 0
    ;(h.taskFake.session as unknown as { send: (t: string) => AsyncGenerator<{ type: string }> })
      .send = (_t: string) => {
      n++
      if (n === 1)
        return (async function* () {
          await blocked
        })()
      return (async function* () {
        throw new Error('loop 已坏')
      })()
    }
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '插话目标' })
    for (let i = 0; i < 4; i++) await settle()
    h.bridge.handle({ type: 'task_send', task: '插话目标', text: '顺便看下这个' })
    for (let i = 0; i < 4; i++) await settle()
    const hydrate = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
      .at(-1)
    const items = hydrate?.items ?? []
    expect(items.some((i) => i.kind === 'user' && i.text === '顺便看下这个')).toBe(false)
    expect(hydrate?.queued ?? [], '排队气泡也撤掉').toEqual([])
    const notice = items.find((i) => i.kind === 'notice')
    expect(notice).toMatchObject({ kind: 'notice', errorKind: '插话失败' })
    expect((notice as { text: string }).text).toContain('顺便看下这个')
    expect((notice as { text: string }).text).toContain('loop 已坏')
    release()
    for (let i = 0; i < 6; i++) await settle()
    // 轮末 fold 不清它（常驻）；用户再发话才清
    h.posted.length = 0
    h.bridge.handle({ type: 'task_open', task: '插话目标' })
    for (let i = 0; i < 4; i++) await settle()
    const reopened = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
      .at(-1)
    expect(reopened?.items.some((i) => i.kind === 'notice')).toBe(true)
  })

  it('停止 → 分身 session interrupt', async () => {
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const h = taskHarness({ taskEvents: [] })
    // 分身挂住不结束：send 之后不放
    ;(h.taskFake.session as unknown as { send: (t: string) => AsyncGenerator<{ type: string }> })
      .send = (_t: string) =>
      (async function* () {
        await blocked
      })()
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '长任务' })
    await settle()
    const name = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)?.tasks[0]?.name
    expect(name).toBeDefined()
    h.bridge.handle({ type: 'task_stop', name: name as string })
    await settle()
    expect(h.taskFake.calls).toContain('interrupt')
    release()
    await settle()
  })

  it('关闭中发消息被拒：不另起一轮、状态不被改回 running', async () => {
    const h = taskHarness({})
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '关闭中别再跑' })
    for (let i = 0; i < 4; i++) await settle()
    // 关闭的摘要排空要调 LLM，窗口很长：让它挂住
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(h.taskFake.session as unknown as { summarizeIdle: () => Promise<void> }).summarizeIdle =
      async () => {
        h.taskFake.calls.push('summarizeIdle')
        await gate
      }
    h.bridge.handle({ type: 'task_close', name: '关闭中别再跑' })
    for (let i = 0; i < 4; i++) await settle()
    const sendsBefore = h.taskFake.calls.filter((c) => c.startsWith('send:')).length
    h.bridge.handle({ type: 'task_send', task: '关闭中别再跑', text: '再干点活' })
    for (let i = 0; i < 4; i++) await settle()
    // 关闭中发消息被拒（宿主闸），不另起一轮、状态不被改回 running
    expect(h.taskFake.calls.filter((c) => c.startsWith('send:')).length).toBe(sendsBefore)
    const last = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(last?.tasks.find((t) => t.name === '关闭中别再跑')?.status).toBe('closing')
    expect(h.posted.some((m) => m.type === 'fatal' && m.message.includes('正在关闭'))).toBe(true)
    release()
    for (let i = 0; i < 6; i++) await settle()
  })

  it('runlog 对账（2026-09-30 补观测）：fork 记身份与父任务、摘要失败逐条记原因、close 记轮数/耗时/改动行数', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../../core/src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      const h = taskHarness({})
      h.bridge.handle({ type: 'ready' })
      await settle()
      h.bridge.handle({ type: 'task_dispatch', brief: '摘要会挂' })
      await settle()
      const fork = calls.find((c) => c.ev === 'task_fork')
      expect(fork).toMatchObject({ parent: '', via: 'user' }) // 在主任务 tab 里开的
      expect(typeof fork?.ms).toBe('number')
      // 开任务不开段：段等第一轮开始（store beginTurn）才开（规则 13，core task.test 有真库用例）
      expect(calls.some((c) => c.ev === 'segment_open' && c.owner === fork?.owner)).toBe(false)
      await h.bridge.dispatchFromAgent('agent 派的', '')
      expect(calls.filter((c) => c.ev === 'task_fork').at(-1)).toMatchObject({
        via: 'agent',
        parent: '',
      })
      const s = h.taskFake.session as unknown as { summarizeIdle: () => Promise<boolean>; summaryDebt: () => boolean }
      s.summarizeIdle = async () => {
        throw new Error('摘要模型 503')
      }
      s.summaryDebt = () => true
      const name = h.posted
        .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
        .at(-1)
        ?.tasks.find((t) => t.name === '摘要会挂')?.name
      h.bridge.handle({ type: 'task_close', name: name as string })
      for (let i = 0; i < 6; i++) await settle()
      const fails = calls.filter((c) => c.ev === 'task_close_summary_fail')
      expect(fails).toHaveLength(3)
      expect(String(fails[0]?.error)).toContain('摘要模型 503')
      const close = calls.find((c) => c.ev === 'task_close')
      expect(close).toMatchObject({ rounds: 3, failures: 3, debtLeft: true })
      for (const k of ['ms', 'flipped', 'sumDeleted', 'msgDeleted', 'segments']) {
        expect(typeof close?.[k]).toBe('number')
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('关闭 → 摘要排空被调、manifest 删除、快照清空', async () => {
    const h = taskHarness({})
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '查完就关' })
    await settle()
    const name = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)?.tasks[0]?.name
    h.bridge.handle({ type: 'task_close', name: name as string })
    for (let i = 0; i < 4; i++) await settle()
    // 收尾调了摘要器（债清是关闭的一部分）+ session 关了
    expect(h.taskFake.calls).toContain('summarizeIdle')
    expect(h.taskFake.calls).toContain('close')
    // manifest 删了（任务不复存在）
    expect(
      readdirSync(join(h.depsFolder, '.simple-code', 'tasks')).filter((f) => f.endsWith('.json')),
    ).toHaveLength(0)
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks).toHaveLength(0)
  })

  it('分支可交互：idle 后 task_send 起新一轮（send 再次调用、再镜像）', async () => {
    const h = taskHarness({ taskEvents: [{ type: 'text_delta', text: '第一轮' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '调研分支' })
    await settle()
    await settle()
    h.posted.length = 0
    // 跑完 idle 后继续打字 = 分支的第二轮
    h.bridge.handle({ type: 'task_send', task: '调研分支', text: '接着说' })
    await settle()
    await settle()
    // 假 session 的 send 被再次调用（第一轮带框架句，第二轮原样）
    const sends = h.taskFake.calls.filter((c) => c.startsWith('send:'))
    expect(sends.at(-1)).toBe('send:接着说')
    // 第二轮的流也以 task_agent 镜像出来
    expect(h.posted.some((m) => m.type === 'task_agent')).toBe(true)
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks[0]?.status).toBe('idle')
  })

  it('分支跑着时 task_send → 插话（session.send 直接入队，状态不降）', async () => {
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const h = taskHarness({ taskEvents: [] })
    ;(h.taskFake.session as unknown as { send: (t: string) => AsyncGenerator<{ type: string }> })
      .send = (t: string) => {
      h.taskFake.calls.push(`send:${t}`)
      return (async function* () {
        await blocked
      })()
    }
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '长活' })
    await settle()
    h.bridge.handle({ type: 'task_send', task: '长活', text: '插一句' })
    await settle()
    await settle()
    // 插话路径：send 第二次被调（真实 session 里这条是空流、入队即返回）
    expect(h.taskFake.calls.filter((c) => c.startsWith('send:')).at(-1)).toBe('send:插一句')
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks[0]?.status).toBe('running')
    release()
    await settle()
  })

  it('**分支插话等 input_delivered 才摆进镜像**：投递前在 queued，投递后排在 core 投递的位置', async () => {
    // 同 bridge 那条（2026-10-31 真机：实时与 reload 后插话位置相反）
    let open!: () => void
    const gate = new Promise<void>((r) => {
      open = r
    })
    let release!: () => void
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const h = taskHarness({ taskEvents: [] })
    let calls = 0
    ;(h.taskFake.session as unknown as { send: (t: string) => AsyncGenerator<{ type: string }> }).send = (
      t: string,
    ) => {
      h.taskFake.calls.push(`send:${t}`)
      const first = calls++ === 0
      return (async function* () {
        if (!first) return // 插话：真实 session 入队即返回空流
        yield { type: 'tool_input_start', id: 't1', name: 'bash' }
        await gate // 工具跑着时插话
        yield { type: 'input_delivered' } // loop 顶出队
        yield { type: 'text_start' }
        await blocked
      })()
    }
    const reopen = async () => {
      h.posted.length = 0
      h.bridge.handle({ type: 'task_open', task: '长活' })
      await settle()
      return h.posted.find((m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate')
    }
    const shape = (items: ChatItem[] = []): string[] => {
      const from = items.findIndex((i) => i.kind === 'user' && i.text === '长活')
      return items.slice(from).map((i) => (i.kind === 'user' ? `user:${i.text}` : i.kind))
    }
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '长活' })
    await settle()
    await settle()
    h.bridge.handle({ type: 'task_send', task: '长活', text: '插一句' })
    await settle()
    await settle()

    const queued = await reopen()
    expect(shape(queued?.items)).toEqual(['user:长活', 'tool'])
    expect(queued?.queued).toEqual([{ kind: 'user', text: '插一句', interject: true }])

    open()
    await settle()
    const delivered = await reopen()
    expect(shape(delivered?.items)).toEqual(['user:长活', 'tool', 'user:插一句', 'assistant'])
    expect(delivered?.queued ?? []).toEqual([])
    const items = delivered?.items ?? []
    expect(items.find((i) => i.kind === 'user' && i.text === '长活')).not.toHaveProperty('interject')
    expect(items.find((i) => i.kind === 'user' && i.text === '插一句')).toMatchObject({ interject: true })
    release()
    await settle()
    // 轮结束 fold：插话已落库（基线重读），queued 清空，不再重复画
    expect((await reopen())?.queued ?? []).toEqual([])
  })

  it('task_open → 补一份 task_hydrate 基线（选中分支时宿主是唯一真相）', async () => {
    const h = taskHarness({ taskEvents: [{ type: 'text_delta', text: '分支经历' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '要看的分支' })
    await settle()
    await settle()
    h.posted.length = 0
    h.bridge.handle({ type: 'task_open', task: '要看的分支' })
    await settle()
    const hydrate = h.posted.find(
      (m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate',
    )
    expect(hydrate).toBeDefined()
    expect(hydrate?.name).toBe('要看的分支')
    // 内容来自 mirror（baseItems=historyRows + replay）。假 session 的
    // historyRows 是空数组、fold 已清 replay，所以基线为空——真库才有
    // 内容；这里只验「选中就有基线可拿」，内容正确性归 events.test
  })

  it('一轮跑完后切走再切回（task_open 重推基线）：底栏的用量与首字/总耗时还在', async () => {
    // 2026-09-23 真机：任务输入框下的「首字 · 总 · ↑↓」切换任务再切回就没了。
    // 轮末 fold 清空 replay，task_hydrate 原来只带 items，webview 整体替换
    // 后 lastTiming 归 null；跑到一半切回则只剩 step_finish，显示 0ms
    const h = taskHarness({
      taskEvents: [
        { type: 'text_delta', text: '答' },
        { type: 'request_timing', ttftMs: 321, totalMs: 4567 } as never,
        {
          type: 'step_finish',
          usage: { inputTokens: 12, outputTokens: 1100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 },
          contextTokens: 50_000,
        } as never,
      ],
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '量一下' })
    await settle()
    await settle()
    h.posted.length = 0
    h.bridge.handle({ type: 'task_open', task: '量一下' })
    await settle()
    const hy = h.posted.find(
      (m): m is Extract<ToWebview, { type: 'task_hydrate' }> => m.type === 'task_hydrate',
    )
    expect(hy?.lastTiming).toEqual({ ttftMs: 321, totalMs: 4567, inputTokens: 12, outputTokens: 1100 })
    expect(hy?.contextTokens).toBe(50_000)
  })

  it('setModel 带 task → 打到分支 session，不动主干', async () => {
    const h = taskHarness({ taskEvents: [] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '换模型的分支' })
    await settle()
    h.bridge.handle({ type: 'setModel', choice: { provider: 'p', model: 'other' }, task: '换模型的分支' })
    await settle()
    expect(h.taskFake.calls.some((c) => c.startsWith('setModel:'))).toBe(true)
  })

  it('不限数（task-trunk）：连开 6 个都受理，tasks 快照不再带 limit', async () => {
    const h = taskHarness({ taskEvents: [] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    for (const brief of ['一', '二', '三', '四', '五', '六']) {
      h.bridge.handle({ type: 'task_dispatch', brief })
      await settle()
    }
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(false)
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks).toHaveLength(6)
    expect(snap && 'limit' in snap).toBe(false)
    h.bridge.handle({ type: 'task_close', name: '二' })
    for (let i = 0; i < 4; i++) await settle()
    const after = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(after?.tasks).toHaveLength(5)
  })

  it('带 task 的 get_regions 走任务 session 的 memoryRoot', async () => {
    // 路由回归：bridge 曾用 session.root（永远=工作区）读。v3 任务与对话
    // 同 root，但「带 task 必须走 sessionOf」这条路由仍要锁住——fake 的
    // memoryRoot 被指到探针目录，断言读到的是探针那份
    const h = taskHarness({})
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '分区探针' })
    await settle()
    const folder = h.depsFolder
    const probe = join(folder, 'probe-root')
    ;(h.taskFake.session as unknown as { setMemoryRoot: (d: string) => void }).setMemoryRoot(probe)
    // 任务行带自己的 owner（recordRegions 的写侧口径，≠ 人起的任务名）；
    // 主 root 那行不带（老行=主任务）——顺带锁住「不串台」：任务视图
    // 不该读到主 root 的 111
    const line = (hot: number, owner?: string) =>
      JSON.stringify({
        at: '2026-09-22T00:00:00.000Z',
        hot,
        warm: 0,
        cold: 0,
        floor: 0,
        ...(owner ? { owner } : {}),
      })
    mkdirSync(join(folder, '.simple-code', 'memory'), { recursive: true })
    writeFileSync(join(folder, '.simple-code', 'memory', 'regions.jsonl'), line(111) + '\n')
    mkdirSync(join(probe, '.simple-code', 'memory'), { recursive: true })
    writeFileSync(
      join(probe, '.simple-code', 'memory', 'regions.jsonl'),
      line(222, 'task-分区探针') + '\n',
    )
    h.bridge.handle({ type: 'get_regions', task: '分区探针' })
    for (let i = 0; i < 3; i++) await settle()
    const got = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'regions' }> => m.type === 'regions')
      .at(-1)
    // info 只依赖 tail（与 historyRows 无关）：读对文件必有 hot=222
    expect(got?.info && 'hot' in (got.info as object) ? (got.info as { hot: number }).hot : null)
      .toBe(222)
  })

  it('恢复：manifest 在，重建 bridge 后任务回条上（idle、惰性不建 session）', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sc-taskrestore-'))
    {
      const h = taskHarness({ folder })
      h.bridge.handle({ type: 'ready' })
      await settle()
      h.bridge.handle({ type: 'task_dispatch', brief: '重启前开的分支' })
      await settle()
      // bridge 关掉（dispose 不删目录）——目录和 manifest 留在 deps.folder
    }
    const h2 = taskHarness({ folder })
    h2.bridge.handle({ type: 'ready' })
    await settle()
    await settle()
    await settle()
    const snap = h2.posted.find(
      (m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks',
    )
    expect(snap?.tasks).toHaveLength(1)
    expect(snap?.tasks[0]?.name).toBe('重启前开的分支')
    expect(snap?.tasks[0]?.status).toBe('idle')
    // 恢复的分支惰性：没人用时 task session 不建
    expect(h2.built).not.toContain('task')
    // 切进去（task_open）即建：否则 reload 后视图空白，继承历史 fold 不进来
    // （2026-09-23 实测回归）。建好后再推一次基线
    const hydratesBefore = h2.posted.filter((m) => m.type === 'task_hydrate').length
    h2.bridge.handle({ type: 'task_open', task: '重启前开的分支' })
    for (let i = 0; i < 4; i++) await settle()
    expect(h2.built).toContain('task')
    expect(h2.posted.filter((m) => m.type === 'task_hydrate').length).toBeGreaterThanOrEqual(hydratesBefore + 2)
  })

  it('审批分支级：关分支的开关 → TaskState.approvalOn=false，主干开关不动', async () => {
    const h = taskHarness({})
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '要关审批的分支' })
    await settle()
    h.bridge.handle({ type: 'setApprovalEnabled', on: false, task: '要关审批的分支' })
    await settle()
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks[0]?.approvalOn).toBe(false)
    // 主干的 state 里 approvalOn 仍是 true（分流没串）
    const st = h.posted.find(
      (m): m is Extract<ToWebview, { type: 'state' }> => m.type === 'state',
    )
    expect(st?.approvalOn).toBe(true)
  })

  it('TaskState.presets 取任务 session 自己的模型（不借主干——presets 按模型配）', async () => {
    const h = taskHarness({})
    ;(h.taskFake.session as unknown as Record<string, unknown>).presetState = () => ({
      current: undefined,
      available: ['line-a'],
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '换了模型的分支' })
    await settle()
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks[0]?.presets).toEqual(['line-a'])
  })

  it('TaskState.imagesEnabled 取任务 session 自己的模型（直收图或配了 visionModel，同主干判据）', async () => {
    const snapWith = async (images: boolean, vision: unknown): Promise<boolean | undefined> => {
      const h = taskHarness({})
      const base = h.taskFake.session.config
      Object.defineProperty(h.taskFake.session, 'config', {
        get: () => ({ ...base, vision, model: { ...base.model, capabilities: { images } } }),
      })
      h.bridge.handle({ type: 'ready' })
      await settle()
      h.bridge.handle({ type: 'task_dispatch', brief: '看图的分支' })
      await settle()
      return h.posted
        .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
        .at(-1)?.tasks[0]?.imagesEnabled
    }
    expect(await snapWith(true, null)).toBe(true)
    expect(await snapWith(false, null)).toBe(false)
    expect(await snapWith(false, { model: 'v' })).toBe(true)
  })

  it('分支模型持久化：setModel 带 task → choiceStore 落键（任务目录）', async () => {
    const h = taskHarness({})
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '选模型的分支' })
    await settle()
    h.bridge.handle({ type: 'setModel', choice: { provider: 'p', model: 'm2' }, task: '选模型的分支' })
    await settle()
    const dirs = [...choiceStoreOf(h).keys()]
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toMatch(/task-/)
  })

  it('关闭失败（session.close 抛）→ fatal 提示、任务保留在条上（可重试）', async () => {
    const h = taskHarness({})
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '不会成功' })
    await settle()
    const name = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)?.tasks[0]?.name
    ;(h.taskFake.session as unknown as { close: () => Promise<void> }).close = async () => {
      throw new Error('boom')
    }
    h.posted.length = 0
    h.bridge.handle({ type: 'task_close', name: name as string })
    for (let i = 0; i < 5; i++) await settle()
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(true)
    // 任务还在（idle）——关闭失败不是任务消失
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks[0]?.status).toBe('idle')
  })

  it('关闭成功 → 双击防重入不报错，owner 还俗（对话视角可见任务段）', async () => {
    const h = taskHarness({ realStore: true })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '会成功' })
    for (let i = 0; i < 3; i++) await settle()
    const name = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)?.tasks[0]?.name
    h.posted.length = 0
    h.bridge.handle({ type: 'task_close', name: name as string })
    // 第二击紧跟着来（真机双击场景——closing 状态吞掉第二击）
    h.bridge.handle({ type: 'task_close', name: name as string })
    for (let i = 0; i < 6; i++) await settle()
    // 双击不产生 fatal（closing 防重入吞掉第二击）
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(false)
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks).toHaveLength(0)
    // owner 还俗：库里再无一行的 owner 非空
    const db = new DatabaseSync(join(h.depsFolder, '.simple-code', 'memory', 'state.db'))
    const owners = db.prepare('SELECT COUNT(*) AS c FROM turns WHERE owner IS NOT NULL').get() as {
      c: number
    }
    db.close()
    expect(owners.c).toBe(0)
  })

  it('attach 时补任务快照和面板基线（rehydrate）', async () => {
    const h = taskHarness({ taskEvents: [{ type: 'text_delta', text: '基线' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '补基线任务' })
    await settle()
    await settle()
    h.posted.length = 0
    h.bridge.attach()
    await settle()
    expect(h.posted.some((m) => m.type === 'tasks')).toBe(true)
    expect(h.posted.some((m) => m.type === 'task_hydrate')).toBe(true)
  })
})

describe('完成回调（task-trunk 规则 12）', () => {
  const mailbox = (folder: string): { owner: string; text: string }[] => {
    const db = new DatabaseSync(join(folder, MEMORY_RELATIVE, 'state.db'))
    const rows = db.prepare(`SELECT owner, text FROM task_results ORDER BY id`).all() as {
      owner: string
      text: string
    }[]
    db.close()
    return rows
  }
  const manifestOf = (folder: string): Record<string, unknown> => {
    const dir = join(folder, '.simple-code', 'tasks')
    const file = readdirSync(dir).find((f) => f.endsWith('.json')) ?? ''
    return JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
  }
  const settleN = async (n = 6): Promise<void> => {
    for (let i = 0; i < n; i++) await settle()
  }

  it('主任务派的任务：派出那一轮结束投一次给主任务（状态 + 最后回复原文），戳主任务取走；第二轮不再投', async () => {
    const h = taskHarness({ realStore: true, taskEvents: [{ type: 'text_delta', text: '查完了：结论在此' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'send', text: '先说一句' }) // 建主任务 session
    await settleN()
    const takesBefore = h.mainTakes()
    await h.bridge.dispatchFromAgent('调研某库', '')
    await settleN()
    expect(mailbox(h.depsFolder)).toEqual([{ owner: '', text: '〔任务结果〕调研某库 · 完成\n查完了：结论在此' }])
    expect(manifestOf(h.depsFolder).callback).toBe('done')
    expect(h.mainTakes()).toBeGreaterThan(takesBefore) // 戳了主任务
    // 第二轮（用户切进任务接着说）：不再回调
    h.bridge.handle({ type: 'task_send', task: '调研某库', text: '再查一点' })
    await settleN()
    expect(mailbox(h.depsFolder)).toHaveLength(1)
  })

  it('主任务 session 还没建（面板未 attach：reload 恢复时补的回调、后台目录的任务）：回调到时建出来取走，不等用户下一句', async () => {
    // 不发 ready：attach 会顺手建主任务 session，那就测不到 pending===null 这条路
    const h = taskHarness({ realStore: true, taskEvents: [{ type: 'text_delta', text: '结论' }] })
    expect(h.mainTakes()).toBe(0)
    await h.bridge.dispatchFromAgent('没说话就开', '')
    await settleN()
    expect(mailbox(h.depsFolder)).toHaveLength(1)
    expect(h.mainTakes()).toBeGreaterThan(0) // 修前：pending===null 直接 return，信箱干等
  })

  it('轮内出错 → 状态写「出错」', async () => {
    const h = taskHarness({
      realStore: true,
      taskEvents: [{ type: 'error', message: '上游 500' }],
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    await h.bridge.dispatchFromAgent('会出错的', '')
    await settleN()
    expect(mailbox(h.depsFolder)[0]?.text).toMatch(/^〔任务结果〕会出错的 · 出错：上游 500\n/)
  })

  it('任务里派的任务回调给派它的任务（owner 键），不给主任务', async () => {
    const h = taskHarness({ realStore: true })
    h.bridge.handle({ type: 'ready' })
    await settle()
    await h.bridge.dispatchFromAgent('父', '')
    await settleN()
    const parentOwner = String(manifestOf(h.depsFolder).owner)
    await h.bridge.dispatchFromAgent('子', parentOwner)
    await settleN()
    const rows = mailbox(h.depsFolder)
    expect(rows.map((r) => r.owner)).toEqual(['', parentOwner]) // 父回主任务、子回父
    expect(rows[1]?.text.startsWith('〔任务结果〕子 · 完成')).toBe(true)
  })

  it('派出那一轮被停止键打断 → 状态写「被停止」，带停之前的回复', async () => {
    let release = (): void => {}
    const h = taskHarness({
      realStore: true,
      taskEvents: [{ type: 'text_delta', text: '做到一半' }],
      taskHang: () => new Promise<void>((r) => (release = r)),
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    await h.bridge.dispatchFromAgent('长活', '')
    await settleN()
    expect(mailbox(h.depsFolder)).toEqual([]) // 还在跑：不投
    h.bridge.handle({ type: 'task_stop', name: '长活' })
    await settle()
    release() // 假 session 没有真中断：放行即「中断后流结束」
    await settleN()
    expect(mailbox(h.depsFolder)).toEqual([{ owner: '', text: '〔任务结果〕长活 · 被停止\n做到一半' }])
  })

  it('登记者已关闭（manifest 里的 parent 已不在）：不投，标已回调', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sc-taskcb-'))
    const { createTask } = await import('@simple-code/core')
    createTask(folder, '孤儿', { parent: 'task-gone' })
    const h = taskHarness({ folder })
    h.bridge.handle({ type: 'ready' })
    await settleN()
    expect(mailbox(folder)).toEqual([])
    expect(manifestOf(folder).callback).toBe('done')
  })

  it('agent 派任务（$SIMPLE_CODE_TASK）：进任务条、同名自动编号不拒、回调给派它的会话', async () => {
    const h = taskHarness({ realStore: true, taskEvents: [{ type: 'text_delta', text: '子结论' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    const a = await h.bridge.dispatchFromAgent('查 A 库\n细节', '')
    const b = await h.bridge.dispatchFromAgent('查 A 库\n另一个角度', '')
    expect(a).toEqual({ ok: true, name: '查 A 库' })
    expect(b).toEqual({ ok: true, name: '查 A 库 2' })
    await settleN()
    const snap = h.posted.filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks').at(-1)
    expect(snap?.tasks.map((t) => t.name).sort()).toEqual(['查 A 库', '查 A 库 2'])
    expect(mailbox(h.depsFolder).map((r) => r.text.split('\n')[0])).toEqual([
      '〔任务结果〕查 A 库 · 完成',
      '〔任务结果〕查 A 库 2 · 完成',
    ])
    // 用户 /task 同名仍拒（行为不变，对照）
    h.bridge.handle({ type: 'task_dispatch', brief: '查 A 库' })
    await settle()
    expect(h.posted.some((m) => m.type === 'fatal' && m.message.includes('已有同名任务'))).toBe(true)
  })

  it('用户开的任务（/task、反思按钮）不登记、不回调；agent 派的照常回调（对照）', async () => {
    // 10-30 用户订正规则 12：只有 SC 派出的任务回调。修前三个用户入口都传 parent
    // 就登记，真机用户开的任务回调进主任务三次
    const h = taskHarness({ realStore: true, taskEvents: [{ type: 'text_delta', text: '结论' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '用户开的' })
    await settleN()
    expect(manifestOf(h.depsFolder)).not.toHaveProperty('parent')
    expect(manifestOf(h.depsFolder)).not.toHaveProperty('callback')
    h.bridge.handle({ type: 'reflect_start' })
    await settleN()
    expect(h.posted.some((m) => m.type === 'reflect_result' && m.ok)).toBe(true)
    expect(mailbox(h.depsFolder)).toEqual([])
    await h.bridge.dispatchFromAgent('agent 派的', '')
    await settleN()
    expect(mailbox(h.depsFolder)).toEqual([{ owner: '', text: '〔任务结果〕agent 派的 · 完成\n结论' }])
  })

  it('agent 派任务带 --model（规则 14）：建会话时先套模型与档位再跑、存进 choiceStore；列表外拒绝不建；不写不套（对照）', async () => {
    const h = taskHarness({ taskModels: [{ provider: 'p', model: 'm2', effort: 'low', use: '查' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    expect(await h.bridge.dispatchFromAgent('指定模型', '', 'm2')).toEqual({ ok: true, name: '指定模型' })
    await settleN()
    const calls = h.taskFake.calls
    const setAt = calls.indexOf('setModel:{"provider":"p","model":"m2","effort":"low"}')
    expect(setAt).toBeGreaterThanOrEqual(0)
    expect(calls).toContain('setEffort:low')
    expect(setAt).toBeLessThan(calls.findIndex((c) => c.startsWith('send:'))) // 第一轮之前就套上
    expect([...choiceStoreOf(h).keys()]).toHaveLength(1)
    const miss = await h.bridge.dispatchFromAgent('列表外', '', 'gpt-9')
    expect(miss).toMatchObject({ ok: false, error: expect.stringContaining('不在 taskModels 里') })
    expect(await h.bridge.dispatchFromAgent('不指定', '')).toEqual({ ok: true, name: '不指定' })
    await settleN()
    expect(calls.filter((c) => c.startsWith('setModel:'))).toHaveLength(1)
    const snap = h.posted.filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks').at(-1)
    expect(snap?.tasks.map((t) => t.name).sort()).toEqual(['不指定', '指定模型'])
  })

  it('bin --models 报的默认 = 建会话时的配置默认，不是主任务切换后的模型（10-30 真机误报）', async () => {
    const models = [{ provider: 'p', model: 'm2', use: '查' }]
    // 主任务当前 config 是 p/m（模拟切换后），配置默认是 p/m0
    const h = taskHarness({ taskModels: models, mainDefault: { provider: 'p', model: 'm0' } })
    expect(await h.bridge.taskModels()).toEqual({ ok: true, models, defaultModel: 'p/m0' })
    const same = taskHarness({ taskModels: models }) // 对照：没切过，两者相同
    expect(await same.bridge.taskModels()).toEqual({ ok: true, models, defaultModel: 'p/m' })
  })

  it('派出那一轮被 reload 打断（manifest 仍 pending）：恢复时补一次「被停止」回调', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sc-taskcb-'))
    {
      const h = taskHarness({ folder, realStore: true })
      h.bridge.handle({ type: 'ready' })
      await settle()
    }
    const { createTask } = await import('@simple-code/core')
    createTask(folder, '被打断的', { parent: '' })
    const h2 = taskHarness({ folder })
    h2.bridge.handle({ type: 'ready' })
    await settleN()
    expect(mailbox(folder)).toEqual([{ owner: '', text: '〔任务结果〕被打断的 · 被停止（窗口重载打断）\n（没有回复文本）' }])
    expect(manifestOf(folder).callback).toBe('done')
  })

  it('恢复时读最后回复抛错（坏行）：回调照补、正文留空，任务中心照常起来', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sc-taskcb-'))
    {
      const h = taskHarness({ folder, realStore: true })
      h.bridge.handle({ type: 'ready' })
      await settle()
    }
    const { createTask, scopeOf } = await import('@simple-code/core')
    const m = createTask(folder, '坏行的', { parent: '' })
    const s = openStore(folder, { task: scopeOf(m) })
    const turn = s.beginTurn({ model: 'p/m', effort: null })
    s.save([
      { role: 'user', parts: [{ type: 'text', text: '问' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '答' }] },
    ])
    s.finishTurn(turn, 1, 'done')
    s.close()
    const db = new DatabaseSync(join(folder, MEMORY_RELATIVE, 'state.db'))
    db.prepare(
      `UPDATE messages SET content_json = '{坏' WHERE owner = ? AND role = 'assistant'`,
    ).run(m.owner)
    db.close()
    const h2 = taskHarness({ folder })
    h2.bridge.handle({ type: 'ready' })
    await settleN()
    expect(mailbox(folder)).toEqual([
      { owner: '', text: '〔任务结果〕坏行的 · 被停止（窗口重载打断）\n（没有回复文本）' },
    ])
    expect(manifestOf(folder).callback).toBe('done')
  })

  /** 发给任务 session 的原文（fake 记成 send:<text>） */
  const sentOf = (h: ReturnType<typeof taskHarness>): string[] =>
    h.taskFake.calls.filter((c) => c.startsWith('send:')).map((c) => c.slice('send:'.length))

  it('只输名称开空任务（规则 13）：idle 不跑，可先切模型；第一条拼框架句只拼一次；用户开的不回调', async () => {
    const h = taskHarness({ realStore: true, taskEvents: [{ type: 'text_delta', text: '空任务答' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_create', name: '空任务' })
    await settleN()
    const snap = h.posted.filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks').at(-1)
    expect(snap?.tasks.map((t) => [t.name, t.status])).toEqual([['空任务', 'idle']])
    expect(sentOf(h)).toEqual([]) // 建好不跑
    expect(manifestOf(h.depsFolder)).toMatchObject({ awaitingFirstMessage: true })
    expect(manifestOf(h.depsFolder)).not.toHaveProperty('callback')
    h.bridge.handle({ type: 'setModel', choice: { provider: 'p', model: 'm2' }, task: '空任务' })
    await settleN()
    expect(h.taskFake.calls).toContain('setModel:{"provider":"p","model":"m2"}')
    expect(sentOf(h)).toEqual([])
    h.bridge.handle({ type: 'task_send', task: '空任务', text: '第一句' })
    await settleN()
    const [first] = sentOf(h)
    expect(first?.startsWith('（task-空任务：你是一个独立任务')).toBe(true)
    expect(first?.endsWith('\n\n第一句')).toBe(true)
    expect(manifestOf(h.depsFolder).awaitingFirstMessage).toBeUndefined()
    expect(mailbox(h.depsFolder)).toEqual([]) // 第一轮结束也不回调
    h.bridge.handle({ type: 'task_send', task: '空任务', text: '第二句' })
    await settleN()
    expect(sentOf(h).at(-1)).toBe('第二句') // 不再拼
    expect(mailbox(h.depsFolder)).toEqual([])
  })

  it('老的空任务（10-30 前用户开的，manifest 仍 pending + awaitingFirstMessage）被 reload：恢复 idle、不补回调；第一条照样拼框架句', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'sc-taskcb-'))
    {
      const h = taskHarness({ folder, realStore: true })
      h.bridge.handle({ type: 'ready' })
      await settle()
    }
    const { createTask } = await import('@simple-code/core')
    createTask(folder, '没说话的', { parent: '', awaitingFirstMessage: true })
    const h2 = taskHarness({ folder })
    h2.bridge.handle({ type: 'ready' })
    await settleN()
    expect(mailbox(folder)).toEqual([]) // 对照：上一条用例里非空任务被打断会补「被停止」
    expect(manifestOf(folder)).toMatchObject({ awaitingFirstMessage: true, callback: 'pending' })
    h2.bridge.handle({ type: 'task_send', task: '没说话的', text: '开工' })
    await settleN()
    expect(sentOf(h2)[0]?.startsWith('（task-没说话的：')).toBe(true)
  })
})


describe('桌面机器人：任务的结局（desktop-robot.md §5.3）', () => {
  const taskOf = (h: ReturnType<typeof taskHarness>, name: string) =>
    h.bridge.robotView().tasks.find((t) => t.task === name)

  it('跑完：done + 最后一段回答；轮内 error 事件结束：error', async () => {
    const h = taskHarness({ taskEvents: [{ type: 'text_start' }, { type: 'text_delta', text: '调研完了。' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '调研某库' })
    await settle()
    await settle()
    expect(taskOf(h, '调研某库')).toMatchObject({ running: false, lastTurn: { end: 'done', text: '调研完了。' } })
    expect(taskOf(h, '调研某库')?.startedAt).toBeTypeOf('number')

    const e = taskHarness({ taskEvents: [{ type: 'error', message: 'PrefixBrokenError: 前缀被改写' }] })
    e.bridge.handle({ type: 'ready' })
    await settle()
    e.bridge.handle({ type: 'task_dispatch', brief: '会出错' })
    await settle()
    await settle()
    expect(taskOf(e, '会出错')?.lastTurn).toMatchObject({ end: 'error', text: 'PrefixBrokenError: 前缀被改写' })
  })

  it('会话建不起来（ensureSession 回 null，不走 catch）：也记 error，不误报 done', async () => {
    const h = taskHarness({ taskSessionErrors: Array.from({ length: 6 }, () => new Error('database is locked')) })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '永远撞锁' })
    await new Promise((r) => setTimeout(r, 900))
    for (let i = 0; i < 6; i++) await settle()
    expect(taskOf(h, '永远撞锁')?.lastTurn).toMatchObject({ end: 'error' })
    expect(taskOf(h, '永远撞锁')?.lastTurn?.text).toContain('会话建立失败')
  })
})
