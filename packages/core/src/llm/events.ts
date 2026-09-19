import type { FinishReason, Usage } from './types.ts'

/**
 * 协议层能观察到的事件——**只描述「模型说了什么」**。
 *
 * 这里没有 tool_result，不是不想加，是协议层物理上给不出：HTTP 响应流在模型
 * 说完"要调 bash"时就结束了，工具执行压根不经过协议层。硬塞进来会得到一个
 * 三个协议永远不会产生的分支，等于在类型上撒谎。
 *
 * 对外的事件是 AgentEvent（见 ../events.ts）。变量命名用 llmEv / agentEv
 * 区分，不要都叫 ev（CLAUDE.md §3.1）。
 */
export type LLMEvent =
  | { type: 'message_start'; usage: Usage }
  | { type: 'text_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'text_end' }
  | { type: 'reasoning_start' }
  | { type: 'reasoning_delta'; text: string }
  /** signature / encrypted_content 要到块结束才拿得到，所以挂在 end 上而不是 start */
  | { type: 'reasoning_end'; encrypted?: string }
  | { type: 'tool_input_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partial: string }
  /** 累积完成并已 parse。这是内部信号，loop 收到后转成对外的 tool_call */
  | { type: 'tool_input_end'; id: string; name: string; input: unknown }
  | { type: 'finish'; reason: FinishReason; usage: Usage }

/** SSE 行解析的产物，协议无关。见 protocols/utils/sse.ts */
export type SSEMessage = {
  /** SSE 的 event: 字段。OpenAI Chat 不发这个字段，此时为空串 */
  event: string
  /** data: 字段的原始文本，尚未 JSON.parse */
  data: string
  /** 流终止哨兵 [DONE] 的结构化形态。不发这个字段的协议见不到它 */
  done?: true
}

/**
 * reducer 必须是纯函数：不发事件、不写日志、不改外部状态。
 * 这是协议层可测试性的全部基础——喂录制的 SSE fixture，断言输出序列即可。
 *
 * 一次输入可能产出 0 个或多个 LLMEvent：OpenAI Chat 没有单个 tool call 的
 * 结束事件，只能在 stream 结束时一次性 flush 全部累积的 tool call。
 */
export type Reducer<S> = (state: S, message: SSEMessage) => [S, LLMEvent[]]
