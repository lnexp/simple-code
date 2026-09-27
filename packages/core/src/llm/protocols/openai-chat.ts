import type { LLMEvent, SSEMessage } from '../events.ts'
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
  flushTools,
  startTool,
  type ToolStream,
} from './utils/tool-stream.ts'
import { asArray, asNumber, asObject, asString, asToolInput, readRetryAfter } from './utils/wire.ts'

type WireMessage = Record<string, unknown>

// ---------------------------------------------------------------- buildRequest

/**
 * 这里**没有**缓存断点，和 anthropic-messages 不一样，是有意的不是漏了。
 *
 * OpenAI 的 prompt caching 默认开着，靠前缀自动匹配，没有 cache_control
 * 那样的标记可打。可选的 prompt_cache_key 只影响路由（让相同前缀的请求
 * 落到同一台机器），不是命中的必要条件，高并发下才值得加。
 */
function buildRequest(req: Request, ctx: ProviderContext) {
  const body = {
    model: req.model,
    stream: true,
    // 不传这个就拿不到 usage。默认不发，且不报错——token 统计会一直是 0
    stream_options: { include_usage: true },
    // 用 max_tokens 而不是 max_completion_tokens。这个协议主要服务于
    // OpenAI 兼容端点（DeepSeek / Qwen / TogetherAI 等），它们多数只认旧
    // 字段；真正的 OpenAI 走 openai-responses。三个协议统一用
    // max_tokens，不为任何厂商做字段切换
    max_tokens: req.maxTokens,
    // effort 在这个协议里叫 reasoning_effort。漏掉它不会报错，只是用户设的
    // 推理档位静默失效——另两个协议都接了，这里也必须接
    reasoning_effort: req.effort,
    messages: [
      // 空 system 就不发这条消息，而不是发一条 content 为空串的
      ...(req.system === '' ? [] : [{ role: 'system', content: req.system }]),
      ...req.messages.flatMap(toWireMessages),
    ],
    // 空数组和字段缺失对多数端点等价，但个别网关会把 [] 当成「启用了
    // tool-calling」从而改变输出形态。三个协议统一发 undefined
    tools:
      req.tools.length === 0
        ? undefined
        : req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
  }

  return {
    url: `${ctx.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`,
    headers: mergeHeaders(
      {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.apiKey}`,
      },
      ctx.headers,
    ),
    body: mergeBody(body, ctx.extraBody),
  }
}

/**
 * 一条 tool 消息里可能有多个 tool_result（模型一次发多个 tool_call），
 * 而这个协议要求一个 tool_call_id 一条消息，所以返回数组。
 *
 * canonical 也用独立的 tool 角色，这里是顺序直传。tool_result 挂在 user
 * 消息里的话，还得处理「tool 消息必须紧跟带 tool_calls 的 assistant，
 * 中间夹一条 user 就 400」这个硬约束——把它从 user 消息里挑出来排到前面。
 */
function toWireMessages(msg: Message): WireMessage[] {
  if (msg.role === 'tool') {
    return msg.parts.flatMap((part) => {
      if (part.type !== 'tool_result') return []
      // tool role 的 content 协议上只有 string，图带不进去。
      // 换道：
      // 图抽出来，拼成紧随其后的合成 user 消息——user 消息的多模态
      // content 本来就在用（用户贴图同路），图照发，只换消息角色
      const wire: WireMessage[] = [
        { role: 'tool', tool_call_id: part.toolCallId, content: part.output },
      ]
      const images = part.images ?? []
      if (images.length > 0) {
        wire.push({
          role: 'user',
          content: [
            { type: 'text', text: `工具结果附图（${part.output.slice(0, 80)}）：` },
            ...images.map((img) => ({
              type: 'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.data}` },
            })),
          ],
        })
      }
      return wire
    })
  }

  const toolCalls = msg.parts.filter((p) => p.type === 'tool_call')
  const content = msg.parts.flatMap(toWireContent)
  const reasoning = msg.parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => p.text)
    .join('')

  if (content.length === 0 && toolCalls.length === 0 && reasoning === '') return []

  return [
    {
      role: msg.role,
      // 纯文本时发字符串而不是数组：部分实现对 content 数组的支持不完整。
      // 没有文本时发 null 而不是空串——「只调工具不说话」是最常见的
      // assistant 形态，严格的实现会区分「没有内容」和「空内容」
      content: content.length === 0 ? null : (asPlainText(content) ?? content),
      // 这个协议没有 signature 之类的完整性字段，推理文本原样回传即可
      ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((t) => ({
              id: t.id,
              type: 'function',
              // asToolInput：存量毒（历史里的裸串 input）归一后再序列化，
              // 否则 arguments 是 '"半截文本"'——合法 JSON 字符串但不是
              // 对象，提供方 parse 后按对象取字段直接 500
              function: { name: t.name, arguments: JSON.stringify(asToolInput(t.input)) },
            })),
          }
        : {}),
    },
  ]
}

function toWireContent(part: Part): WireMessage[] {
  switch (part.type) {
    case 'text':
      return [{ type: 'text', text: part.text }]
    case 'image':
      return [
        { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
      ]
    // reasoning 不进 content 数组，它在回传时是消息级的 reasoning_content
    // 字段（见 toWireMessages）。tool_call / tool_result 已在上面处理
    default:
      return []
  }
}

function asPlainText(content: WireMessage[]): string | null {
  return content.every((c) => c.type === 'text')
    ? content.map((c) => asString(c.text)).join('')
    : null
}

// ---------------------------------------------------------------- reducer

type State = {
  tools: ToolStream
  usage: Usage
  finishReason: FinishReason
  isTextOpen: boolean
  isReasoningOpen: boolean
  /** [DONE] 到过没有。SSE 流「正常 EOF 但没送哨兵」是网关掐断的形态，
   *  不校验会把断流当成完整回答——turn 静默收尾，界面什么都不显示 */
  finished: boolean
}

const initial = (): State => ({
  tools: emptyToolStream(),
  usage: zeroUsage(),
  finishReason: 'stop',
  isTextOpen: false,
  isReasoningOpen: false,
  finished: false,
})

function reduce(state: State, msg: SSEMessage): [State, LLMEvent[]] {
  const ev = asObject(JSON.parse(msg.data))
  if (ev.error) throw new LLMStreamError(toError(asObject(ev.error), 0))

  // usage 独占最后一个 chunk，那时 choices 是空数组
  const next = ev.usage ? { ...state, usage: toUsage(ev.usage) } : state
  const choice = asObject(asArray(ev.choices)[0])
  if (Object.keys(choice).length === 0) return [next, []]

  const [afterDelta, events] = onDelta(next, asObject(choice.delta))
  const reason = choice.finish_reason
  // finish_reason 和 usage 不在同一个 chunk 里。这里只记下原因，事件留到
  // finalize 再发——否则 usage 永远是 0，且不会报错
  return [reason ? { ...afterDelta, finishReason: toFinishReason(reason) } : afterDelta, events]
}

function onDelta(state: State, delta: Record<string, unknown>): [State, LLMEvent[]] {
  const events: LLMEvent[] = []
  let next = state

  // reasoning_content 是 DeepSeek / Qwen 等在这个协议上的扩展字段。官方
  // OpenAI 不发，但它们都走 openai-chat——不接就把整段推理过程静默丢了
  const reasoning = asString(delta.reasoning_content)
  if (reasoning !== '') {
    if (!next.isReasoningOpen) {
      events.push({ type: 'reasoning_start' })
      next = { ...next, isReasoningOpen: true }
    }
    events.push({ type: 'reasoning_delta', text: reasoning })
  }

  const text = asString(delta.content)
  if (text !== '') {
    // 推理块必须先收尾再开正文，否则 UI 拿到的 start/end 是交错的
    if (next.isReasoningOpen) {
      events.push({ type: 'reasoning_end' })
      next = { ...next, isReasoningOpen: false }
    }
    if (!next.isTextOpen) {
      events.push({ type: 'text_start' })
      next = { ...next, isTextOpen: true }
    }
    events.push({ type: 'text_delta', text })
  }

  for (const raw of asArray(delta.tool_calls)) {
    const [s, evs] = onToolCallDelta(next, asObject(raw))
    next = s
    events.push(...evs)
  }
  return [next, events]
}

function onToolCallDelta(state: State, raw: Record<string, unknown>): [State, LLMEvent[]] {
  const key = String(asNumber(raw.index, 0))
  const fn = asObject(raw.function)
  const known = state.tools.entries[key]
  const events: LLMEvent[] = []
  let tools = state.tools

  // 后续分片里 name 是空串、id 缺失——拿它们覆盖会把工具名和 id 擦掉，
  // 而且不报错：请求发出去才在服务端 400
  const id = asString(raw.id) || known?.id || ''
  const name = asString(fn.name) || known?.name || ''
  if (!known) {
    // 首次出现却缺 id 或 name，说明流不合规。兜底成空串会造出一个 id='' 的
    // 工具调用一路走到 finalize，之后按 id 配对 tool_result 时静默失配
    if (id === '' || name === '') {
      throw new LLMStreamError({
        kind: 'server',
        message: `tool call 分片缺少 id 或 name（index ${key}），无法组装工具调用`,
        retryable: true,
      })
    }
    tools = startTool(tools, key, id, name)
    events.push({ type: 'tool_input_start', id, name })
  }

  const partial = asString(fn.arguments)
  if (partial !== '') {
    tools = appendTool(tools, key, partial)
    events.push({ type: 'tool_input_delta', id, partial })
  }
  return [{ ...state, tools }, events]
}

/**
 * 流结束后才发得出的事件。
 *
 * 这个协议**没有单个 tool call 的结束事件**，也没有 message_stop——finish_reason
 * 和 usage 分在两个 chunk 里，[DONE] 之后才算真的完。所以累积的 tool call 只能
 * 在这里一次性结算。
 */
function finalize(state: State): LLMEvent[] {
  const events: LLMEvent[] = []
  if (state.isReasoningOpen) events.push({ type: 'reasoning_end' })
  if (state.isTextOpen) events.push({ type: 'text_end' })
  for (const call of flushTools(state.tools)) {
    events.push({ type: 'tool_input_end', id: call.id, name: call.name, input: call.input })
  }
  events.push({ type: 'finish', reason: state.finishReason, usage: state.usage })
  return events
}

// ---------------------------------------------------------------- usage / 错误

const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

/**
 * 这个协议的 prompt_tokens **已经包含**缓存命中的部分（与 Anthropic 相反：
 * 那边的 input_tokens 不含缓存）。所以要减掉 cached_tokens 才和 canonical
 * 的「三者相加 = 完整输入量」不变量对齐，否则缓存部分会被算两遍。
 */
function toUsage(raw: unknown): Usage {
  const u = asObject(raw)
  const cached = asNumber(asObject(u.prompt_tokens_details).cached_tokens, 0)
  return {
    inputTokens: Math.max(0, asNumber(u.prompt_tokens, 0) - cached),
    outputTokens: asNumber(u.completion_tokens, 0),
    cacheCreationInputTokens: 0, // 这个协议不区分写入与命中
    cacheReadInputTokens: cached,
    reasoningTokens: asNumber(asObject(u.completion_tokens_details).reasoning_tokens, 0),
  }
}

function toFinishReason(raw: unknown): FinishReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'content-filter'
    default:
      return 'stop'
  }
}

function parseError(status: number, body: unknown, headers?: Headers): ProtocolError {
  const err = toError(asObject(asObject(body).error), status)
  const retryAfterMs = readRetryAfter(headers)
  return retryAfterMs === null ? err : { ...err, retryAfterMs }
}

function toError(err: Record<string, unknown>, status: number): ProtocolError {
  const message = asString(err.message) || `HTTP ${status}`
  const kind = errorKind(asString(err.code) || asString(err.type), message, status)
  return { kind, message, retryable: kind === 'rate_limit' || kind === 'server' }
}

function errorKind(code: string, message: string, status: number): ProtocolError['kind'] {
  if (code === 'invalid_api_key' || status === 401 || status === 403) return 'auth'
  if (code === 'rate_limit_exceeded' || status === 429) return 'rate_limit'
  if (status >= 500) return 'server'
  if (code === 'context_length_exceeded' || /context length|too many tokens/i.test(message)) {
    return 'context_overflow'
  }
  if (status >= 400) return 'invalid_request'
  return 'unknown'
}

// ---------------------------------------------------------------- 出口

async function* parseStream(raw: AsyncIterable<SSEMessage>): AsyncIterable<LLMEvent> {
  let state = initial()
  for await (const msg of raw) {
    if (msg.done !== undefined) {
      state = { ...state, finished: true }
      break
    }
    const [next, events] = reduce(state, msg)
    state = next
    yield* events
  }
  // 干净 EOF 但没有 [DONE]：不是模型说完了，是链路上有人把流掐了
  // （网关超时断连的表现正是这种形态）。当成功处理的话半截甚至零事件
  // 回答会被当成「模型没说话」，turn 静默正常收尾
  if (!state.finished) {
    throw new LLMStreamError({
      kind: 'server',
      message: '响应流被提前断开（未收到结束标记），本次回答不完整',
      retryable: true,
    })
  }
  yield* finalize(state)
}

export const openaiChat: Protocol = {
  name: 'openai-chat',
  buildRequest,
  parseStream,
  parseError,
}
