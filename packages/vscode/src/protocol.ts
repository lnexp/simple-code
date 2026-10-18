import type {
  AgentEvent,
  ApprovalCategory,
  BgProcessInfo,
  CompactResult,
  Effort,
  ImageInput,
  ModelRef,
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
  | { type: 'setApprovalEnabled'; on: boolean; task?: string }
  /** 用户点掉一个后台残留进程。宿主 TERM 后回一条 bg_processes 更新列表。
   *  folder：该进程所属的 bridge——多根下 registry 各目录独立，pid 只在
   *  原目录有账，不带 folder 会被路由到当前 bridge 而杀空（用户拍板：
   *  进程条按目录隔离显示，但跨目录的 × 必须打到正确的 bridge） */
  | { type: 'bg_kill'; pid: number; folder?: string }
  /** 要一份上下文分区快照（点状态行「上下文 X」弹出面板）。响应是 regions。
   *  task：查分支的库——上下文环跟着分支走，不拿主干的数字骗人 */
  | { type: 'get_regions'; task?: string }
  /** 手动压缩（上下文分析面板的按钮，2026-10-17）。task：压分支；缺省 = 主任务。
   *  响应是 compact_result。只在停止时能压，跑着的 session 由 core 拒绝 */
  | { type: 'compact'; task?: string }
  /**
   * 往上拉到顶了，要更早的历史。cursor = 上一页返回的 `next`（第一次
   * null——从最新的归档行起）。响应是一条 historyPage
   */
  | { type: 'fetchHistory'; cursor: number | null }
  /** 分支：从最新回答 fork（`/task` 或分支条 + 按钮都走这）。主干在跑会被拒
   *  （fork 要拷记忆库）。brief 是分支的第一条消息 */
  | { type: 'task_dispatch'; brief: string }
  /** 分支：往分支发消息（切换分支后输入框的目标）。分支跑着 = 插话入队
   *  （core 的 newInput 语义），空闲 = 起新一轮 */
  | { type: 'task_send'; task: string; text: string; images?: ImageInput[] }
  /** 选中了某个分支（切换视图）：宿主补一份该分支的基线（单一真相，
   *  webview 的增量投影不跨 attach 存活） */
  | { type: 'task_open'; task: string }
  /** 关闭任务（task-v3：唯一的生命周期操作。在跑会先停，摘要排空后收尾） */
  | { type: 'task_close'; name: string }
  /** 中断任务正在跑的轮（与对话的停止同一语义，通用控件） */
  | { type: 'task_stop'; name: string }

export type ToWebview =
  /** core 的事件**原样透传**，不在宿主侧翻译。翻译是 webview 的事 */
  /** at：事件到达宿主的墙钟。startedAt/endedAt 全靠它——webview 和宿主
   *  镜像用同一个值，切回重放时秒表起点不漂 */
  | { type: 'agent'; event: AgentEvent; at: number }
  /** 要审批的命令到了，渲染成气泡等 approval_reply */
  | {
      type: 'approval_request'
      /** 超时自动拒绝的墙钟时刻（bridge 的 setTimer 同款口径）。
       * 卡上倒计时用；attach 重推的是同一对象，剩余时间自动变短 */
      expiresAt: number
      /** 发卡的是哪个文件夹——后台跑着的轮弹的卡带这个，卡片上标注 */
      folder?: string
      /** 分身任务弹的卡带这个：任务名。卡片标注来源，面板内过滤也靠它 */
      task?: string
      id: number
      command: string
      toolCallId: string
      category: ApprovalCategory
      detail: string
      reason: string
      /** 支持「始终允许」时的预览（会往 approval.json 记什么）。
       * 没有字段 = 该卡不出第三键（隐藏路径等不收敛场景）。
       * nonpath：该命令从第 from 位（0 基）位置参数起不判为路径
       * （元素寻址工具的误拦采集） */
      always?:
        | { kind: 'lead'; lead: string }
        | { kind: 'path'; dir: string }
        | { kind: 'nonpath'; lead: string; from: number }
        /** paths：multi 卡同质 external_dir 的批量目录（方案 1，
         * 2026-09-21）——按钮「始终允许这 N 个目录」 */
        | { kind: 'paths'; dirs: string[] }
        | { kind: 'hidden'; path: string; write: boolean }
    }
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
      /** 审批开关当前值。开关是宿主内存态，webview 重载后靠这条恢复 */
      approvalOn: boolean
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
      contextTokens?: number
      lastTiming?: ChatView['lastTiming']
    }
  /**
   * fetchHistory 的响应：更早的一页（正序，prepend 即可）。`next` 是下一页
   * cursor，null = 到底。**空页 + null 也合法**（没有任何归档时第一拉就是）
   */
  | { type: 'historyPage'; items: ChatItem[]; next: number | null }
  | { type: 'fatal'; message: string }
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
   * 分身任务的全量快照（有变化才发）。folder 由路由注入（approval 同款）：
   * 任务跟目录走，切走即清、切回由宿主镜像补发
   */
  | { type: 'tasks'; tasks: TaskState[]; folder?: string; /** 分支上限（+ 入口的显隐判据，宿主是唯一真相） */ limit: number }
  /** 分身任务的流事件（task_agent → 任务面板的增量）。只在 active 直发 */
  | { type: 'task_agent'; name: string; event: AgentEvent; at: number; folder?: string }
  /** 分身任务面板的基线（切回/重开时补发，整体替换该任务的 items） */
  | {
      type: 'task_hydrate'
      name: string
      items: ChatItem[]
      folder?: string
      /** 同 hydrate：底栏水位/上一轮用量，不带的话切回任务底栏清空 */
      contextTokens?: number
      lastTiming?: ChatView['lastTiming']
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
  approvalOn: boolean
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
