import type { ToolCallPart } from '../../types.ts'
import { asToolInput } from './wire.ts'

/**
 * tool call 的增量 JSON 累积。三个协议共用，但写入语义不同：
 *
 * - anthropic / openai-chat：纯追加（`buf += delta`）
 * - openai-responses：`output_item.done` 时**可能把完整 arguments 再发一遍**，
 *   必须整体替换。只会追加的状态机在这里会得到 `{"a":1}{"a":1}` 这种垃圾。
 *
 * 所以 replace 不是为将来预留的——它现在就有唯一的真实调用方。
 *
 * key 是不透明字符串而不是 number，因为三个协议的索引方式不同：
 * content block index / tool_call index / item_id。各协议自己决定怎么生成。
 */
export type ToolStream = {
  /** 保持模型给出的顺序，Record 的键序不可依赖 */
  order: string[]
  entries: Record<string, ToolEntry>
}

type ToolEntry = { id: string; name: string; buf: string }

export const emptyToolStream = (): ToolStream => ({ order: [], entries: {} })

// 以下全部返回新对象。reducer 必须是纯函数（CLAUDE.md §4.3）——原地修改会让
// 「同一个 state 喂同一个事件得到同样结果」不成立，录制的 fixture 就不可重放了。
// 一轮最多几个 tool call，浅拷贝的成本可以忽略。

export function startTool(s: ToolStream, key: string, id: string, name: string): ToolStream {
  const existing = s.entries[key]
  return {
    order: existing ? s.order : [...s.order, key],
    // 已存在时保留已累积的 buf：openai-chat 的首个 delta 同时带 name 和 arguments
    entries: { ...s.entries, [key]: { id, name, buf: existing?.buf ?? '' } },
  }
}

export function appendTool(s: ToolStream, key: string, delta: string): ToolStream {
  const e = s.entries[key]
  if (!e) return s
  return { order: s.order, entries: { ...s.entries, [key]: { ...e, buf: e.buf + delta } } }
}

export function replaceTool(s: ToolStream, key: string, full: string): ToolStream {
  const e = s.entries[key]
  if (!e) return s
  return { order: s.order, entries: { ...s.entries, [key]: { ...e, buf: full } } }
}

/** 取单个 tool call：Anthropic / Responses 有明确的结束事件，可以逐个结算 */
export function pickTool(s: ToolStream, key: string): ToolCallPart | null {
  const e = s.entries[key]
  return e ? toPart(e) : null
}

/** 全部结算：openai-chat 没有单个 tool call 的结束事件，只能在流结束时一次性来 */
export function flushTools(s: ToolStream): ToolCallPart[] {
  return s.order.flatMap((key) => {
    const e = s.entries[key]
    return e ? [toPart(e)] : []
  })
}

const toPart = (e: ToolEntry): ToolCallPart => ({
  type: 'tool_call',
  id: e.id,
  name: e.name,
  input: parseInput(e.buf),
})

/**
 * parse 失败不抛。模型偶尔会产生截断或非法的 JSON，抛异常会打断整个 loop。
 * 失败/非对象一律包成 { _raw: 原文 } 的对象出生——形状保证回传合法
 * （见 wire.ts asToolInput 的账），原文保留给工具层：参数校验返回一条
 * 模型读得懂的散文错误（CLAUDE.md §4.2），模型看到后重新组织参数再试。
 */
function parseInput(buf: string): Record<string, unknown> {
  // 无参数的工具不会产生任何 delta，buf 是空串。JSON.parse('') 会抛
  if (buf === '') return {}
  try {
    // 合法 JSON 但整体不是对象（'"foo"' / '[1,2]'）同样要归一——
    // parse 成功的裸串照样毒历史，catch 只堵得住一半
    return asToolInput(JSON.parse(buf))
  } catch {
    return { _raw: buf }
  }
}
