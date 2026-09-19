/**
 * canonical format —— 我们自己的消息表示，与任何具体协议无关。
 *
 * 命名约定见 CLAUDE.md §3.2：本文件里的类型都是 canonical，协议层内部处理
 * wire 格式的类型一律加协议名前缀（AnthropicMessage / OpenAIMessage）。
 */

export type TextPart = {
  type: 'text'
  text: string
}

/**
 * UI 送进来的图（send 的入参）。跟 ImagePart 的区别：没有 `detail`——
 * 那是请求偏好（跟 temperature 同层），不该由输入侧决定
 */
export type ImageInput = { data: string; mimeType: string }

export type ImagePart = {
  type: 'image'
  data: string // base64，不含 data: 前缀
  mimeType: string
  detail?: 'auto' | 'low' | 'high' | 'original'
}

export type ReasoningPart = {
  type: 'reasoning'
  text: string
  /**
   * Anthropic 的 signature 与 OpenAI 的 encrypted_content 共用此字段：都是原样
   * 收发的不透明串。
   *
   * **签发方绑定**：拿 A 模型签的串去请求 B 模型会 400。换模型时由
   * `session.dropSignatures` 剥掉——加同类字段的话记得一起剥
   */
  encrypted?: string
}

export type ToolCallPart = {
  type: 'tool_call'
  /** 不透明字符串，原样收发。三个协议的 id 形态不同，我们不解析也不生成 */
  id: string
  name: string
  input: unknown
}

export type ToolResultPart = {
  type: 'tool_result'
  toolCallId: string
  output: string
  isError: boolean
  /**
   * 工具带出来的图（webfetch 抓到 image/*，web-tools §1 D4）。原图整存，
   * 发送侧过 resizer 统一缩放，与用户贴图同一条路——工具不自己压
   */
  images?: ImagePart[]
  /**
   * 用户中断时补的占位，**不同于工具正常失败**。
   * 二者都是 isError，但被中断的不算"待处理工作"——把它算成待处理会让 loop
   * 空转一轮（发一个请求过去，模型无事可做，再返回）。见 core-modules.md §7
   */
  interrupted?: boolean
}

export type Part = TextPart | ImagePart | ReasoningPart | ToolCallPart | ToolResultPart

/**
 * 没有 'system'——system prompt 是 Request.system 字段，不混进消息列表。
 * 这样 design.md §5.3 的 caching 断点位置才稳定。
 *
 * **tool_result 是独立的 role: 'tool' 消息，不塞进 user 消息里。**
 * 就这四个值。
 *
 * 三个协议的 wire 格式各不相同——Anthropic 是 user 消息里的 content block、
 * openai-chat 是独立的 role:'tool' 消息、Responses 是无 role 的扁平 item。
 * canonical 保留 role 这一维，三个方向都是直接映射；合进 user 的话，降到
 * openai-chat 要把一条消息拆成 N 条并处理顺序约束（那个约束是硬的：tool
 * 消息必须紧跟带 tool_calls 的 assistant，中间夹一条 user 就 400）。
 *
 * 更要紧的是「谁发的」得是身份信息而不是推断。loop 判断「用户在 agent 跑
 * 的时候插了话」直接看 role === 'user' 即可；合进 user 的话得改成「parts
 * 里有没有非 tool_result 成分」，推断错了不报错，只是行为不对。
 */
/**
 * **这里没有逃生舱字段。** 曾经有两个（`ReasoningPart.providerMetadata`、
 * `Message.native`），早期设计留的，三个协议实现下来一次都没用上，
 * 零读写。删掉的理由见 design.md「二级逃生舱」那节的修订说明。
 *
 * 真需要时**连同处理逻辑一起加回来**——尤其别忘了换模型时要不要跟着
 * `encrypted` 一起剥（session.ts 的 dropSignatures）。空着的字段没人记得
 * 它需要被清理。
 */
export type Message = {
  role: 'user' | 'assistant' | 'tool'
  parts: Part[]
}

export type ToolDefinition = {
  name: string
  description: string
  /** JSON Schema。协议层决定把它放进 `input_schema`（Anthropic）还是 `parameters`（OpenAI） */
  parameters: Record<string, unknown>
}

/**
 * 四个字段各自独立可解释，不存"总和 + 差值"。
 *
 * 存差值会引入下溢那一类 bug：差值被 clamp 到 0 时静默存错，且错了看不出来。
 * 加法关系（前三者之和 = 完整输入量，实测确证见 design.md 附录 A）作为不变量
 * 写在文档里，不体现在数据结构里。
 */
export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  /** OpenAI Responses 单独报告；Anthropic 不报，此时为 0 */
  reasoningTokens: number
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error'

/**
 * 推理深度。**三个协议都原样透传**——anthropic 放 `output_config.effort`、
 * openai-chat 叫 `reasoning_effort`、responses 放 `reasoning.effort`。
 *
 * 所以这个联合是**我们的口径，不是某一家的**。某个端点认不认 `xhigh` /
 * `max` 取决于那个端点，客户端无从判断：认不出时理想情况是 400（看得见），
 * 但也可能被静默忽略——那就是「设了没生效」且没有任何迹象。真碰上了再考虑
 * 给 modelSpec 加一个「这个模型支持哪几档」的字段，现在不预留（§2）
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Request = {
  model: string
  maxTokens: number
  thinking: 'adaptive' | 'disabled'
  effort: Effort
  reasoningDisplay: 'omitted' | 'summarized'
  system: string
  tools: ToolDefinition[]
  messages: Message[]
}
// Request 里没有 stream 字段——恒为 true（design.md §5），不给关掉的选项。

/**
 * 模型能力。缺失即不支持，没有"默认支持"（CLAUDE.md §1.2）。
 *
 * **只有 `images` 一项，这是有意的。** design.md §724 定下的规矩是：请求参数
 * （thinking / effort / reasoningDisplay）**不做本地能力校验**——能力矩阵随
 * 模型迭代不断变化，维护一份必然过时的表不如让 API 自己说话。
 *
 * `images` 是唯一的例外，理由在 §726：**图片配错会污染历史**。发过去 400，
 * 这条消息还留在 context 里，之后每一轮再 400 一次，loop 直接卡死。所以它
 * 必须在发请求前就知道（`normalize.ts` 靠它决定剥不剥图片）。
 *
 * 曾经还有个 `reasoning`，但它不满足这个判据——effort 配错最多是这次请求
 * 行为不如预期，不会留在历史里反复毒化。它从头到尾没有消费者，直到被拿去
 * 当「要不要显示推理深度选择器」的开关，而那正是 §724 说不该做的事。删了
 */
export type Capabilities = {
  images: boolean
}
