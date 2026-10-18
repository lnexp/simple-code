import { describe, expect, it } from 'vitest'
import type { LLMEvent } from '../src/llm/events.ts'
import { anthropicMessages } from '../src/llm/protocols/anthropic-messages.ts'
import { parseSSE } from '../src/llm/protocols/utils/sse.ts'
import type { Message, Request, ToolDefinition, Usage } from '../src/llm/types.ts'
import { eventsFromFixture, readFixture, shape } from './helpers.ts'

const FIXTURE = 'anthropic-messages.tool-call.sse'

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
  anthropicMessages.buildRequest(baseRequest(over), {
    baseUrl: 'https://x.test',
    apiKey: 'k',
  }).body as Record<string, unknown>

/** 喂合成的 SSE。fixture 覆盖不到的分支（缓存命中、message_delta 只带输出侧）只能这样测 */
async function feed(events: [string, Record<string, unknown>][]): Promise<LLMEvent[]> {
  const sse = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`)
    .join('')
  async function* once() {
    yield new TextEncoder().encode(sse)
  }
  const out: LLMEvent[] = []
  for await (const llmEv of anthropicMessages.parseStream(parseSSE(once()))) out.push(llmEv)
  return out
}

describe('anthropic-messages / parseStream', () => {
  it('流 EOF 但没收到 message_stop：当断流抛错，不当成功', async () => {
    // 网关超时掐断的表现正是「干净 EOF、无终止事件」。当成功处理的话
    // turn 会静默正常收尾——没有错误、没有落盘、界面什么都不显示
    await expect(
      feed([['message_start', { message: { usage: { input_tokens: 1, output_tokens: 0 } } }]]),
    ).rejects.toMatchObject({ detail: { kind: 'server', retryable: true } })
  })

  it('从录制的 fixture 解出完整事件序列', async () => {
    const events = await eventsFromFixture(anthropicMessages.parseStream, FIXTURE)

    expect(shape(events)).toEqual([
      'message_start',
      'tool_input_start',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_end',
      'finish',
    ])
  })

  it('分片的 JSON 累积成对象——分片确实切在字符串字面量中间', async () => {
    const raw = (await readFixture(FIXTURE)).toString('utf8')
    // 先证明前提：这份 fixture 的分片是 `{"command": / "l / s"}`，
    // 若某次重录变成一整块发出，这个测试就没测到累积逻辑了
    expect(raw).toContain('"partial_json":"\\"l"')

    const events = await eventsFromFixture(anthropicMessages.parseStream, FIXTURE)
    const end = events.find((e) => e.type === 'tool_input_end')
    expect(end).toMatchObject({ name: 'bash', input: { command: 'ls' } })
    expect(end?.type === 'tool_input_end' && end.id).toMatch(/^toolu_/)
  })

  it('stop_reason=tool_use 映射成 tool-calls', async () => {
    const events = await eventsFromFixture(anthropicMessages.parseStream, FIXTURE)
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'tool-calls' })
  })

  it('message_delta 只带输出侧时，不清零输入侧 usage', async () => {
    // 必须用合成 SSE：录制那次的网关在 message_delta 里回了完整 usage
    // （含 input_tokens: 392），拿 fixture 测这条等于测了个空集合——
    // 覆盖式实现也能通过。官方 API 的 message_delta 只有 output_tokens
    const events = await feed([
      ['message_start', { message: { usage: { input_tokens: 392, output_tokens: 16 } } }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 47 } }],
      ['message_stop', {}],
    ])
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    expect(finish.usage.inputTokens).toBe(392)
    expect(finish.usage.outputTokens).toBe(47)
  })

  it('拒答的 stop_details 原样透传到 finish 事件上', async () => {
    // 2026-09-23 实测：Opus 5 的 reasoning_extraction 拒答是 HTTP 200 +
    // 空 content + stop_reason refusal。stop_details 里的 explanation 是
    // 用户能看懂的唯一线索，丢了它这轮就是「模型什么都没说」
    const events = await feed([
      ['message_start', { message: { usage: { input_tokens: 100 } } }],
      [
        'message_delta',
        {
          delta: {
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'reasoning_extraction',
              explanation: 'blocked under commercial terms',
            },
          },
          usage: { output_tokens: 0 },
        },
      ],
      ['message_stop', {}],
    ])
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    expect(finish.reason).toBe('content-filter')
    expect(finish.refusal).toEqual({
      category: 'reasoning_extraction',
      explanation: 'blocked under commercial terms',
    })
  })

  it('非拒答的 stop_reason 不带 refusal 字段', async () => {
    // finish.refusal 是可选字段——协议层只在 content-filter 时给。别的
    // 结束原因带上它的话，消费端会以为拒答了
    const events = await feed([
      ['message_start', { message: { usage: {} } }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
      ['message_stop', {}],
    ])
    const finish = events.at(-1)
    if (finish?.type !== 'finish') throw new Error('最后一个事件应该是 finish')

    expect(finish).not.toHaveProperty('refusal')
  })

  it('未知的 content block 类型整块忽略，不会落进 tool 分支', async () => {
    // redacted_thinking 是安全系统屏蔽推理内容时发的，它没有 id 也没有 name。
    // 写成「不是 text 也不是 thinking 就当 tool_use」的话，会产生一个 id=''
    // 的幽灵 tool call，而且 content_block_stop 认不出它、永远不结算
    const events = await feed([
      ['message_start', { message: { usage: {} } }],
      [
        'content_block_start',
        { index: 0, content_block: { type: 'redacted_thinking', data: 'x' } },
      ],
      [
        'content_block_delta',
        { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      ],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn' } }],
      ['message_stop', {}],
    ])
    expect(shape(events)).toEqual(['message_start', 'finish'])
  })

  it('未知块之后的正常 tool_use 仍然正确', async () => {
    // 对照组：证明上一条不是因为整个流都被吞了
    const events = await feed([
      ['content_block_start', { index: 0, content_block: { type: 'redacted_thinking' } }],
      ['content_block_stop', { index: 0 }],
      [
        'content_block_start',
        { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } },
      ],
      [
        'content_block_delta',
        { index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
      ],
      ['content_block_stop', { index: 1 }],
      ['message_stop', {}],
    ])
    expect(events.find((e) => e.type === 'tool_input_end')).toMatchObject({
      id: 'toolu_1',
      input: { a: 1 },
    })
  })

  it('error 事件抛 LLMStreamError 而不是当成正常结束', async () => {
    const bytes = await readFixture('anthropic-messages.error.sse')
    expect(bytes.toString('utf8')).toContain('"type":"error"') // 前提

    const run = async () => {
      const out = []
      async function* once() {
        yield bytes
      }
      for await (const e of anthropicMessages.parseStream(parseSSE(once()))) out.push(e)
      return out
    }
    await expect(run()).rejects.toThrow('模型不存在')
  })

  it('网关夹在 200 流里的上游错误（type 不认识）→ 可重试；认得出的类型照旧不重试', async () => {
    // 真机原文（runlog 9-18 / 9-29）：网关把上游 502 包成流内 error 事件，
    // type 是 bad_response_status_code / <nil>，原来归 unknown、首次失败即放弃
    const caught = async (error: Record<string, unknown>) => {
      try {
        await feed([['error', { error }]])
      } catch (e) {
        return (e as { detail: { kind: string; retryable: boolean } }).detail
      }
      throw new Error('没抛')
    }
    expect(
      await caught({ type: 'bad_response_status_code', message: '上游服务错误[502]: bad response status code 502' }),
    ).toMatchObject({ kind: 'unknown', retryable: true })
    expect(await caught({ type: '<nil>', message: 'No available accounts: no available accounts' })).toMatchObject({
      retryable: true,
    })
    expect(await caught({ message: 'handshake timed out after 15000ms' })).toMatchObject({ retryable: true })
    // 对照组：流内也能认出的不可恢复错误，不能因为 status=0 就被放行重试
    expect(await caught({ type: 'authentication_error', message: 'bad key' })).toMatchObject({
      kind: 'auth',
      retryable: false,
    })
    expect(await caught({ type: 'invalid_request_error', message: 'model not found' })).toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    })
  })
})

describe('anthropic-messages / usage 的三个输入字段', () => {
  // 实测确证的加法关系（design.md 附录 A）：三者之和 = 完整输入量。
  // 用合成 SSE 而不是 fixture——录到的那次缓存字段全是 0，
  // 拿它测「三个字段各自独立读取」等于测了个空集合
  const startUsage = async (usage: Record<string, number>) => {
    // message_stop 只是满足「流完整结束」的校验，usage 相关断言不依赖它
    const events = await feed([
      ['message_start', { message: { usage } }],
      ['message_stop', {}],
    ])
    const start = events[0]
    if (start?.type !== 'message_start') throw new Error('第一个事件应该是 message_start')
    return start.usage
  }

  const totalInput = (u: Usage) =>
    u.inputTokens + u.cacheCreationInputTokens + u.cacheReadInputTokens

  it('热缓存时三个字段各自读出，不做减法', async () => {
    const usage = await startUsage({
      input_tokens: 29,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 23263,
      output_tokens: 5,
    })
    expect(usage.inputTokens).toBe(29)
    expect(usage.cacheReadInputTokens).toBe(23263)
    // 只读 inputTokens 会把 23292 读成 29——这正是必须三者相加的原因
    expect(totalInput(usage)).toBe(23292)
  })

  it('冷缓存与热缓存的总和一致', async () => {
    const cold = await startUsage({
      input_tokens: 29,
      cache_creation_input_tokens: 23263,
      cache_read_input_tokens: 0,
    })
    const hot = await startUsage({
      input_tokens: 29,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 23263,
    })
    expect(totalInput(cold)).toBe(totalInput(hot))
    // 对照组：总和相等但分布不同，说明确实读的是两个不同字段
    expect(cold.cacheCreationInputTokens).not.toBe(hot.cacheCreationInputTokens)
  })
})

describe('anthropic-messages / buildRequest', () => {
  it('caching 断点放在 system 的最后一个 block', () => {
    expect(body().system).toEqual([
      { type: 'text', text: 'S', cache_control: { type: 'ephemeral' } },
    ])
  })

  it('带 userId 时发 metadata.user_id（官方客户端同款），没有则整个字段不发', () => {
    expect(body({ userId: '{"session_id":"abc"}' }).metadata).toEqual({
      user_id: '{"session_id":"abc"}',
    })
    expect(body().metadata).toBeUndefined()
    expect('metadata' in body()).toBe(false)
  })

  it('tool schema 用 input_schema 而不是 parameters', () => {
    const tools = body({
      tools: [{ name: 'bash', description: 'd', parameters: { type: 'object' } }],
    }).tools
    expect(tools).toEqual([{ name: 'bash', description: 'd', input_schema: { type: 'object' } }])
  })

  it('canonical 的 tool 消息降成 role:user —— Anthropic 没有 tool 角色', () => {
    const messages: Message[] = [
      { role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: {} }] },
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', toolCallId: 't1', output: 'ok', isError: false },
          { type: 'tool_result', toolCallId: 't2', output: 'boom', isError: true },
        ],
      },
    ]
    const wire = body({ messages }).messages as Record<string, unknown>[]

    // role 直传会发出 { role: 'tool' }，Anthropic 400
    expect(wire.map((m) => m.role)).toEqual(['assistant', 'user'])
    // 一条 tool 消息里的多个结果留在同一条 user 消息里，不拆开。
    // 末尾那个 cache_control 是缓存断点——这里用 toEqual 而不是 toMatchObject，
    // 顺带守住"断点只打在最后一个块上"
    expect(wire[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
        {
          type: 'tool_result',
          tool_use_id: 't2',
          content: 'boom',
          is_error: true,
          cache_control: { type: 'ephemeral' },
        },
      ],
    })
  })

  it('历史里的裸串 input 归一成对象——tool_use.input 必须是对象，原样回传必 500', () => {
    // 存量毒：本修复出生前进历史的截断残串。出生侧已堵（tool-stream
    // parseInput），这条锁住回传侧——别处的裸串（手改 jsonl、旧版本
    // 会话）也拦得住
    const messages: Message[] = [
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: '{"command":"ls' }],
      },
    ]
    const wire = body({ messages }).messages as Record<string, any>[]
    const block = wire[0]!.content[0] as Record<string, unknown>
    expect(block.input).toEqual({ _raw: '{"command":"ls' })
  })

  it('assistant 不会被一起降成 user', () => {
    // 对照组：上一条锁住了 tool → user，这条锁住 assistant 不受影响。
    // 少了它的话「role 全写死成 user」也能让上一条通过
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: '问' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '答' }] },
    ]
    const wire = body({ messages }).messages as Record<string, unknown>[]
    expect(wire.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('没有 signature 的 reasoning 整块丢弃，绝不自造', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '想了想' },
          { type: 'reasoning', text: '又想了想', encrypted: 'sig-abc' },
        ],
      },
    ]
    const content = (body({ messages }).messages as { content: unknown[] }[])[0]?.content
    expect(content).toEqual([{ type: 'thinking', thinking: '又想了想', signature: 'sig-abc' }])
  })

  it('thinking=disabled 时不发 display', () => {
    expect(body({ thinking: 'disabled' }).thinking).toEqual({ type: 'disabled' })
    expect(body({ thinking: 'adaptive' }).thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
  })

  it('baseUrl 末尾多余的斜杠不会拼出双斜杠', () => {
    const built = anthropicMessages.buildRequest(baseRequest(), {
      baseUrl: 'https://x.test//',
      apiKey: 'k',
    })
    expect(built.url).toBe('https://x.test/v1/messages')
  })
})

describe('anthropic-messages / 缓存断点', () => {
  const text = (t: string): Message => ({ role: 'user', parts: [{ type: 'text', text: t }] })
  const reply = (t: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text: t }] })

  /** 数一下整个请求里有几个 cache_control，不管藏在哪一层 */
  const countBreakpoints = (over: Partial<Request> = {}): number =>
    JSON.stringify(body(over)).split('"cache_control"').length - 1

  const messagesOf = (over: Partial<Request>) =>
    body(over).messages as { content: Record<string, unknown>[] }[]

  it('断点共两个：system 一个 + 末条消息一个（官方客户端同款）', () => {
    // 更多断点没有额外收益（写入按断点间增量段计价），反而在中转链上
    // 多一个变量。2026-09-28 从「尾 3 条各一个」回退到官方客户端同款单断点
    const many = Array.from({ length: 20 }, (_, i) => text(`第 ${i} 条`))

    expect(countBreakpoints({ messages: many })).toBe(2)
    expect(countBreakpoints({ messages: [text('就一条')] })).toBe(2)
    expect(countBreakpoints({ messages: [text('甲'), text('乙')] })).toBe(2)
  })

  it('cacheTtl=1h：三个断点都带 ttl:1h（tools 末个 + system + 末条消息，同一档，不触发长短混用的顺序规则）', () => {
    const tools = [
      { name: 'bash', description: '跑命令', parameters: { type: 'object' } },
      { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
    ] as ToolDefinition[]
    const b = body({ cacheTtl: '1h', messages: [text('甲'), text('乙')], tools })
    expect(JSON.stringify(b).split('"ttl":"1h"').length - 1).toBe(3)
    expect((b.system as Record<string, unknown>[])[0]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    // 只打最后一个 tool，且网关注入的 5m 会让位
    const wireTools = b.tools as Record<string, unknown>[]
    expect(wireTools[0]).not.toHaveProperty('cache_control')
    expect(wireTools.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(messagesOf({ cacheTtl: '1h', messages: [text('甲')] })[0]?.content[0]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  it('没配 cacheTtl：请求体里不出现 ttl，tools 上也不打标记，跟加这个功能之前逐字节一致', () => {
    const tools = [
      { name: 'bash', description: '跑命令', parameters: { type: 'object' } },
    ] as ToolDefinition[]
    const b = body({ messages: [text('甲'), text('乙')], tools })
    expect(JSON.stringify(b)).not.toContain('"ttl"')
    expect((b.tools as Record<string, unknown>[]).at(-1)).not.toHaveProperty('cache_control')
    expect(countBreakpoints({ messages: [text('甲'), text('乙')] })).toBe(2)
  })

  it('末消息带图：断点落在 text 上，不打在 image 上（2026-10-16 修复）', () => {
    // 1h 断点打在末尾 image 上会触发上游自动缓存的回退路径，混档 400
    const withImage: Message[] = [
      text('甲'),
      {
        role: 'user',
        parts: [
          { type: 'text', text: '看下这张截图' },
          { type: 'image', mimeType: 'image/png', data: 'QUJD' },
        ],
      },
    ]
    const b = body({ cacheTtl: '1h', messages: withImage })
    const last = (b.messages as { content: Record<string, unknown>[] }[]).at(-1)
    expect(last?.content[0]).toMatchObject({ type: 'text', cache_control: { ttl: '1h' } })
    expect(last?.content[1]).toMatchObject({ type: 'image' })
    expect(last?.content[1]).not.toHaveProperty('cache_control')
  })

  it('末消息纯图：不打消息断点（只剩 system 一个），不硬塞到 image 上', () => {
    const onlyImage: Message[] = [
      text('甲'),
      {
        role: 'user',
        parts: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }],
      },
    ]
    expect(countBreakpoints({ messages: onlyImage })).toBe(1)
  })

  it('断点只落在末条消息上，其余一个都没有', () => {
    const wire = messagesOf({
      messages: [text('旧一'), text('旧二'), text('旧三'), text('新')],
    })

    expect(wire[0]?.content[0]).not.toHaveProperty('cache_control')
    expect(wire[1]?.content[0]).not.toHaveProperty('cache_control')
    expect(wire[2]?.content[0]).not.toHaveProperty('cache_control')
    expect(wire[3]?.content[0]).toHaveProperty('cache_control')
  })

  it('末条断点随消息追加前移（真 API 靠 20 块回看找上一请求的条目）', () => {
    const prev = [text('问一'), reply('答一'), text('问二')]
    const prevWire = messagesOf({ messages: prev })
    expect(prevWire[2]?.content[0]).toHaveProperty('cache_control')

    const next = [...prev, reply('答二'), text('问三')]
    const nextWire = messagesOf({ messages: next })
    // 上一请求的末条（index 2）不再带断点——命中交给官方回看
    expect(nextWire[2]?.content[0]).not.toHaveProperty('cache_control')
    expect(nextWire[4]?.content[0]).toHaveProperty('cache_control')
    expect(nextWire[3]?.content[0]).not.toHaveProperty('cache_control')
  })

  it('最后一条消息以 thinking 结尾时，断点往前挪到能打的块上', () => {
    // thinking 块不能直接打 cache_control，是官方明列的例外，打上去会 400
    const withThinking: Message = {
      role: 'assistant',
      parts: [
        { type: 'text', text: '我想想' },
        { type: 'reasoning', text: '推理', encrypted: 'sig' },
      ],
    }
    const wire = messagesOf({ messages: [withThinking] })

    // 前提：thinking 块确实在、确实排在最后，不然这条测的是别的东西
    expect(wire[0]?.content[1]).toMatchObject({ type: 'thinking' })
    expect(wire[0]?.content[1]).not.toHaveProperty('cache_control')
    expect(wire[0]?.content[0]).toHaveProperty('cache_control')
  })

  it('整条消息都是 thinking 时不打，也不崩', () => {
    const onlyThinking: Message = {
      role: 'assistant',
      parts: [{ type: 'reasoning', text: '推理', encrypted: 'sig' }],
    }

    expect(countBreakpoints({ messages: [onlyThinking] })).toBe(1) // 只剩 system 那个
  })

  it('没有消息时不崩', () => {
    expect(countBreakpoints({ messages: [] })).toBe(1)
  })
})

describe('anthropic-messages / parseError', () => {
  const err = (status: number, type: string, message = 'm', headers?: Headers) =>
    anthropicMessages.parseError(status, { error: { type, message } }, headers)

  it('429 可重试，401 不可重试', () => {
    expect(err(429, 'rate_limit_error')).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(err(401, 'authentication_error')).toMatchObject({ kind: 'auth', retryable: false })
    expect(err(529, 'overloaded_error')).toMatchObject({ kind: 'server', retryable: true })
  })

  it('context overflow 认文案而不是类型——它的类型也是 invalid_request_error', () => {
    const overflow = err(400, 'invalid_request_error', 'prompt is too long: 250000 tokens')
    expect(overflow.kind).toBe('context_overflow')
    expect(overflow.retryable).toBe(false)

    // 对照组：同样是 invalid_request_error，文案不匹配时不能误判成 overflow
    expect(err(400, 'invalid_request_error', 'model not found').kind).toBe('invalid_request')
  })

  it('retry-after-ms 优先于 retry-after', () => {
    const h = new Headers({ 'retry-after-ms': '1500', 'retry-after': '60' })
    expect(err(429, 'rate_limit_error', 'm', h).retryAfterMs).toBe(1500)
    expect(
      err(429, 'rate_limit_error', 'm', new Headers({ 'retry-after': '2' })).retryAfterMs,
    ).toBe(2000)
  })

  it('没有 Retry-After 时不产生 retryAfterMs 字段', () => {
    expect(err(429, 'rate_limit_error')).not.toHaveProperty('retryAfterMs')
  })
})

describe('tool_result 带图（web-tools D4）', () => {
  const img = { type: 'image' as const, data: 'QUJD', mimeType: 'image/png' }
  const withImages = [
    {
      role: 'tool' as const,
      parts: [
        {
          type: 'tool_result' as const,
          toolCallId: 'call_1',
          output: '抓到了',
          isError: false,
          images: [img],
        },
      ],
    },
  ]

  it('带图：content 变 blocks，图前文后', () => {
    const messages = body({ messages: withImages }).messages as Array<{
      role: string
      content: unknown
    }>
    expect(messages[0]?.role).toBe('user')
    // 最后一条消息会带 cache_control 断点（withCacheBreakpoint），与本用例无关
    expect(messages[0]?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
          },
          { type: 'text', text: '抓到了' },
        ],
        is_error: false,
      }),
    ])
  })

  it('纯文本：content 保持 string——wire 形状不无谓变化', () => {
    const messages = body({
      messages: [
        {
          role: 'tool' as const,
          parts: [
            { type: 'tool_result' as const, toolCallId: 'call_1', output: 'ok', isError: false },
          ],
        },
      ],
    }).messages as Array<{ content: Array<{ type: string; content: unknown }> }>
    const block = messages[0]?.content[0]
    expect(block?.type).toBe('tool_result')
    expect(block?.content).toBe('ok')
  })
})
