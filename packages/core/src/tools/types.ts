import type { ImageInput, ToolDefinition } from '../llm/types.ts'
import type { ApprovalCategory } from './approval.ts'
import type { BgRegistry } from './bg.ts'

export type { ImageInput }

export type ToolContext = {
  /** 记忆库根（分身任务 = 任务目录）。bash 往子进程注入
   *  SIMPLE_CODE_MEMORY_DIR——$SIMPLE_CODE_MEMORY 靠它认自己的库 */
  memoryRoot?: string
  /** 工作区根目录的绝对路径。工具的相对路径都基于它解析 */
  root: string
  /** 用户中断。中断时正在跑的命令跟着杀，不等它跑完（design.md §5.2） */
  signal: AbortSignal
  /**
   * 插话软中断：用户在工具执行期间发了新消息（排队插话由 runLoop 在迭代
   * 顶投递）。与 signal（stop，中断即杀）不同——**不杀**：bash 听到它就把
   * 执行中的命令转后台、控制权还给循环，命令继续跑、输出接日志文件。
   * 没有它，一条 11 分钟的 bash 会把用户的问题扣住 11 分钟（2026-09-21）。
   * 用不到的忽略即可；信号每次插话换新，只命中当时正在执行的那一个工具
   */
  interjectSignal?: AbortSignal
  /** 本条工具调用在事件流里的 id。bash 的审批卡靠它锚到对应命令行下方。
   * 可选：ephemeral/单测构造 ctx 时不必填，工具层用空串兜底 */
  toolCallId?: string
  /**
   * 原始输出的落盘钩子（design.md §9.3 的第 ① 层）。第 2 步接上了：
   * 未截断的完整输出流向 `memory/raw/<toolCallId>.log`。
   *
   * 传 undefined 就是不落盘，工具行为不变——ephemeral session 和
   * 单测走的是这条路。
   */
  onRawOutput?: (chunk: string) => void
  /**
   * 上面那个钩子把原始输出写到了哪（**工作区相对路径**）。
   *
   * 截断提示里要带上它，模型才知道去哪 `cat` 完整输出（design.md:512）。
   * 光落盘不给路径等于白落——文件在那儿，模型不知道。
   *
   * 用相对路径不是绝对路径：模型拿它直接拼 `cat` 命令，而 bash 的 cwd
   * 就是工作区根目录
   */
  rawPath?: string
  /**
   * 权限审批（docs/proposals/approval.md §4.1）。注入模式与 onRawOutput
   * 同款（可选，不注入 = 无审批，ephemeral / 单测走老行为），但语义
   * 不同：那个是 fire-and-forget 事件钩子，这个要 await 回执——是审批，
   * 不是通知。名字里不带 user：模型向用户提问是另一回事，别混。
   *
   * 工具在判定器说要问时调它，拿到 'deny' 就不执行。中断语义：宿主
   * 收到 abort 要 resolve 'deny'（core 侧另有 race 兜底）。
   *
   * `{ deny: '...' }` 是**拒绝带反馈**：
   * 用户拒绝时留了一句话给 agent——「别用 curl，用 webfetch」这种。
   * 模型看得见这句，重试质量比裸 deny 高一档。纯 'deny' 依然合法
   */
  requestApproval?: (q: {
    command: string
    toolCallId: string
    category: ApprovalCategory
    detail: string
    reason: string
    /** 支持「始终允许」时的预览：选了会往 approval.json 记什么。没有
     * 这个字段 = 该卡不出第三键（隐藏路径等不收敛的场景） */
    always?:
      | { kind: 'lead'; lead: string }
      | { kind: 'path'; dir: string }
      | { kind: 'nonpath'; lead: string; from: number }
      | { kind: 'paths'; dirs: string[] }
  }) => Promise<'allow' | 'always' | 'deny' | { deny: string }>
  /**
   * 视觉转述（vision relay）：主模型无视觉且配置了 visionModel 时由 session
   * 注入。view_image 拿它把图换成文字描述——主模型全程不见像素。可选：
   * 没注入 = 无转述能力，工具走老路（图原样返回，发送出口换占位文本）。
   * 抛错 = 转述失败，工具层负责降级提示
   */
  visionRelay?: (
    image: { data: string; mimeType: string },
    focus: string,
    /** 主循环的中断信号。轮内转述传它——不传的话请求打不断（见 makeVisionRelay） */
    signal?: AbortSignal,
  ) => Promise<string>
  /**
   * 后台进程登记簿（bg.ts）。可选：CLI/ephemeral/单测不注入，bash 的
   * 残留抓取随之跳过——工具行为不变，只是没人记账。
   *
   * bash 在命令正常结束（close）后调 collect；超时/中断路径不调——
   * 那两条路已 killGroup，组里不会有活口
   */
  bg?: BgRegistry
}

/**
 * 原始输出的落盘句柄。定义在 tools 层是因为 loop 和 session 都要引用它，
 * 而它们都在 tools 上游（CLAUDE.md §1.3 的分层方向）。
 *
 * `path` 跟着句柄一起给，不让调用方自己拼——拼错了不会报错，只是模型
 * `cat` 的时候找不到文件，而那时已经离落盘很远了
 */
export type RawSink = {
  write(chunk: string): void
  close(): void
  /** 工作区相对路径，进截断提示给模型看 */
  readonly path: string
}

export type ToolOutput = {
  /** 已截断，可以直接发给模型 */
  output: string
  exitCode: number
  isError: boolean
  /**
   * 工具带出的图（原图 base64，不含 data: 前缀）。工具**不自己压**——
   * 发送侧 resizer 统一处理（web-tools §1 D4），与用户贴图同一条路。
   * ImageInput 而非 ImagePart：入口侧没有 detail 那个请求偏好
   */
  images?: ImageInput[]
}

export interface Tool {
  readonly name: string
  readonly definition: ToolDefinition
  /**
   * **永不抛异常**（CLAUDE.md §4.1）。非 0 退出、超时、spawn 失败、参数非法——
   * 全部变成 isError: true 的正常返回。抛出去会打断整个 loop。
   */
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutput>
}
