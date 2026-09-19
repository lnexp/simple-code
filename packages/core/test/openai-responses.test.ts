import { describe, expect, it } from 'vitest'
import type { LLMEvent } from '../src/llm/events.ts'
import { openaiResponses } from '../src/llm/protocols/openai-responses.ts'
import { parseSSE } from '../src/llm/protocols/utils/sse.ts'
import type { Message, Request } from '../src/llm/types.ts'
import { eventsFromFixture, readFixture, shape } from './helpers.ts'

const FIXTURE = 'openai-responses.tool-call.sse'

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
  openaiResponses.buildRequest(baseRequest(over), { baseUrl: 'https://x.test', apiKey: 'k' })
    .body as Record<string, unknown>

const wireInput = (messages: Message[]) => body({ messages }).input as Record<string, unknown>[]

async function feed(events: [string, Record<string, unknown>][]): Promise<LLMEvent[]> {
  const sse = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`)
    .join('')
  async function* once() {
    yield new TextEncoder().encode(sse)
  }
  const out: LLMEvent[] = []
  for await (const llmEv of openaiResponses.parseStream(parseSSE(once()))) out.push(llmEv)
  return out
}

describe('openai-responses / parseStream', () => {
  it('流 EOF 但没收到 response.completed：当断流抛错，不当成功', async () => {
    // 同 anthropic 侧：干净 EOF 不是模型说完了，是链路把流掐了
    await expect(
      feed([['response.output_text.delta', { delta: '半截' }]]),
    ).rejects.toMatchObject({ detail: { kind: 'server', retryable: true } })
  })

  it('从录制的 fixture 解出完整事件序列', async () => {
    const events = await eventsFromFixture(openaiResponses.parseStream, FIXTURE)
    expect(shape(events)).toEqual([
      'reasoning_start',
      'reasoning_end',
      'tool_input_start',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_end',
      'finish',
    ])
  })

  it('done 重发完整 arguments 时整体替换，不追加', async () => {
    const raw = (await readFixture(FIXTURE)).toString('utf8')
    // 前提：done 里带的是完整 JSON 而不是最后一个分片。若网关改了行为，
    // 这条就退化成在测普通累积了
    expect(raw).toContain('"arguments":"{\\"command\\":\\"ls\\"}"')

    const events = await eventsFromFixture(openaiResponses.parseStream, FIXTURE)
    // 纯追加的实现会得到 {"command":"ls"}{"command":"ls"}，parse 失败后退化成字符串
    expect(events.find((e) => e.type === 'tool_input_end')).toMatchObject({
      name: 'bash',
      input: { command: 'ls' },
    })
  })

  it('对外用 call_id，不是流里索引用的 item_id', async () => {
    const raw = (await readFixture(FIXTURE)).toString('utf8')
    // 前提：这两个 id 确实不同。如果碰巧相同，这条测试什么也没验证
    expect(raw).toContain('"id":"fc_')
    expect(raw).toContain('"call_id":"call_')

    const events = await eventsFromFixture(openaiResponses.parseStream, FIXTURE)
    for (const e of events) {
      if (e.type === 'tool_input_start' || e.type === 'tool_input_delta') {
        expect(e.id).toMatch(/^call_/)
      }
    }
    const end = events.find((e) => e.type === 'tool_input_end')
    expect(end?.type === 'tool_input_end' && end.id).toMatch(/^call_/)
  })

  it('reasoning 的 encrypted 取 done 那份，不是 added 的中途快照', async () => {
    const raw = (await readFixture(FIXTURE)).toString('utf8')
    const lengths = [...raw.matchAll(/"encrypted_content":"([^"]*)"/g)].map(
      (m) => m[1]?.length ?? 0,
    )
    // 前提：added 和 done 的长度确实不同（实测 1292 → 1336）。
    // 相同的话取哪个都对，这条测试就是空的
    expect(lengths).toHaveLength(2)
    expect(lengths[0]).not.toBe(lengths[1])

    const events = await eventsFromFixture(openaiResponses.parseStream, FIXTURE)
    const end = events.find((e) => e.type === 'reasoning_end')
    if (end?.type !== 'reasoning_end') throw new Error('应该有 reasoning_end')
    expect(end.encrypted).toHaveLength(lengths[1] as number)
  })

  it('finish 从 output 反推——这个协议没有 finish_reason 字段', async () => {
    const events = await eventsFromFixture(openaiResponses.parseStream, FIXTURE)
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    // output 里有 function_call。漏了这条反推，loop 会以为对话结束了
    expect(finish.reason).toBe('tool-calls')
    expect(finish.usage.outputTokens).toBe(31)
    expect(finish.usage.reasoningTokens).toBe(11)
  })

  it('没有 tool call 时是 stop，截断时是 length', async () => {
    const stop = await feed([
      ['response.completed', { response: { status: 'completed', output: [{ type: 'message' }] } }],
    ])
    expect(stop.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' })

    const truncated = await feed([
      [
        'response.incomplete',
        {
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            output: [],
          },
        },
      ],
    ])
    expect(truncated.at(-1)).toMatchObject({ type: 'finish', reason: 'length' })
  })

  it('文本块的 start/end 由 message item 的 added/done 界定', async () => {
    const events = await feed([
      ['response.output_item.added', { item: { id: 'msg_1', type: 'message' } }],
      ['response.output_text.delta', { item_id: 'msg_1', delta: '你' }],
      ['response.output_text.delta', { item_id: 'msg_1', delta: '好' }],
      ['response.output_item.done', { item: { id: 'msg_1', type: 'message' } }],
      ['response.completed', { response: { status: 'completed', output: [] } }],
    ])
    expect(shape(events)).toEqual(['text_start', 'text_delta', 'text_delta', 'text_end', 'finish'])
  })

  it('response.failed 抛 LLMStreamError', async () => {
    await expect(
      feed([['response.failed', { response: { error: { message: '上游炸了' } } }]]),
    ).rejects.toThrow('上游炸了')
  })
})

describe('openai-responses / usage', () => {
  it('input_tokens 含缓存命中，要减掉', async () => {
    const events = await feed([
      [
        'response.completed',
        {
          response: {
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 23292,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 23263 },
            },
          },
        },
      ],
    ])
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    expect(finish.usage.inputTokens).toBe(29)
    expect(finish.usage.cacheReadInputTokens).toBe(23263)
  })
})

describe('openai-responses / buildRequest', () => {
  it('system 走顶层 instructions', () => {
    expect(body().instructions).toBe('S')
  })

  it('store:false 时必须 include encrypted_content，否则下一轮没有 reasoning 可回传', () => {
    expect(body().store).toBe(false)
    expect(body().include).toEqual(['reasoning.encrypted_content'])
  })

  it('tool schema 是扁平的，不包在 function 里', () => {
    expect(
      body({ tools: [{ name: 'bash', description: 'd', parameters: { type: 'object' } }] }).tools,
    ).toEqual([
      { type: 'function', name: 'bash', description: 'd', parameters: { type: 'object' } },
    ])
  })

  it('tool_call 回传用 call_id；tool_result 是独立的 function_call_output item', () => {
    const input = wireInput([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_1', name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        parts: [
          { type: 'tool_result', toolCallId: 'call_1', output: 'a.txt', isError: false },
          { type: 'text', text: '继续' },
        ],
      },
    ])
    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'bash',
        arguments: '{"command":"ls"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ])
  })

  it('输入侧是 input_text，输出侧是 output_text', () => {
    const user = wireInput([{ role: 'user', parts: [{ type: 'text', text: 'u' }] }])
    const assistant = wireInput([{ role: 'assistant', parts: [{ type: 'text', text: 'a' }] }])
    expect(user[0]?.content).toEqual([{ type: 'input_text', text: 'u' }])
    expect(assistant[0]?.content).toEqual([{ type: 'output_text', text: 'a' }])
  })

  it('reasoning 带 encrypted_content 才回传，summary 原样带回', () => {
    const input = wireInput([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '没有 encrypted，丢弃' },
          { type: 'reasoning', text: '摘要文本', encrypted: 'enc' },
        ],
      },
    ])
    // summary 写死成 [] 会静默丢掉模型上一轮产出的摘要
    expect(input).toEqual([
      {
        type: 'reasoning',
        encrypted_content: 'enc',
        summary: [{ type: 'summary_text', text: '摘要文本' }],
      },
    ])
  })

  it('reasoning 没有摘要文本时 summary 是空数组', () => {
    const input = wireInput([
      { role: 'assistant', parts: [{ type: 'reasoning', text: '', encrypted: 'enc' }] },
    ])
    expect(input[0]?.summary).toEqual([])
  })

  it('thinking=disabled 时不发 reasoning 配置，也不发 include', () => {
    // include 要挂在 reasoning 上：关掉推理还索要 encrypted_content，
    // 是在要一个不会产生的东西，严格的端点会 400
    expect(body({ thinking: 'disabled' })).not.toHaveProperty('reasoning')
    expect(body({ thinking: 'disabled' })).not.toHaveProperty('include')

    expect(body({ thinking: 'adaptive' }).reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body({ reasoningDisplay: 'omitted' }).reasoning).toEqual({
      effort: 'high',
      summary: null,
    })
  })
})

describe('tool_result 带图（web-tools D4）', () => {
  it('带图：output 变 content items，图前文后', () => {
    const input = wireInput([
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
    ])
    expect(input[0]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
        { type: 'input_text', text: '抓到了' },
      ],
    })
  })
})
