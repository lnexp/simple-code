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
  pickTool,
  replaceTool,
  startTool,
  type ToolStream,
} from './utils/tool-stream.ts'
import { asArray, asNumber, asObject, asString, readRetryAfter } from './utils/wire.ts'

type WireItem = Record<string, unknown>

// ---------------------------------------------------------------- buildRequest

/** 没有缓存断点的理由同 openai-chat.ts：OpenAI 的缓存是自动的，没标记可打 */
function buildRequest(req: Request, ctx: ProviderContext) {
  const body = {
    model: req.model,
    stream: true,
    // instructions 必传：不传时至少有一个网关会注入它自己的默认提示词
    // （实测有网关注入约 21k 字符的默认提示词），行为完全不可控
    instructions: req.system,
    input: req.messages.flatMap(toWireItems),
    tools: req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    max_output_tokens: req.maxTokens,
    store: false,
    ...(req.thinking === 'adaptive'
      ? {
          reasoning: {
            effort: req.effort,
            summary: req.reasoningDisplay === 'summarized' ? 'auto' : null,
          },
          // store: false 时 encrypted_content 默认不返回，必须显式 include。
          // 少了它下一轮就没有 reasoning 可回传，模型每轮都从头想。
          // 但只在开了 reasoning 时发——关掉时要一个不会产生的东西，
          // 严格的端点会 400
          include: ['reasoning.encrypted_content'],
        }
      : {}),
  }

  return {
    url: `${ctx.baseUrl.replace(/\/+$/, '')}/v1/responses`,
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

/** 一条 canonical 消息可能变成多个 item：这个协议里 tool call / 结果 / 推理都是顶层 item */
function toWireItems(msg: Message): WireItem[] {
  const items: WireItem[] = []
  const content: WireItem[] = []

  for (const part of msg.parts) {
    const item = toStandaloneItem(part)
    if (item) {
      items.push(item)
      continue
    }
    const c = toContentPart(part, msg.role)
    if (c) content.push(c)
  }

  // tool 消息只含 tool_result，全部走上面的 standalone 分支，content 恒为空，
  // 所以这里不会产出 { role: 'tool' } ——Responses 的 role 里没有这个值
  if (content.length > 0) items.push({ role: msg.role, content })
  return items
}

function toStandaloneItem(part: Part): WireItem | null {
  switch (part.type) {
    case 'tool_call':
      // 回传时用 call_id 而不是流里的 item_id（fc_xxx）——它们是两个不同的 id
      return {
        type: 'function_call',
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.input),
      }
    case 'tool_result':
      // 带图时 output 是 content items 数组（InputImage 直接进 responses
      // API）；纯文本保持 string
      if (part.images && part.images.length > 0) {
        return {
          type: 'function_call_output',
          call_id: part.toolCallId,
          output: [
            ...part.images.map((img) => ({
              type: 'input_image',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            })),
            { type: 'input_text', text: part.output },
          ],
        }
      }
      return { type: 'function_call_output', call_id: part.toolCallId, output: part.output }
    case 'reasoning':
      // 没有 encrypted_content 的 reasoning 回传过去没有意义，丢弃
      if (!part.encrypted) return null
      return {
        type: 'reasoning',
        encrypted_content: part.encrypted,
        // summary 要把模型上一轮产出的文本原样带回，写死成 [] 会静默丢掉它
        summary: part.text === '' ? [] : [{ type: 'summary_text', text: part.text }],
      }
    default:
      return null
  }
}

function toContentPart(part: Part, role: Message['role']): WireItem | null {
  switch (part.type) {
    case 'text':
      // 输入侧和输出侧的 type 名字不同，用错会 400
      return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
    case 'image':
      return { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` }
    default:
      return null
  }
}

// ---------------------------------------------------------------- reducer

type State = {
  tools: ToolStream
  /** item_id → call_id。流里按 item_id 索引，canonical 要的是 call_id */
  callIds: Record<string, string>
  usage: Usage
  finishReason: FinishReason
  /** response.completed / incomplete 到过没有。SSE 流「正常 EOF 但没送
   *  终止事件」是网关掐断的形态，不校验会把断流当成完整回答 */
  finished: boolean
}

const initial = (): State => ({
  tools: emptyToolStream(),
  callIds: {},
  usage: zeroUsage(),
  finishReason: 'stop',
  finished: false,
})

function reduce(state: State, msg: SSEMessage): [State, LLMEvent[]] {
  const ev = asObject(JSON.parse(msg.data))
  switch (msg.event) {
    case 'response.output_item.added':
      return onItemAdded(state, ev)
    case 'response.output_item.done':
      return onItemDone(state, ev)
    case 'response.function_call_arguments.delta':
      return onArgumentsDelta(state, ev)
    case 'response.function_call_arguments.done':
      // 这里重发的是**完整** arguments，不是增量。追加会得到 {..}{..}
      return [
        { ...state, tools: replaceTool(state.tools, asString(ev.item_id), asString(ev.arguments)) },
        [],
      ]
    case 'response.output_text.delta':
      return [state, [{ type: 'text_delta', text: asString(ev.delta) }]]
    // reasoning_text 与 reasoning_summary_text 是两个不同事件（前者是原始推理
    // 内容，后者是摘要），字段也不同（content_index vs summary_index）。
    // 只接后者的话，走前者的模型推理过程会被整段丢弃且不报错
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary.delta':
    case 'response.reasoning_summary_text.delta':
      return [state, [{ type: 'reasoning_delta', text: asString(ev.delta) }]]
    case 'response.completed':
    case 'response.incomplete':
      return onCompleted(state, ev)
    case 'response.failed':
    case 'error':
      throw new LLMStreamError(toError(asObject(asObject(ev.response).error ?? ev.error), 0))
    default:
      return [state, []]
  }
}

function onItemAdded(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const item = asObject(ev.item)
  const itemId = asString(item.id)

  switch (asString(item.type)) {
    case 'function_call': {
      const callId = asString(item.call_id)
      const name = asString(item.name)
      // 三者缺一就整条忽略。用空串兜底的话，多个残缺 item 会挤在同一个
      // '' key 上互相覆盖，产生极难定位的静默错乱
      if (itemId === '' || callId === '' || name === '') return [state, []]
      return [
        {
          ...state,
          callIds: { ...state.callIds, [itemId]: callId },
          tools: startTool(state.tools, itemId, callId, name),
        },
        [{ type: 'tool_input_start', id: callId, name }],
      ]
    }
    case 'reasoning':
      return [state, [{ type: 'reasoning_start' }]]
    case 'message':
      return [state, [{ type: 'text_start' }]]
    default:
      return [state, []]
  }
}

function onItemDone(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const item = asObject(ev.item)
  const itemId = asString(item.id)

  switch (asString(item.type)) {
    case 'function_call': {
      if (itemId === '') return [state, []]
      const tools = replaceTool(state.tools, itemId, asString(item.arguments))
      const call = pickTool(tools, itemId)
      return [
        { ...state, tools },
        call ? [{ type: 'tool_input_end', id: call.id, name: call.name, input: call.input }] : [],
      ]
    }
    case 'reasoning': {
      // encrypted_content 在 added 和 done 里都有，但 added 那份是中途快照
      // （实测 1292 字节 vs done 的 1336）。取错的话回传的是残缺内容
      const encrypted = asString(item.encrypted_content)
      return [state, [encrypted ? { type: 'reasoning_end', encrypted } : { type: 'reasoning_end' }]]
    }
    case 'message':
      return [state, [{ type: 'text_end' }]]
    default:
      return [state, []]
  }
}

function onArgumentsDelta(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const itemId = asString(ev.item_id)
  const partial = asString(ev.delta)
  const callId = state.callIds[itemId]
  return [
    { ...state, tools: appendTool(state.tools, itemId, partial) },
    callId ? [{ type: 'tool_input_delta', id: callId, partial }] : [],
  ]
}

function onCompleted(state: State, ev: Record<string, unknown>): [State, LLMEvent[]] {
  const response = asObject(ev.response)
  const usage = toUsage(response.usage)
  const reason = toFinishReason(response)
  return [{ ...state, usage, finishReason: reason, finished: true }, [{ type: 'finish', reason, usage }]]
}

// ---------------------------------------------------------------- usage / 错误

const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

/** 和 openai-chat 一样，input_tokens 已含缓存命中，要减掉才不会算两遍 */
function toUsage(raw: unknown): Usage {
  const u = asObject(raw)
  const cached = asNumber(asObject(u.input_tokens_details).cached_tokens, 0)
  return {
    inputTokens: Math.max(0, asNumber(u.input_tokens, 0) - cached),
    outputTokens: asNumber(u.output_tokens, 0),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
    reasoningTokens: asNumber(asObject(u.output_tokens_details).reasoning_tokens, 0),
  }
}

/**
 * 这个协议没有 finish_reason 字段，要从 status + output 反推。
 * 有 function_call item 就是 tool-calls——漏了这条，loop 会以为对话结束了。
 */
function toFinishReason(response: Record<string, unknown>): FinishReason {
  if (asString(response.status) === 'incomplete') {
    const reason = asString(asObject(response.incomplete_details).reason)
    return reason === 'max_output_tokens' ? 'length' : 'content-filter'
  }
  const hasToolCall = asArray(response.output).some(
    (item) => asString(asObject(item).type) === 'function_call',
  )
  return hasToolCall ? 'tool-calls' : 'stop'
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
    // 见 anthropic-messages.ts 同一处：兼容网关兜底的 [DONE]，跳过别 parse
    if (msg.done !== undefined) continue
    const [next, events] = reduce(state, msg)
    state = next
    yield* events
  }
  // 见 anthropic-messages.ts 同一处：干净 EOF 但没有终止事件 = 链路把流掐了，
  // 不是模型说完了。不校验的话 turn 会静默「正常」收尾，界面上什么都不显示
  if (!state.finished) {
    throw new LLMStreamError({
      kind: 'server',
      message: '响应流被提前断开（未收到结束标记），本次回答不完整',
      retryable: true,
    })
  }
}

export const openaiResponses: Protocol = {
  name: 'openai-responses',
  buildRequest,
  parseStream,
  parseError,
}
