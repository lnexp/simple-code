import { describe, expect, it } from 'vitest'
import { createRouter, type RouterDeps } from '../src/router.ts'
import type { Bridge } from '../src/bridge.ts'
import type { ToHost, ToWebview } from '../src/protocol.ts'

/** 假 bridge：记录调用，post 全部转给路由注入的（测过滤） */
function makeFakeBridgeDeps() {
  const sent: ToWebview[] = []
  const calls: Array<{
    folder: string
    method: 'attach' | 'detach' | 'requestReload' | 'dispose' | 'rehydrateTasks' | 'taskModels' | `dispatch:${string}`
  }> = []
  let folders = ['/w/a', '/w/b']
  type Fake = Bridge & {
    _post: (m: ToWebview) => void
    _turnEnd: () => void
    _running: boolean
    _pending: number
    /** 挂着的卡的 toolCallId（allowToolCall 用）；放行的记进 _allowed */
    _cards: string[]
    _allowed: string[]
  }
  const made = new Map<string, Fake>()
  const deps: RouterDeps = {
    post: (m) => sent.push(m),
    folders: () => folders,
    saveFolder: () => {},
    createBridge: (folder, post, onTurnEnd) => {
      const b = {
        _post: post,
        _turnEnd: onTurnEnd,
        _running: false,
        _pending: 0,
        _cards: [] as string[],
        _allowed: [] as string[],
        attach: () => calls.push({ folder, method: 'attach' }),
        isRunning: () => made.get(folder)?._running ?? false,
        anyRunning: () => false,
        robotView: () => ({ tasks: [], approvals: [] }),
        allowToolCall: (id: string) => {
          const f = made.get(folder)
          if (!f?._cards.includes(id)) return false
          f._allowed.push(id)
          return true
        },
        pendingApprovals: () => made.get(folder)?._pending ?? 0,
        rehydrateTasks: () => calls.push({ folder, method: 'rehydrateTasks' }),
        handle: () => {},
        detach: () => calls.push({ folder, method: 'detach' }),
        requestReload: () => calls.push({ folder, method: 'requestReload' }),
        dispose: () => calls.push({ folder, method: 'dispose' }),
        dispatchFromAgent: async (brief: string, owner: string, model?: string) => {
          calls.push({ folder, method: `dispatch:${owner}:${brief}${model ? `:${model}` : ''}` })
          return { ok: true as const, name: brief }
        },
        taskModels: async () => {
          calls.push({ folder, method: 'taskModels' })
          return { ok: true as const, models: [], defaultModel: 'p/m' }
        },
      } as Fake
      made.set(folder, b)
      return b
    },
  }
  return { deps, sent, calls, setFolders: (f: string[]) => (folders = f), made }
}

describe('多根路由（router）', () => {
  it('tasks 快照触发 folders 重发（分身跑起来 → tab 绿点亮）', () => {
    const { deps, sent, made } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    const before = sent.filter((m) => m.type === 'folders').length
    // 分身状态变化：bridge 内部 postTasks 走 bridgePost → router 应重发 folders
    ;(made.get('/w/a') as unknown as { _post: (m: ToWebview) => void })._post({
      type: 'tasks',
      tasks: [{ name: 't', status: 'running' }],
    } as ToWebview)
    const after = sent.filter((m) => m.type === 'folders').length
    expect(after).toBe(before + 1)
  })

  it('agent 派任务按 root 交给那个文件夹的 bridge（后台目录也行）；没有 bridge 的目录拒绝', async () => {
    const { deps, calls } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' }) // spawn /w/a
    r.handle({ type: 'switchFolder', folder: '/w/b' }) // a 转后台
    expect(await r.dispatchFromAgent({ root: '/w/a', brief: '调研', owner: 'task-x1' })).toEqual({ ok: true, name: '调研' })
    expect(calls.filter((c) => c.method.startsWith('dispatch'))).toEqual([{ folder: '/w/a', method: 'dispatch:task-x1:调研' }])
    const miss = await r.dispatchFromAgent({ root: '/w/none', brief: '调研', owner: '' })
    expect(miss.ok).toBe(false)
    // --model 原文透传到那个文件夹的 bridge（规则 14）；--models 同样按 root 找
    await r.dispatchFromAgent({ root: '/w/a', brief: '查', owner: '', model: 'm2' })
    expect(calls.at(-1)).toEqual({ folder: '/w/a', method: 'dispatch::查:m2' })
    expect(await r.taskModels({ root: '/w/a' })).toEqual({ ok: true, models: [], defaultModel: 'p/m' })
    expect((await r.taskModels({ root: '/w/none' })).ok).toBe(false)
  })

  it('ready：spawn active=[0] 并 attach，推 folders 清单', () => {
    const { deps, sent } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    expect(sent.some((m) => m.type === 'folders' && m.active === '/w/a')).toBe(true)
    expect(sent.filter((m) => m.type === 'folders').length).toBe(1)
  })

  it('seed：上次选择在列表里则第一个 spawn 的就是它', () => {
    const { deps, sent } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.seed('/w/b')
    r.handle({ type: 'ready' })
    expect(sent.some((m) => m.type === 'folders' && m.active === '/w/b')).toBe(true)
  })

  it('switchFolder：旧的 detach、新的 attach、选择被保存', () => {
    const saved: string[] = []
    const { deps, calls, sent } = makeFakeBridgeDeps()
    ;(deps as { saveFolder: (f: string) => void }).saveFolder = (f) => saved.push(f)
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    expect(calls).toContainEqual({ folder: '/w/a', method: 'detach' })
    expect(calls).toContainEqual({ folder: '/w/b', method: 'attach' })
    expect(saved).toEqual(['/w/b'])
    // 先发清单再 attach：webview 下拉和 hydrate 一起到位
    const folderMsgAt = sent.findIndex((m) => m.type === 'folders' && m.active === '/w/b')
    expect(folderMsgAt).toBeGreaterThanOrEqual(0)
  })

  it('后台 bridge 的 post：只有审批消息放行且带 folder 标注，其余丢弃', () => {
    const { deps, sent, made } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' }) // active = /w/a
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    r.handle({ type: 'switchFolder', folder: '/w/a' }) // b 转后台
    const bg = made.get('/w/b')!
    bg._post({ type: 'state', running: true, folder: '/w/b', current: null, models: [], effort: null, effortOverridden: false,
      presets: [], approvalOn: true, imagesEnabled: false, contextWindow: 0 })
    bg._post({ type: 'agent', event: { type: 'text_delta', text: 'x' } as never, at: 1 })
    bg._post({ type: 'approval_request', id: 1, expiresAt: 1, command: 'rm /etc/x', toolCallId: 't', category: 'external_dir', detail: '/etc/x', reason: '项目外' })
    expect(sent.filter((m) => m.type === 'state').length).toBe(0)
    expect(sent.filter((m) => m.type === 'agent').length).toBe(0)
    const card = sent.find((m) => m.type === 'approval_request')
    expect(card).toMatchObject({ type: 'approval_request', folder: '/w/b', id: 1 })
  })

  it('approval_reply 带 folder 路由回原 bridge', () => {
    const { deps, made } = makeFakeBridgeDeps()
    const handled: ToHost[] = []
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    // b 的 handle 记录
    ;(made.get('/w/b')! as unknown as { handle: (m: ToHost) => void }).handle = (m) => handled.push(m)
    r.handle({ type: 'approval_reply', id: 3, choice: 'deny', folder: '/w/b' })
    expect(handled).toEqual([{ type: 'approval_reply', id: 3, choice: 'deny', folder: '/w/b' }])
  })

  it('bg_processes 后台目录也放行并注入 folder（webview 只更新那个桶）', () => {
    const { deps, sent, made } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' }) // spawn b（惰性：访问过才存在）
    r.handle({ type: 'switchFolder', folder: '/w/a' }) // b 转后台
    made.get('/w/b')!._post({
      type: 'bg_processes',
      items: [{ pgid: 42, pids: [42], label: '起服务', command: 'http.server', startedAt: 1 }],
    })
    const snap = sent.find((m) => m.type === 'bg_processes')
    expect(snap).toMatchObject({ type: 'bg_processes', folder: '/w/b' })
  })

  it('bg_kill 按 folder 路由回原 bridge（pid 的账在原目录 registry）', () => {
    const { deps, made } = makeFakeBridgeDeps()
    const handled: ToHost[] = []
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' }) // spawn b
    r.handle({ type: 'switchFolder', folder: '/w/a' }) // active 是 a
    ;(made.get('/w/b')! as unknown as { handle: (m: ToHost) => void }).handle = (m) => handled.push(m)
    r.handle({ type: 'bg_kill', pgid: 42, folder: '/w/b' })
    expect(handled).toEqual([{ type: 'bg_kill', pgid: 42, folder: '/w/b' }])
  })

  it('folders 推送带 running 状态（后台 ● 标记的数据源）', () => {
    const { deps, sent, made } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    r.handle({ type: 'switchFolder', folder: '/w/a' })
    const a = made.get('/w/a')!
    a._running = true
    a._turnEnd()
    const last = sent.filter((m) => m.type === 'folders').at(-1)
    expect(last).toMatchObject({
      type: 'folders',
      active: '/w/a',
      folders: [
        { path: '/w/a', running: true },
        { path: '/w/b', running: false },
      ],
    })
  })

  it('后台文件夹的待审批数随 folders 推出去（角标的数据来源）', () => {
    const { deps, sent, made } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' }) // active /w/a
    r.handle({ type: 'switchFolder', folder: '/w/b' }) // active /w/b，a 转后台
    const a = made.get('/w/a')!
    // a 在后台弹了两张卡：卡片本身不跨标签显示，但数字要到得了 UI
    a._pending = 2
    a._turnEnd() // bridge 在挂卡/关卡时调它，router 借此重推
    const last = sent.filter((m) => m.type === 'folders').at(-1)
    expect(last).toMatchObject({
      active: '/w/b',
      folders: [
        { path: '/w/a', pendingApprovals: 2 },
        { path: '/w/b', pendingApprovals: 0 },
      ],
    })
    // 答复/超时后角标要灭
    a._pending = 0
    a._turnEnd()
    expect(sent.filter((m) => m.type === 'folders').at(-1)).toMatchObject({
      folders: [
        { path: '/w/a', pendingApprovals: 0 },
        { path: '/w/b', pendingApprovals: 0 },
      ],
    })
  })

  it('setFolders：active 被移出工作区 → dispose 并回落 [0]；非 active 的移除 → dispose', () => {
    const { deps, calls, sent, setFolders } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' }) // active /w/a
    r.handle({ type: 'switchFolder', folder: '/w/b' }) // active /w/b，a bridge 活着（后台）
    setFolders(['/w/b', '/w/c'])
    r.setFolders()
    // a 被移出：它的 bridge dispose
    expect(calls).toContainEqual({ folder: '/w/a', method: 'dispose' })
    const last = sent.filter((m) => m.type === 'folders').at(-1)
    expect(last).toMatchObject({ active: '/w/b' })
    // active 被移出：回落 + attach 新的
    setFolders(['/w/c'])
    r.setFolders()
    expect(calls).toContainEqual({ folder: '/w/b', method: 'dispose' })
    const last2 = sent.filter((m) => m.type === 'folders').at(-1)
    expect(last2).toMatchObject({ active: '/w/c' })
    expect(calls).toContainEqual({ folder: '/w/c', method: 'attach' })
  })

  it('dispose：全部 bridge dispose', () => {
    const { deps, calls } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    r.dispose()
    expect(calls.filter((c) => c.method === 'dispose').length).toBe(2)
  })
})

describe('settings 热重载转发', () => {
  it('requestReloadAll 到所有已 spawn 的 bridge', () => {
    const { deps, calls } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    r.requestReloadAll()
    const methods = calls.filter((c) => c.method === 'requestReload').map((c) => c.folder).sort()
    expect(methods).toEqual(['/w/a', '/w/b'])
  })
})

describe('桌面机器人接口（desktop-robot.md §5.2、§5.5）', () => {
  it('allow 按 toolCallId 找到卡所在目录的 bridge；没有这张卡 = false', () => {
    const { deps, made } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    made.get('/w/b')!._cards = ['toolu_b']
    expect(r.allow('toolu_b')).toBe(true)
    expect(made.get('/w/b')!._allowed).toEqual(['toolu_b'])
    // 对照：a 目录的 bridge 没被放行任何东西；乱发的 id 批不了
    expect(made.get('/w/a')!._allowed).toEqual([])
    expect(r.allow('toolu_nope')).toBe(false)
  })

  it('focus：切到目录，select_task 排在切目录推的消息之后（不被「恢复上次选中」盖掉）', () => {
    const { deps, sent, calls } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    sent.length = 0
    r.focus('/w/b', 'DAG 运行记录')
    expect(calls.at(-1)).toEqual({ folder: '/w/b', method: 'attach' })
    expect(sent.map((m) => m.type)).toEqual(['folders', 'select_task'])
    expect(sent.at(-1)).toEqual({ type: 'select_task', task: 'DAG 运行记录' })
    // 不在工作区的目录：无操作
    sent.length = 0
    r.focus('/w/zzz', null)
    expect(sent).toEqual([])
  })

  it('webview 没就绪（面板关着、被 focus 命令拉起）：等 ready 直接落到目标目录再选任务', () => {
    const { deps, sent, calls } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    r.detachAll() // 面板关了
    sent.length = 0
    calls.length = 0
    r.focus('/w/b', null)
    // 前提：就绪前什么都没发（发了也会被 VS Code 丢掉）
    expect(sent).toEqual([])
    r.handle({ type: 'ready' })
    expect(calls.filter((c) => c.method === 'attach')).toEqual([{ folder: '/w/b', method: 'attach' }])
    expect(sent.at(-1)).toEqual({ type: 'select_task', task: null })
    expect(r.showing().folder).toBe('/w/b')
  })

  it('view_task 记下面板正显示的任务并通知；目录清单重推时也通知', () => {
    const { deps } = makeFakeBridgeDeps()
    let changes = 0
    const r = createRouter({ ...deps, onChange: () => changes++ })
    r.handle({ type: 'ready' })
    const afterReady = changes
    expect(afterReady).toBeGreaterThan(0)
    r.handle({ type: 'view_task', task: 'A' })
    expect(r.showing()).toEqual({ folder: '/w/a', task: 'A' })
    expect(changes).toBe(afterReady + 1)
  })

  it('robotFolders 只含建过 bridge 的目录，按工作区顺序', () => {
    const { deps } = makeFakeBridgeDeps()
    const r = createRouter(deps)
    r.handle({ type: 'ready' })
    expect(r.robotFolders().map((f) => f.folder)).toEqual(['/w/a'])
    r.handle({ type: 'switchFolder', folder: '/w/b' })
    expect(r.robotFolders().map((f) => f.folder)).toEqual(['/w/a', '/w/b'])
  })
})
