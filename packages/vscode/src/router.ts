import type {
  TaskDispatchRequest,
  TaskDispatchResponse,
  TaskModelsRequest,
  TaskModelsResponse,
  TaskSendListRequest,
  TaskSendListResponse,
  TaskSendRequest,
  TaskSendResponse,
  WakeRequest,
  WakeResponse,
} from '@simple-code/core'
import type { Bridge } from './bridge.ts'
import type { ToHost, ToWebview } from './protocol.ts'
import type { RobotFolderView } from './robot-feed.ts'
import { createWakeCenter } from './wake-center.ts'

/**
 * 多根工作区的文件夹路由（design.md §7）。
 *
 * 结构：**每个文件夹一个 bridge 实例**，本层持有 Map + active 指针。
 * 不把多 folder 状态塞进单个 bridge——bridge 的「面板关了事件照收、
 * 跑完释放锁」（detach）正好就是「切走转后台」的语义，原样复用：
 *
 * - 切到 B：A detach（空闲=立即释放锁；跑着=releaseAfterTurn，落盘不
 *   打断——B 方案，用户拍板），B 建好/复用后 attach
 * - A 后台弹审批卡：post 路由只放行 approval_request（带 folder 标注），
 *   其余消息丢弃——历史在盘上，切回时 hydrate 全量替换接上
 * - 文件夹被移出工作区：它的 bridge dispose（跑着的轮中断——工作区都
 *   没了，没有「跑完再说」的对象）
 */
export type RouterDeps = {
  post: (msg: ToWebview) => void
  /**
   * 建单个文件夹的 bridge。post/onTurnEnd 由本层注入——前者带过滤
   * （后台 bridge 只有审批消息能到 UI），实现里只管 session 和 vscode
   */
  createBridge: (folder: string, post: (msg: ToWebview) => void, onTurnEnd: () => void) => Bridge
  /** 当前工作区文件夹列表（尾斜杠已去）。顺序即 VS Code 的顺序 */
  folders: () => string[]
  /** 持久化/读取上次选择（workspaceState）。实现自己处理失效值 */
  saveFolder: (folder: string) => void
  /** 机器人看的状态变了（目录清单重推的同一批时机 + 面板换了显示的任务）。
   *  desktop-robot.md §9：「postFolders 的同一批时机推一次 status」 */
  onChange?: () => void
}

export type Router = {
  handle: (msg: ToHost) => void
  /** 预置 active（上次选择）。在第一条 ready 之前调，避免先连 [0] 再跳 */
  seed: (folder: string) => void
  /** 面板关了：所有 bridge detach（后台轮照跑照落盘，跑完各自释放锁） */
  detachAll: () => void
  /** settings.json 变更：所有活 bridge 重建 session 重读配置（bridge.requestReload） */
  requestReloadAll: () => void
  /** 工作区文件夹增删时（onDidChangeWorkspaceFolders） */
  setFolders: () => void
  /** agent 派任务（task-bridge.ts）：交给 root 所在文件夹的 bridge。那个
   *  文件夹没有 bridge = 派它的会话不在本窗口，拒绝 */
  dispatchFromAgent: (req: TaskDispatchRequest) => Promise<TaskDispatchResponse>
  /** bin --models（规则 14）：root 所在文件夹配置里的 taskModels */
  taskModels: (req: TaskModelsRequest) => Promise<TaskModelsResponse>
  /** task_send：root 所在目录发消息 / 列任务（loop-interrupt.md 实现项 2） */
  taskSend: (req: TaskSendRequest) => TaskSendResponse
  taskSendList: (req: TaskSendListRequest) => TaskSendListResponse
  /** $SIMPLE_CODE_WAKE：注册闹钟（wake-center 全局，投递按 root 找 bridge） */
  wake: (req: WakeRequest) => WakeResponse
  /** 桌面机器人：各已打开目录的现状（只含建过 bridge 的——没打开过的目录不可能有事） */
  robotFolders: () => RobotFolderView[]
  /** 面板此刻显示的目录与任务（null = 主任务）。§5.1 seen 的判据之一 */
  showing: () => { folder: string; task: string | null }
  /** 机器人上点「允许」：找到卡所在的 bridge 放行。没有这张卡 = false */
  allow: (toolCallId: string) => boolean
  /** 机器人上点某条：切到目录，再让 webview 选中任务。webview 还没就绪
   *  （面板刚被 focus 命令拉起）就等 ready 后再做 */
  focus: (folder: string, task: string | null) => void
  dispose: () => void
}

export function createRouter(deps: RouterDeps): Router {
  const bridges = new Map<string, Bridge>()
  // 闹钟的到点投递：root 定位 bridge，owner 定位主任务（''）或任务（task-xx）
  const wakeCenter = createWakeCenter((root, owner, text) => {
    bridges.get(root)?.wakeFire(owner, text)
  })
  let active = ''
  /** webview 报来的「正显示哪个任务」（view_task） */
  let shownTask: string | null = null
  /** webview 能收消息吗：ready 置真，面板关掉（detachAll）置假。之前发的
   *  select_task 会被 VS Code 静默丢掉（protocol.ts ready 的注释） */
  let webviewReady = false
  let pendingFocus: { folder: string; task: string | null } | null = null

  const activeBridge = (): Bridge | undefined => bridges.get(active)

  const pick = (): string => deps.folders()[0] ?? ''

  const postFolders = (): void => {
    deps.post({
      type: 'folders',
      folders: deps.folders().map((p) => ({
        path: p,
        // 主干或任一分身在跑都算这个目录在忙（2026-09-22 真机反馈：
        // 分支干活时目录名前的绿点不亮）
        running: (bridges.get(p)?.isRunning() ?? false) || (bridges.get(p)?.anyRunning() ?? false),
        pendingApprovals: bridges.get(p)?.pendingApprovals() ?? 0,
      })),
      active,
    })
    deps.onChange?.()
  }

  /** 该文件夹 bridge 的 post：非 active 只放行状态类消息（带 folder 标注），
   * 其余丢弃——历史在盘上，切回时 hydrate 接上，中间的 UI 增量没人看。
   * 任务的 task_agent 是高频流（跟 agent 同级），只走 active；任务快照和
   * 面板基线是状态类（跟 bg_processes 同级），带 folder 常发 */
  const bridgePost = (folder: string) => (msg: ToWebview) => {
    // tasks 快照意味着分身状态变了（跑起来/停了）——folder tab 绿点跟着刷
    if (msg.type === 'tasks') postFolders()
    if (
      msg.type === 'approval_request' ||
      msg.type === 'approval_closed' ||
      msg.type === 'bg_processes' ||
      msg.type === 'tasks' ||
      msg.type === 'task_hydrate'
    ) {
      deps.post({ ...msg, folder })
      return
    }
    if (folder === active) deps.post(msg)
  }

  const spawn = (folder: string): Bridge => {
    const b = deps.createBridge(folder, bridgePost(folder), postFolders)
    bridges.set(folder, b)
    return b
  }

  /** 切换主体。目标不在列表里 = 无操作（webview 只发列表里的） */
  const switchTo = (folder: string): void => {
    if (folder === active || !deps.folders().includes(folder)) return
    activeBridge()?.detach()
    active = folder
    deps.saveFolder(folder)
    // 先发清单再 attach：webview 顶部下拉要和 hydrate 一起到位，
    // 顺序反了会闪一下「旧文件夹名 + 新历史」
    postFolders()
    ;(bridges.get(folder) ?? spawn(folder)).attach()
  }

  const selectTask = (task: string | null): void => {
    deps.post({ type: 'select_task', task })
  }

  return {
    seed: (folder) => {
      if (active === '' && deps.folders().includes(folder)) active = folder
    },
    detachAll: () => {
      webviewReady = false
      for (const b of bridges.values()) b.detach()
    },
    requestReloadAll: () => {
      for (const b of bridges.values()) b.requestReload()
    },
    handle: (msg) => {
      switch (msg.type) {
        case 'ready':
          webviewReady = true
          // 机器人点了跳转、面板是被 focus 命令拉起来的：直接落到目标目录
          if (pendingFocus !== null && deps.folders().includes(pendingFocus.folder))
            active = pendingFocus.folder
          // seed 已设过 active（上次选择）就不动它——「没 spawn」不是重置
          // active 的理由，否则 seed 被 [0] 顶掉，出现先连 [0] 再跳的闪换
          if (active === '') active = pick()
          if (active && !bridges.has(active)) spawn(active)
          bridges.get(active)?.attach()
          postFolders()
          if (pendingFocus !== null) {
            selectTask(pendingFocus.task)
            pendingFocus = null
          }
          return
        case 'switchFolder':
          switchTo(msg.folder)
          return
        case 'view_task':
          shownTask = msg.task
          deps.onChange?.()
          return
        case 'approval_reply':
          // 后台文件夹的卡：id 是各 bridge 自己的 seq，必须路由回原地
          if (msg.folder) bridges.get(msg.folder)?.handle(msg)
          else activeBridge()?.handle(msg)
          return
        case 'bg_kill':
          // pid 的账在原目录的 registry 里（各 bridge 独立），路由错就杀空
          if (msg.folder) bridges.get(msg.folder)?.handle(msg)
          else activeBridge()?.handle(msg)
          return
        default:
          activeBridge()?.handle(msg)
      }
    },

    setFolders: () => {
      const list = deps.folders()
      // 移出工作区的：轮也要中断——它的记忆目录已经不在射程里
      for (const [folder, b] of bridges) {
        if (list.includes(folder)) continue
        b.dispose()
        bridges.delete(folder)
      }
      if (active !== '' && !list.includes(active)) {
        active = pick()
        if (active) spawn(active).attach()
        postFolders()
      } else {
        postFolders()
      }
    },

    dispatchFromAgent: async ({ root, brief, owner, model, lean }) => {
      const b = bridges.get(root)
      if (!b) return { ok: false, error: `本窗口没有打开「${root}」的 SC 会话` }
      return b.dispatchFromAgent(brief, owner, model, lean)
    },

    taskModels: async ({ root }) => {
      const b = bridges.get(root)
      if (!b) return { ok: false, error: `本窗口没有打开「${root}」的 SC 会话` }
      return b.taskModels()
    },

    taskSend: ({ root, task, text }) => {
      const b = bridges.get(root)
      if (!b) return { ok: false, error: `本窗口没有打开「${root}」的 SC 会话` }
      const error = b.taskSendFromAgent(task, text)
      return error === null ? { ok: true } : { ok: false, error }
    },

    taskSendList: ({ root }) => {
      const b = bridges.get(root)
      if (!b) return { ok: false, error: `本窗口没有打开「${root}」的 SC 会话` }
      return { ok: true, tasks: b.taskSendList() }
    },
    wake: (req) => wakeCenter.add(req),

    robotFolders: () =>
      deps.folders().flatMap((folder) => {
        const b = bridges.get(folder)
        return b ? [{ folder, ...b.robotView() }] : []
      }),

    showing: () => ({ folder: active, task: shownTask }),

    allow: (toolCallId) => {
      for (const b of bridges.values()) if (b.allowToolCall(toolCallId)) return true
      return false
    },

    focus: (folder, task) => {
      if (!deps.folders().includes(folder)) return
      if (!webviewReady) {
        pendingFocus = { folder, task }
        return
      }
      // 先切目录：switchTo 同步推 folders/hydrate/tasks，webview 按序处理，
      // select_task 排在后面，不会被切目录时的「恢复上次选中的任务」盖掉
      switchTo(folder)
      selectTask(task)
    },

    dispose: () => {
      for (const b of bridges.values()) b.dispose()
      bridges.clear()
      wakeCenter.dispose() // 闹钟随面板走：停用即清（不持久化的拍板）
    },
  }
}
