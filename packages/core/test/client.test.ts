import { describe, expect, it, vi } from 'vitest'
import { sendRequest } from '../src/llm/client.ts'
import type { LLMEvent } from '../src/llm/events.ts'
import { LLMStreamError, type Protocol } from '../src/llm/protocol.ts'
import { resolveProtocol } from '../src/llm/registry.ts'
import type { Request } from '../src/llm/types.ts'

const KEY = 'sk-SENTINEL-9f3a'
const PROVIDER = { baseUrl: 'https://example.invalid/v1', apiKey: KEY }

const REQ: Request = {
  model: 'test-model',
  system: '你是个助手',
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  maxTokens: 1024,
  thinking: 'disabled',
  effort: 'high',
  reasoningDisplay: 'omitted',
}

const bodyOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

const ANTHROPIC_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

type Call = { url: string; init: RequestInit }

function stubFetch(response: Response): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return response
  }) as unknown as typeof fetch
  return { impl, calls }
}

const drain = async (stream: AsyncIterable<LLMEvent>): Promise<LLMEvent[]> => {
  const out: LLMEvent[] = []
  for await (const llmEv of stream) out.push(llmEv)
  return out
}

const send = (protocol: Protocol, response: Response) => {
  const { impl, calls } = stubFetch(response)
  const stream = sendRequest(REQ, {
    protocol,
    provider: PROVIDER,
    signal: new AbortController().signal,
    fetchImpl: impl,
  })
  return { stream, calls }
}

describe('sendRequest', () => {
  it('把 SSE 流交给协议解析，产出 LLMEvent', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream } = send(protocol, new Response(bodyOf(ANTHROPIC_SSE), { status: 200 }))

    const events = await drain(stream)

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'text_start',
      'text_delta',
      'text_end',
      'finish',
    ])
  })

  it('URL、method、body 来自协议的 buildRequest', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream, calls } = send(protocol, new Response(bodyOf(ANTHROPIC_SSE), { status: 200 }))
    await drain(stream)

    const expected = protocol.buildRequest(REQ, PROVIDER)
    expect(calls[0]?.url).toBe(expected.url)
    expect(calls[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(expected.body)
  })

  it('API key 只进 header，绝不进 body', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream, calls } = send(protocol, new Response(bodyOf(ANTHROPIC_SSE), { status: 200 }))
    await drain(stream)

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(Object.values(headers).join(' ')).toContain(KEY) // 前提：key 确实传出去了
    expect(String(calls[0]?.init.body)).not.toContain(KEY)
  })

  it('三个协议走同一条发送路径', async () => {
    for (const name of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const) {
      const protocol = resolveProtocol(name)
      const { calls, stream } = send(protocol, new Response(bodyOf(''), { status: 200 }))
      // 空 body 没有终止事件，带断流校验的协议会抛——本用例只验
      // URL/method 走同一条路径，流内容不参与断言
      await drain(stream).catch(() => undefined)

      expect(calls[0]?.url).toBe(protocol.buildRequest(REQ, PROVIDER).url)
    }
  })
})

describe('错误响应', () => {
  it('非 2xx 交给协议分类，抛 LLMStreamError', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream } = send(
      protocol,
      new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429,
        headers: { 'retry-after': '3' },
      }),
    )

    await expect(drain(stream)).rejects.toMatchObject({
      name: 'LLMStreamError',
      detail: { kind: 'rate_limit', retryable: true, retryAfterMs: 3_000 },
    })
  })

  it('错误体不是 JSON 时不崩，落回按状态码分类', async () => {
    // 网关挂了会返回 HTML 错误页。在这里 throw 会把真正的错误信息盖掉
    const protocol = resolveProtocol('anthropic-messages')
    const { stream } = send(protocol, new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    await expect(drain(stream)).rejects.toMatchObject({
      detail: { kind: 'server', retryable: true },
    })
  })

  // 2026-09-30 某渠道连续 429 只剩「HTTP 429」——body 不是 JSON，safeJson 回 {}
  // 把原文丢了，看不出网关说了什么。兜底文案时附原文（折叠空白、前 200 字）
  it('兜底成「HTTP n」时附上响应体原文：折叠空白、截 200 字、key 打码', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const body = `<html>\n  <body>Too   Many Requests key=${KEY}</body></html>` + 'x'.repeat(300)
    const { stream } = send(protocol, new Response(body, { status: 429 }))
    const error = await drain(stream).catch((e: LLMStreamError) => e)
    const msg = (error as LLMStreamError).detail.message
    expect(msg.startsWith('HTTP 429：<html> <body>Too Many Requests key=***</body></html>x')).toBe(true)
    expect(msg).not.toContain(KEY)
    expect(msg.length).toBeLessThanOrEqual('HTTP 429：'.length + 201)
    expect((error as LLMStreamError).detail.kind).toBe('rate_limit')
  })

  it('协议取到了 message 就不附原文；空 body 也不附', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const ok = send(protocol, new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 }))
    await expect(drain(ok.stream)).rejects.toMatchObject({ detail: { message: 'slow down' } })
    const empty = send(protocol, new Response('', { status: 503 }))
    await expect(drain(empty.stream)).rejects.toMatchObject({ detail: { message: 'HTTP 503' } })
  })

  it('200 但没有 body 时报可重试错误，而不是当成空回复', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream } = send(protocol, new Response(null, { status: 200 }))

    await expect(drain(stream)).rejects.toBeInstanceOf(LLMStreamError)
    await expect(
      drain(send(protocol, new Response(null, { status: 200 })).stream),
    ).rejects.toMatchObject({ detail: { retryable: true } })
  })

  it('错误消息里不含 API key', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream } = send(
      protocol,
      new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }),
    )

    await expect(drain(stream)).rejects.toSatisfy(
      (error: LLMStreamError) => !error.detail.message.includes(KEY),
    )
  })
})

/**
 * 一个受控的 SSE 流：`push` 手动喂一块，`finish` 关掉。
 * 不喂就永远不动——这正是要测的那个形状（连上了，但不再吐字节）
 */
function controllableBody(): {
  body: ReadableStream<Uint8Array>
  push(text: string): void
  finish(): void
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  return {
    body,
    push: (text) => ctrl.enqueue(new TextEncoder().encode(text)),
    finish: () => ctrl.close(),
  }
}

const MESSAGE_START =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
const TEXT_DELTA =
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n'
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

const sendWithIdle = (
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  signal?: AbortSignal,
) =>
  sendRequest(REQ, {
    protocol: resolveProtocol('anthropic-messages'),
    provider: PROVIDER,
    signal: signal ?? new AbortController().signal,
    idleTimeoutMs,
    fetchImpl: stubFetch(new Response(body, { status: 200 })).impl,
  })

/**
 * **真实踩到的 bug**：bash 工具跑完之后，loop 发下一个请求，那个请求再也没
 * 回来，进程要手动 kill。查下来 client.ts 的注释写着「超时收在这里」但代码
 * 里一个计时器都没有——只有用户中断的 signal。
 */
describe('流空闲超时', () => {
  it('连上了但不再吐字节 —— 中止并报可重试错误', async () => {
    const { body, push } = controllableBody()
    const stream = sendWithIdle(body, 60)
    push(MESSAGE_START) // 前提：流确实活过，不是一开始就死的
    // 之后不喂也不关，模拟网关挂起

    await expect(drain(stream)).rejects.toMatchObject({
      detail: { retryable: true },
    })
  })

  it('对照组：持续有数据就不能被杀 —— 计时器是「空闲」不是「总时长」', async () => {
    // 没有这条的话，「无条件超时」和「按总时长超时」两种错误实现都能让
    // 上一条全绿。这里总耗时（4×40=160ms）远超 60ms 的空闲上限，
    // 但每次间隔都只有 40ms，正确的实现一次都不该开火
    const { body, push, finish } = controllableBody()
    const stream = sendWithIdle(body, 60)

    const feeding = (async () => {
      push(MESSAGE_START)
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 40))
        push(TEXT_DELTA)
      }
      push(MESSAGE_STOP)
      finish()
    })()

    const events = await drain(stream)
    await feeding
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(3)
  })

  it('SSE 注释行（网关心跳）不再给空闲钟续命 —— 按内容不按字节', async () => {
    // 2026-09-21 实锤：watch 按字节重置，而本网关的心跳是注释行
    // （: gateway-keepalive）——字节在流、内容不来，空闲钟永远不开火
    const { body, push } = controllableBody()
    const stream = sendWithIdle(body, 60)
    push(MESSAGE_START)
    // 心跳持续跳（30ms 一条，跳 900ms）：修复前注释行也是字节，钟被无限
    // 续命；修复后 60ms 无内容就该开火
    const heartbeats = (async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 30))
        try {
          push(': gateway-keepalive\n\n')
        } catch {
          return // 流已被超时中止：再 enqueue 会抛 ERR_INVALID_STATE
        }
      }
    })()
    let rejected = false
    drain(stream).catch(() => {
      rejected = true
    })
    await new Promise((r) => setTimeout(r, 200))
    // 200ms 时心跳仍在跳（还剩 700ms）：60ms 空闲必须早已开火
    expect(rejected).toBe(true)
    void heartbeats
  })

  it('Anthropic 的 ping 事件不是内容 —— 也不续命', async () => {
    // 心跳的第二种形态：协议层的事件（event: ping），anthropic-messages
    // 把它丢了不产 LLMEvent——touch 放在 LLMEvent 层就不会被它续命
    const { body, push } = controllableBody()
    const stream = sendWithIdle(body, 60)
    push(MESSAGE_START)
    const pings = (async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 30))
        try {
          push('event: ping\ndata: {"type":"ping"}\n\n')
        } catch {
          return // 流已被超时中止：再 enqueue 会抛 ERR_INVALID_STATE
        }
      }
    })()
    let rejected = false
    drain(stream).catch(() => {
      rejected = true
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(rejected).toBe(true)
    void pings
  })

  it('响应头一直不来也算挂 —— 计时器要盖住 fetch 那段', async () => {
    // 只包读流的话，「连上了但响应头不来」这种挂法漏网，现象一模一样
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })) as unknown as typeof fetch

    const stream = sendRequest(REQ, {
      protocol: resolveProtocol('anthropic-messages'),
      provider: PROVIDER,
      signal: new AbortController().signal,
      idleTimeoutMs: 60,
      fetchImpl: hangingFetch,
    })

    await expect(drain(stream)).rejects.toMatchObject({ detail: { retryable: true } })
  })

  it('用户中断不能被当成超时 —— 那会被重试，中断就白按了', async () => {
    // 两者都表现为 AbortError，光看异常类型分不出来。分错的后果是
    // 用户按了中断，loop 却当成网络抖动重发一遍
    const { body, push } = controllableBody()
    const outer = new AbortController()
    const stream = sendWithIdle(body, 5_000, outer.signal)
    push(MESSAGE_START)

    const drained = drain(stream)
    outer.abort(new Error('用户中断'))

    // 不是 LLMStreamError（那是「可重试」的形状），原样抛出去让 retry.ts
    // 的 throwIfAborted 处理
    await expect(drained).rejects.not.toBeInstanceOf(LLMStreamError)
  })

  it('不配 idleTimeoutMs 就没有超时 —— 正常流照旧跑通', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const { stream } = send(protocol, new Response(bodyOf(ANTHROPIC_SSE), { status: 200 }))

    expect((await drain(stream)).map((e) => e.type)).toContain('finish')
  })

  it('超时消息里不含 API key', async () => {
    const { body, push } = controllableBody()
    const stream = sendWithIdle(body, 60)
    push(MESSAGE_START)

    await expect(drain(stream)).rejects.toSatisfy(
      (error: LLMStreamError) => !error.detail.message.includes(KEY),
    )
  })
})

describe('运行日志（2026-09-30 补观测）', () => {
  const capture = async (run: () => Promise<unknown>) => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      await run().catch(() => {})
    } finally {
      spy.mockRestore()
    }
    return calls
  }

  it('流没走完就断：llm 行带上收到的事件计数与最后一条 data', async () => {
    // 9-30 真机形态：没有 event: 行，只有 data.type，且断在结束标记之前
    const sse =
      'data: {"type":"response.created","response":{}}\n\n' +
      'data: {"type":"response.in_progress","response":{}}\n\n' +
      'data: {"type":"response.in_progress","response":{}}\n\n'
    const protocol = resolveProtocol('openai-responses')
    const calls = await capture(() => drain(send(protocol, new Response(bodyOf(sse), { status: 200 })).stream))
    const llm = calls.find((c) => c.ev === 'llm')
    expect(llm?.error).toBeDefined()
    expect(llm?.stream).toEqual({
      count: 3,
      types: { 'response.created': 1, 'response.in_progress': 2 },
      last: '{"type":"response.in_progress","response":{}}',
    })
  })

  it('对照组：成功的流不记 stream（不落内容）', async () => {
    const protocol = resolveProtocol('anthropic-messages')
    const calls = await capture(() => drain(send(protocol, new Response(bodyOf(ANTHROPIC_SSE), { status: 200 })).stream))
    const llm = calls.find((c) => c.ev === 'llm')
    expect(llm).toBeDefined()
    expect(llm?.error).toBeUndefined()
    expect(llm?.stream).toBeUndefined()
  })

  it('llm_req 记网关路由参数（extraBody）', async () => {
    const calls = await capture(() =>
      drain(
        sendRequest(REQ, {
          protocol: resolveProtocol('anthropic-messages'),
          provider: { ...PROVIDER, extraBody: { providerId: 97 } },
          signal: new AbortController().signal,
          fetchImpl: stubFetch(new Response(bodyOf(ANTHROPIC_SSE), { status: 200 })).impl,
        }),
      ),
    )
    expect(calls.find((c) => c.ev === 'llm_req')?.extra).toEqual({ providerId: 97 })
  })
})
