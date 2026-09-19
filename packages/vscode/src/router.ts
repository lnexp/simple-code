import type { ToHost, ToWebview } from './protocol.ts'
import type { Bridge } from './bridge.ts'

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
  dispose: () => void
}

export function createRouter(deps: RouterDeps): Router {
  const bridges = new Map<string, Bridge>()
  let active = ''

  const activeBridge = (): Bridge | undefined => bridges.get(active)

  const pick = (): string => deps.folders()[0] ?? ''

  const postFolders = (): void => {
    deps.post({
      type: 'folders',
      folders: deps.folders().map((p) => ({
        path: p,
        running: bridges.get(p)?.isRunning() ?? false,
        pendingApprovals: bridges.get(p)?.pendingApprovals() ?? 0,
      })),
      active,
    })
  }

  /** 该文件夹 bridge 的 post：非 active 只放行审批消息（带 folder 标注），
   * 其余丢弃——历史在盘上，切回时 hydrate 接上，中间的 UI 增量没人看 */
  const bridgePost = (folder: string) => (msg: ToWebview) => {
    if (
      msg.type === 'approval_request' ||
      msg.type === 'approval_closed' ||
      msg.type === 'bg_processes'
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

  return {
    seed: (folder) => {
      if (active === '' && deps.folders().includes(folder)) active = folder
    },
    detachAll: () => {
      for (const b of bridges.values()) b.detach()
    },
    requestReloadAll: () => {
      for (const b of bridges.values()) b.requestReload()
    },
    handle: (msg) => {
      switch (msg.type) {
        case 'ready':
          // seed 已设过 active（上次选择）就不动它——「没 spawn」不是重置
          // active 的理由，否则 seed 被 [0] 顶掉，出现先连 [0] 再跳的闪换
          if (active === '') active = pick()
          if (active && !bridges.has(active)) spawn(active)
          bridges.get(active)?.attach()
          postFolders()
          return
        case 'switchFolder':
          switchTo(msg.folder)
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

    dispose: () => {
      for (const b of bridges.values()) b.dispose()
      bridges.clear()
    },
  }
}
