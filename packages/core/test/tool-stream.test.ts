import { describe, expect, it } from 'vitest'
import {
  appendTool,
  emptyToolStream,
  flushTools,
  replaceTool,
  startTool,
} from '../src/llm/protocols/utils/tool-stream.ts'

describe('ToolStream', () => {
  it('累积分片后 parse 成对象', () => {
    // 分片切法取自真实录制：JSON 字符串字面量会被切在中间
    let s = startTool(emptyToolStream(), '0', 'toolu_1', 'bash')
    for (const d of ['{"', 'command', '":"', 'ls', '"}']) s = appendTool(s, '0', d)
    expect(flushTools(s)).toEqual([
      { type: 'tool_call', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ])
  })

  it('replace 覆盖已累积的内容，而不是接在后面', () => {
    let s = startTool(emptyToolStream(), 'item_1', 'call_1', 'bash')
    for (const d of ['{"command"', ':"ls"}']) s = appendTool(s, 'item_1', d)

    // 对照组：Responses 在 output_item.done 时重发完整 arguments。若这里用
    // append，buf 会变成 '{"command":"ls"}{"command":"ls"}'，parse 失败后
    // 归一成 { _raw } 对象（裸串进历史会毒回传，见 parseInput 注释）
    const appended = appendTool(s, 'item_1', '{"command":"ls"}')
    expect(flushTools(appended)[0]?.input).toEqual({ _raw: '{"command":"ls"}{"command":"ls"}' })

    const replaced = replaceTool(s, 'item_1', '{"command":"ls"}')
    expect(flushTools(replaced)[0]?.input).toEqual({ command: 'ls' })
  })

  it('按模型给出的顺序 flush，不依赖 Record 的键序', () => {
    let s = emptyToolStream()
    // 用数字形状的键：Record 的整数键会被引擎重排成升序，字面顺序保不住
    s = startTool(s, '2', 'c', 'bash')
    s = startTool(s, '0', 'a', 'bash')
    s = startTool(s, '1', 'b', 'bash')
    expect(flushTools(s).map((t) => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('startTool 重复调用不清空已累积的 buf', () => {
    // openai-chat 的首个 delta 同时带 name 和 arguments 起始片段
    let s = startTool(emptyToolStream(), '0', 'call_1', 'bash')
    s = appendTool(s, '0', '{"command"')
    s = startTool(s, '0', 'call_1', 'bash')
    s = appendTool(s, '0', ':"ls"}')
    expect(flushTools(s)[0]?.input).toEqual({ command: 'ls' })
  })

  it('无参数的工具没有 delta，input 是空对象而不是抛异常', () => {
    const s = startTool(emptyToolStream(), '0', 'call_1', 'noop')
    expect(flushTools(s)[0]?.input).toEqual({})
  })

  it('非法 JSON 不抛，包成 { _raw } 对象出生——裸串进历史回传必 500', () => {
    let s = startTool(emptyToolStream(), '0', 'call_1', 'bash')
    s = appendTool(s, '0', '{"command":"ls') // 被截断
    expect(() => flushTools(s)).not.toThrow()
    expect(flushTools(s)[0]?.input).toEqual({ _raw: '{"command":"ls' })
  })

  it('合法 JSON 但整体不是对象（字符串/数组）同样归一——parse 成功的裸串照样毒历史', () => {
    let s = startTool(emptyToolStream(), '0', 'call_1', 'bash')
    s = appendTool(s, '0', '"半截文本"') // JSON.parse 成功，结果是字符串
    expect(flushTools(s)[0]?.input).toEqual({ _raw: '半截文本' })
    let s2 = startTool(emptyToolStream(), '0', 'call_2', 'bash')
    s2 = appendTool(s2, '0', '[1,2]')
    expect(flushTools(s2)[0]?.input).toEqual({ _raw: '[1,2]' })
  })

  it('操作是纯的：不改入参，同一 state 重复喂得到同样结果', () => {
    const base = startTool(emptyToolStream(), '0', 'call_1', 'bash')
    const once = appendTool(base, '0', 'x')
    const twice = appendTool(base, '0', 'x')

    expect(flushTools(base)[0]?.input).toEqual({}) // base 未被改动
    expect(once).toEqual(twice)
    expect(once).not.toBe(twice)
  })

  it('对未 start 的 key 写入是无操作，不凭空造出 tool call', () => {
    const s = appendTool(emptyToolStream(), '0', '{"a":1}')
    expect(flushTools(s)).toEqual([])
  })
})
