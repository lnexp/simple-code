import {
  type AgentEvent,
  type Effort,
  type ImageInput,
  lastRegionLine,
  type ModelRef,
  type Session,
  toHydrateRows,

  openDbReadOnly,
  MEMORY_RELATIVE,
  type TaskManifest,
} from '@simple-code/core'
import {
  type ApprovalCategory,
  listModels,
  logRun,
  type SessionOptions,
  type SetTimer,
  watchIdle,
} from '@simple-code/core'
import {
  createTaskCenter,
  readModel,
  type TaskApprovalQ,
  type TaskChoiceStore,
} from './tasks.ts'
import {
  type ChatItem,
  type ChatView,
  emptyView,
  hydrateItems,
  reduce,
} from '../webview/events.ts'
import type { ApprovalRequest, ToHost, ToWebview } from './protocol.ts'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
const execFile = promisify(execFileCb)

/**
 * 面板的全部逻辑：ready 握手、发消息、中断、事件转发。
 *
 * **不 import 'vscode'**——它只需要一个「能 postMessage 的东西」和一个
 * 「能拿到 session 的东西」，两个都作为参数注入。panel.ts 那层因此只剩
 * 「把 vscode 的对象接上来」，薄到不用测（vscode-impl.md §7）。
 */

export type BridgeDeps = {
  post: (msg: ToWebview) => void
  /**
   * 惰性拿 session。**第一次调用时才建**——`getSession` 要拿文件锁、开 SQLite，
   * 激活阶段做这些会拖慢编辑器启动，而用户可能根本不打开面板
   *
   * 带 requestApproval 参数（approval.md §4.1）：session 创建时把审批回调
   * 注进去，闭包引用 bridge 内的中枢——开关、pending、超时全在 bridge 管，
   * session/core 对 UI 形态无感
   */
  session: (requestApproval: NonNullable<SessionOptions['requestApproval']>) => Promise<Session>
  /**
   * 任务 session 工厂（task-v3）：同一个库，`task=owner 域` + `skipLock`
   * （同进程对话已持锁）。bridge 不自己建——session 的构造全在 panel 层
   * （vscode-impl.md §7 的接线纪律），这里只拿工厂
   */
  taskSession: (
    task: TaskManifest,
    requestApproval: (q: TaskApprovalQ) => Promise<'allow' | 'always' | 'deny' | { deny: string }>,
  ) => Promise<Session>
  /** 任务模型选择的持久化（透传 TaskCenter）。不传 = 任务配置内存态 */
  choiceStore?: TaskChoiceStore
  folder: string
  /**
   * 后台可见状态变了，路由层该重推 folders 了。两类触发点：一轮结束
   * （running 翻回 false）、审批卡增删（角标数变化）——bridge 内部的
   * running 与 pendingApprovals 外面都看不到，只能由内往外通知。
   * 名字沿用 onTurnEnd 是历史原因，实际语义是「状态变了，去刷新」
   */
  onTurnEnd?: () => void
  /** 换掉定时器，测试用。不传就是真定时器 */
  setTimer?: SetTimer
  /**
   * 用系统浏览器打开链接。注入而不是直接 import vscode——bridge 不认
   * vscode（文件头注释），面板那层接真实现，测试接假的
   */
  openExternal: (url: string) => Thenable<boolean>
  /**
   * 在编辑器里打开文件（消息气泡路径链接的点击）。注入理由同 openExternal。
   * 相对路径的拼接在 bridge 做（deps.folder 是唯一的工作区根来源）
   */
  openFile: (path: string, line?: number) => Thenable<unknown>
  /**
   * 上次选的模型，没选过返回 null。
   *
   * **按工作区存，不是全局。** 不回写用户级配置文件：那份文件
   * 是用户手写的、带 `$comment` 的，程序改它会毁掉格式，而且「程序偷偷改你
   * 的配置」和 §1.2「配置缺失就报错，不猜」是一个精神的两面。
   *
   * 选工作区级是**本项目自行推断**：一个 VS Code 窗口就是一个项目，而「大
   * 重构用贵模型、小改动用便宜的」是按项目分的。想改成全局就把 panel.ts 的
   * workspaceState 换成 globalState，一行
   */
  savedChoice: () => SavedChoice | null
  saveChoice: (choice: SavedChoice) => void
  /** 恢复失败时清掉持久化的失效选择（配置改名/删模型后自愈，提示不复发） */
  clearChoice?: () => void
}

/**
 * 存盘的选择。**模型和推理深度存在一起**，一次写两个 key。
 *
 * 存一起是因为 core 里换模型会清掉 effort 覆盖：分两个键存的话，模型换了而
 * effort 那条记录还在，下次启动会把不属于这个模型的档位套上去
 */
export type SavedChoice = ModelRef & { effort?: Effort }

export type Bridge = {
  handle: (msg: ToHost) => void
  /**
   * webview 挂载完成（ready 握手）或**多根切回这个文件夹**。ready 消息
   * webview 只发一次，切换是路由层主动调——语义相同：接上 UI、推状态、
   * 惰性建 session。从后台切回时轮可能还在跑：fold 还没发生，
   * mirrorItems 里带着 replay 的中间态，hydrate 全量替换后增量继续推
   */
  attach: () => void
  /** 轮在不在跑。路由层用来渲染其他文件夹的 ● 后台标记 */
  isRunning: () => boolean
  /** 任一分身在跑（router 并进 folder tab 绿点） */
  anyRunning: () => boolean
  /**
   * 挂起中的审批数。路由层用它给后台文件夹的标签点角标——卡片本身不跨
   * 标签显示（怕人在没有对话上下文时误批），但「那边有事等着」要能看见
   */
  pendingApprovals: () => number
  /**
   * **面板**关了（onDidDispose）。跟 dispose（扩展停用）语义不同：
   * - 跑着的轮**不打断**——用户意图是「不看了」，不是「别写了」。模型正
   *   在改文件时拦腰斩断比让它写完糟。跑完自动落盘、释放锁
   * - 空闲就立刻释放（文件锁），CLI 随时能启动
   */
  detach: () => void
  /** settings.json 变更：重建 session 重读配置。跑着/挂着审批时约到轮结束 */
  requestReload: () => void
  /** 分身任务面板要基线（attach 已含；此口留给路由层切回时直调） */
  rehydrateTasks: () => void
  /**
   * 扩展停用。中断正在跑的 loop 并关 session——进程都要没了，没有
   * 「跑完再说」的余地
   */
  dispose: () => void
}

/** 历史分页一页多少条。50 条 ≈ 两三屏，够了；太大则一次 DOM 里塞太多块 */
const HISTORY_PAGE = 50

export function createBridge(deps: BridgeDeps): Bridge {
  /**
   * webview 报告自己挂载好了没有。
   *
   * **在此之前推的消息全部丢弃，不是缓存。** 因为在 ready 之前根本不该有
   * 消息可推——我们不在激活时推任何东西，第一条消息必然是用户点了发送之后
   * 产生的，那时 webview 早就 ready 了。留这个标志是为了兜住「用户在 webview
   * 挂载完成前就触发了什么」的意外，让它安静地不发，而不是发到黑洞里。
   */
  let ready = false
  let running = false
  /** 等主任务这轮结束的人（任务关闭的还俗那一步）。send 的 finally 收口时放行 */
  let idleWaiters: (() => void)[] = []
  const waitIdle = async (): Promise<void> => {
    // while 不是 if：放行后到这里之间主任务可能又开了一轮
    while (running) await new Promise<void>((r) => idleWaiters.push(r))
  }
  /** 拿 session 的那个 promise。同一个面板只建一次，重复点发送不会建两个 */
  let pending: Promise<Session> | null = null
  /**
   * 空闲摘要的驱动（design.md §9.7）。session 建起来的时候一起建——
   * 它读的是 session 的配置。
   *
   * **这里曾经是整个记忆系统在扩展里失效的一环**：摘要在 CLI 里挂在
   * REPL 的空闲定时器上，扩展没有这条线，summaries 表永远是空的，
   * 卸载全部退化成「头部+路径」。现在 arm/disarm 的含义是「一轮跑完了
   * 用户还没发下一条」：send 开头 disarm（用户动手了），收尾 arm（开始
   * 等下一条）。用户敲字期间没有到宿主的信号，定时器照跑——和 CLI 一致
   */
  let idle: ReturnType<typeof watchIdle> | null = null
  /**
   * 当前模型和可选项。**session 建起来才知道**——配置是惰性加载的
   * （getSession），面板刚打开时是 null / 空。不猜默认值（CLAUDE.md §1.2）
   */
  let current: ModelRef | null = null
  let models: ModelRef[] = []
  /**
   * 推理深度的显示状态。**从 session 读，不自己记**——换模型时 core 会清掉
   * 覆盖，自己记一份就跟它分叉了（Session.effortState 的注释）
   */
  let effort: Effort | null = null
  let effortOverridden = false
  /** 当前预设与当前模型可选的预设名（t885）。同 effort，权威在 core：
   * 换模型时 core 自己会清掉预设，UI 各记一份就会分叉 */
  let preset: string | undefined
  let presets: string[] = []
  let imagesEnabled = false
  /** 当前模型的上下文窗口。底栏的环形水位要拿它当分母——页脚那个
   *  「上下文 X」本来就按窗口报，两处口径必须一样 */
  let contextWindow = 0
  /**
   * 面板还开着吗。关了之后事件照收（跑着的轮不打断）、post 进黑洞，
   * 跑完再释放。**重开面板把它翻回 true**——事件循环一直在 bridge 里，
   * 这是「面板关了再开能看到全部内容」的根
   */
  let attached = false
  /** 面板关了且轮在跑：这轮结束就关 session（释放文件锁） */
  let releaseAfterTurn = false
  /** settings.json 变更请求重载：与 releaseAfterTurn 分开记——面板切走再切回
   * 会作废 releaseAfterTurn（detach 语义是「不看了」），但 reload 不能跟着丢，
   * 否则 watcher 只触发一次，这次丢了配置永远不刷新 */
  let reloadPending = false

  // ── 审批中枢（approval.md §4.2）───────────────────────────────
  // 两态开关是宿主内存态：session 创建时把下面的 requestApproval 闭包注
  // 进去，之后切开关只改这个布尔——core、判定器、协议都不用知道
  let approvalOn = true
  let approvalSeq = 0
  const pendingApprovals = new Map<
    number,
    {
      /** 卡片留底：多根切回时 attach 重推 pending 的卡（webview 是无状态
       *  投影，切走即清，不重推的话后台目录的卡永远看不见） */
      card: ApprovalRequest
      resolve: (r: 'allow' | 'always' | 'deny' | { deny: string }) => void
    }
  >()
  /** 挂机等不到人：宁可让模型把「审批超时」带回来，也不放行不确定的命令 */
  const APPROVAL_TIMEOUT_MS = 5 * 60_000
  // fallback 要返回真 cancel——as 骗类型的话，答复路径调 cancel() 会当场
  // 拿 NodeJS.Timeout 当函数调（真事，测试抓的）
  const setTimer: SetTimer =
    deps.setTimer ??
    ((ms, fn) => {
      const t = setTimeout(fn, ms)
      return () => clearTimeout(t)
    })

  const finishApproval = (id: number, r: 'allow' | 'always' | 'deny' | { deny: string }): void => {
    const entry = pendingApprovals.get(id)
    if (!entry) return
    pendingApprovals.delete(id)
    logRun({
      ev: 'approval_result',
      folder: deps.folder,
      id,
      decision: typeof r === 'string' ? r : `deny:${r.deny}`,
    })
    post({ type: 'approval_closed', id })
    entry.resolve(r)
    // 角标要跟着灭：超时 deny 也走这里，不通知的话后台标签会一直亮着
    deps.onTurnEnd?.()
  }


  const requestApproval = (q: {
    command: string
    toolCallId: string
    category: ApprovalCategory
    detail: string
    reason: string
    always?:
      | { kind: 'lead'; lead: string }
      | { kind: 'path'; dir: string }
      | { kind: 'nonpath'; lead: string; from: number }
      | { kind: 'paths'; dirs: string[] }
      | { kind: 'hidden'; path: string; write: boolean }
    /** 分身任务弹的卡：任务名，卡片标注来源 */
    task?: string
  }): Promise<'allow' | 'always' | 'deny' | { deny: string }> => {
    // 分支的卡按分支自己的开关判（2026-09-22 拍板）；主干/缺省走 folder 级
    const on = q.task !== undefined ? tasks.approvalOnOf(q.task) : approvalOn
    if (!on) return Promise.resolve('allow')
    const id = ++approvalSeq
    logRun({
      ev: 'approval_ask',
      folder: deps.folder,
      id,
      category: q.category,
      command: q.command.slice(0, 300),
    })
    const card: ApprovalRequest = {
      type: 'approval_request',
      expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
      id,
      command: q.command,
      toolCallId: q.toolCallId,
      category: q.category,
      detail: q.detail,
      reason: q.reason,
      ...(q.always ? { always: q.always } : {}),
      ...(q.task !== undefined ? { task: q.task } : {}),
    }
    post(card)
    return new Promise((resolve) => {
      const cancel = setTimer(APPROVAL_TIMEOUT_MS, () => finishApproval(id, 'deny'))
      pendingApprovals.set(id, {
        card,
        resolve: (r) => {
        cancel()
        resolve(r)
        },
      })
      // 后台文件夹的卡不弹到当前界面，角标是唯一的可见信号——挂上就通知。
      // **必须在 set 之后**：router 的 onTurnEnd 即 postFolders，同步读
      // pendingApprovals()；先通知会读到旧数，角标要等下一次别的重推才亮（9-30 修）
      deps.onTurnEnd?.()
    })
  }

  // ── 历史镜像 ──────────────────────────────────────────────────
  // 面板重开时 webview 是一张白纸，要把「上次看到哪」补给它。webview 的
  // ChatView 是纯函数 reduce 出来的（events.ts 不碰 DOM），宿主跑同一个
  // reducer 就能维护镜像，不需要 webview 活着。
  //
  // 镜像 = 基线（上次 turn 定稿的条目）+ 重放（本轮的事件）。基线只在
  // session 新建时捕获一次——**mid-turn 读 session.messages() 会读到本轮
  // 已完成的 step（step_finish 即 persist），跟重放重叠**，每 attach 一次
  // 就多一份。turn 结束时折叠（fold）进基线，重放清零——只存一轮的量，
  // 面板开一天也不会攒出无界内存
  let baseItems: ChatItem[] = []
  /** 事件 + 到达宿主的墙钟。重放把钟一起带走（reduce 纯化），mirrorItems
   *  幂等——切回时 hydrate 出来的秒表是真实起点，不再被重放时刻的假钟顶掉 */
  let replay: Array<{ ev: AgentEvent; at: number }> = []
  /** 最后一次 step_finish 报的水位/用量。fold 清空 replay 后仍要活着——
   *  切回时（轮已结束）镜像的这两个值从这里取，否则底栏水位清零 */
  let lastContextTokens = 0
  let lastTiming: ChatView['lastTiming'] = null
  /**
   * 上一轮的页脚（模型/结束时刻/耗时）。页脚字段只存在于 webview 的 view
   * 里，hydrateItems 重建不出来——fold 重读 messages() 和 warmUp 的基线
   * 重捕都会把它冲掉，所以 fold 时记在这里，两处补回。**只覆盖最近一轮**：
   * 更早轮次的页脚要靠 turns meta 落盘恢复，那是另一个缺口（现状：重启
   * 面板后历史轮本来就没有页脚，切回对齐这个语义）
   */
  let lastFooter: { model: string | null; finishedAt: number; elapsedMs: number } | null = null
  const withFooter = (items: ChatItem[]): ChatItem[] => {
    if (!lastFooter) return items
    const at = items.findLastIndex((i) => i.kind === 'assistant')
    if (at === -1) return items
    const next = [...items]
    next[at] = { ...(next[at] as Extract<ChatItem, { kind: 'assistant' }>), ...lastFooter }
    return next
  }
  /**
   * 当前轮的用户气泡。**user 消息是 App 本地 append 的，不在事件流里**——
   * 镜像不补它的话，跑着的时候重开面板会看到一段没有问题的回答。
   * 必须是数组：插话（running 时 send）会再来一条，单数槽位的话后者
   * 把前者顶掉——轮内切走再切回，第一条 user 气泡就"被改写"成插话
   * 内容（某项目 turn-822 实测）。fold 时随重放一起收编进
   * 基线后清空。顺序上插话排在全部过程前面——镜像本来是近似视图，
   * 精确位置只有 fold 重读 messages() 才有
   */
  let pendingUsers: ChatItem[] = []

  const mirrorView = (): ChatView => {
    const items = [...baseItems, ...pendingUsers]
    let view = { ...emptyView(), items, contextTokens: lastContextTokens, lastTiming }
    for (const { ev, at } of replay) view = reduce(view, ev, at)
    return view
  }

  /**
   * turn 定稿：**基线直接重读 `session.messages()`**，不折叠重放。两个理由：
   * 1. user 气泡只在内存历史里（App 本地 append 的，事件流看不见），
   *    重放路线必须额外补 pendingUser，而重读天然就有
   * 2. 中断/报错路径下重放跟实际落盘的历史可能有出入（normalize 补的
   *    占位、删的孤儿），messages() 就是事实
   *
   * 时序前提：core 的 persist 挂在事件流的 finally 里，bridge 的 for-await
   * 退出时它已经跑完——这里读到的一定是定稿后的
   */
  const fold = (session: Session): void => {
    // historyRows：行带 turnId/meta/elapsedMs，基线里每轮尾部 assistant
    // 自带页脚（当时的模型·耗时，落盘事实）。messages() 不带——live 轮的
    // 页脚只有 lastFooter 一条内存路，重启就丢
    baseItems = hydrateItems(session.historyRows())
    replay = []
    pendingUsers = []
    // fold 本身就是一次基线同步：标记置上，warmUp 不再重读（重读也不重叠
    // ——replay 已清零——但没必要，messages() 全量读一次是有代价的）
    baselineSynced = true
  }

  const post = (msg: ToWebview): void => {
    if (!ready) return
    deps.post(msg)
  }

  // ── 任务中心（task-v3）──────────────────────────────────────
  // 审批中枢在上面刚定义好——任务中心的 labeled 审批闭包引用它
  const tasks = createTaskCenter({
    folder: deps.folder,
    post,
    session: deps.taskSession,
    requestApproval,
    ...(deps.choiceStore !== undefined ? { choiceStore: deps.choiceStore } : {}),
    ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
  })
  /** 派活闸门在这里：fork 写活库（reserved 行+跳段），要对话静止在轮边界 */
  const dispatchTask = (brief: string): void => {
    const busy = (): string | null => (running ? '主任务正在跑——等这轮跑完再开任务' : null)
    void tasks.dispatch(brief, busy).then((error) => {
      if (error !== null) post({ type: 'fatal', message: error })
    })
  }

  /** 关闭任务（task-v3）：不碰对话的 session——owner 还俗后对话下次装配
   *  自然看到该段。失败提示走 fatal，任务保留可重试 */
  const doCloseTask = async (name: string): Promise<void> => {
    const r = await tasks.close(name, {
      busy: () => (running ? '主任务正在跑——等这轮跑完再关闭任务' : null),
      waitIdle,
    })
    if (!r.ok) post({ type: 'fatal', message: r.error ?? '关闭失败' })
  }
  let closing: Promise<void> | null = null

  const getSession = (): Promise<Session> => {
    // **失败不留在缓存里**（t886）：settings.json 写坏时 loadConfig 抛异常，
    // 而 pending ??= 缓存的是 Promise 本身——rejected 的那个会一直被返回，
    // 用户把配置改回去也救不回来，只能 Reload Window。清掉就能让下一次
    // 交互（发消息、切模型、切档位）自动重试：配置写坏是必然会发生的，
    // 改回去就该能自己爬起来，而不是加一层「不让它坏」的机制
    if (pending === null) {
      const mine: Promise<Session> = (closing ?? Promise.resolve())
        .then(() => deps.session(requestApproval))
        .catch((error: unknown) => {
          // 只清自己那一份：失败的 catch 可能排在 closeSession + 重建之后，
          // 无条件 pending = null 会把刚建好的新 session 误清（实测会）
          if (pending === mine) pending = null
          throw error
        })
      pending = mine
    }
    return pending
  }

  /** 模型相关的显示状态一把全刷。分开刷早晚漏一个，现象是界面停在上一个模型 */
  const refresh = (session: Session): void => {
    current = readModel(session)
    const state = session.effortState()
    effort = state.effort
    effortOverridden = state.overridden
    const ps = session.presetState()
    preset = ps.current
    presets = ps.available
    // 直收图，或走 visionRelay 转述——core send 门控的同款判据（两条
    // 拦截口径不一致的话，UI 放行的图在 core 被拒、或反过来）
    imagesEnabled =
      session.config.model.capabilities.images || session.config.vision !== null
    contextWindow = session.config.model.contextWindow
  }

  /**
   * 第一次真正拿到 session 时：挂空闲驱动、记下模型清单、**恢复上次的选择**。
   *
   * 恢复失败**不能让整个面板起不来**：用户可能在两次会话之间把那个模型从
   * settings.json 里删了，此时 setModel 抛异常（core 不回退默认，§1.2）。
   * 那是完全合理的状态，不该表现成「面板打不开」——落回配置里的模型，
   * 把原因说给用户听。**这条不报错就是静默用错模型**
   */
  const onSessionReady = (session: Session): void => {
    idle ??= watchIdle(session, deps.setTimer)
    // models 列表来自配置，一生成一次就够。**saved 恢复不行**：detach 会
    // closeSession，重建的 session 从配置默认模型起跑——gate 连恢复带
    // refresh 一起挡的话，第二次及以后的 session 永远拿不回用户的选择，
    // bridge.current 也没人重置，UI 显示上次选择、请求走默认，当场分裂
    // （真机踩过：UI 显示 model-a，请求全是 model-b）。
    // 恢复本身幂等（setModel 同模型早退），重复跑无害
    if (models.length === 0) models = listModels(session.config.config)
    const saved = deps.savedChoice()
    if (saved) {
      try {
        session.setModel(saved)
        // **必须在 setModel 之后**：setModel 会清掉 effort 覆盖，
        // 反过来的话恢复出来的档位当场被清掉，而且没有
        // 任何迹象——存了、也「恢复」了，就是没生效
        if (saved.effort !== undefined) session.setEffort(saved.effort)
      } catch (error) {
        // 清掉失效的持久化选择——不清的话每次启动都恢复失败、这条提示
        // 每次都弹（配置里改个模型名就能复现），「提醒一次」变成「永远在」
        deps.clearChoice?.()
        post({
          type: 'fatal',
          message: `上次选的模型 ${saved.provider}/${saved.model} 用不了（已清除记录，此提醒只出现一次），已回到配置里的模型：${
            error instanceof Error ? error.message : String(error)
          }`,
        })
      }
    }
    refresh(session)
  }

  /** footerPush：这次 state 带 footer（只有 turn 收口那次用，见 protocol 注释） */
  const pushState = (footerPush = false): void =>
    post({
      type: 'state',
      running,
      ...(footerPush && lastFooter !== null ? { footer: lastFooter } : {}),
      folder: deps.folder,
      current,
      models,
      effort,
      effortOverridden,
      // 条件展开：tsconfig 开了 exactOptionalPropertyTypes，可选字段不收
      // 显式 undefined（与 footer 同款写法）
      ...(preset === undefined ? {} : { preset }),
      presets,
      approvalOn,
      imagesEnabled,
      contextWindow,
    })

  /**
   * 建 session（或复用活着的），把基线和模型清单补给 webview。
   *
   * 基线**只在 session 新建后捕获一次**（baselineSynced=false 时）——复用
   * 活 session 的重连不捕获：那正是轮还在跑的情形，messages() 读到的
   * 本轮已完成 step 已在重放里，再捕获就重一份。跑完的 fold 会把重放
   * 折进基线，基线从此一直新鲜
   */
  let baselineSynced = false
  const warmUp = async (): Promise<void> => {
    try {
      const session = await getSession()
      onSessionReady(session)
      // **replay 非空时禁止重捕**：mid-turn 读 messages() 会读到本轮已完成
      // 的 step（step_finish 即 persist），跟重放重叠——单 webview 时代只在
      // 「关面板立刻重开」撞上；多根切换后成了常态：切走 → 空闲释放 session
      // （baselineSynced 置 false）→ 后台轮还在跑 → 切回 → 重捕+重放各一份。
      // 现象是界面上「N 个操作」折叠组双份、同 id 两条 key 冲突一条点不开
      if (!baselineSynced && replay.length === 0) {
        // historyRows 的原图先换缩略图再进 hydrate（fold 那处是同步上下文，
        // 保持原样直传——原图行 hydrateItems 端会窄化掉不显示）
        baseItems = hydrateItems(await toHydrateRows(session.historyRows()))
        // 基线行自带历史页脚（historyRows）；本会话刚跑完的最近一轮
        // elapsed 可能还没落盘（收尾写在 turn 定稿），lastFooter 兜底补回
        baseItems = withFooter(baseItems)
        baselineSynced = true
      }
      const mirror = mirrorView()
      post({
        type: 'hydrate',
        items: mirror.items,
        contextTokens: mirror.contextTokens,
        ...(mirror.lastTiming ? { lastTiming: mirror.lastTiming } : {}),
      })
      // 切回补推（webview 是无状态投影，切走即清空）：后台进程清单 + 还在
      // 等答复的审批卡。不补的话前者永远空、后者只能等 5 分钟超时 deny
      post({ type: 'bg_processes', items: session.bgSnapshot() })
      for (const [, { card }] of pendingApprovals) post(card)
      pushState()
    } catch (error) {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** 关 session 并释放文件锁。幂等：第二次调用 pending 已是 null，什么都不做 */
  const closeSession = (source: 'detach' | 'reload' | 'dispose'): void => {
    baselineSynced = false
    releaseAfterTurn = false
    reloadPending = false
    idle?.disarm()
    idle = null
    const session = pending
    pending = null
    closing = session?.then((s) => s.close(source)) ?? null
  }

  /**
   * 换模型。**跑的时候拒绝。**
   *
   * core 那边跑着切是安全的（当前轮不受影响，下一轮才换）。
   * 我们仍然拒绝，因为**界面骗不起**：选择器一改就显示新模型，而正在流式
   * 输出的那段回答是旧模型说的。等几秒的代价，比让用户以为自己在看新模型的
   * 输出要小。UI 那边同时把选择器禁掉——**这里的判断不能省**，webview 是
   * 不可信面（同 openLink 的理由）
   */
  const switchModel = async (choice: ModelRef): Promise<void> => {
    if (running) return
    try {
      const session = await getSession()
      session.setModel(choice)
      refresh(session)
      // effort 带不带过去，跟着 core 的实际行为走：换模型时 core 清了覆盖，
      // 存过去等于下次启动又套回来；**同模型只换预设时 core 不清**（t885），
      // 这时丢掉 effort 会让「切条线路，档位没了」——refresh 后读回生效值
      // 即可，不用在这里重算一遍谁清谁不清
      const after = session.effortState()
      deps.saveChoice(after.overridden ? { ...choice, effort: after.effort } : choice)
    } catch (error) {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    }
    pushState()
  }

  /** 换推理深度。跑的时候同样拒绝，理由同 switchModel */
  const switchEffort = async (next: Effort | null): Promise<void> => {
    if (running) return
    try {
      const session = await getSession()
      session.setEffort(next)
      refresh(session)
      if (current) deps.saveChoice(next === null ? current : { ...current, effort: next })
    } catch (error) {
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    }
    pushState()
  }

  const send = async (text: string, images?: ImageInput[]): Promise<void> => {
    idle?.disarm() // 用户动手了不算空闲——插话也算动手
    if (running) {
      // 排队插话（t656 翻案）：UI 已放行 running 时输入，这层以前
      // `if (running) return` 把它静默扔掉——用户消息石沉大海（2026-09-17
      // 实测）。core 的 send 在 running 时入队（tasks.push newInput）并
      // 返回空流，工具批次边界插入；镜像补 pendingUser 让气泡先上屏
      pendingUsers.push({ kind: 'user', text, ...(images && images.length > 0 ? { images } : {}) })
      pushState()
      void getSession().then(async (s) => {
        try {
          for await (const _ev of s.send(text, images)) break // 入队即空流
        } catch {
          // 入队路径不该抛；真抛了也不打断当前轮，下轮 UI 重发可见
        }
      })
      return
    }
    // 页脚耗时的起点记在宿主：finishTurn 由 webview 的 state 消息驱动，
    // 切走再切回后 hydrate 重建的行没有它——镜像在 fold 时补（见 finally）
    const turnStartedAt = Date.now()
    running = true
    // user 气泡进镜像（App 本地 append 的，事件流里没有）。见 pendingUsers 注释
    pendingUsers.push({ kind: 'user', text, ...(images && images.length > 0 ? { images } : {}) })
    pushState()
    let session: Session | null = null
    try {
      session = await getSession()
      onSessionReady(session)
      for await (const agentEv of session.send(text, images)) {
        const at = Date.now()
        replay.push({ ev: agentEv, at })
        if (agentEv.type === 'step_finish') {
          lastContextTokens = agentEv.contextTokens
          lastTiming = {
            ...(lastTiming ?? { ttftMs: 0, totalMs: 0 }),
            inputTokens: agentEv.usage.inputTokens,
            outputTokens: agentEv.usage.outputTokens,
          }
        }
        // 首字/总耗时也要存：只存 step_finish 的话 fold 后切回，底栏显示
        // 「首字 0ms · 总 0ms」（reduce 用 0 垫缺的字段）
        if (agentEv.type === 'request_timing') {
          lastTiming = {
            ...(lastTiming ?? { inputTokens: 0, outputTokens: 0 }),
            ttftMs: agentEv.ttftMs,
            totalMs: agentEv.totalMs,
          }
        }
        // 后台进程快照不走 'agent' 透传：它不是聊天条目，webview 的 reduce
        // 没有它的位置。拆成独立消息，跟 approval_request 一个通道模式
        if (agentEv.type === 'bg_processes') {
          post({ type: 'bg_processes', items: agentEv.items })
          continue
        }
        post({ type: 'agent', event: agentEv, at })
      }
    } catch (error) {
      // core 抛到这里的是「这次根本没跑起来」——配置错、拿不到锁、core 自身
      // 的 bug。**必须接住**：不接的话未捕获的 rejection 会打到扩展宿主，
      // 而我们是进程内跑 core（vscode-impl.md §2.3）
      post({ type: 'fatal', message: error instanceof Error ? error.message : String(error) })
    } finally {
      // 所有退出路径收口到一个地方（CLAUDE.md §4.5）。散在三个 return 前面
      // 的话，早晚漏一个，现象是停止按钮一直是「运行中」
      running = false
      const waiters = idleWaiters
      idleWaiters = []
      for (const w of waiters) w()
      if (session) {
        fold(session) // 定稿进基线，重放清零——下次重开从基线起
        const finishedAt = Date.now()
        lastFooter = {
          model: current?.model ?? null,
          finishedAt,
          elapsedMs: finishedAt - turnStartedAt,
        }
        baseItems = withFooter(baseItems)
      }
      // 收口这次 state 带 footer：宿主账本（send→finally 全程在宿主，不受
      // 面板重开影响）覆盖 webview 本地账本——turnStartedAt 丢了的 webview
      // 靠这个补回耗时，而不是永远显示「无耗时」页脚等下次重开
      pushState(true)
      deps.onTurnEnd?.()
      // 面板已经关了：这就是约定好的「跑完自动释放」。interrupt 路径也
      // 走这里（中断后 loop 收尾同样产出定稿历史）
      if (releaseAfterTurn) closeSession('detach')
      else if (reloadPending) closeSession('reload')
      else idle?.arm() // 一轮结束，从这一刻算空闲
    }
  }

  /** ready 握手与多根切回共用：接上 UI、推状态、把 session 建起来 */
  const attach = (): void => {
    ready = true
    attached = true
    releaseAfterTurn = false // 接回来了：即使之前约了「跑完释放」也作废
    // 立刻回一次状态。webview 靠这条知道自己连上了
    pushState()
    // 顺手把 session 建起来，好让模型清单能填进选择器。
    //
    // **这是把「惰性」的边界从「第一次发消息」挪到「打开面板」**，而
    // 惰性当初的理由正是「用户可能根本不打开面板」（BridgeDeps.session
    // 的注释）——打开了面板就不在那个理由的射程内了。副作用是配置写错
    // 会在开面板时就报出来，比憋到第一次发送才报要好
    void warmUp()
    // 任务快照 + 各任务面板基线（切走期间 task_agent 被路由过滤，靠这里补）
    tasks.rehydrate()
  }

  return {
    attach,
    isRunning: () => running,
    // 分身是否在跑——router 合并进 folder tab 绿点（2026-09-22 真机反馈：
    // 分支干活时目录名前的绿点不亮）
    anyRunning: () => tasks.anyRunning(),
    pendingApprovals: () => pendingApprovals.size,
    rehydrateTasks: () => tasks.rehydrate(),
    handle: (msg) => {
      switch (msg.type) {
        case 'ready':
          attach()
          return
        case 'send':
          void send(msg.text, msg.images)
          return
        case 'setModel':
          // task：改分支 session 的（控件区跟分支走）。models 列表全
          // folder 一份，分支的合法性由同一份配置保证
          if (msg.task !== undefined) void tasks.setModel(msg.task, msg.choice)
          else void switchModel(msg.choice)
          return
        case 'setEffort':
          if (msg.task !== undefined) void tasks.setEffort(msg.task, msg.effort)
          else void switchEffort(msg.effort)
          return
        case 'interrupt':
          // session 还没建就中断是空操作，不用判断
          // 审批等待也一并按拒绝收场——用户点停止时不想让任何东西挂着
          for (const id of pendingApprovals.keys()) finishApproval(id, 'deny')
          void pending?.then((s) => s.interrupt('stop'))
          return
        case 'approval_reply':
          finishApproval(
            msg.id,
            msg.choice === 'deny' && msg.feedback ? { deny: msg.feedback } : msg.choice,
          )
          return
        case 'setApprovalEnabled':
          if (msg.task !== undefined) {
            tasks.setApprovalOn(msg.task, msg.on)
            return
          }
          approvalOn = msg.on
          pushState()
          return
        case 'bg_kill':
          // 有卡片才有得点，session 必然已建——但仍走惰性拿，不破坏约定
          void getSession().then((s) => {
            post({ type: 'bg_processes', items: s.terminateBg(msg.pid) })
          })
          return
        case 'task_dispatch':
          dispatchTask(msg.brief)
          return
        case 'task_send': {
          const error = tasks.send(msg.task, msg.text)
          if (error !== null) post({ type: 'fatal', message: error })
          return
        }
        case 'task_open':
          // 只补基线，不报错——切走的瞬间任务被关闭是正常竞态
          tasks.open(msg.task)
          return
        case 'task_close':
          void doCloseTask(msg.name)
          return
        case 'task_stop':
          tasks.stop(msg.name)
          return
        case 'get_regions': {
          void (async () => {
            try {
              // 任务视图看任务的 session；regions.jsonl 主任务和任务
              // 交错写，尾行按 owner 过滤——不过滤就是「最后写入者赢」
              // （任务面板显示主任务的数字）
              const session =
                msg.task !== undefined
                  ? ((await tasks.sessionOf(msg.task)) ?? (await getSession()))
                  : await getSession()
              // 注意用 memoryRoot 不是 root：root 永远是工作区（审批/bash/
              // notes 共享侧），记忆库在 memoryRoot
              // 用 session.owner 过滤——msg.task 是人起的任务名（runs 键），
              // 和 owner（'task-xxx'）不是同一个字符串，拿它过滤永远空
              const tail = lastRegionLine(session.memoryRoot, session.owner)
              // 老行没有冷温热/floor 字段（2026-09-11 拆分前）——缺的当 0，
              // 「历史行 + 新面板」的过渡期口径，新记录自然齐
              const info = tail
                ? {
                    at: String(tail.at ?? ''),
                    contextWindow: session.config.model.contextWindow,
                    maxTokens: session.config.request.maxTokens,
                    budget: Number(tail.budget ?? 0),
                    overhead: Number(tail.overhead ?? 0),
                    cold: Number(tail.cold ?? 0),
                    warm: Number(tail.warm ?? 0),
                    hot: Number(tail.hot ?? 0),
                    stub: Number(tail.stub ?? 0),
                    floor: Number(tail.floor ?? 0),
                    live: Number(tail.live ?? 0),
                    real: typeof tail.real === 'number' && tail.real > 0 ? tail.real : null,
                  }
                : null
              post({ type: 'regions', info })
            } catch {
              post({ type: 'regions', info: null })
            }
          })()
          return
        }
        case 'fetchHistory': {
          void (async () => {
            try {
              const session = await getSession()
              const page = await session.historyPage(msg.cursor, HISTORY_PAGE)
              post({
                type: 'historyPage',
                // 整行传（含 turnId/meta/elapsedMs）：hydrateItems 按轮给
                // 尾部 assistant 补页脚——历史轮「用了什么模型·多长时间」
                // 常驻（用户拍板：落盘的是当时的值，之后换模型不改写）
                items: hydrateItems(page.rows),
                next: page.next,
              })
            } catch (error) {
              post({
                type: 'fatal',
                message: error instanceof Error ? error.message : String(error),
              })
            }
          })()
          return
        }
        case 'openFile': {
          // 只认绝对/相对，~ 不展开（pathlink 侧本来就不识别 ~）。
          // deps.openFile（panel）对不存在的 abs 有兜底解析——模型给的
          // 常是包片段路径。最终打不开（是目录/形似路径的词）才 catch：
          // 报错弹窗比静默更吓人
          const abs = msg.path.startsWith('/') ? msg.path : `${deps.folder}/${msg.path}`
          void Promise.resolve(deps.openFile(abs, msg.line)).catch(() => {})
          return
        }
        case 'openLink':
          // 白名单校验放宿主侧不放 webview：webview 是不可信面，模型输出
          // 里什么协议都可能来。openExternal 对非 http(s) 的行为没有承诺
          if (/^https?:\/\//i.test(msg.url)) void deps.openExternal(msg.url)
          return
      }
    },

    detach: () => {
      ready = false
      attached = false
      if (running) {
        // 轮还在跑：不打断。见 detach 的注释——用户意图是「不看了」，
        // 拦腰斩断正在改文件的模型比让它写完糟
        releaseAfterTurn = true
        idle?.disarm()
        return
      }
      closeSession('detach')
    },

    /** settings.json 变更：loadConfig 只在 session 建立时读一次，重建才能
     * 重读。跑着/挂着审批不打断（审批等待期 running 仍为 true），约到这轮
     * 结束自动关；空闲直接关。下次用时惰性重建，锁正常释放再拿 */
    requestReload: () => {
      if (running || pendingApprovals.size > 0) {
        reloadPending = true
        return
      }
      closeSession('reload')
    },

    dispose: () => {
      // 幂等：面板 detach 已关过（pending 为 null）时什么都不做。
      // 扩展停用没有「跑完再说」的余地——中断 + 关；分身任务一并关
      ready = false
      attached = false
      for (const id of pendingApprovals.keys()) finishApproval(id, 'deny')
      void pending?.then((s) => s.interrupt('dispose'))
      tasks.dispose()
      closeSession('dispose')
    },
  }
}

/** 事件转成给 webview 的消息。导出只为测试能构造 */
export const wrap = (event: AgentEvent, at: number): ToWebview => ({ type: 'agent', event, at })
