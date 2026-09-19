import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { ProtocolName } from '../src/llm/protocol.ts'
import { getSession } from '../src/session/session.ts'
import { readFixture } from './helpers.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-9f3a'

/**
 * 三个协议各一份真实录制的 SSE。**用 fixture 而不是手写事件**：真实分片会切在
 * JSON 字符串字面量中间，手写的想不到那种切法（CLAUDE.md §6.2）
 */
const CASES: { protocol: ProtocolName; fixture: string }[] = [
  { protocol: 'anthropic-messages', fixture: 'anthropic-messages.tool-call.sse' },
  { protocol: 'openai-chat', fixture: 'openai-chat.tool-call.sse' },
  { protocol: 'openai-responses', fixture: 'openai-responses.tool-call.sse' },
]

const bodyOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      // 一次一小块，逼真一点：分片边界本来就落在任意位置
      for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.subarray(i, i + 64))
      controller.close()
    },
  })

/** 第一轮回放 fixture，之后的轮次返回一句「做完了」，免得无限循环 */
function replayThenStop(protocol: ProtocolName, bytes: Uint8Array) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const done = doneSse(protocol)

  const impl = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers })
    const payload = calls.length === 1 ? bytes : new TextEncoder().encode(done)
    return new Response(bodyOf(payload), { status: 200 })
  }) as unknown as typeof fetch

  return { impl, calls }
}

/**
 * 各协议「说一句话就结束」的最小 SSE。收尾轮用。
 *
 * 三份都必须真的带文本：空 parts 的 assistant 消息会被 normalize 丢掉
 * （那是对的——空消息发回去有的服务端直接 400），于是断言历史里少一条，
 * 现象是「第二轮明明发了请求却没结果」
 */
function doneSse(protocol: ProtocolName): string {
  if (protocol === 'anthropic-messages') {
    return [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"做完了"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n')
  }
  if (protocol === 'openai-chat') {
    return [
      'data: {"choices":[{"delta":{"content":"做完了"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
  }
  return [
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"做完了"}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message"}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
    '',
    '',
  ].join('\n')
}

async function workspace(protocol: ProtocolName, extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-e2e-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(
    globalPath,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      providers: {
        p: {
          protocol,
          baseUrl: 'https://example.invalid',
          apiKey: '${TEST_KEY}',
          models: { m: { contextWindow: 100_000 } },
        },
      },
      // 关掉 step 跑完的自动摘要（§9.7 修正二）：本文件数的是「这一轮发了
      // 几个请求」，混进来的摘要请求会让 calls 多出来，看着像 loop 多跑了一轮
      memory: { idleSummarizeDelayMs: 0 },
      ...extra,
    }),
    'utf8',
  )
  return { dir, globalPath }
}

describe('同一段 loop 在三种协议下都能跑', () => {
  for (const { protocol, fixture } of CASES) {
    it(`${protocol}：真实 SSE → 执行 bash → 回填历史`, async () => {
      const bytes = await readFixture(fixture)
      const { dir, globalPath } = await workspace(protocol)
      const { impl, calls } = replayThenStop(protocol, bytes)

      const session = await getSession(dir, {
        globalPath,
        env: { TEST_KEY: KEY },
        skipLock: true,
        fetchImpl: impl,
      })

      const events: AgentEvent[] = []
      for await (const ev of session.send('列出当前目录')) events.push(ev)
      await session.close()

      // 前提：这份 fixture 确实产生了工具调用，否则下面全是空断言
      const toolCalls = events.filter((e) => e.type === 'tool_call')
      expect(toolCalls.length).toBeGreaterThan(0)

      // bash 真的跑了，结果回填成 role:'tool' 消息
      const toolMsg = session.messages().find((m) => m.role === 'tool')
      expect(toolMsg?.parts[0]).toMatchObject({ type: 'tool_result', isError: false })

      // 跑完之后又发了一轮（把结果给模型看）
      expect(calls.length).toBe(2)
      const roles = session.messages().map((m) => m.role)
      expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant'])

      // 三个协议的收尾轮 wire 格式完全不同，落到 canonical 是同一个形状
      expect(session.messages().at(-1)?.parts).toEqual([{ type: 'text', text: '做完了' }])
    })
  }

  it('三个协议的 URL 与鉴权头各不相同，但 loop 代码是同一份', async () => {
    const urls = new Set<string>()
    for (const { protocol, fixture } of CASES) {
      const bytes = await readFixture(fixture)
      const { dir, globalPath } = await workspace(protocol)
      const { impl, calls } = replayThenStop(protocol, bytes)
      const session = await getSession(dir, {
        globalPath,
        env: { TEST_KEY: KEY },
        skipLock: true,
        fetchImpl: impl,
      })
      for await (const _ev of session.send('列出当前目录')) {
        // 消费完
      }
      await session.close()

      urls.add(calls[0]?.url ?? '')
      // API key 只进 header，绝不进 body
      expect(JSON.stringify(calls[0]?.headers)).toContain(KEY)
      expect(JSON.stringify(calls[0]?.body)).not.toContain(KEY)
    }
    expect(urls.size).toBe(3)
  })
})

// ---------------------------------------------------------------- 异常路径

const sseResponse = (text: string) =>
  new Response(bodyOf(new TextEncoder().encode(text)), { status: 200 })

const errorResponse = (status: number, type: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: 'boom' } }), {
    status,
    headers,
  })

/**
 * 吐一半合法 SSE 然后把连接拉断。真实世界的流中断就长这样。
 *
 * 必须用 pull 分两次：`enqueue` 之后立刻 `error()` 会把还在队列里的分片一起
 * 丢掉，消费方一个字节都读不到——那测的就不是「吐了一半才断」了
 */
const truncated = (text: string) => {
  let sent = false
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent) return controller.error(new Error('socket hang up'))
        sent = true
        controller.enqueue(new TextEncoder().encode(text))
      },
    }),
    { status: 200 },
  )
}

/** 按顺序回应，用完最后一个之后一直重复它 */
function sequence(replies: (() => Response)[]) {
  const calls: unknown[] = []
  const impl = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    const at = calls.length
    calls.push(JSON.parse(String(init?.body)))
    return (replies[at] ?? replies[replies.length - 1])?.()
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** 退避默认 2 秒，测试里得压到 1 毫秒，不然一条用例要跑几秒 */
const FAST_RETRY = { loop: { retry: { initialDelayMs: 1, maxAttempts: 3 } } }

const openWith = async (impl: typeof fetch) => {
  const { dir, globalPath } = await workspace('anthropic-messages', FAST_RETRY)
  return getSession(dir, { globalPath, env: { TEST_KEY: KEY }, skipLock: true, fetchImpl: impl })
}

describe('端到端异常路径', () => {
  it('429 之后重试，重试成功就当无事发生', async () => {
    const bytes = await readFixture('anthropic-messages.tool-call.sse')
    const { impl, calls } = sequence([
      () => errorResponse(429, 'rate_limit_error', { 'retry-after-ms': '1' }),
      () => sseResponse(new TextDecoder().decode(bytes)),
      () => sseResponse(doneSse('anthropic-messages')),
    ])
    const session = await openWith(impl)

    const events: AgentEvent[] = []
    for await (const ev of session.send('列出当前目录')) events.push(ev)
    await session.close()

    // 429 那次不算一轮：3 次 HTTP，但对话只走了 2 轮
    expect(calls.length).toBe(3)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(session.messages().map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  it('对照组：400 不重试，错误作为 error 事件出来', async () => {
    // 没有这条的话，上一条通过也可能只是因为「什么都重试」——
    // 那样 400 会被重试 3 次，用户等 3 倍时间看同一个错
    const { impl, calls } = sequence([() => errorResponse(400, 'invalid_request_error')])
    const session = await openWith(impl)

    const events: AgentEvent[] = []
    for await (const ev of session.send('hi')) events.push(ev)
    await session.close()

    expect(calls.length).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })

  it('流吐到一半断掉：重发并发 restart，半截内容不留在历史里', async () => {
    const half = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我正在"}}',
      '',
      // 断在 content_block_stop **之后**：这个块已经落进 parts 了。断在块中间的话
      // 内容还停在未闭合的暂存里，restart 清不清空都看不出差别
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      '',
    ].join('\n')
    const { impl, calls } = sequence([
      () => truncated(half),
      () => sseResponse(doneSse('anthropic-messages')),
    ])
    const session = await openWith(impl)

    const events: AgentEvent[] = []
    for await (const ev of session.send('hi')) events.push(ev)
    await session.close()

    // 前提：断之前真的吐出去了内容，否则 restart 根本不该发，这条测的是空集合
    const before = events.findIndex((e) => e.type === 'restart')
    expect(events.slice(0, before)).toContainEqual({ type: 'text_delta', text: '我正在' })

    expect(calls.length).toBe(2)
    // 「我正在」必须消失：留着的话模型看到自己说过半句没说完的话
    expect(session.messages().at(-1)?.parts).toEqual([{ type: 'text', text: '做完了' }])
  })
})
