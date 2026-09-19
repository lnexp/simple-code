import type { AgentEvent } from '../events.ts'
import { LLMStreamError } from '../llm/protocol.ts'
import { resizeImageParts, stripImagesWhenUnsupported, thumbnailDataUrl } from '../llm/resizer.ts'
import { logRun } from '../runlog.ts'
import type {
  Capabilities,
  FinishReason,
  ImageInput,
  Message,
  Part,
  Request,
  ToolCallPart,
  ToolResultPart,
  Usage,
} from '../llm/types.ts'
import type { RawSink, Tool, ToolContext, ToolOutput } from '../tools/types.ts'
import {
  type Accumulator,
  accumulate,
  emptyAccumulator,
  finishAccumulator,
  pendingToolCalls,
} from './accumulate.ts'
import {
  assembleContext,
  hotSummaryIds,
  type LiveMessage,
  type Summary,
  type UnloadedRef,
} from './assemble.ts'
import { hasPendingToolCalls, hasUnansweredUserInput, normalizeWithOrigin } from './normalize.ts'
import { type RegionSizes, regionSizes } from './regions.ts'
import { drainStubWater } from './summarize.ts'
import type { StreamEvent } from './retry.ts'
import { inputBudget as budgetOf, contextUsage, estimateMessageTokens } from './tokens.ts'
import { unloadMessage } from './unload.ts'

/**
 * 排队的任务，**FIFO**（core-modules.md §7）。
 *
 * 只有 newInput 一个成员。文档原本计划让卸载也走这里，实施时发现不必——
 * 卸载在 `runStep` 里就地做完，卸完接着发请求，不需要退回外层再来一轮。
 */
/**
 * 用户一轮输入的 parts 组装。text 在前图在后——图是「附言」，放前面的话
 * 文本在多模态对齐里的锚点位置会更靠后（按顺序渲染）
 */
export const userParts = (text: string, images?: ImageInput[]): Part[] => [
  { type: 'text', text },
  ...(images ?? []).map((img): Part => ({ type: 'image', ...img })),
]

export type Task = { type: 'newInput'; text: string; images?: ImageInput[] }

export type LoopDeps = {
  /**
   * 发一次请求并把整个流交出来。**已经包过 requestWithRetry**——loop 不认识
   * 协议、不认识 HTTP，测试直接喂一个假的（core-modules.md §10）
   */
  stream(request: Request, signal: AbortSignal): AsyncIterable<StreamEvent>
  tools: Map<string, Tool>
  root: string
  caps: Capabilities
  /** buildRequest 需要、但 loop 不解释的部分 */
  request: Omit<Request, 'messages'>
  /**
   * 重读 AGENTS.md / notes 索引并更新 deps.request.system。**只允许在
   * 卸载触发点调用**（budget / stale / force——见 unloadIfNeeded）：那时
   * 摘要顶替已把前缀缓存整个作废，换 system 是零边际成本；任何其他时机
   * 调用都会废掉全史 KV 缓存。one session 长会话靠它拿到用户中途改的
   * 约定，不必等 reload（AGENTS.md 本体仍是建会话读一次）。
   * 返回 { agentsOverLimit } 时由本层发提示——deps 自己没有事件通道
   */
  reloadSystem?: () => Promise<void | { agentsOverLimit?: boolean }>
  /**
   * 主动催一次摘要生成（非阻塞）。存根段超线又没有 ready 摘要可顶替时由
   * activateByStubLevel 调——连续使用中 idle 摘要跟不上，存根堆着没人
   * 回收。session 的实现复用 summarizeIdle（自带并发闸）；不给就跳过
   */
  kickSummary?: () => void
  /** 时钟，计 request_timing 用。生产是 Date.now，注入是为了测试能钉死数值 */
  now: () => number
  maxIterations: number
  /**
   * 工具原始输出的落盘句柄工厂（design.md §9.3 第 ① 层）。
   * 不传就是不落盘——ephemeral session 和大多数单测走这条路。
   */
  rawSink?: (toolCallId: string) => RawSink
  /** 权限审批（approval.md §4.1）。不传 = 无审批（工具放行），测试/ephemeral 走这条 */
  requestApproval?: ToolContext['requestApproval']
  /** 视觉转述副模型。不传 = view_image 走老路（图直给，出口换占位） */
  visionRelay?: ToolContext['visionRelay']
  /** 后台进程登记簿（bg.ts）。不传 = 不记账，同 requestApproval 的注入模式 */
  bg?: ToolContext['bg']
  /**
   * 上下文卸载（design.md §9.4）。不传就不卸载——ephemeral session 天然
   * 如此（没有 store 就没地方存原文），跟 rawSink 一个模式。
   */
  memory?: MemoryDeps
}

export type MemoryDeps = {
  contextWindow: number
  /** 卸到**预算**的这个比例为止（不是窗口的，见 unloadIfNeeded） */
  targetRatio: number
  /**
   * 距上次响应超过它就视缓存已死，预算没超也压到 target（提案 §12）。
   * per-model 配置（`modelSpec.cacheTtlMs`），缺省 3 小时——那里的注释写了
   * 为什么往大了给
   */
  cacheTtlMs: number
  /** 时钟。生产是 Date.now，注入是为了测试能钉死「距上次响应多久」 */
  now: () => number
  /**
   * 上次模型响应结束的时刻。null = 本进程还没有过响应（刚启动），此时不判
   * stale——宁可漏判不误判，见 isCacheStale 的注释
   */
  lastResponseAt: () => number | null
  /** 流结束时记录响应时刻。和 lastResponseAt 配对，cacheTtlMs 的那一端 */
  markResponded: () => void
  /**
   * 保底区的大小，**按 token 算，不按 turn 算**（提案 §11.5）。最近这么多
   * token 的原文一个字不动。
   *
   * 原来是「整个当前 turn」，那等于没有上限——turn 多大它多大，实测最大的
   * turn 有 152,125 token（§8.1）。「一个 turn 有 100 个 step 就卸不动」正是
   * 这么来的。理由和 §8.3 拒绝「保 N 个 turn」是同一个：**turn 不是尺寸稳定
   * 的单位**（p90/p50 = 11 倍）。
   */
  floorTokens: number
  /**
   * 存根段上限（token）。三级递进的第二级水位线（2026-09-12 拍板）：
   * 卸载把原文裁成存根后，摘要在手也不急着顶替——存根便宜地保留真实头部
   * 文本，存根段超过这条线才让摘要进场。装配口径算水位（顶替的判断和发
   * 出去的那份必须是同一把尺子）
   */
  stubTokens: number
  /** 已卸载（推进线过）的 step 集合。水位口径：已卸未顶替的内容——存根和
   * 裁不动的原文——都是「等摘要收的滞留」。纯文本段没有存根形态，不把它
   * 算上的话触发卸载后 token 一点不降（原文继续全文在场） */
  unloadedSteps: () => Set<number>
  /**
   * 预算之外再留的余量，见 inputBudget。
   *
   * 做成注入而不是 loop 里的常量：system prompt 和工具定义每轮都发，但它们
   * 不在 `ctx.messages` 里，`contextUsage` 看不见——余量主要就是为它们留的，
   * 而它们多大只有上层知道。顺带让测试能把它设成 0，用几百 token 的小窗口
   * 就能验证预算逻辑
   */
  safetyMargin: number
  /** normalizeHistory 增删消息后同步归属数组（提案 §1.5 补记） */
  remap: (origin: (number | null)[]) => void
  /** 裁剪后保留的头部字符数 */
  keepHeadChars: number
  /** 工具输入输出超过这么多字符才裁。低于它原样保留（提案 §4.2） */
  clipThresholdChars: number
  /**
   * 把这些下标的消息标记为已卸载（原文留库），返回各自的归档路径和 turn 归属。
   * 下标对齐 `ctx.messages`。
   *
   * **turn 归属是要的**：摘要按 turn 生效（§9.5 的原子边界），而 `ctx.messages`
   * 是纯数组，光看它分不出哪几条属于同一个 turn
   */
  unload: (indices: number[]) => UnloadedRef[]
  /**
   * 把这些 step 标为冷。**和 unload 分开调**：出局是位置决定的（§11.5），
   * 但 step 里裁剪后一个字不变的短消息不进 unload 的 indices——给它们也存
   * 一份原文就是往库里写一模一样的两行。
   *
   * 纯文本 step 一条都不进 indices，全靠这个入口标冷；它们出局的收益也不在
   * 裁剪，在于**摘要能顶替它们**
   */
  markCold: (stepIds: number[]) => void
  /**
   * 启用这个 turn 的 L0 摘要，返回是否真的启用了（摘要 ready 才启用）。
   * false 就走 3a 的截断存根——§9.7 的降级路径。
   */
  /** 启用该 step 的 L0 摘要。head 和归档路径由 store 自己从库里取（见 headOfStep） */
  activateSummary: (stepId: number) => boolean
  /** 已生效（`inContext`）的摘要。发请求前拼装要用 */
  summaries: () => Summary[]
  /** 这几条摘要的叶子正文，按 summary id。查不到的不在返回值里（走温区渲染） */
  leafBodies: (summaries: Summary[]) => Map<number, string>
  /** 热区留几条展开正文（§4.4）。实测取 8，账见 schema.ts 的 hotLeaves */
  hotLeaves: number
  /** 热区降级一次降几条。**必须成批**，否则每轮破 ③ 的缓存（§4.7 硬约束一） */
  demoteBatch: number
  /**
   * 给内存历史配上 turn 归属。
   *
   * 由 store 提供而不是 loop 自己数：归属规则（老消息保留原归属、新增的算当前
   * turn）在 store.save 里已经有一份，两处各写一遍迟早对不上，而对不上的现象是
   * 摘要盖错 turn——context 里某一轮凭空消失或重复，不报错
   */
  withTurns: (messages: Message[]) => LiveMessage[]
  /**
   * 记一行「这次请求四个区各占多少」。**纯诊断，不参与任何判断**——参与了
   * 就得管它写失败怎么办，而它是给人调比例看的，掉几行无所谓。
   *
   * 做成注入而不是 loop 自己写文件：loop 层不碰 fs（`rawSink` 同一个模式）
   */
  recordRegions: (sizes: RegionSizes, budget: number) => void
  /** applyPendingMerges 剪掉存根后同步缩 store 的归属数组（见 Store.pruneMessages） */
  pruneMessages: (indices: number[]) => void
  /**
   * 生效待应用的合并（§9.1「生效」），返回被换出 context 的 turn 集合。
   * 空集 = 没有待生效的
   */
  applyMerges: () => Set<number>
  /** applyMerges 之后修剪内存存根，turn 归属缓存跟着缩 */
}

export type LoopContext = {
  messages: Message[]
  tasks: Task[]
  deps: LoopDeps
  signal: AbortSignal
  /**
   * 模型上一轮为什么停。四条件退出要看它，第一轮是 undefined。
   *
   * 显式写 `| undefined` 而不是只靠 `?`：截断续写要把它清掉表示"已消费"，
   * 而 exactOptionalPropertyTypes 下可选属性不能赋 undefined
   */
  lastFinish?: FinishReason | undefined
  /** 已经因为输出被截断而续写了几次。见 resumeAfterTruncation */
  resumeCount?: number
  /**
   * 上一轮 API 返回的真实 usage，预算判断的基线（tokens.ts 的 contextUsage）。
   * 第一轮是 undefined，那时全靠估算——历史短，估错也撞不到窗口。
   */
  lastUsage?: Usage | undefined
  /**
   * `lastUsage` 覆盖到**拼装后那份**的哪个下标为止。它之后的算「新增」，要估算。
   *
   * **坐标系是 `assembleForRequest(ctx)` 的结果，不是 `ctx.messages`**——和
   * `currentUsage` 遍历的那个数组必须是同一个，两者错开就是在拿 A 的下标切
   * B 的数组。usage 描述的本来就是「发出去的那份」，按它的长度记最直接。
   *
   * 一度记成 `ctx.messages.length`，配上照着内存历史遍历的 `currentUsage`
   * ——两处都是内存坐标系，自洽，但量的是根本没发出去的东西：被摘要顶替的
   * live 消息（§4.1）留在内存里却不进请求，全被当成用量。实测 542,938 字符
   * 的 live 消息全落在生效摘要的覆盖范围内，把 126k 的真实上下文顶过 238,000
   * 的预算，隔一阵就误归档一次。
   *
   * 更早还错过一次方向相反的（5b63f04）：下标记的是拼装后长度、遍历走内存
   * 历史。**两个坐标系并存就会反复出这种错，所以现在统一到拼装后那份**
   */
  usageCoversUpTo?: number
  /**
   * 本 turn 触发过死循环熔断。熔断的 result 会落进历史（模型下一轮看得到
   * 原因和出路），但 turn 本身到此为止——不终止的话，模型无视熔断文案
   * 继续原样重试就是永动烧 token（merge-e2e 的无限 mock 转满 500 轮
   * maxIterations 实测过这个坑）
   */
  doomed?: boolean
  /**
   * visionRelay 的转述缓存（图 data → `[视觉转述] …` 成品文本，'' = 失败）。
   * 可变状态和 lastUsage 一个模式：loop 内逐轮累积，不落库。缓存住的意义
   * 是发送出口（assembleForRequest → stripImagesWhenUnsupported）是同步的，
   * 转述这种异步活只能提前一步在这里做完；'' 也算命中——失败不重试，
   * 出口兜底占位符
   */
  relayCache?: Map<string, string>
}

/**
 * 输出被截断后最多续写几次。
 */
const MAX_RESUME = 3

/**
 * 顶层入口。**任何未分类的错误都不能让进程崩**（design.md §5.2 第四条地基）：
 * 发一个 error 事件然后正常结束，turn 完了但进程还活着。
 *
 * 清理收口在 finally。成功、中断、报错三条路径都要补未配对的 tool_result，散在三个 return
 * 前面早晚漏一个。
 */
export async function* run(ctx: LoopContext): AsyncIterable<AgentEvent> {
  try {
    yield* runLoop(ctx)
  } catch (error) {
    // LLMStreamError 带 ProtocolError detail（kind/retryable/retryAfterMs，
    // message 是协议层写给用户看的人话）。String(error) 会把它抹成
    // 'Error: xxx' 且丢掉分类——UI 就没法区分「换 key」和「等等再试」
    if (error instanceof LLMStreamError) {
      logRun({
        ev: 'error',
        folder: ctx.deps.root,
        message: error.detail.message,
        kind: error.detail.kind,
        retryable: error.detail.retryable,
      })
      yield {
        type: 'error',
        message: error.detail.message,
        retryable: error.detail.retryable,
        kind: error.detail.kind,
      }
      return
    }
    logRun({ ev: 'error', folder: ctx.deps.root, message: String(error), retryable: false })
    yield { type: 'error', message: String(error), retryable: false }
  } finally {
    // 中断落在流里时，已经攒下的 tool_call 可能一个结果都没有。不补占位的话
    // 下一轮请求缺配对直接 400，而且这条历史一直在，之后每轮都 400
    normalize(ctx)
  }
}

/** 外层：一直跑到真的没事做了 */
async function* runLoop(ctx: LoopContext): AsyncIterable<AgentEvent> {
  for (let iteration = 0; iteration < ctx.deps.maxIterations; iteration++) {
    // 排队的任务优先于生成新回复。不需要单独的调度器——每轮结束检查一遍即可。
    //
    // **shift 不是 pop。** core-modules.md §7 写的是「栈」，但用户在 agent
    // 跑的时候连发两条消息时，栈会先处理第二条——模型看到的因果顺序是反的，
    // 且不报错。第 3 步的 unload 要插队就插到队首，不是把结构改成栈
    const task = ctx.tasks.shift()
    if (task) {
      ctx.messages.push({ role: 'user', parts: userParts(task.text, task.images) })
      continue
    }

    if (ctx.signal.aborted) return

    // 截断续写要排在 shouldExit 前面：'length' 不等于 'tool-calls'，
    // 不拦住的话下一行就直接 return，话说到一半的回答被当成正常结束
    if (needsResume(ctx)) {
      const done = yield* resumeAfterTruncation(ctx)
      if (done) return
      continue
    }

    if (shouldExit(ctx)) return

    // 非视觉模型 + 配了 visionModel：发请求前把历史里没转述过的图（用户
    // 贴图 / reload 进来的）转述进缓存——发送出口按缓存把图换成转述文本。
    // 放这里（而不是 send 入口）覆盖全部入图路径：send 直落库、排队 task、
    // 重启恢复的历史；缓存保证一张图只转述一次，切模型也不重述。
    // view_image 不用管——它执行时 output 已经带转述了
    await relayPendingImages(ctx)

    yield* runStep(ctx)
    // 熔断后 turn 收口：result 已落历史（模型下轮可见原因），但不再继续
    if (ctx.doomed) return
  }
  yield { type: 'error', message: `超过 ${ctx.deps.maxIterations} 轮仍未结束`, retryable: false }
}

/**
 * visionRelay 转述缓存填充（见 LoopContext.relayCache）。失败的图存 ''
 * 一次性了结——每轮重试一个必然再失败的请求，loop 会像 400 卡死一样难看；
 * '' 在出口兜底成占位符，模型至少知道这里原本有图
 */
async function relayPendingImages(ctx: LoopContext): Promise<void> {
  if (ctx.deps.caps.images || !ctx.deps.visionRelay) return
  const pending: { data: string; mimeType: string }[] = []
  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type === 'image' && !ctx.relayCache?.has(part.data)) {
        if (pending.every((img) => img.data !== part.data)) pending.push(part)
      }
    }
  }
  if (pending.length === 0) return
  const relay = ctx.deps.visionRelay
  const texts = await Promise.all(
    pending.map(async (img) => {
      try {
        return `[视觉转述] ${await relay(img, '')}`.trim()
      } catch {
        return ''
      }
    }),
  )
  ctx.relayCache ??= new Map()
  pending.forEach((img, i) => ctx.relayCache!.set(img.data, texts[i] ?? ''))
}

/**
 * 这一轮模型调工具了吗——**看消息里有没有 tool_call，不看 finish reason**。
 *
 * finish reason 不可信（见 runLoop 内的注释），踩过坑的判据只看消息内容。
 */
function lastTurnCalledTools(messages: Message[]): boolean {
  const lastAssistant = messages.findLast((msg) => msg.role === 'assistant')
  return lastAssistant?.parts.some((part) => part.type === 'tool_call') ?? false
}

/**
 * 输出被 max_tokens 砍断了，而且这一轮**没有调工具**。
 *
 * 调了工具就不续写：工具结果回填之后模型本来就会接着说，再塞一条续写指令
 * 是多余的，还会让模型以为自己被打断了两次。
 */
const needsResume = (ctx: LoopContext): boolean =>
  ctx.lastFinish === 'length' && !lastTurnCalledTools(ctx.messages)

/**
 * 输出被截断时**续写而不是直接结束**：
 * 追加一条要求模型接着说的消息，被截断的那条 assistant 消息**保留在历史里**，
 * 模型从断点处继续。
 *
 * 注意**不能参数一字未改地重发整个请求**：参数没变，几乎必然再次截断，
 * 白烧重试的钱最后还是报错。我们没做「先提 max_tokens 静默重试一次」这层——
 * 配置里的 maxTokens 经过 zod 的 default 之后就分不清是用户写的还是默认值了，
 * 没有那个信息就没法照做。要补的话得先让 config 层保留原始值。
 *
 * 返回 true 表示已经没救了，调用方该结束。
 */
async function* resumeAfterTruncation(ctx: LoopContext): AsyncGenerator<AgentEvent, boolean> {
  const attempt = (ctx.resumeCount ?? 0) + 1
  if (attempt > MAX_RESUME) {
    yield {
      type: 'error',
      message: `输出连续 ${MAX_RESUME} 次被 max_tokens 截断，已停止续写。把任务拆小一点，或者调大配置里的 request.maxTokens`,
      retryable: false,
    }
    return true
  }

  ctx.resumeCount = attempt
  // 把 lastFinish 清掉：这个"上一轮为什么停"的信息已经被消费了。不清的话
  // needsResume 下一轮还是 true，会一路续写到上限却一个请求都不发
  ctx.lastFinish = undefined
  ctx.messages.push({ role: 'user', parts: [{ type: 'text', text: RESUME_PROMPT }] })
  yield { type: 'truncated', attempt, limit: MAX_RESUME }
  return false
}

/**
 * 措辞语义：
 *
 * > Output token limit hit. Resume directly — no apology, no recap of what you
 * > were doing. Pick up mid-thought if that is where the cut happened.
 * > Break remaining work into smaller pieces.
 *
 * 三句都有用：不许道歉和复述是因为那会再烧掉一截输出；「从断点接着说」是
 * 因为模型的默认反应是重新开一段；「把剩下的拆小」是防止下一轮又被截断。
 */
const RESUME_PROMPT =
  '输出被长度上限截断了。直接接着写，不要道歉、不要复述已经说过的内容。' +
  '如果是在句子中间断的，就从断的地方继续。把剩下的工作拆成小块，避免再次被截断。'

/**
 * 退出条件是四个条件的合取，**不是 `toolCalls.length === 0`**。
 *
 * ## 为什么不能只看 finish reason
 *
 * `lastFinish !== 'tool-calls'` 看起来已经表达了「模型不打算调工具了」，
 * 于是后面两项像是重复判断。**不是。finish reason 本身就不可信**：
 *
 * provider 说 `stop` 却带着 tool_call 是**实际会发生**的，而且有两段后果，
 * 我们原来只挡住了前一段：
 *
 * 1. 工具没执行 → 下一轮请求缺配对直接 400，而且这条历史一直在，每轮都 400
 * 2. **工具执行了、结果也回填了，但 loop 认为没事做直接退出——
 *    tool_result 永远没发给模型**。agent 干完活不汇报，全程不报错
 *
 * 第 2 段是 `lastTurnCalledTools` 挡的：这一轮只要调过工具，就必须再发一轮
 * 把结果给模型看。
 *
 * `hasPendingToolCalls` 挡的是孤儿**藏在更早消息里**的情况——
 * `lastTurnCalledTools` 只看最后一条 assistant 消息，看不见它。第 1 步的历史
 * 由 loop 自己产生，出不了那种形状；第 2 步从 SQLite 载入之后形状就不受我们
 * 控制了。变异检验确认过：没有那条测试的话，删掉这一项全绿。
 *
 * ## 最后一项也容易漏
 *
 * 用户在 agent 跑的时候插一句话，没有 `hasUnansweredUserInput` 的话 loop
 * 会认定「没有 tool call 了，结束」，**那条消息直接被丢掉，不报错**。
 */
function shouldExit(ctx: LoopContext): boolean {
  return (
    ctx.lastFinish !== undefined &&
    ctx.lastFinish !== 'tool-calls' &&
    !lastTurnCalledTools(ctx.messages) &&
    !hasPendingToolCalls(ctx.messages) &&
    !hasUnansweredUserInput(ctx.messages)
  )
}

/**
 * 内层：消费一个流到底，再串行跑完它要的工具。
 *
 * 没有返回值。文档里画的是三态 `continue | stop | unload`，但三个都不需要
 * 返回值表达：stop 是冗余的（`runLoop` 每轮开头已经查过 `signal.aborted`，
 * 变异检验确认过改成恒返回 continue 全绿），而 unload **不需要退回外层**
 * ——它在这一步里就地做完，卸完接着发请求，外层不必知道发生过卸载。
 */
async function* runStep(ctx: LoopContext): AsyncIterable<AgentEvent> {
  // 无条件过一遍。防的三件事都是「不报错但这条历史一直在，之后每轮都 400」
  normalize(ctx)

  // 卸载排在 normalize 之后、发请求之前：估算要基于干净的历史（孤儿
  // tool_call 会让它偏），而卸载完还要重新组装 request
  yield* unloadIfNeeded(ctx)
  // 三级递进的第二级（2026-09-12 拍板）：存根段水位检查。卸载把原文降级
  // 成存根后，摘要在手也不急——存根段超线才让摘要进场顶替。放在这里
  // 而不是卸载循环里：水位是**装配口径**（顶替过的不再计入），和发出去
  // 的那份同一把尺子；force 自救后同样受益（有摘要可顶就顶，窗口省更多）
  activateByStubLevel(ctx)

  const acc = yield* streamWithOverflowRecovery(ctx)

  // 预算基线的下标在 streamWithOverflowRecovery 里记（发请求那一刻，按拼装
  // 后那份的长度）。这里只推回复——**它是下一轮的「新增」**，所以必须在
  // 记完基线之后进数组
  ctx.messages.push(finishAccumulator(acc))
  ctx.lastFinish = acc.finish
  ctx.lastUsage = acc.usage
  // 缓存寿命的计时起点（提案 §12）。记在流结束而不是发请求前：stale 判断
  // 要量的是「服务端最后一次见到我们是什么时候」，请求发出去服务端还没回话
  // 时缓存状态未定，以响应到达为准
  ctx.deps.memory?.markResponded()
  // 在 push 回复之后算：报的是「下一轮要发多少」，那条回复也要算进去
  yield { type: 'step_finish', usage: acc.usage, contextTokens: currentUsage(ctx) }

  const calls = pendingToolCalls(acc)
  if (calls.length > 0) yield* executeTools(ctx, calls)
}

/**
 * 发一次请求；撞上下文超限就**强制卸载后重发**，而不是直接失败。
 *
 * 这是估算失效时的兜底。主动卸载（`unloadIfNeeded`）靠的是预算判断，而预算里
 * 有估算成分，估算永远可能偏低；偏低的后果就是这里的 400。**两者不能互相替代**：
 * 前者是预防，后者是预防失败后的自救。
 *
 * 都不裸重试原请求，是「先压缩/卸载，再发新请求」：
 * 每次重试之前一定要真的卸掉东西，参数没变就重发必然再次失败。
 *
 * 次数上限 3（有线上案例：1,279 个 session 出现 50+ 次连续失败，
 * 最高 3,272 次，每天浪费约 250K 次调用）。卸到只剩当前 turn 仍然超时会退出——那时已经
 * 没东西可卸了，再试是纯浪费。
 *
 * 救不回来时**抛出去**，由 `run` 的顶层 catch 变成一个 error 事件并结束这一轮。
 */
async function* streamWithOverflowRecovery(
  ctx: LoopContext,
): AsyncGenerator<AgentEvent, Accumulator> {
  for (let attempt = 0; ; attempt++) {
    // 图片缩放只在发出的一份上做（web-tools §2）：库和内存里始终原图，
    // 每轮从库重新组装、重新压，天然幂等——跟上面 assembleForRequest 对摘要
    // 是同一条纪律（变换发生在出口，源头不动）
    const request = {
      ...ctx.deps.request,
      messages: await resizeImageParts(assembleForRequest(ctx)),
    }
    // **每次尝试都记**，包括 overflow 自救的第 2、3 次——那几次的分区正是
    // 「卸载到底有没有把 ④ 压下去」的唯一证据
    // 保底区边界按当前 live 重算一遍（快照口径）。force 路径实际卸穿了
    // 保底区，重算出的边界偏乐观——观测误差，force 本来就是异常路径
    const live = ctx.deps.memory?.withTurns(ctx.messages) ?? []
    const floorStart = ctx.deps.memory
      ? floorStartIndex(live, ctx.deps.memory.floorTokens, inputBudget(ctx))
      : live.length
    const floorSet = new Set(live.slice(floorStart).map((entry) => entry.message))
    const stepIds = new Map(live.map((entry) => [entry.message, entry.stepId] as const))
    ctx.deps.memory?.recordRegions(regionSizes(request, floorSet, stepIds), inputBudget(ctx))
    // 预算基线的坐标系跟着**真正发出去的那份**走（见 usageCoversUpTo）。
    // 记在这里而不是外面：overflow 自救会重新拼装、重新卸载，最后一次尝试
    // 发出去多少条才是 usage 描述的那份，在外面拼第二次会拼出不同的长度
    ctx.usageCoversUpTo = request.messages.length
    let acc = emptyAccumulator()
    const startedAt = ctx.deps.now()
    let firstAt: number | null = null
    try {
      for await (const streamEv of ctx.deps.stream(request, ctx.signal)) {
        if (firstAt === null) firstAt = ctx.deps.now()
        const [next, agentEvs] = accumulate(acc, streamEv)
        acc = next
        for (const agentEv of agentEvs) yield agentEv
      }
      yield {
        type: 'request_timing',
        ttftMs: (firstAt ?? startedAt) - startedAt,
        totalMs: ctx.deps.now() - startedAt,
      }
      return acc
    } catch (error) {
      if (!isContextOverflow(error)) throw error
      // **已经吐出去的事件不撤回。** 超限一般在流开头就报，但即使中途报了，
      // 重发会从头再来一遍——UI 上表现为重复文本，比静默丢失好排查
      if (attempt + 1 >= MAX_OVERFLOW_RECOVERY || !(yield* forceUnload(ctx))) {
        // **抛而不是发 error 事件后返回。** 返回的话 runLoop 照常进下一轮，
        // 又发一次同样超限的请求——熔断只挡住了这一步，挡不住外层循环，
        // 结果还是无限重试（实测：上限 3 但实际发了 11 次）
        throw new LLMStreamError({
          kind: 'context_overflow',
          message:
            '上下文超过模型窗口上限，卸载历史后仍然放不下。' +
            '开一个新会话，或者在配置里换一个窗口更大的模型。',
          retryable: false,
        })
      }
    }
  }
}

/**
 * 卸一轮，返回是否真的卸掉了东西。没卸掉就没必要重发——参数没变，必然再错。
 *
 * 判据是 `unloaded` 事件里的条数，**不能比较 messages 的引用**：
 * `unloadIfNeeded` 末尾的 `normalizeHistory` 无条件返回新数组，比引用的话
 * 一条没卸也会看成"变了"，于是照样重发，熔断变成纯计数（实测：期望 1 次
 * 请求，实际 3 次）
 */
async function* forceUnload(ctx: LoopContext): AsyncGenerator<AgentEvent, boolean> {
  let unloaded = 0
  for await (const agentEv of unloadIfNeeded(ctx, true)) {
    if (agentEv.type === 'unloaded') unloaded += agentEv.count
    yield agentEv
  }
  return unloaded > 0
}

/**
 * 连续几次「卸载后重发」还不行就放弃。
 *
 * 不设上限的话，卸到只剩保底区（`floorStartIndex`）
 * 之后每轮都卸不动，而每轮都要真发一次请求——每天 250K 次浪费调用那种场景。
 */
const MAX_OVERFLOW_RECOVERY = 3

/** 协议层已经把这类错误分好类了（三个协议的 errorKind），这里只认标签 */
const isContextOverflow = (error: unknown): boolean =>
  error instanceof LLMStreamError && error.detail.kind === 'context_overflow'

/**
 * 把内存历史 + 已生效的摘要拼成要发出去的那份（提案 §4.1）。
 *
 * **这是唯一的拼装点。** 原提案说要在 `store.load()` 也拼一次、两处共用纯函数
 * 保持一致，实测下来那是错的：`load()` 的结果是 session 的内存历史，之后每轮
 * `save()` 原样写回库，摘要文本会当成真的 live 消息入库，重启一次多一份
 * （store.ts:load 的注释记了症状）。所以库和内存里始终是 live 原样，摘要只在
 * 「要发出去的那份」里出现，不回流。
 *
 * 没有 memory（ephemeral session、大多数单测）就是原样发，跟卸载一个模式。
 */
function assembleForRequest(ctx: LoopContext): Message[] {
  const memory = ctx.deps.memory
  // 图片降级在出口做（resizer.ts 的 stripImagesWhenUnsupported）：这是
  // 「发出去的那份」的最后一站，之后的消费方（发请求 / 估算 / usage 基线）
  // 看到的都是同一份降级后的。库里和 ctx.messages 永远保留原图
  if (!memory) return stripImagesWhenUnsupported(ctx.messages, ctx.deps.caps, ctx.relayCache)

  const summaries = memory.summaries()
  if (summaries.length === 0) return stripImagesWhenUnsupported(ctx.messages, ctx.deps.caps, ctx.relayCache)
  // 热区那几条展开叶子正文，其余只给键（§4.4 的分辨率梯度）。**只读热区的
  // 文件**——全读一遍是每轮请求都要付的 IO，而热区是十几个（`hotLeaves` 8，
  // 加降级批次的摆动上限 17），索引区整体上百条
  const hot = hotSummaryIds(summaries, {
    hotLeaves: memory.hotLeaves,
    batch: memory.demoteBatch,
  })
  const bodies = memory.leafBodies(summaries.filter((summary) => hot.has(summary.id)))
  return stripImagesWhenUnsupported(
    assembleContext(memory.withTurns(ctx.messages), summaries, bodies),
    ctx.deps.caps,
    ctx.relayCache,
  )
}

/**
 * 到阈值就卸载最老的消息，直到降回 target（design.md §9.4）。
 *
 * 完整流程文档写的三步（第 3b-2 步起三步齐了）：
 *
 * ```
 * 1. applyPendingMerges()          ← §9.1 生效，见下面那个函数
 * 2. while (tokens > target) unloadOldest()
 * 3. normalizeHistory()            ← §5.2 兜底，保证 tool 配对
 * ```
 *
 * 第 3 步的兜底不是可有可无的：卸载按 turn 边界切（§9.5），但边界算错时
 * tool_call 和它的 result 可能被拆散，那是下一轮 400 且此后每轮都 400。
 *
 * force 路径（context_overflow 自救）也走这里，apply 同样先于强卸——塌缩
 * 释放的空间可能直接把预算救回线内，那就一条都不用强卸。
 */
async function* unloadIfNeeded(ctx: LoopContext, force = false): AsyncIterable<AgentEvent> {
  const memory = ctx.deps.memory
  if (!memory) return

  // **先应用待生效的合并，再看要不要卸、卸多少**（§9.1「生效必须先于卸载」）。
  // 放在预算判断之前：塌缩本身就能释放一大块（10 条 L0 变 1 条 L1），
  // 很多时候应用完已经在预算内，一条都不用卸——顺序反了会按「还没释放」
  // 的状态多卸一批近期上下文
  yield* applyPendingMerges(ctx)

  // 缓存过期是第二个触发条件（提案 §12）：one session 隔夜回来，预算没超但
  // prompt cache 已经过期，这一发横竖全价，基数越小越好——把「该做的压缩」
  // 搭上这趟本来就要破的前缀。判据只能用时间推断：cache_read 只出现在响应的
  // usage 里，发请求前看不见
  const stale = isCacheStale(memory)
  const over = currentUsage(ctx) > inputBudget(ctx)
  if (!force && !stale && !over) return
  // 诊断（2026-09-18）：真机上出现过「距上次成功响应 2-6 秒、上下文才占 5%」
  // 却报 stale 归档的现象，四个数都落盘才能判是 last 没更新还是 ttl 读错。
  // 时间一律记 epoch ms + ISO(带 Z)，别只记可读串——跨时区读日志会把 UTC
  // 当本地看，这次定位就先被带偏过一轮
  if (stale || force || over) {
    const last = memory.lastResponseAt()
    logRun({
      ev: 'unload_trigger',
      folder: ctx.deps.root,
      reason: force ? 'force' : over ? 'budget' : 'stale',
      nowMs: memory.now(),
      nowIso: new Date(memory.now()).toISOString(),
      lastMs: last,
      lastIso: last === null ? null : new Date(last).toISOString(),
      sinceMs: last === null ? null : memory.now() - last,
      ttlMs: memory.cacheTtlMs,
      usage: currentUsage(ctx),
      budget: inputBudget(ctx),
    })
  }
  // 归档原因主因优先（force > 预算 > 缓存过期）。只看「有没有触发」不区分的话，
  // 三个场景共用一条「上下文接近上限」文案：缓存过期时是假的（实测 raw 14%
  // 也这么喊）、force 时是说反了（不是「接近」，是已经超了、连保底区都卸了）
  const reason: 'budget' | 'stale' | 'force' = force ? 'force' : over ? 'budget' : 'stale'
  // 搭这趟本来就要破缓存的车刷新 system prompt（AGENTS.md / notes 有没有
  // 改过、改了什么，都无所谓——重读一遍几 ms，横竖前缀已作废）
  const reload = await ctx.deps.reloadSystem?.()
  if (reload?.agentsOverLimit) {
    yield {
      type: 'error',
      message:
        'AGENTS.md 超过 2,048 token 上限，本次刷新已跳过（system 仍用旧版）。请精简 AGENTS.md——超限部分每轮全价；拆出来的结论放 .simple-code/notes/。',
      retryable: false,
    }
  }

  // **基数是预算，不是窗口**（提案 §10.5）。一度写成 `contextWindow * ratio`，
  // 那样这个比例的含义会随 maxTokens 漂移：窗口 256k、maxTokens 16k 时
  // 「窗口的 35%」是预算的 37.6%，maxTokens 配到 64k 就变成 47%——同一个配置值
  // 在两处配置下差 12 个百分点，而配置看起来完全合理。
  //
  // 这里原来还夹了一道 `Math.min(target, budget)`，防的是「target 比 budget
  // 还大 → 每轮判定超了却一条都挑不出来 → 卸载静默失效」。基数改成预算之后
  // 那个洞的根没了（schema 保证 targetRatio ≤ 1），夹子结构上不可能触发，删掉。
  // **要加回来的话先想清楚什么配置能让它触发**，想不出来就是又在防一个不存在的情况
  const target = inputBudget(ctx) * memory.targetRatio
  // **卸载的单位是 step**（提案 §11.5）。原来是 turn 整组，那样切不进一个
  // 大 turn 的内部——保底区改成按 token 收口之后边界会落在 turn 中间，
  // 按 turn 挑就又回到「100 个 step 的 turn 一条都卸不掉」
  const live = memory.withTurns(ctx.messages)
  const picked = pickOldestSteps({
    live,
    target,
    // **force 路径放弃保底区。** 一度以为不需要——「保底区有 floorTokens
    // 夹着，撑不爆窗口」。错了：夹的是**门限**，不是保底区的实际大小。
    // `floorStartIndex` 无论如何要整个圈住最后一个 step，而一个 step 能有
    // 「maxTokens 的助手输出 + N 条各 maxOutputChars 的工具结果」那么大，
    // 窗口小、一个 step 里工具调用又多的时候，它自己就超窗口。
    //
    // 那正是 §4.8 第 1 级降级当年要救的情况。这里不是把「裁剪」请回来——
    // 动作还是同一个 `unloadMessage`，只是紧急时连保底区一起卸。代价（模型
    // 看不清自己这一轮干了什么）比熔断后让用户「开个新会话」小
    floorStart: force ? live.length : floorStartIndex(live, memory.floorTokens, inputBudget(ctx)),
    keepHeadChars: memory.keepHeadChars,
    clipThresholdChars: memory.clipThresholdChars,
    // 起点用和触发判断同一个口径。用纯估算起算的话，触发说"超了"而挑选说
    // "已经在 target 以下"，一条都挑不出来——不报错，卸载静默失效
    from: currentUsage(ctx),
  })
  // 真的一条都挑不出来了（force 路径下意味着连保底区都卸过一遍）。
  // 往上报 count=0 由 forceUnload 判熔断，别在这里抛
  if (picked.length === 0) return

  // **挑中的 step 全判冷，但只有真卸得动的才往库里另存一份原文。**
  //
  // 两个集合不一样是有意的：纯文本 step、已经是存根的 step，卸载对它们是
  // 恒等的（`clipShell` 的收缩保护 + `isStubbed` 幂等），给它也存一份「原文」
  // 的话，库里就是内容完全相同的两行——写放大的另一种形态，
  // `write-amplification` 盯着这个。但它们照样该判冷：**出局是位置决定的，
  // 卸不卸得动是另一回事**（§11.5），判冷了摘要才能顶替它们
  const indices = picked.filter((index) => savingOf(live, index, memory) > 0)
  const cold = [...new Set(picked.flatMap((index) => live[index]?.stepId ?? []))]

  memory.markCold(cold)
  const refs = memory.unload(indices)
  let unloaded = 0
  for (const [nth, index] of indices.entries()) {
    const message = ctx.messages[index]
    const ref = refs[nth]
    if (message && ref) {
      ctx.messages[index] = unloadMessage(message, {
        threshold: memory.clipThresholdChars,
        keepHeadChars: memory.keepHeadChars,
        archive: ref.archivePath,
      })
      unloaded++
    }
  }
  // 摘要不再在这里激活（2026-09-12 三级递进）：卸载只管把原文降级成存根
  // （第一级），摘要进场由存根段水位驱动（activateByStubLevel，第二级）——
  // 两个开关解绑后，摘要在手也可以先不用，上下文按压力逐级压缩。
  // markCold 照旧：判冷是摘要顶替的资格，水位检查只激活判过冷的段
  normalize(ctx)
  // count 是**真的改写了几条**，不是打算卸几条。store 少还一个 ref（下标越界、
  // 行已经是 unloaded）时两者会不一样，报"打算卸的"会让上层以为卸成功了——
  // 超限自救就是靠这个数判断"还有没有东西可卸"，报虚数会让它一直重发
  // estimated 报卸完之后**发出去那份**有多大，和触发判断同一个口径。报
  // `ctx.messages` 的话，被摘要顶替的那些也算进去——数字比真实大好几倍，
  // 而这个字段唯一的用途就是让人判断「卸载到底管不管用」
  yield {
    type: 'unloaded',
    count: unloaded,
    estimated: estimateAll(assembleForRequest(ctx)),
    reason,
  }
}

/**
 * 把库里待生效的合并换进 context（§9.1 的第 1 步）。
 *
 * 塌缩的「换进」分两半，缺一不可：
 *
 * 1. 库里的开关（`applyMerges`）：子孙 in_context→0、链根→0→1——拼装
 *    （assembleContext）读的就是这个，从此 L1 顶替那批 L0
 * 2. **内存里的截断存根必须删掉。** 这是实现时推演出来的坑（提案没写）：
 *    token 估算量的是 `ctx.messages`，存根还躺在里面的话估算看不见这次
 *    释放——上一行的「apply 先于卸载、少卸一批」就白设计了，卸载循环
 *    会以为还超着，照样多卸
 *
 * 按 turn 整删是安全的：被合并的 L0 全都 in_context=1（pickMergeGroup 的
 * 入选条件），而 in_context=1 说明那个段的段头已被推进线扫过（碰头即上岗），
 * 拼装对被覆盖的 step 不输出原文——ctx.messages 里这些行还躺着也不进请求，
 * 整删只是让估算和实际发出去的对齐。段尾可能还有推进线没扫到的 live 原文
 * （碰头即上岗允许段半卸被顶替），那在 L0 上岗时就已经决定了，整删不新增
 * 伤害。turn 就是 §9.5 的原子边界，也不会拆散 tool 配对。
 */
function* applyPendingMerges(ctx: LoopContext): IterableIterator<AgentEvent> {
  const memory = ctx.deps.memory
  if (!memory) return

  const dropped = memory.applyMerges()
  if (dropped.size === 0) return

  // 归属要在删之前取（withTurns 靠下标对齐，删了再取就错位了）。
  // 钥匙是 stepId：合并收编的单位是 step（applyMerges 返回 step 集合），
  // 按 turnId 剪会把同 turn 里还在 context 的 step 连带剪掉
  const attributed = memory.withTurns(ctx.messages)
  const pruned: number[] = []
  ctx.messages = ctx.messages.filter((_, i) => {
    const drop = dropped.has(attributed[i]?.stepId ?? -1)
    if (drop) pruned.push(i)
    return !drop
  })
  // **必须通知 store**：ctx.messages 从中段缩了，归属数组不同步缩的话
  // 下一次 save 按下标对齐全体错位（step-summary-rework §4.4）
  memory.pruneMessages(pruned)
}

/**
 * 归一化历史，**并把增删告诉 store**。
 *
 * 两件事必须成对做，所以收成一个函数：`normalizeHistory` 会插占位 result、
 * 丢掉变空的消息，而 store 的 turnOf/stepOf 是按下标对齐的。少通知一次，
 * 插入点之后的历史就整体错一位——不报错，只是某轮归错 turn（提案 §1.5）。
 *
 * 原来三个调用点各写一行 `ctx.messages = normalizeHistory(...)`，谁也不通知
 * store。散着写就是在等第四个调用点漏掉。
 */
function normalize(ctx: LoopContext): void {
  const { messages, origin } = normalizeWithOrigin(ctx.messages)
  ctx.messages = messages
  ctx.deps.memory?.remap(origin)
}

/** 消息的前几十字，取第一个文本 part。没有文本就用 part 类型顶着 */
export function headOf(message: Message, limit: number): string {
  const part = message.parts.find((p) => p.type === 'text')
  const text = part?.type === 'text' ? part.text : `(${message.parts[0]?.type ?? '空'})`
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * 从最老的开始挑，挑到估算值降到 target 以下为止。
 *
 * **单位是 step，不是 turn**（提案 §11.5）。改单位是因为保底区改成了按 token
 * 收口——16,000 token 的边界会落在一个 turn 中间，按 turn 挑就切不进去，
 * 「一个 turn 有 100 个 step」照样一条都卸不掉。
 *
 * **严格从最老开始**（§9.4）：符合时间局部性，且保证 context 里近期部分是
 * 连续完整的，不出空洞。挑中间的会让模型看到「第 3 轮和第 5 轮完整、第 4 轮
 * 是摘要」这种跳跃；也让已卸载集合保持 step id 的连续前缀——「碰头即上岗」
 * 判的是段头那一条（store 的 segmentHeadUnloaded），前缀性保证段头卸了就是
 * 推进线真的到过这段。挑中间的会出现段尾卸了、段头没卸：判头退回不上岗
 * （存根滞留），判任一则把没退场的历史顶掉（§11.6 坑三）。
 *
 * **没有 `saved <= 0 就跳过`。** 上一版按 turn 挑时有这一条，防的是「已经
 * 全卸空的 turn 汇总为 0、`estimated` 一点不降、循环不 break、把保底线以内
 * 的也挑上」——真实库 66545 行里 80% 的重复行是这么来的，6 天 74 MB。
 * 现在不需要了，两个原因：
 *
 * ① 出局判据换成了位置（在不在保底区外），不是收益。裁不动的短消息照样
 *    出局——**这正是 §11.4 敢让对话文本免裁的前提**
 * ② 保底区有了硬边界，越过它就 break，挑不到「保底线以内」去
 *
 * 写放大的防线**下沉到消息层**（调用方的 `indices = picked.filter(saved > 0)`）：
 * 内容相同的两行才是写放大，那条判断在那里做更准。
 */
function pickOldestSteps(opts: {
  live: LiveMessage[]
  target: number
  /** 保底区第一条消息的下标。它和它之后的一律不碰 */
  floorStart: number
  keepHeadChars: number
  clipThresholdChars: number
  /** 当前用量的起算值。由调用方按真实口径算好传进来，见 contextUsage */
  from: number
}): number[] {
  const { live, target, floorStart } = opts
  const picked: number[] = []
  let estimated = opts.from

  for (const step of groupByStep(live)) {
    if (estimated <= target) break
    // **整个 step 都得在保底区之外。** step 是按顺序排的，一旦有一个碰到保底
    // 区，后面的全在里面，所以是 break 不是 continue。
    // 不切开 step 是因为摘要的 covers 是 step 区间——切开会让一个段永远
    // 凑不齐「整段卸空」
    if (step.some((index) => index >= floorStart)) break

    // **减去的是「省下来的量」，不是整条。** 卸载后每条还剩头部和归档提示，
    // 按整条减的话会以为已经降到 target 了，实际还差一截——现象是卸完仍然
    // 超预算，而且不报错。用真的卸载结果来算，不另写一套估算。
    //
    // 省不到（纯文本 step、已经是存根的 step）也照样入选，只是 `estimated`
    // 不降、循环继续往前走。它们出局的收益不在裁剪，在于**摘要能顶替它们**
    picked.push(...step)
    estimated -= step.reduce((sum, index) => sum + savingOf(live, index, opts), 0)
  }
  return picked
}

/** 一条消息卸载后能省下的 token。负数表示卸完反而更大（短消息加了归档提示） */
function savingOf(
  live: LiveMessage[],
  index: number,
  opts: { keepHeadChars: number; clipThresholdChars: number },
): number {
  const message = live[index]?.message
  if (!message) return 0
  const after = unloadMessage(message, {
    threshold: opts.clipThresholdChars,
    keepHeadChars: opts.keepHeadChars,
    archive: PATH_PLACEHOLDER,
  })
  return estimateMessageTokens(message.parts) - estimateMessageTokens(after.parts)
}

/**
 * 按 step 把下标分组，保持原顺序。相邻同 step 的连成一组。
 *
 * 不用 Map 收集是因为**顺序要的是消息顺序**，而 Map 的键序是插入序——step id
 * 在归属重映射之后不保证单调（`remapMessages` 让补出来的消息继承前一条），
 * 拿键序当消息序会把某一组挪到错的位置。
 */
function groupByStep(live: LiveMessage[]): number[][] {
  const groups: { stepId: number; indices: number[] }[] = []
  for (const [index, entry] of live.entries()) {
    const last = groups[groups.length - 1]
    if (last && last.stepId === entry.stepId) last.indices.push(index)
    else groups.push({ stepId: entry.stepId, indices: [index] })
  }
  return groups.map((group) => group.indices)
}

/**
 * 试算用的假路径。真实路径要等 `store.unload()` 才知道，但长度相近——
 * 试算只影响挑几条，差一两个 token 不影响正确性
 */
const PATH_PLACEHOLDER = '.simple-code/memory/turns/000/turn-000000.jsonl' // 带桶层，和真实路径等长

/**
 * 保底区从哪一条开始。它和它之后的消息一律不碰，**哪怕这样降不到 target**。
 *
 * 保底区存在的理由（design.md 没写，本项目自行推断）：全卸光的话
 * 模型连当前问题都看不到，只剩一堆「[已卸载，见 xxx]」，而它此时已经无法
 * 自救（连自己在干什么都不知道，谈不上去 cat 归档）。宁可这一轮超预算撞 400，
 * 那至少是个明确的错误；卸光是静默的胡言乱语。
 *
 * **从后往前按 token 数，不是「最后一个 user 消息及其之后」**（提案 §11.5）。
 * 旧口径等于「整个当前 turn」，那不是上限——turn 多大它多大，实测最大的
 * turn 有 152,125 token。「100 个 step 的 turn 卸不动」就是这么来的：
 * `pickOldest` 第一组就撞上保底区，直接 break，一条都挑不出来。
 *
 * 边界**对齐到 step 起点**：step 是卸载的原子单位，保底线切进一个 step 中间
 * 会把同一步切成「半卸半保」，段头判定（segmentHeadUnloaded）跟着失去依据。
 * 对齐的方向是**往前扩**（多保一点），不是往后缩——保多了只是少卸一点，
 * 保少了会切开 step。
 *
 * **绝对值还要再夹一道比例上限**（`FLOOR_MAX_RATIO`）：`floorTokens` 的默认
 * 16,000 是按 238,000 的预算定的，配一个 8k 窗口的模型时它比整个预算还大，
 * 保底区吞掉全部历史——**又变成一条都卸不动，和改动前一模一样的病**。
 * 这不是假想，本次实施时 `summary-e2e`/`merge-e2e`（窗口 3,000）当场全红，
 * 是它们把这个缺口照出来的。
 */
/**
 * 存根段水位检查——三级递进的第二级（2026-09-12 拍板）。
 *
 * 原文 →（触发线）存根 →（本函数）摘要顶替。摘要在手也不急着用：存根
 * 比摘要便宜地保留真实头部文本，只有存根段超过 `stubTokens`（默认 16k，
 * 与 floorTokens 同量级）才让最老的 ready 摘要进场。这条线之前的行为是
 * 「卸载时 ready 的当场顶替」（两级绑死），连续使用中 idle 摘要跟不上时
 * floor 外原文全文堆积（实测 121k）——解绑后触发线一到
 * 原文就塌缩成存根，窗口控制不再依赖摘要进度。
 *
 * 激活顺序最老优先；`activateSummary` 只认段头已卸的段（段头没卸说明
 * 推进线没到过，顶了就抢跑）。全激活完仍超线 = 摘要没跟上 → kickSummary
 * 主动催一次（不阻塞本轮，summarizeIdle 自己有并发闸）。
 *
 * 每激活一条重新装配算水位：激活一条顶替掉的是它 covers 的整个 step
 * 区间的存根，增量算容易和 covers 的边界口径漂，装配口径是唯一不会错的。
 * ready 摘要十几条的量级，这个循环的成本可忽略
 */
function activateByStubLevel(ctx: LoopContext): void {
  const memory = ctx.deps.memory
  if (!memory) return
  drainStubWater({
    assemble: () => {
      const messages = assembleForRequest(ctx)
      // 装配数组里的消息引用与 withTurns 同源（assembleContext 不克隆），
      // 用引用建 step 映射
      const stepOf = new Map<Message, number>()
      for (const entry of memory.withTurns(ctx.messages)) stepOf.set(entry.message, entry.stepId)
      return { messages, stepOf }
    },
    stubTokens: memory.stubTokens,
    summaries: () => memory.summaries(),
    activateSummary: (stepId) => memory.activateSummary(stepId),
    unloadedSteps: () => memory.unloadedSteps(),
    kick: () => ctx.deps.kickSummary?.(),
  })
}


function floorStartIndex(live: LiveMessage[], floorTokens: number, budget: number): number {
  const limit = Math.min(floorTokens, budget * FLOOR_MAX_RATIO)
  let tokens = 0
  let index = live.length
  for (let i = live.length - 1; i >= 0; i--) {
    const entry = live[i]
    if (!entry) continue
    tokens += estimateMessageTokens(entry.message.parts)
    index = i
    if (tokens >= limit) break
  }
  // 往前扩到 step 起点。**至少保住最后一个 step**：即使它自己就超 limit，
  // 上面的循环也会在它中间停下，这里把它整个圈回来
  while (index > 0 && live[index - 1]?.stepId === live[index]?.stepId) index--
  return index
}

/**
 * 保底区最多占预算的多少。
 *
 * 0.2 是本项目自行推断：`target` 是预算的 35%（§8.3），保底区必须**明显小于**
 * 它，否则卸载刚做完就又超 target。20% 留出 15 个百分点给 ②③④，够了。
 * 真正重要的不是这个数的精确值，而是**有这道夹子**——没有它，
 * 「floorTokens 比预算大」这种配置会静默退化成不卸载。
 */
const FLOOR_MAX_RATIO = 0.2

const estimateAll = (messages: Message[]): number =>
  messages.reduce((sum, msg) => sum + estimateMessageTokens(msg.parts), 0)

/**
 * 这一轮大概要发出去多少输入 token。真实 usage 打底，新增部分估算。
 *
 * **量的是拼装后那份，不是 `ctx.messages`**——和 `regionSizes` 同源（那边
 * 也是量 `assembleForRequest` 的结果）。摘要顶替之后两者差得很远：被覆盖的
 * live 消息整条不进请求，却一直躺在内存历史里。照着内存历史算的话，那些
 * 根本没发出去的消息全被计进用量，虚高到误触发归档——实测 542,938 字符的
 * live 消息全部落在生效摘要的覆盖范围内，把 126k 的真实上下文顶过 238,000
 * 的预算。
 *
 * 5b63f04 修的是同一个坑的另外半边（基线下标一度记成拼装后数组的长度）。
 * 那次只把基线摆正，遍历范围仍照着内存历史走，于是虚高从「每轮都触发」
 * 缓解成「攒够摘要就触发一次」，看着像修好了。**两处必须同一个坐标系**：
 * 下面 `sinceIndex` 传的是拼装后数组的长度，见 `usageCoversUpTo` 的注释。
 */
const currentUsage = (ctx: LoopContext): number =>
  contextUsage(assembleForRequest(ctx), ctx.lastUsage ?? null, ctx.usageCoversUpTo ?? 0)

/** 输入还能占多少 token。公式和取舍见 `tokens.ts` 的 `inputBudget` */
function inputBudget(ctx: LoopContext): number {
  const memory = ctx.deps.memory
  if (!memory) return Number.POSITIVE_INFINITY
  return budgetOf({
    contextWindow: memory.contextWindow,
    maxTokens: ctx.deps.request.maxTokens,
    safetyMargin: memory.safetyMargin,
  })
}

/**
 * 缓存是否已死（提案 §12）。纯时间推断——服务端的缓存状态看不见，
 * `cache_read_input_tokens` 只在响应的 usage 里出现，而判断发生在发请求前。
 *
 * **null 不算 stale**（刚启动、本进程还没响应过）：误判和漏判的代价不对称，
 * 误判（缓存还热就压）是双输——白破一个热缓存 + 全价重付小基数，比漏判
 * （全价重付大基数）多亏一截。漏判还有预算触发兜底，误判没有任何东西兜。
 *
 * 工具跑很久的场景不用单独处理：工具结束后 loop 进下一个 runStep，这里的
 * 判断天然发生在那一次发请求前，「工具执行的那段时间」已经被计入了
 */
function isCacheStale(memory: MemoryDeps): boolean {
  const last = memory.lastResponseAt()
  if (last === null) return false
  return memory.now() - last > memory.cacheTtlMs
}

/**
 * 严格串行，一条跑完再跑下一条。
 *
 * 并行跑两条 bash 有真实风险——同时写一个文件、npm install 和 npm test
 * 抢锁（design.md §5.2）。慢一点，但可预测。
 *
 * 结果合成**一条** role:'tool' 消息，不是一个结果一条：一条 assistant 可能
 * 发多个 tool_call，它们的结果属于同一轮。
 */
async function* executeTools(ctx: LoopContext, calls: ToolCallPart[]): AsyncIterable<AgentEvent> {
  const results: ToolResultPart[] = []

  for (const call of calls) {
    // 中断后剩下的不执行。**占位不在这里补**——run 的 finally 里那次
    // normalize 是补占位的唯一落点，写两处就有两处要维护，而且工具违反
    // 「永不抛」契约时这里根本跑不到（core-modules.md §7）
    if (ctx.signal.aborted) break

    // 熔断不 throw：throw 后这个 tool_call 已进历史、result 却没有，
    // normalize 补的占位写的是「这次工具调用被用户中断」——把熔断误标
    // 成用户中断，模型下一轮真的以为自己被叫停了（2026-09-16 实测，
    // 评测轮询被熔断后界面/模型两头都误读）。改成 isError 的 result：
    // 模型看得到熔断原因和出路，turn 也不整段报废
    const doom = doomLoopGuard(ctx, call, calls)
    if (doom !== null) {
      ctx.doomed = true
      results.push({ type: 'tool_result', toolCallId: call.id, output: doom, isError: true })
      yield { type: 'tool_error', id: call.id, message: doom }
      continue
    }
    if (ctx.doomed) {
      // 批内排在熔断后面的 call（哪怕参数不同）：turn 都终止了，补 result
      // 不执行——不补就是缺配对，normalize 又会误标成「用户中断」
      const note = '本轮已因死循环熔断终止，这次调用没有执行。'
      results.push({ type: 'tool_result', toolCallId: call.id, output: note, isError: true })
      yield { type: 'tool_error', id: call.id, message: note }
      continue
    }

    yield { type: 'tool_call', id: call.id, name: call.name, input: call.input }
    const [result, agentEv] = await runOne(ctx, call)
    results.push(result)
    yield agentEv
    // 登记簿有变化才发（drain 内部判断）；全量快照，宿主整包替换列表
    const bgEv = ctx.deps.bg?.drain()
    if (bgEv) yield bgEv
  }

  // 中断在第一个工具之前发生时 results 是空的，这里会 push 一条空 tool 消息。
  // 不特判：finally 那次 normalize 会把占位并进去（空消息也会被 dropParts
  // 清掉），特判一下就是第二个落点
  ctx.messages.push({ role: 'tool', parts: results })
}

/** 死循环熔断阈值；语义差异见 doomLoopGuard */
const DOOM_LOOP_THRESHOLD = 3

/**
 * 熔断「完全相同的工具调用连续做 N 次」。与 maxIterations 互补：那个数轮数，
 * 这个数「重复做同一件事」——轮数没超但每轮都做同一个无效调用，是真死循环。
 *
 * 判定两条（同名同参为前提）：
 *
 * 1. 历史 (call, result) 对的尾部连续段里 **result 也相同** ≥ 阈值。只看
 *    调用不看结果的话，合法轮询（sleep+grep 同参、每轮结果都在变）会被
 *    误杀——2026-09-16 实测误杀过评测轮询。真死循环的指纹恰恰是「问了
 *    三遍、答案一模一样还在问」。
 * 2. 批内 3 连发完全相同的 call：result 还没出来没法比，但同批连发同一条
 *    命令没有合法场景（轮询是隔轮的），直接拦。
 *
 * 我们的审批（docs/proposals/approval.md）
 * 按命令内容判定，判不了「重复」这种时序模式，所以这里仍是直接熔断本
 * turn——误杀（合法轮询，如 sleep+curl 同参重试）的代价是用户重发一轮，
 * 可恢复；不杀的代价是无上限地烧 token。错误信息里给轮询场景留了出路。
 */
function doomLoopGuard(
  ctx: LoopContext,
  call: ToolCallPart,
  batch: readonly ToolCallPart[],
): string | null {
  const sameKey = (c: ToolCallPart): string => `${c.name} ${JSON.stringify(c.input)}`
  const key = sameKey(call)
  const message =
    `连续 ${DOOM_LOOP_THRESHOLD} 次完全相同的 ${call.name} 调用且结果一致，疑似死循环，已熔断。` +
    '如果这是合法的重复操作（比如轮询等待），换一下参数或改用带条件的等待后重发。'
  if (batch.filter((c) => sameKey(c) === key).length >= DOOM_LOOP_THRESHOLD) return message

  // 历史 (call, result) 配对：toolCallId → output。从后往前数尾部连续段，
  // 中间隔了不同调用或**不同结果**就断——轮询每轮结果在变，永远数不满
  const outputs = new Map<string, string>()
  for (const m of ctx.messages) {
    if (m?.role !== 'tool') continue
    for (const p of m.parts) {
      if (p.type === 'tool_result') outputs.set(p.toolCallId, p.output)
    }
  }
  let run = 0
  // 段内上一个数过的 call 的结果：比较对象是「扫描链上的前一个」，不是
  // 同一条消息里的前一个——段链要跨消息边界（每轮批尾到下一轮批头）
  let lastOut: string | undefined
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i]
    if (!m || m.role !== 'assistant') continue
    const parts = m.parts.filter((p): p is typeof call => p.type === 'tool_call')
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j]
      if (!p) continue
      if (sameKey(p) !== key) return null
      // 本批还没执行的 call 没有 result：计入但免比较（原语义是第 3 次
      // 执行前拦下，不是放满 3 次后拦第 4 次）
      const out = outputs.get(p.id)
      if (out === undefined) {
        run++
        continue
      }
      if (lastOut !== undefined && out !== lastOut) return null
      lastOut = out
      run++
      if (run >= DOOM_LOOP_THRESHOLD)
        return message
    }
  }
  return null
}

/**
 * 工具执行的唯一出口。
 *
 * 未知工具名不抛异常，跟工具自身失败一样变成 isError 的结果——模型看到
 * 「没有这个工具」会自己改用别的，抛出去则整个 turn 结束（CLAUDE.md §4.1）
 */
async function runOne(ctx: LoopContext, call: ToolCallPart): Promise<[ToolResultPart, AgentEvent]> {
  const tool = ctx.deps.tools.get(call.name)
  if (!tool) {
    const available = [...ctx.deps.tools.keys()].join(' / ')
    const message = `没有名为 ${call.name} 的工具。可用的是：${available}`
    logRun({ ev: 'tool_fail', folder: ctx.deps.root, tool: call.name, message: 'unknown tool' })
    return [
      { type: 'tool_result', toolCallId: call.id, output: message, isError: true },
      { type: 'tool_error', id: call.id, message },
    ]
  }

  // 原始输出落盘（design.md §9.3 第 ① 层）。sink 的 close 必须收在 finally——
  // 工具违反「永不抛」契约时也得关，否则文件句柄泄漏，长会话下会耗尽 fd
  const sink = ctx.deps.rawSink?.(call.id)
  let out: ToolOutput
  try {
    out = await tool.execute(call.input, {
      root: ctx.deps.root,
      signal: ctx.signal,
      toolCallId: call.id,
      ...(sink ? { onRawOutput: (chunk: string) => sink.write(chunk), rawPath: sink.path } : {}),
      ...(ctx.deps.requestApproval ? { requestApproval: ctx.deps.requestApproval } : {}),
      ...(ctx.deps.visionRelay ? { visionRelay: ctx.deps.visionRelay } : {}),
      ...(ctx.deps.bg ? { bg: ctx.deps.bg } : {}),
    })
  } finally {
    sink?.close()
  }

  if (out.isError) {
    logRun({
      ev: 'tool_fail',
      folder: ctx.deps.root,
      tool: call.name,
      message: out.output.slice(0, 200),
    })
  }

  const images = out.images?.map((img) => ({ type: 'image' as const, ...img }))
  // webview 只拿 256px 缩略图，原图在库里（消息 JSON 整存），要看大的
  // 从历史渲染那条路走（阶段 3 的 webview 部分）
  const thumbnails =
    out.images && out.images.length > 0
      ? (
          await Promise.all(
            out.images.map((img) =>
              thumbnailDataUrl({ type: 'image', ...img }).then((u) => u ?? ''),
            ),
          )
        ).filter((u) => u !== '')
      : undefined
  return [
    {
      type: 'tool_result',
      toolCallId: call.id,
      output: out.output,
      isError: out.isError,
      ...(images ? { images } : {}),
    },
    {
      type: 'tool_result',
      id: call.id,
      output: out.output,
      exitCode: out.exitCode,
      ...(thumbnails ? { images: thumbnails } : {}),
    },
  ]
}
