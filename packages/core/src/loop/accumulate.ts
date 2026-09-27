import type { AgentEvent } from '../events.ts'
import type { RefusalDetail } from '../llm/events.ts'
import type { FinishReason, Message, Part, ToolCallPart, Usage } from '../llm/types.ts'
import type { StreamEvent } from './retry.ts'

/**
 * 攒一条 assistant 消息。
 *
 * 单独一个模块是因为它是纯的：喂一串 StreamEvent，产出 (AgentEvent[], 消息)。
 * run.ts 里那圈 for await 只负责转发，不掺状态机——`restart` 要作废半截内容，
 * 混在 loop 里写很容易只清掉一半（比如清了 parts 忘了 usage）。
 */
export type Accumulator = {
  parts: Part[]
  usage: Usage
  finish: FinishReason
  /** content-filter 拒答的详情，run 拿它把「模型为什么没说话」透传给用户 */
  refusal?: RefusalDetail
  /** 未收尾的块。流中途断掉时靠它决定要不要补一个 end 事件 */
  open: OpenBlock
}

type OpenBlock =
  | { type: 'none' }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }

export const zeroUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

export const emptyAccumulator = (): Accumulator => ({
  parts: [],
  usage: zeroUsage(),
  finish: 'stop',
  open: { type: 'none' },
})

/**
 * 一个 StreamEvent 进，(新状态, 要对外发的 AgentEvent) 出。
 *
 * 大多数事件是 1:1 转发，值得注意的只有三处：
 * - `reasoning_end` 的 encrypted 不外传——那是回传给模型的不透明串，UI 用不上
 * - `tool_input_end` 不对外发，工具调用要等到真的开始执行时才发 tool_call
 * - `restart` 把累积状态清空
 */
export function accumulate(state: Accumulator, ev: StreamEvent): [Accumulator, AgentEvent[]] {
  switch (ev.type) {
    case 'restart':
      // 整个清空，不只是 parts：usage 也是本次尝试的，留着会被下一轮加成两份
      return [emptyAccumulator(), [{ type: 'restart' }]]

    case 'message_start':
      return [{ ...state, usage: ev.usage }, []]

    case 'text_start':
      return [{ ...state, open: { type: 'text', text: '' } }, [{ type: 'text_start' }]]

    case 'text_delta':
      return [appendOpen(state, 'text', ev.text), [{ type: 'text_delta', text: ev.text }]]

    case 'text_end':
      return [closeOpen(state), [{ type: 'text_end' }]]

    case 'reasoning_start':
      return [{ ...state, open: { type: 'reasoning', text: '' } }, [{ type: 'reasoning_start' }]]

    case 'reasoning_delta':
      return [appendOpen(state, 'reasoning', ev.text), [{ type: 'reasoning_delta', text: ev.text }]]

    case 'reasoning_end':
      return [closeOpen(state, ev.encrypted), [{ type: 'reasoning_end' }]]

    case 'tool_input_start':
      return [state, [{ type: 'tool_input_start', id: ev.id, name: ev.name }]]

    case 'tool_input_delta':
      return [state, [{ type: 'tool_input_delta', id: ev.id, partial: ev.partial }]]

    case 'tool_input_end':
      return [
        { ...state, parts: [...state.parts, toolCall(ev.id, ev.name, ev.input)] },
        [], // 对外的 tool_call 等到真的开始执行时才发（core-modules.md §7）
      ]

    case 'finish':
      return [
        { ...state, usage: ev.usage, finish: ev.reason, ...(ev.refusal ? { refusal: ev.refusal } : {}) },
        [],
      ]
  }
}

const toolCall = (id: string, name: string, input: unknown): ToolCallPart => ({
  type: 'tool_call',
  id,
  name,
  input,
})

function appendOpen(state: Accumulator, kind: 'text' | 'reasoning', text: string): Accumulator {
  // 没有 start 就来 delta，说明协议层漏发了。按 kind 开一个而不是丢掉——
  // 丢掉的话这段内容静默消失，比多开一个块严重得多
  const open =
    state.open.type === kind
      ? { ...state.open, text: state.open.text + text }
      : { type: kind, text }
  return { ...state, open }
}

/** 把未收尾的块结算成 part。空文本的块不产出 part——空 text part 有些端点会 400 */
function closeOpen(state: Accumulator, encrypted?: string): Accumulator {
  const { open } = state
  if (open.type === 'none') return state
  if (open.type === 'text') {
    const parts = open.text === '' ? state.parts : [...state.parts, textPart(open.text)]
    return { ...state, parts, open: { type: 'none' } }
  }
  // reasoning 即使文本为空也要保留：encrypted 是回传给模型的，丢了下一轮
  // 就少了一段推理上下文。Anthropic 的 thinking display:'omitted' 正是
  // 「文本为空但 signature 有值」（design.md 附录 A.3）
  const keep = open.text !== '' || encrypted !== undefined
  const parts = keep ? [...state.parts, reasoningPart(open.text, encrypted)] : state.parts
  return { ...state, parts, open: { type: 'none' } }
}

const textPart = (text: string): Part => ({ type: 'text', text })

const reasoningPart = (text: string, encrypted?: string): Part =>
  encrypted === undefined ? { type: 'reasoning', text } : { type: 'reasoning', text, encrypted }

/**
 * 收尾。流正常结束时 open 应该已经是 none，中途断掉则不是——
 * 那种情况把半截内容也留下，用户已经看见它了，历史里凭空少一段更奇怪。
 */
export function finishAccumulator(state: Accumulator): Message {
  return { role: 'assistant', parts: closeOpen(state).parts }
}

export const pendingToolCalls = (state: Accumulator): ToolCallPart[] =>
  state.parts.filter((p): p is ToolCallPart => p.type === 'tool_call')
