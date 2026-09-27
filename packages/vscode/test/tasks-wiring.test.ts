/**
 * 任务的 bridge 接线（task-v3）。
 *
 * 引擎本身（owner 分治、号段、关闭流程）在 core 的 task.test.ts；
 * 这里只测宿主侧：派活闸门、task_agent 镜像、停止/关闭的 session
 * 生命周期、失败路径任务保留可重试、reload 恢复。
 */
import { describe, expect, it } from 'vitest'
import type { Session, SetTimer } from '@simple-code/core'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge } from '../src/bridge.ts'
import { MEMORY_RELATIVE, openStore } from '@simple-code/core'
import type { ToWebview } from '../src/protocol.ts'
import type { BridgeDeps } from '../src/bridge.ts'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 分身的假 session：send 产事件，interrupt/close 记调用 */
function fakeTaskSession(events: { type: string; text?: string; message?: string }[]) {
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
  /** 复用这个目录建 bridge（恢复测试：第一次留下的 task- 目录要被第二次
   *  扫到）。不传 = 独立临时目录 */
  folder?: string
  /** 造最小真主库（fork/merge 走真路径——纯 fake 环境里 merge 第一击
   *  就 fatal「主干还没有记忆」，测不了成功路径） */
  realStore?: boolean
  /** taskSession 工厂按次抛这些错（shift 取用），耗尽后返回正常 session。
   *  测 ensureSession 的 BUSY 重试与终态可见（2026-09-23 卡死回归） */
  taskSessionErrors?: Error[]
}) {
  const posted: ToWebview[] = []
  const mainCalls: string[] = []
  const taskFake = fakeTaskSession(options.taskEvents ?? [{ type: 'text_delta', text: '分身在干活' }])
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
            },
            model: { effort: 'high', capabilities: { images: false }, contextWindow: 200_000 },
            request: { effort: 'high' },
          }
        },
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
    store.finishTurn(t, 1)
    store.close()
  }
  const bridge = createBridge(deps)
  return { bridge, posted, taskFake, built, choiceStore, depsFolder: deps.folder as string, mainCalls }
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

  it('派活后 kick 一次私有压缩（继承段进场顶替，不阻塞 brief）', async () => {
    const h = taskHarness({ taskEvents: [{ type: 'text_delta', text: '第一轮' }] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '继承段压缩' })
    for (let i = 0; i < 4; i++) await settle()
    // dispatch 即 kick：不等 idle 30 秒，任务摘要器马上开始收继承段
    expect(h.taskFake.calls).toContain('summarizeIdle')
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
    const h = taskHarness({
      taskSessionErrors: Array.from({ length: 6 }, () => new Error('database is locked')),
    })
    h.bridge.handle({ type: 'ready' })
    await settle()
    h.bridge.handle({ type: 'task_dispatch', brief: '永远撞锁' })
    await new Promise((r) => setTimeout(r, 900))
    for (let i = 0; i < 6; i++) await settle()
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

  it('派活时主干在跑 → fatal 拒掉，不建任务', async () => {
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
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(true)
    expect(h.posted.some((m) => m.type === 'tasks')).toBe(false)
    expect(h.built).not.toContain('task')
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

  it('满 3 个：第 4 个派活 fatal 拒绝，tasks 消息带 limit（+ 入口显隐的真相）', async () => {
    const h = taskHarness({ taskEvents: [] })
    h.bridge.handle({ type: 'ready' })
    await settle()
    for (const brief of ['一', '二', '三']) {
      h.bridge.handle({ type: 'task_dispatch', brief })
      await settle()
    }
    h.bridge.handle({ type: 'task_dispatch', brief: '第四个' })
    await settle()
    expect(h.posted.some((m) => m.type === 'fatal')).toBe(true)
    // 第 4 个被拒不发新快照——最后一份 tasks 仍是 3 个 + limit
    const snap = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(snap?.tasks).toHaveLength(3)
    expect(snap?.limit).toBe(3)
    // 关一个就有位置了
    h.bridge.handle({ type: 'task_close', name: '二' })
    for (let i = 0; i < 4; i++) await settle()
    const after = h.posted
      .filter((m): m is Extract<ToWebview, { type: 'tasks' }> => m.type === 'tasks')
      .at(-1)
    expect(after?.tasks).toHaveLength(2)
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
