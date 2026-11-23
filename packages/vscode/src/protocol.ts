import type {
  AgentEvent,
  ApprovalAsk,
  BgProcessInfo,
  CompactResult,
  Effort,
  ImageInput,
  MemoryStats,
  ModelRef,
  SettingsEdit,
  SettingsView,
} from '@simple-code/core'
// 只取类型（import type，编译后消失）：ChatItem 定义在 webview 侧的事件层，
// 但 hydrate/historyPage 的载荷就是它。复制一份类型的话，改一边忘另一边
// 不会编译报错——protocol 存在的意义就是防这个（文件头注释）
import type { ChatItem, ChatView } from '../webview/events.ts'

/**
 * webview ↔ 扩展之间传的东西。**两侧共用这一份**——各写一遍的话，改了一边
 * 忘了另一边不会编译报错（postMessage 的参数类型是 unknown），只会运行时
 * 静默丢消息。
 *
 * 方向是不对称的，这是有意的：
 *
 * - **webview → 扩展**：命令，就三个，都不需要返回值
 * - **扩展 → webview**：事件流，高频，单向推
 *
 * 所以**没有 RPC 那一层**（带 id 配对 + pending map + 超时）：webview 不需要
 * 向扩展请求有返回值的操作，加 id 配对是为不存在的需求付复杂度。
 * 见 vscode-impl.md §5.2
 */

/** 审批值守三态（2026-11-04 拍板）：有人值守=弹卡等人；无人值守=ask 一律
 * 按无人处理拒（模型读到「当前无人处理审批，不是用户拒绝」）；关闭=触发即放行 */
export type Attendance = 'attended' | 'unattended' | 'off'

/** 排队发送的一个目标（主任务或某任务）的队列快照（turn-queue.ts）。
 *  paused：上一轮被停止/出错，等用户手动发消息、那一轮正常结束才接着发 */
export type TurnQueueView = {
  paused: boolean
  items: Array<{ id: number; text: string; imageCount: number }>
}

/** 「+ 任务」新任务状态的控件初值（task-trunk.md 规则 13）：任务发第一条消息
 *  才建，此前没有 session 可读，宿主按配置预先算好。model = 任务的默认模型
 *  （配置默认，不是主任务当前选的）；perModel 与 state.models 同序，解析失败
 *  的模型为 null（那项不显示档位/预设） */
export type TaskDraftDefaults = {
  model: ModelRef
  perModel: Array<{
    effort: Effort
    presets: string[]
    imagesEnabled: boolean
    contextWindow: number
  } | null>
}

export type ToHost =
  /**
   * webview 挂载完毕，可以收事件了。
   *
   * **必须有这个握手**：VS Code 会静默丢弃在 webview 的 acquireVsCodeApi
   * 就绪之前发出的 postMessage，慢网络下很常见。扩展收到 ready
   * 之前推的事件全都进不去，界面就一直停在初始状态——不报错，只是空白。
   */
  | { type: 'ready' }
  /**
   * 多根工作区切文件夹（design.md §7）。选哪个只决定记忆存哪、UI 显示
   * 哪条上下文——不是权限边界，agent 照样能 cd 到别的文件夹干活
   */
  | { type: 'switchFolder'; folder: string }
  | { type: 'send'; text: string; images?: ImageInput[] }
  | { type: 'interrupt' }
  /** markdown 里的链接被点了。宿主拿去 openExternal——webview 自己不能导航 */
  | { type: 'openLink'; url: string }
  /**
   * 消息气泡里的路径链接被点了（pathlink.ts 链接化的产物）。相对路径
   * 宿主拿工作区根去拼——folder 的源头在宿主，webview 不掺和
   */
  | { type: 'openFile'; path: string; line?: number }
  /**
   * 换模型。**带 provider**——同名模型可以配在两个 provider 下，只给名字有
   * 二义性（core 的 ModelRef 注释）
   */
  /** task：发给分支 session（切换分支后控件区跟分支走，2026-09-22 拍板）。
   *  缺省 = 主干 */
  | { type: 'setModel'; choice: ModelRef; task?: string }
  /** 换推理深度。`null` = 撤掉覆盖，回到配置里那个值 */
  | { type: 'setEffort'; effort: Effort | null; task?: string }
  /** 审批气泡的答复（approval_request 的回执） */
  /** folder：后台文件夹的审批卡回执路由用；缺省 = 当前文件夹 */
  | {
      type: 'approval_reply'
      id: number
      choice: 'allow' | 'always' | 'deny'
      /** 拒绝时留给 agent 的一句话（可选）。host 侧转成 { deny: feedback } */
      feedback?: string
      folder?: string
    }
  /** 输入框下的审批开关（approval.md §4.2 两态）。task：分支自己的开关
   *  （2026-09-22 拍板：审批配置跟分支走）；缺省 = 主干/folder 级 */
  | { type: 'setAttendance'; mode: Attendance; task?: string }
  /** 用户点掉一组后台残留进程（一条命令留下的整个进程组）。宿主 TERM 整组后
   *  回一条 bg_processes 更新列表。
   *  folder：该进程所属的 bridge——多根下 registry 各目录独立，pgid 只在
   *  原目录有账，不带 folder 会被路由到当前 bridge 而杀空（用户拍板：
   *  进程条按目录隔离显示，但跨目录的 × 必须打到正确的 bridge） */
  | { type: 'bg_kill'; pgid: number; folder?: string }
  /** 要一份上下文分区快照（点状态行「上下文 X」弹出面板）。响应是 regions。
   *  task：查分支的库——上下文环跟着分支走，不拿主干的数字骗人 */
  | { type: 'get_regions'; task?: string }
  /** 上下文面板「历史摘要」开关（2026-11-03）。task：分支独立（改该任务
   *  session 的内存 config + 持久化）；缺省 = 主任务（folder 级，写项目
   *  .simple-code/settings.json）。下一轮装配生效 */
  | { type: 'set_summary_in_context'; value: boolean; task?: string }
  /** 手动压缩（上下文分析面板的按钮，2026-10-17）。task：压分支；缺省 = 主任务。
   *  响应是 compact_result。只在停止时能压，跑着的 session 由 core 拒绝 */
  | { type: 'compact'; task?: string }
  /**
   * 往上拉到顶了，要更早的历史。cursor = 上一页返回的 `next`（第一次
   * null——从最新的归档行起）。响应是一条 historyPage
   */
  | { type: 'fetchHistory'; cursor: number | null }
  /** 任务视图往上翻 unloaded 历史（同 fetchHistory，带任务名路由到任务 session） */
  | { type: 'task_fetchHistory'; task: string; cursor: number | null }
  /** 开任务并立刻跑（`/task`），不等主任务静止。brief 是任务的第一条消息；
   *  from = 在哪个任务 tab 里开的（省略 = 主任务），登记为父任务（完成回调回给它） */
  | { type: 'task_dispatch'; brief: string; from?: string }
  /** 拖放形态观测（webview onDrop 上报，宿主转 runlog ev=drop_debug）：
  判据修错的账要能对着真实数据复盘 */
  | {
      type: 'drop_debug'
      kinds: string[]
      fileCount: number
      fileMeta: Array<{ name: string; size: number; path?: string }>
      explorerLike: boolean
      /** enter = dragenter 首报（types 残缺形态）；缺省 = drop 时刻（types 完整） */
      phase?: 'enter'
    }
  /** 「+ 任务」（规则 13，2026-11-14 改）：第一条消息即开。text = 第一条消息
   *  （含附件）；name = 用户打的字，宿主取首行 20 字作任务名、同名加序号。
   *  choice / attendance = 新任务状态里先选的（省略 = 默认）。建好即发，宿主
   *  回 select_task 让面板切过去。from 同 task_dispatch */
  | {
      type: 'task_create'
      name: string
      text: string
      images?: ImageInput[]
      from?: string
      choice?: ModelRef & { effort?: Effort }
      attendance?: Attendance
    }
  /** 记忆面板：取计数四元组 + 上次反思，响应一条 memory_data（reflect-trigger.md） */
  | { type: 'reflect_panel' }
  /** 点「反思」：以产品内置指令任务书开任务（不读文件、无 skill） */
  | { type: 'reflect_start'; from?: string }
  /** 双选项的「关闭并重开」：关掉挂着的反思任务、起新的一次 */
  | { type: 'reflect_reopen'; from?: string }
  /** 分支：往分支发消息（切换分支后输入框的目标）。分支跑着 = 插话入队
   *  （core 的 newInput 语义），空闲 = 起新一轮 */
  | { type: 'task_send'; task: string; text: string; images?: ImageInput[] }
  /** 选中了某个分支（切换视图）：宿主补一份该分支的基线（单一真相，
   *  webview 的增量投影不跨 attach 存活） */
  | { type: 'task_open'; task: string }
  /** 关闭任务（task-v3：唯一的生命周期操作。在跑会先停，摘要排空后收尾） */
  | { type: 'task_close'; name: string }
  /** 改任务名（显示用）：owner 不动——行/段/摘要都是 owner 域的，名字只是
   *  manifest 的字段和内存键。撞名由宿主拒，回 fatal 提示 */
  | { type: 'task_rename'; task: string; name: string }
  /** 任务拉段开关（2026-11-21 用户定）：on = 压缩点拉别的会话的 merged
   *  段（带出处标签）；off = 完全独立。写 manifest，跑着的任务下一轮生效 */
  | { type: 'task_pull_set'; task: string; on: boolean }
  /** 中断任务正在跑的轮（与对话的停止同一语义，通用控件） */
  | { type: 'task_stop'; name: string }
  /** 面板正显示哪个任务（null = 主任务）。桌面机器人据此判「这条你看得到」，
   *  不提醒（desktop-robot.md §5.1） */
  | { type: 'view_task'; task: string | null }
  /** Ctrl+Enter 排队（docs/proposals/queued-sends.md）：目标这一轮正常结束
   *  后作为新一轮发出。task 省略 = 主任务。空闲且没暂停 = 宿主立刻发 */
  | { type: 'turnQueueAdd'; text: string; images?: ImageInput[]; task?: string }
  /** 取消一条排队（按 id：队首可能恰在此刻发出，按序号会删错条） */
  | { type: 'turnQueueCancel'; id: number }
  /** 设置页（2026-11-17 原型放行）：要一份设置视图（齿轮点开、webview
   *  重挂载时）。响应是 settings_view */
  | { type: 'settings_get' }
  /** 设置页右上角「settings.json」：在编辑器里打开实际生效的那个文件 */
  | { type: 'settings_openFile' }
  /** 设置页的一个写操作。宿主逐条校验后写回（webview 是不可信面），
   *  响应是 settings_result */
  | { type: 'settings_write'; edit: SettingsEdit }
  /** 设置页「飞书推送」开关（2026-11-17 用户：推送开关「配置页面上也要有」）。
   *  写 ~/.simple-code/gateway/state.json 的 push 键——网关每次推送前读，
   *  不用重启；手机上 /推送 开|关 改的是同一个值。响应是 gateway_push */
  | { type: 'gateway_push_set'; on: boolean }
  /** 设置页「飞书推送」分区里的检测按钮（2026-11-18 用户：lark-cli 坏了
   *  静默失效，要能从界面看出装没装、登录没登录）。响应 gateway_check_result */
  | { type: 'gateway_check' }
  /** 设置页「桌面机器人」开关（2026-11-18 用户拍板）：转发机器人插件的
   *  enable/disable 命令（带静默参数）——拉起/退出逻辑只在插件一处维护，
   *  SC 不抄进程操作。完成后回 robot_state */
  | { type: 'robot_toggle'; on: boolean }
  /** 设置页「桌面机器人」分区未装时的安装按钮：走 installRobot 同款
   *  installExtension。完成后回 robot_state */
  | { type: 'robot_install' }

export type ToWebview =
  /** core 的事件**原样透传**，不在宿主侧翻译。翻译是 webview 的事 */
  /** at：事件到达宿主的墙钟。startedAt/endedAt 全靠它——webview 和宿主
   *  镜像用同一个值，切回重放时秒表起点不漂 */
  | { type: 'agent'; event: AgentEvent; at: number }
  /** 要审批的命令到了，渲染成气泡等 approval_reply */
  | ({
      type: 'approval_request'
      /** 超时自动拒绝的墙钟时刻（bridge 的 setTimer 同款口径）。
       * 卡上倒计时用；attach 重推的是同一对象，剩余时间自动变短 */
      expiresAt: number
      /** 发卡的是哪个文件夹——后台跑着的轮弹的卡带这个，卡片上标注 */
      folder?: string
      id: number
      /** 载荷（ApprovalAsk）：command/toolCallId/category/detail/reason/
       * parts/always/task——core types.ts 唯一权威，四处消费收敛于此
       * （2026-11-05：曾经各写一份，拆 lead 时漏改过 bridge） */
    } & ApprovalAsk)
  /** 气泡关掉（答复/超时/中断）。webview 重载后收不到它——超时兜底在宿主 */
  /** folder：非 active 文件夹的卡关掉时路由层标注，webview 按 (folder,id) 关卡 */
  | { type: 'approval_closed'; id: number; folder?: string }
  /**
   * 后台残留进程的全量快照（有变化才发）。core 的同名事件被 bridge 拦下
   * 翻译成这条——不走 'agent' 透传，因为它不是聊天条目，reduce 管不了它。
   *  folder 由路由注入（approval 同款）：后台目录轮还在跑、进程退出/新增
   *  时快照要能到达 webview——但只更新**那个目录**的桶，不动当前显示
   *  （用户拍板：进程条按目录隔离，互不干扰） */
  | { type: 'bg_processes'; items: BgProcessInfo[]; folder?: string }
  /** 排队发送的全量快照（有变化就推、attach 补推）。tasks 按任务名——
   *  webview 只认任务名；宿主内部按 owner 存 */
  | { type: 'turnQueue'; main: TurnQueueView; tasks: Record<string, TurnQueueView> }
  /**
   * `current` / `models` 在 session 建起来之前分别是 null 和空数组——配置是
   * 惰性加载的（bridge.ts 的 `getSession` 注释），面板刚打开时还不知道配了
   * 哪些模型。**不给默认值**（CLAUDE.md §1.2），UI 拿到 null 就不显示那一项。
   *
   * `models` 每次 state 都整个带上而不是单独一条消息：它就几行，而单独发
   * 意味着「webview 重新挂载后要记得补发」——那是会忘的那种接线
   */
  | {
      type: 'state'
      running: boolean
      /**
       * 宿主侧的页脚权威数据，只在 turn 收口那次 state 带（平时不带——
       * 旧 footer 盖到新一轮 assistant 上就错了）。webview 的 turnStartedAt
       * 是内存态，面板中途重开（hydrate）即丢，finishTurn 只能出「无耗时」
       * 页脚；宿主的账从 send 记到 finally，不受重开影响——收口后用它把
       * 末条 assistant 的页脚覆盖成权威值
       */
      footer?: { model: string | null; finishedAt: number; elapsedMs: number }
      folder: string
      current: ModelRef | null
      models: ModelRef[]
      /**
       * 当前生效的推理深度，以及它是不是用户手动盖的。
       *
       * 两个字段而不是一个 `Effort | null`：UI 要**同时**知道「现在是哪一档」
       * （显示什么）和「是不是默认」（图标要不要高亮）。只给 null 的话，
       * 默认态就没法显示具体档位，用户看不出「默认」到底是多深。
       * 靠两种颜色区分：
       * `text-muted-foreground` 和 `--status-info`
       */
      effort: Effort | null
      effortOverridden: boolean
      /**
       * 当前参数预设（t885）。undefined = 用模型本体，界面上显示「默认」。
       * presets 为空数组时 UI 整个控件不渲染——没配的模型不占那块地方
       */
      preset?: string
      presets: string[]
      /** 审批值守态（2026-11-04 三态拍板）。宿主内存态，webview 重载后靠这条恢复 */
      attendance: Attendance
      /** 历史摘要开关当前值（memory.summaryInContext，folder 级） */
      summaryInContext: boolean
      /**
       * 贴图通道可用：当前模型直收图，或配了 visionModel（非视觉模型下贴图
       * 走转述，与 view_image 同口径）。两者都不满足才拦粘贴——那时图发
       * 出去被 400 的话消息留在 context 里，之后每轮都 400（design.md §726）
       */
      imagesEnabled: boolean
      /**
       * 当前模型的上下文窗口。底栏环形水位的分母——0 表示还没建 session
       * （建之前 contextTokens 也是 0，那时按钮本来就不渲染）
       */
      contextWindow: number
      /** 新任务状态的控件初值。session 建好后才有（配置惰性加载） */
      taskDraft?: TaskDraftDefaults
    }
  /**
   * 扩展侧出了 webview 自己看不到的错（配置加载失败、拿不到文件锁、core 抛了
   * 未捕获异常）。跟 AgentEvent 里的 `error` 不是一回事：那个是模型/网络的
   * 错，这个是「这次根本没跑起来」
   */
  /**
   * 历史基线：定稿消息折成的条目。**webview 收到即整体替换 items**——
   * 只在 ready 握手后发一次，之后的内容走增量 agent 事件
   */
  /** contextTokens/lastTiming：底栏水位和上一轮用量的数据源。镜像重放
   *  算出来了就得一起带——只发 items 的话切回后水位清零（ChatView 的
   *  字段不在 items 里）。可选字段：老用例不关心就不填 */
  | {
      type: 'hydrate'
      items: ChatItem[]
      /** 基线世代号：分页回包核对它，丢弃重推基线前在途的旧页（2026-11-12 双链重复） */
      epoch?: number
      contextTokens?: number
      lastTiming?: ChatView['lastTiming']
      /** 排队中、core 还没投进历史的插话（ChatView.queued）；不带 = 没有 */
      queued?: ChatView['queued']
    }
  /**
   * fetchHistory 的响应：更早的一页（正序，prepend 即可）。`next` 是下一页
   * cursor，null = 到底。**空页 + null 也合法**（没有任何归档时第一拉就是）。
   * epoch/from：核对基线世代与请求游标，防重推基线或并发拉取引发双份 prepend
   */
  | {
      type: 'historyPage'
      items: ChatItem[]
      next: number | null
      epoch?: number
      from?: number | null
    }
  /** 任务历史的上一页（prepend 进该任务的 items）。next = null = 到底 */
  | {
      type: 'task_historyPage'
      name: string
      items: ChatItem[]
      next: number | null
      epoch?: number
      from?: number | null
    }
  | { type: 'fatal'; message: string }
  /** 设置页数据（settings_get 的响应 / 首开推送）。missing = 文件不存在，
   *  webview 据此显示首开表单代替对话 */
  | { type: 'settings_view'; view: SettingsView }
  /** settings_write 的结果。ok 时带新视图；不 ok 只带 error（表单底部展示） */
  | { type: 'settings_result'; ok: boolean; error?: string; view?: SettingsView }
  /** 飞书推送开关的当前值（随 settings_view 一起推，gateway_push_set 后再推）。
   *  null = 飞书网关没启用（gateway/config.json 没有或 enabled 不是 true），
   *  设置页不显示这一项 */
  | { type: 'gateway_push'; on: boolean | null; larkCli?: string | null }
  /** gateway_check 的结果。installed=false 时 version/auth 缺省 */
  | { type: 'gateway_check_result'; result: GatewayCheck }
  /** 桌面机器人的开关状态（随 settings_view 一起推，robot_toggle/robot_install
   *  后再推）。mac=false（SC 主插件判不了机器人）整个分区不显示；mac=true
   *  且 installed=false 显示安装按钮而不是开关 */
  | { type: 'robot_state'; mac: boolean; installed: boolean; on: boolean }
  /**
   * 上下文分区快照（regions.jsonl 尾行 + 窗口/输出预留拼成）。null =
   * 还没有任何记录（新装/从未跑过一轮）
   */
  | { type: 'regions'; info: RegionsInfo | null }
  /** compact 的结果。task 原样带回：面板只认自己那个分支的结果 */
  | { type: 'compact_result'; result: CompactResult; task?: string }
  /**
   * 多根工作区的文件夹清单（design.md §7）。宿主在切换、增删文件夹、
   * 后台轮结束时推送。UI 只在 `folders.length > 1` 时渲染顶部下拉——
   * 单根没有这个概念，不占空间
   */
  | { type: 'folders'; folders: FolderState[]; active: string }
  /**
   * 编辑器当前文件/选区（底栏「当前文件」按钮，2026-11-10 方案 1）。宿主在
   * ready、切编辑器、选区变化（200ms 防抖）时推；null = 当前不是文件（设置
   * 页、输出面板、没开编辑器）——按钮不渲染
   */
  | { type: 'active_editor'; editor: ActiveEditor | null }
  /**
   * 分身任务的全量快照（有变化才发）。folder 由路由注入（approval 同款）：
   * 任务跟目录走，切走即清、切回由宿主镜像补发
   */
  | { type: 'tasks'; tasks: TaskState[]; folder?: string }
  /** 选中这个任务（null = 主任务）：桌面机器人上点了某条，宿主已切好目录
   *  （desktop-robot.md §5.5）。同点任务条：选中 + 要基线 */
  | { type: 'select_task'; task: string | null }
  /** 记忆面板的计数（reflect_panel 的响应） */
  | { type: 'memory_data'; stats: MemoryStats }
  /** 反思开任务的结果：ok = 受理（面板自动关）；失败留 reason 在面板里 */
  | { type: 'reflect_result'; ok: boolean; reason?: string }
  /** 分身任务的流事件（task_agent → 任务面板的增量）。只在 active 直发 */
  | { type: 'task_agent'; name: string; event: AgentEvent; at: number; folder?: string }
  /** 分身任务面板的基线（切回/重开时补发，整体替换该任务的 items） */
  | {
      type: 'task_hydrate'
      name: string
      items: ChatItem[]
      folder?: string
      /** 同 hydrate：基线世代号，丢弃基线替换前已发出的旧分页回包 */
      epoch?: number
      /** 同 hydrate：底栏水位/上一轮用量，不带的话切回任务底栏清空 */
      contextTokens?: number
      lastTiming?: ChatView['lastTiming']
      /** 同 hydrate */
      queued?: ChatView['queued']
    }

/** 任务的卡片状态（task-v3）。任务是**可交互的平行对话流**（2026-09-22
 * 拍板，推翻早前「一次性任务书」形态）：切过去能继续打字，跑着时输入插话
 * 入队、空闲时起新一轮。closing = 关闭收尾中（摘要排空）。 */
export type TaskState = {
  name: string
  status: 'running' | 'idle' | 'error' | 'closing'
  /** 最后一条 assistant 文本（分支条摘要预览用） */
  lastText: string
  /** status = error 时的原因 */
  error?: string
  /** 控件区跟着分支走（同一次拍板）：模型/深度/预设/窗口是分支 session
   *  自己的账。session 还没建好时 current 为 null——控件显示空态。
   *  models 不带：配置全 folder 一份，UI 借主干的 */
  current: ModelRef | null
  effort: Effort | null
  effortOverridden: boolean
  preset?: string
  /** 分支当前模型配的预设名。presets 按模型配，不按 folder——借主干的话
   *  主干模型没配、分支模型配了时分支里控件整个消失（2026-10-08） */
  presets: string[]
  /** 分支的贴图通道（判据同 state.imagesEnabled）。也是模型级的，借主干的话
   *  主干能收图、分支不能时分支里贴的图会被 core 拒 */
  imagesEnabled: boolean
  contextWindow: number
  /** 分支自己的审批开关（内存态，对齐主干） */
  attendance: Attendance
  /** 历史摘要开关（folder 级，主任务与分支同值——见 protocol 上面那条） */
  summaryInContext: boolean
  /** 拉段开关（manifest.pullSegments）：true = 拉别的会话的段；任务默认
   *  false（独立）。主任务无此字段（恒开） */
  pullSegments: boolean
}

/** 单个文件夹的显示状态：路径 + 它的轮是否在跑（后台轮的 ● 标记） */
export type FolderState = {
  path: string
  running: boolean
  /**
   * 挂起中的审批数。后台文件夹的卡不跨标签弹出（彻底隔离，App.tsx 有说明），
   * 但「那边有事等人」得让人知道——标签上亮个角标，切过去才看得到卡片内容。
   * 不显示卡片是为了不让人在缺少对话上下文的情况下点允许
   */
  pendingApprovals: number
}

/** 活动编辑器：绝对路径 + 选区（1 起、含两端整行）。没选区 start/end 都不带；
 *  text 只在选区 ≤ SELECTION_TEXT_LIMIT 行时带（editor-ref.ts） */
export type ActiveEditor = {
  path: string
  start?: number
  end?: number
  text?: string
}

/** 上下文分析面板的数据：regions.jsonl 最后一条 + 当时的窗口口径 */
export type RegionsInfo = {
  /** 那条记录的时间（ISO）——数据可能是上一轮的，展示要说清楚「什么时候的账」 */
  at: string
  /** 窗口与输出预留：占比的分母口径（窗口 = 预算 + 预留 + 安全余量） */
  contextWindow: number
  maxTokens: number
  budget: number
  overhead: number
  cold: number
  warm: number
  hot: number
  stub: number
  floor: number
  live: number
  /**
   * 同一次请求 API 报回的输入 token（缓存读写都算）。上面七个区是字符密度
   * 估算原值，面板按 real/估算和 同比例缩放显示。null = 没拿到（失败的尝试、
   * 渠道不报 usage、9-29 之前的老行）——退回纯估算
   */
  real: number | null
}

/** 审批请求（approval_request 的命名类型，给 webview 和 bridge 引用） */
export type ApprovalRequest = Extract<ToWebview, { type: 'approval_request' }>

/** lark-cli 检测结果（设置页「飞书推送」分区，gateway_check 的响应）。auth
 *  取 `auth status` 输出里的 identities.bot.status：'ready' = 登录正常；
 *  null = 已装但读不到 */
export type GatewayCheck = {
  larkCli: string
  installed: boolean
  /** `--version` 的原始输出（如 "lark-cli version 1.0.97"） */
  version?: string
  auth?: string | null
  /** 不可用时的原因（spawn 报错 / 超时 / 退出码非 0 的 stderr 尾巴） */
  error?: string
}
