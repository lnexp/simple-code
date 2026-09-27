import type { LLMEvent, RefusalDetail, SSEMessage } from '../events.ts'
import {
  LLMStreamError,
  mergeBody,
  mergeHeaders,
  type Protocol,
  type ProtocolError,
  type ProviderContext,
} from '../protocol.ts'
import type { FinishReason, Message, Part, Request, Usage } from '../types.ts'
import {
  appendTool,
  emptyToolStream,
  pickTool,
  startTool,
  type ToolStream,
} from './utils/tool-stream.ts'
import { asNumber, asObject, asString, asToolInput, readRetryAfter } from './utils/wire.ts'

// wire 格式的东西不要和 canonical 的 Message / Part 混（CLAUDE.md §3.2）。
// 这些类型只在本文件内部出现。
type WireContent = Record<string, unknown>
type WireMessage = { role: 'user' | 'assistant'; content: WireContent[] }

// ---------------------------------------------------------------- buildRequest

function buildRequest(req: Request, ctx: ProviderContext) {
  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    // 断点覆盖它**之前的全部内容**，而前缀按 tools → system → messages 的
    // 顺序累积——所以这一个断点已经把 tools 一起缓存了，不必给 tools 再打。
    // 分开打只在两者变化频率不同时才有意义，我们这两样一次会话里都不变。
    //
    // 但 tools + system 不到最小缓存长度（Opus 4.8 是 1024 token）时，这个
    // 断点**静默失效**：不报错，usage 里两个 cache 字段都是 0。实测一个
    // bash 工具加两句 system 只有 600 出头，够不着。所以真正省钱的是下面
    // 那个 messages 断点——历史长起来之后才有东西可缓存。
    system: [{ type: 'text', text: req.system, cache_control: CACHE_CONTROL }],
    messages: withCacheBreakpoint(req.messages.map(toWireMessage)),
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
    thinking:
      req.thinking === 'adaptive'
        ? { type: 'adaptive', display: req.reasoningDisplay }
        : { type: 'disabled' },
    output_config: { effort: req.effort },
  }

  return {
    url: `${ctx.baseUrl.replace(/\/+$/, '')}/v1/messages`,
    headers: mergeHeaders(
      {
        'content-type': 'application/json',
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
      },
      ctx.headers,
    ),
    body: mergeBody(body, ctx.extraBody),
  }
}

/**
 * canonical 的 tool 消息在这里降成 user——Anthropic 没有 tool 角色，
 * tool_result 就是 user 消息里的 content block。 *
 * 降完可能出现两条连续的 user 消息（tool_result 一条 + 用户插话一条）。
 * 不用处理：官方文档明写「Consecutive user or assistant turns in your
 * request will be combined into a single turn」，服务端自己合。
 */
const toWireMessage = (msg: Message): WireMessage => ({
  role: msg.role === 'assistant' ? 'assistant' : 'user',
  content: msg.parts.flatMap((p) => {
    const c = toWireContent(p)
    return c ? [c] : []
  }),
})

const CACHE_CONTROL = { type: 'ephemeral' } as const

/**
 * 从后往前**最多三条**消息，各在末尾打一个断点（加 system 一个，正好用满
 * 四个断点的硬上限）。
 *
 * 末条是本请求的写入点；倒数第二、三条钉住**上一请求的断点位置**。官方
 * 文档的读取规则是从断点往回找既有条目（lookback window 20 个 block），
 * 所以真 API 上末条一个断点就够；但中转网关未必实现回看——只认「断点
 * 位置精确相同」的条目，断点随尾前移就每轮全量 miss（2026-09-23 实测
 * modelbest 网关：内容前缀逐字段一致、增量 4 个 block，仍 cache miss）。
 * 把上一请求的断点位置钉住，命中就不再依赖回看。
 *
 * 钉倒数第三条就够了：请求 = 上一请求 + assistant + user（一轮模型调用
 * 恰好追加这两条——工具轮是 tool_use/tool_result 对，收尾轮是回答/下一
 * 句），所以上一请求的末条恒为本次的倒数第三条。倒数第二条覆盖只追加
 * 一条的插话轮。实测锚点：请求 b 末条 468 → 请求 a 的 468 正是倒数第三条。
 *
 * 多写不亏：缓存写入按断点间的**增量段**计价，前面的断点命中走读、
 * 未命中也只是把该段写一遍——总写入量恒等于整个前缀一遍，不会翻倍。
 *
 * thinking 块不能直接打（官方明列的例外），所以每条消息里从后往前找
 * 第一个不是 thinking 的块。整条消息都是 thinking 就跳过它——少一个钉子
 * 不会更糟。
 */
function withCacheBreakpoint(wire: WireMessage[]): WireMessage[] {
  const out = [...wire]
  for (let i = wire.length - 1; i >= 0 && i >= wire.length - 3; i--) {
    const m = out[i]
    if (!m) continue
    const at = m.content.findLastIndex((block) => block.type !== 'thinking')
    if (at === -1) continue
    out[i] = {
      ...m,
      content: m.content.map((block, j) =>
        j === at ? { ...block, cache_control: CACHE_CONTROL } : block,
      ),
    }
  }
  return out
}

function toWireContent(part: Part): WireContent | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: part.mimeType, data: part.data },
      }
    case 'reasoning':
      // 没有 signature 就整块丢弃，绝不自造一个。丢弃在「校验」和「不校验」两种
      // 假设下都合法，伪造只在后者合法（design.md 附录 A）
      return part.encrypted
        ? { type: 'thinking', thinking: part.text, signature: part.encrypted }
        : null
    case 'tool_call':
      // input 归一成对象（asToolInput）：历史里的裸串（本修复出生前住进
      // 去的存量毒）原样回传必 500——tool_use.input 必须是对象
      return { type: 'tool_use', id: part.id, name: part.name, input: asToolInput(part.input) }
    case 'tool_result':
      // 带图时 content 是 blocks 数组（图 + 文本都排进去）；纯文本保持
      // string——wire 形状不无谓变化，兼容对 block 数组支持不完整的实现
      if (part.images && part.images.length > 0) {
        return {
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: [
            ...part.images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mimeType, data: img.data },
            })),
            { type: 'text', text: part.output },
          ],
          is_error: part.isError,
        }
      }
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: part.output,
        is_error: part.isError,
      }
  }
}

// ---------------------------------------------------------------- reducer

type BlockKind = 'text' | 'thinking' | 'tool_use'

type State = {
  blocks: Record<number, BlockKind>
  /** signature 是通过 signature_delta 增量发的，要攒到 content_block_stop 才完整 */
  signatures: Record<number, string>
  tools: ToolStream
  usage: Usage
  stopReason: FinishReason
  /** 拒答详情（stop_details）。只在 stopReason 是 content-filter 时有 */
  refusal?: RefusalDetail
  /** message_stop 到过没有。SSE 流可以「正常 EOF 但没送终止事件」——
   *  网关超时掐断就是这个形态，不校验的话半截流会被当成完整回答 */
  finished: boolean
}

const initial = (): State => ({
  blocks: {},
  signatures: {},
  tools: emptyToolStream(),
  usage: zeroUsage(),
  stopReason: 'stop',
  finished: false,
})

function reduce(state: State, msg: SSEMessage): [State, LLMEvent[]] {
  const ev = asObject(JSON.parse(msg.data))
  switch (msg.event) {
    case 'message_start': {
      const usage = toUsage(asObject(ev.message).usage)
      return [{ ...state, usage }, [{ type: 'message_start', usage }]]
    }
    case 'content_block_start':
      return onBlockStart(state, ev)
    case 'content_block_delta':
      return onBlockDelta(state, ev)
    case 'content_block_stop':
      return onBlockStop(state, ev)
    case 'message_delta':
      return onMessageDelta(state, ev)
    case 'message_stop':
      return [
        { ...state, finished: true },
        [
          {
            type: 'finish',
            reason: state.stopReason,
            usage: state.usage,
            ...(state.refusal ? { refusal: state.refusal } : {}),
          },
        ],
      ]
    case 'error':
      throw new LLMStreamError(toError(asObject(ev.error), 0))
    default:
      return [state, []] // ping 之类
  }
}

function onBlockStart(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const index = asNumber(ev.index, 0)
  const block = asObject(ev.content_block)
  const remember = (kind: BlockKind) => ({ ...state.blocks, [index]: kind })

  // 必须是显式白名单。写成「不是 text 也不是 thinking 就当 tool_use」的话，
  // redacted_thinking（安全系统屏蔽推理内容时会发）会掉进 tool 分支：它没有
  // id 也没有 name，于是产生一个 id='' 的幽灵 tool call，而 content_block_stop
  // 又认不出它、永远不结算。不报错，只是状态悄悄错了
  switch (asString(block.type)) {
    case 'text':
      return [{ ...state, blocks: remember('text') }, [{ type: 'text_start' }]]
    case 'thinking':
      return [{ ...state, blocks: remember('thinking') }, [{ type: 'reasoning_start' }]]
    case 'tool_use': {
      const id = asString(block.id)
      const name = asString(block.name)
      return [
        {
          ...state,
          blocks: remember('tool_use'),
          tools: startTool(state.tools, String(index), id, name),
        },
        [{ type: 'tool_input_start', id, name }],
      ]
    }
    default:
      // redacted_thinking / server_tool_use / 将来新增的类型：整块忽略。
      // 不记进 blocks，该 index 后续的 delta 与 stop 自然也是 no-op
      return [state, []]
  }
}

function onBlockDelta(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const index = asNumber(ev.index, 0)
  const delta = asObject(ev.delta)

  switch (asString(delta.type)) {
    case 'text_delta':
      return [state, [{ type: 'text_delta', text: asString(delta.text) }]]
    case 'thinking_delta':
      return [state, [{ type: 'reasoning_delta', text: asString(delta.thinking) }]]
    case 'signature_delta': {
      const prev = state.signatures[index] ?? ''
      const signatures = { ...state.signatures, [index]: prev + asString(delta.signature) }
      return [{ ...state, signatures }, []]
    }
    case 'input_json_delta': {
      // 同样要认准 block 类型：未知块也可能带 delta，无条件写入会凭空造出
      // 一个没有 start 的 tool 状态
      if (state.blocks[index] !== 'tool_use') return [state, []]
      const partial = asString(delta.partial_json)
      const id = state.tools.entries[String(index)]?.id
      return [
        { ...state, tools: appendTool(state.tools, String(index), partial) },
        id ? [{ type: 'tool_input_delta', id, partial }] : [],
      ]
    }
    default:
      return [state, []]
  }
}

function onBlockStop(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const index = asNumber(ev.index, 0)
  switch (state.blocks[index]) {
    case 'text':
      return [state, [{ type: 'text_end' }]]
    case 'thinking': {
      const encrypted = state.signatures[index]
      return [state, [encrypted ? { type: 'reasoning_end', encrypted } : { type: 'reasoning_end' }]]
    }
    case 'tool_use': {
      const call = pickTool(state.tools, String(index))
      return [
        state,
        call ? [{ type: 'tool_input_end', id: call.id, name: call.name, input: call.input }] : [],
      ]
    }
    default:
      return [state, []]
  }
}

function onMessageDelta(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const delta = asObject(ev.delta)
  const stopReason = toFinishReason(delta.stop_reason)
  // 拒答的 stop_details 就在同一个 delta 里，只有拒答时才有。category 和
  // explanation 官方文档都说可为 null，都按「没有就不带」处理
  let refusal: RefusalDetail | undefined
  if (stopReason === 'content-filter') {
    const details = asObject(delta.stop_details)
    const category = asString(details.category)
    const explanation = asString(details.explanation)
    if (category !== '' || explanation !== '') {
      refusal = {
        ...(category !== '' ? { category } : {}),
        ...(explanation !== '' ? { explanation } : {}),
      }
    }
  }
  // message_delta 的 usage 只带输出侧字段，输入侧必须保留 message_start 的值。
  // 直接覆盖会把 input 清零，而且不报错——只是 token 统计悄悄变小
  return [
    { ...state, stopReason, ...(refusal ? { refusal } : {}), usage: toUsage(ev.usage, state.usage) },
    [],
  ]
}

// ---------------------------------------------------------------- usage

const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

/**
 * 三个输入侧字段各自独立读，**不做减法**。它们的和才是完整输入量（实测确证，
 * design.md 附录 A）：只读 input_tokens 会把 23k 读成 29。
 */
function toUsage(raw: unknown, fallback: Usage = zeroUsage()): Usage {
  const u = asObject(raw)
  const details = asObject(u.output_tokens_details)
  return {
    inputTokens: asNumber(u.input_tokens, fallback.inputTokens),
    outputTokens: asNumber(u.output_tokens, fallback.outputTokens),
    cacheCreationInputTokens: asNumber(
      u.cache_creation_input_tokens,
      fallback.cacheCreationInputTokens,
    ),
    cacheReadInputTokens: asNumber(u.cache_read_input_tokens, fallback.cacheReadInputTokens),
    reasoningTokens: asNumber(details.thinking_tokens, fallback.reasoningTokens),
  }
}

function toFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'content-filter'
    default:
      return 'stop'
  }
}

// ---------------------------------------------------------------- 错误

function parseError(status: number, body: unknown, headers?: Headers): ProtocolError {
  const err = toError(asObject(asObject(body).error), status)
  const retryAfterMs = readRetryAfter(headers)
  return retryAfterMs === null ? err : { ...err, retryAfterMs }
}

function toError(err: Record<string, unknown>, status: number): ProtocolError {
  const message = asString(err.message) || `HTTP ${status}`
  const kind = errorKind(asString(err.type), message, status)
  return { kind, message, retryable: kind === 'rate_limit' || kind === 'server' }
}

function errorKind(type: string, message: string, status: number): ProtocolError['kind'] {
  if (type === 'authentication_error' || status === 401 || status === 403) return 'auth'
  if (type === 'rate_limit_error' || status === 429) return 'rate_limit'
  if (type === 'overloaded_error' || status >= 500) return 'server'
  // context overflow 在 Anthropic 也是 invalid_request_error，类型上区分不出来，
  // 只能认文案。必须先于 invalid_request 判断，否则永远轮不到
  if (/context|too long|maximum.*token/i.test(message)) return 'context_overflow'
  if (type === 'invalid_request_error' || status >= 400) return 'invalid_request'
  return 'unknown'
}

// ---------------------------------------------------------------- 出口

async function* parseStream(raw: AsyncIterable<SSEMessage>): AsyncIterable<LLMEvent> {
  let state = initial()
  for await (const msg of raw) {
    // 兼容网关会给所有协议兜底加 [DONE]。它的终止判据是 message_stop，
    // 哨兵本身无事可做，但不能让它落进下面的 JSON.parse
    if (msg.done !== undefined) continue
    const [next, events] = reduce(state, msg)
    state = next
    yield* events
  }
  // 流结束却没见到 message_stop：不是模型说完了，是链路上有人把流掐了
  // （网关超时断连的表现正是「干净 EOF、无终止事件」）。当成功处理的话，
  // 半截回答甚至零事件回答会被当成「模型没说话」，turn 静默正常收尾——
  // 没有错误、没有落盘、界面什么都不显示。2026-09-11 的 turn-000450 就是
  // 这样断的：工具结果刚落盘，下一跳被掐，UI 无任何反馈
  if (!state.finished) {
    throw new LLMStreamError({
      kind: 'server',
      message: '响应流被提前断开（未收到结束标记），本次回答不完整',
      retryable: true,
    })
  }
}

export const anthropicMessages: Protocol = {
  name: 'anthropic-messages',
  buildRequest,
  parseStream,
  parseError,
}
