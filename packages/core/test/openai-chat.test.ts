import { describe, expect, it } from 'vitest'
import type { LLMEvent } from '../src/llm/events.ts'
import { openaiChat } from '../src/llm/protocols/openai-chat.ts'
import { parseSSE } from '../src/llm/protocols/utils/sse.ts'
import type { Message, Request } from '../src/llm/types.ts'
import { eventsFromFixture, readFixture, shape } from './helpers.ts'

const FIXTURE = 'openai-chat.tool-call.sse'

const baseRequest = (over: Partial<Request> = {}): Request => ({
  model: 'm',
  maxTokens: 100,
  thinking: 'adaptive',
  effort: 'high',
  reasoningDisplay: 'summarized',
  system: 'S',
  tools: [],
  messages: [],
  ...over,
})

const body = (over: Partial<Request> = {}) =>
  openaiChat.buildRequest(baseRequest(over), { baseUrl: 'https://x.test', apiKey: 'k' })
    .body as Record<string, unknown>

const wireMessages = (messages: Message[]) =>
  body({ messages }).messages as Record<string, unknown>[]

/** 喂合成 chunk。fixture 覆盖不到的分支只能这样测 */
async function feed(chunks: Record<string, unknown>[]): Promise<LLMEvent[]> {
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  async function* once() {
    yield new TextEncoder().encode(sse)
  }
  const out: LLMEvent[] = []
  for await (const llmEv of openaiChat.parseStream(parseSSE(once()))) out.push(llmEv)
  return out
}

const choice = (delta: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
})

describe('openai-chat / parseStream', () => {
  it('流 EOF 但没收到 [DONE]：当断流抛错，不当成功', async () => {
    // 网关超时掐断的表现正是「干净 EOF、无哨兵」。当成功处理的话
    // turn 会静默正常收尾——没有错误、没有落盘、界面什么都不显示
    const sse = `data: ${JSON.stringify({ choices: [choice({ content: '半截' })] })}\n\n`
    async function* once() {
      yield new TextEncoder().encode(sse)
    }
    const out: LLMEvent[] = []
    await expect(
      (async () => {
        for await (const llmEv of openaiChat.parseStream(parseSSE(once()))) out.push(llmEv)
      })(),
    ).rejects.toMatchObject({ detail: { kind: 'server', retryable: true } })
  })

  it('从录制的 fixture 解出完整事件序列', async () => {
    const events = await eventsFromFixture(openaiChat.parseStream, FIXTURE)
    expect(shape(events)).toEqual([
      'tool_input_start',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      // 没有单个 tool call 的结束事件，input_end 是流结束后 flush 出来的
      'tool_input_end',
      'finish',
    ])
  })

  it('分片累积成对象，且工具名没被后续的空串覆盖', async () => {
    const raw = (await readFixture(FIXTURE)).toString('utf8')
    // 先证明前提：后续分片确实带 name:""。若网关改成不发 name，
    // 「不被覆盖」这条就没测到了
    expect(raw).toContain('"function":{"name":"","arguments":"{\\""}')

    const events = await eventsFromFixture(openaiChat.parseStream, FIXTURE)
    expect(events.find((e) => e.type === 'tool_input_end')).toMatchObject({
      name: 'bash',
      input: { command: 'ls' },
    })
  })

  it('finish 带 usage——它们不在同一个 chunk 里', async () => {
    const raw = (await readFixture(FIXTURE)).toString('utf8')
    // 前提：finish_reason 的 chunk 里没有 usage，usage 独占最后一个 chunk
    expect(raw).toContain('"finish_reason":"tool_calls"}]}')
    expect(raw).toContain('"choices":[],"usage"')

    const events = await eventsFromFixture(openaiChat.parseStream, FIXTURE)
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    expect(finish.reason).toBe('tool-calls')
    // 见到 finish_reason 就发事件的实现，这里会是 0
    expect(finish.usage.outputTokens).toBe(31)
    expect(finish.usage.reasoningTokens).toBe(11)
  })

  it('空 content 不产生 text_start', async () => {
    // fixture 里 finish 那一 chunk 带的是 content:""，不能因此开一个空文本块
    const events = await feed([choice({ content: '' }, 'stop')])
    expect(shape(events)).toEqual(['finish'])
  })

  it('有文本时 start/end 配对', async () => {
    const events = await feed([
      choice({ content: '你' }),
      choice({ content: '好' }),
      choice({}, 'stop'),
    ])
    expect(shape(events)).toEqual(['text_start', 'text_delta', 'text_delta', 'text_end', 'finish'])
  })

  it('多个并行 tool call 各自累积，按 index 区分', async () => {
    const events = await feed([
      choice({
        tool_calls: [
          { index: 0, id: 'a', function: { name: 'bash', arguments: '' } },
          { index: 1, id: 'b', function: { name: 'bash', arguments: '' } },
        ],
      }),
      choice({ tool_calls: [{ index: 1, function: { name: '', arguments: '{"command":"b"}' } }] }),
      choice({ tool_calls: [{ index: 0, function: { name: '', arguments: '{"command":"a"}' } }] }),
      choice({}, 'tool_calls'),
    ])
    const ends = events.filter((e) => e.type === 'tool_input_end')
    expect(ends).toEqual([
      { type: 'tool_input_end', id: 'a', name: 'bash', input: { command: 'a' } },
      { type: 'tool_input_end', id: 'b', name: 'bash', input: { command: 'b' } },
    ])
  })

  it('tool call 首次出现却缺 id 或 name 时报错，不造空壳工具', async () => {
    // 兜底成空串会让一个 id='' 的工具调用一路走到 finalize，
    // 之后按 id 配对 tool_result 时静默失配
    await expect(
      feed([choice({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] })]),
    ).rejects.toThrow(/缺少 id 或 name/)

    await expect(
      feed([choice({ tool_calls: [{ index: 0, id: 'a', function: { arguments: '{}' } }] })]),
    ).rejects.toThrow(/缺少 id 或 name/)
  })

  it('reasoning_content 产出 reasoning 事件，且先于正文收尾', async () => {
    // DeepSeek / Qwen 走这个协议时用 reasoning_content 承载推理内容
    const events = await feed([
      choice({ reasoning_content: '先' }),
      choice({ reasoning_content: '想想' }),
      choice({ content: '答案' }),
      choice({}, 'stop'),
    ])
    expect(shape(events)).toEqual([
      'reasoning_start',
      'reasoning_delta',
      'reasoning_delta',
      'reasoning_end',
      'text_start',
      'text_delta',
      'text_end',
      'finish',
    ])
  })

  it('只有 reasoning 没有正文时，finalize 也会收尾', async () => {
    const events = await feed([choice({ reasoning_content: '想' }), choice({}, 'stop')])
    expect(shape(events)).toEqual(['reasoning_start', 'reasoning_delta', 'reasoning_end', 'finish'])
  })

  it('流中途的 error 抛 LLMStreamError', async () => {
    await expect(feed([{ error: { message: '上游炸了', code: 'server_error' } }])).rejects.toThrow(
      '上游炸了',
    )
  })
})

describe('openai-chat / usage 与 Anthropic 的口径差异', () => {
  it('prompt_tokens 含缓存命中，要减掉才不会算两遍', async () => {
    const events = await feed([
      choice({}, 'stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 23292,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 23263 },
        },
      },
    ])
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    // canonical 的不变量是「三者相加 = 完整输入量」。不减的话
    // 23292 + 23263 = 46555，凭空多出一倍
    expect(finish.usage.inputTokens).toBe(29)
    expect(finish.usage.cacheReadInputTokens).toBe(23263)
    const total =
      finish.usage.inputTokens +
      finish.usage.cacheCreationInputTokens +
      finish.usage.cacheReadInputTokens
    expect(total).toBe(23292)
  })
})

describe('openai-chat / buildRequest', () => {
  it('system 是 messages[0]，不是顶层字段', () => {
    expect(body().messages).toEqual([{ role: 'system', content: 'S' }])
    expect(body()).not.toHaveProperty('system')
  })

  it('历史里的裸串 input 归一后再序列化——arguments 必须能 parse 成对象', () => {
    // 存量毒：裸串直接 stringify 会发出 '"半截文本"'——合法 JSON 字符串
    // 但不是对象，提供方按对象取字段直接 500（2026-09-27 test 工作区实案）
    const wire = wireMessages([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: '半截文本' }],
      },
    ])
    // wire[0] 是 system（openai 的 system 也是 messages 一员），assistant 在 [1]
    const fn = (wire[1] as Record<string, any>).tool_calls[0].function
    expect(JSON.parse(fn.arguments)).toEqual({ _raw: '半截文本' })
  })

  it('必须传 stream_options.include_usage，否则拿不到 usage', () => {
    expect(body().stream_options).toEqual({ include_usage: true })
  })

  it('用 max_tokens 而不是 max_completion_tokens', () => {
    // 这个协议服务的兼容端点多数只认旧字段；真正的 OpenAI 走 responses
    expect(body().max_tokens).toBe(100)
    expect(body()).not.toHaveProperty('max_completion_tokens')
  })

  it('effort 映射成 reasoning_effort——漏了它用户设的档位会静默失效', () => {
    expect(body({ effort: 'low' }).reasoning_effort).toBe('low')
  })

  it('空 system 不发 system 消息，空 tools 不发 tools 字段', () => {
    expect(body({ system: '' }).messages).toEqual([])
    expect(body().tools).toBeUndefined()
  })

  it('tool schema 用 parameters，包在 function 里', () => {
    expect(
      body({ tools: [{ name: 'bash', description: 'd', parameters: { type: 'object' } }] }).tools,
    ).toEqual([
      {
        type: 'function',
        function: { name: 'bash', description: 'd', parameters: { type: 'object' } },
      },
    ])
  })

  it('一条 tool 消息里的多个 tool_result 各成一条 wire 消息', () => {
    // 这个协议要求一个 tool_call_id 一条消息，而 canonical 允许一条 tool
    // 消息装多个结果（模型一次发多个 tool_call 时就是这样）
    const msgs = wireMessages([
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', toolCallId: 't1', output: 'ok', isError: false },
          { type: 'tool_result', toolCallId: 't2', output: 'boom', isError: true },
        ],
      },
    ])
    expect(msgs.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
      { role: 'tool', tool_call_id: 't2', content: 'boom' },
    ])
  })

  it('tool 消息紧跟带 tool_calls 的 assistant，中间不夹 user', () => {
    // OpenAI 的硬约束：中间夹一条 user 消息会 400。canonical 保留 tool 角色
    // 之后这里是顺序直传——早先 tool_result 挂在 user 消息里的版本，得专门
    // 把它从 user 消息里挑出来排到文本前面
    const msgs = wireMessages([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: {} }] },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 't1', output: 'ok', isError: false }],
      },
      { role: 'user', parts: [{ type: 'text', text: '继续' }] },
    ])
    expect(msgs.map((m) => m.role)).toEqual(['system', 'assistant', 'tool', 'user'])
  })

  it('assistant 的 tool_call 变成 tool_calls，input 序列化成字符串', () => {
    const msgs = wireMessages([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }],
      },
    ])
    // content 是 null 不是空串：「只调工具不说话」是最常见的 assistant 形态，
    // 严格的实现会区分「没有内容」和「空内容」
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
      ],
    })
  })

  it('reasoning 回传成消息级的 reasoning_content，不进 content 数组', () => {
    // DeepSeek / Qwen 等在这个协议上用 reasoning_content 承载推理内容。
    // 整段丢掉的话，多轮对话里模型看不到自己上一轮的思考
    const msgs = wireMessages([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '想了想', encrypted: 'sig' },
          { type: 'text', text: '答案' },
        ],
      },
    ])
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: '答案',
      reasoning_content: '想了想',
    })
  })

  it('图片转成 data URI，此时 content 是数组', () => {
    const msgs = wireMessages([
      {
        role: 'user',
        parts: [
          { type: 'text', text: '看' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
        ],
      },
    ])
    expect(msgs[1]?.content).toEqual([
      { type: 'text', text: '看' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ])
  })
})

describe('openai-chat / parseError', () => {
  const err = (status: number, code: string, message = 'm') =>
    openaiChat.parseError(status, { error: { code, message } })

  it('429 可重试，401 不可重试', () => {
    expect(err(429, 'rate_limit_exceeded')).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(err(401, 'invalid_api_key')).toMatchObject({ kind: 'auth', retryable: false })
    expect(err(503, '')).toMatchObject({ kind: 'server', retryable: true })
  })

  it('context overflow 认 code，也认文案', () => {
    expect(err(400, 'context_length_exceeded').kind).toBe('context_overflow')
    expect(err(400, '', "this model's maximum context length is 128000").kind).toBe(
      'context_overflow',
    )
    // 对照组：同样 400，文案不匹配时不能误判
    expect(err(400, 'invalid_request_error', 'unknown parameter').kind).toBe('invalid_request')
  })
})

describe('tool_result 带图：换道（web-tools D4）', () => {
  it('带图：tool 消息只留文本，图拼成紧随其后的合成 user 消息', () => {
    const messages = wireMessages([
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: 'call_1',
            output: '抓到了',
            isError: false,
            images: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }],
          },
        ],
      },
    ]).filter((m) => m.role !== 'system')
    expect(messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '抓到了' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '工具结果附图（抓到了）：' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,QUJD' },
          },
        ],
      },
    ])
  })

  it('纯文本：不插合成消息——回归', () => {
    const messages = wireMessages([
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 'c', output: 'ok', isError: false }],
      },
    ])
    expect(messages.filter((m) => m.role !== 'system')).toEqual([
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
    ])
  })
})
