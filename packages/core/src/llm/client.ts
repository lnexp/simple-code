import { isContentEvent, type LLMEvent, type RefusalDetail, type SSEMessage } from './events.ts'
import {
  LLMStreamError,
  type Protocol,
  type ProtocolError,
  type ProviderContext,
} from './protocol.ts'
import { parseSSE } from './protocols/utils/sse.ts'
import { logRun } from '../runlog.ts'
import { saveRefusalSnapshot } from './refusal-snapshot.ts'
import { describeError } from '../tools/describe.ts'
import type { FinishReason, Request } from './types.ts'

export type SendOptions = {
  protocol: Protocol
  provider: ProviderContext
  signal: AbortSignal
  fetchImpl?: typeof fetch
  /**
   * 两个数据块之间的最大间隔。不传就没有超时——测试和 fixture 回放
   * 走这条路（喂完就结束，本来也挂不住）。
   */
  idleTimeoutMs?: number
  /** 运行日志里的来源标记：主对话不传，内部请求传 'summary' / 'merge' / 'vision-relay' */
  tag?: string
  /** 运行日志里的目录标识（多根并行时区分是谁在请求）。完整路径，不猜 basename */
  folder?: string
}

/**
 * 唯一发 HTTP 的地方。协议层只描述请求长什么样，发送、超时、abort 收在这里
 * ——重试逻辑（loop/retry.ts）才有一个明确的包裹点。
 */
export async function* sendRequest(
  request: Request,
  options: SendOptions,
): AsyncIterable<LLMEvent> {
  // 检查原信号，不能等 idle clock 换成新信号后再交给 fetch。
  options.signal.throwIfAborted()
  const { url, headers, body } = options.protocol.buildRequest(request, options.provider)
  const bodyText = JSON.stringify(body)
  const doFetch = options.fetchImpl ?? fetch
  const startedAt = Date.now()
  /** 流自然走完才算成功；消费者提前 break（少见）单独标记 */
  let completed = false
  let finishReason: FinishReason | undefined
  let refusal: RefusalDetail | undefined
  let sawContent = false
  let failure: { kind: string; message: string } | undefined
  let tap: StreamTap | undefined

  // 卡点日志（定位宿主同步卡死用，2026-09-21）：**冻住的进程写不了日志**，
  // 所以检查点全部写在「即将进入的阶段」之前——runlog 里最后一条 ev 就是
  // 卡住的那段。词表：llm_req（fetch 前）→ llm_resp（响应头已到，流阶段）
  // → llm（完成，finally 里）。loop 侧另有 tool_run/tool_img 补齐工具段
  logRun({
    ev: 'llm_req',
    model: request.model,
    ...(options.folder ? { folder: options.folder } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    // 网关路由参数（providerId 这类）：同一模型走哪个渠道，只有它分得清
    // （9-30 一次断流，三个同模型渠道在日志里无从区分）
    ...(options.provider.extraBody ? { extra: options.provider.extraBody } : {}),
  })
  // 计时器盖住 fetch 和读流两段。fetch 那段也要盖：连上了但响应头一直不来
  // 同样是挂住，而且现象一模一样（进程不动，没有任何输出）
  const clock = startIdleClock(options.idleTimeoutMs, options.signal)
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers,
      body: bodyText,
      signal: clock.signal,
    })

    if (!response.ok) {
      const raw = await safeText(response)
      const detail = options.protocol.parseError(response.status, safeParse(raw), response.headers)
      throw new LLMStreamError(withRawBody(detail, response.status, raw, options.provider.apiKey))
    }
    if (!response.body) {
      throw new LLMStreamError(emptyBodyError(response.status))
    }

    logRun({
      ev: 'llm_resp',
      model: request.model,
      ...(options.folder ? { folder: options.folder } : {}),
      ...(options.tag ? { tag: options.tag } : {}),
    })
    tap = tapSSE(parseSSE(clock.watch(response.body)))
    const events = options.protocol.parseStream(tap.messages)
    for await (const ev of events) {
      // 重置放在**内容层**（每产出一个真实事件），不放在字节层：网关心跳
      // （SSE 注释行 / ping 事件）也是字节但不是内容，按字节重置等于被
      // 心跳无限续命——某项目曾因此挂 12 分钟（2026-09-21）
      clock.touch()
      if (ev.type === 'finish') {
        finishReason = ev.reason
        refusal = ev.refusal
      }
      sawContent ||= isContentEvent(ev)
      yield ev
    }
    completed = true
  } catch (error) {
    // abort 的原因有两个，**必须分开**：用户中断不该重试（retry.ts:44 靠
    // throwIfAborted 挡掉），空闲超时该重试。两者都表现为 AbortError，
    // 光看异常类型分不出来，所以问计时器自己有没有开火
    if (clock.firedIdle) {
      failure = { kind: 'server', message: `idle ${options.idleTimeoutMs ?? 0}ms` }
      throw new LLMStreamError(idleTimeoutError(options.idleTimeoutMs ?? 0))
    }
    if (options.signal.aborted) {
      failure = { kind: 'aborted', message: 'user interrupt' }
      throw error
    }
    failure =
      error instanceof LLMStreamError
        ? { kind: error.detail.kind, message: error.detail.message }
        : { kind: 'network', message: describeError(error) }
    throw error
  } finally {
    clock.stop()
    const ms = Date.now() - startedAt
    const refusalLog = finishReason === 'content-filter'
      ? await saveRefusalSnapshot({
          ...(options.folder ? { folder: options.folder } : {}),
          ...(options.tag ? { tag: options.tag } : {}), model: request.model,
          protocol: options.protocol.name, provider: options.provider,
          body: bodyText, startedAt, ...(refusal ? { refusal } : {}),
        })
      : {}
    // 每次尝试一行（重试 3 次就是 3 行）。中断（用户 abort）不计失败——
    // 那不是模型的问题，kind 记 'aborted' 便于区分
    const incomplete = !failure && !completed
    // 走完了却零内容：retry.ts 会在外层抛错重试，但这一层看它是成功的。
    // 10-09 某后端项目 14 次空响应没留下收到了什么，分不清「网关真空」与
    // 「解析器丢了不认识的块」——带上 stream 统计才能区分
    const empty = completed && !sawContent
    logRun({
      ev: 'llm',
      model: request.model,
      ...(options.folder ? { folder: options.folder } : {}),
      ...(options.tag ? { tag: options.tag } : {}),
      ms,
      // 结束原因（stop/length/tool-calls/…）。查「为什么被截断」以前只能翻
      // turns 归档按续写指令原文整条匹配，现在一行 llm 就有
      ...(finishReason ? { finish: finishReason } : {}),
      ...refusalLog,
      ...(failure ? { error: failure } : {}),
      ...(incomplete ? { incomplete: true } : {}),
      ...(empty ? { empty: true } : {}),
      // 失败/未走完时带上收到了什么：协议层对不认识的事件静默丢弃，报错只剩
      // 「未收到结束标记」——9-30 网关去掉 event: 行，就是靠抓原始流才看出来
      ...((failure || incomplete || empty) && tap ? { stream: tap.summary() } : {}),
    })
  }
}

type StreamTap = {
  messages: AsyncIterable<SSEMessage>
  /** 条数、按类型计数、最后一条 data 的前 300 字 */
  summary(): { count: number; types: Record<string, number>; last: string }
}

/**
 * 旁路统计 SSE 消息，只透传不改。类型名取 event: 行，没有就取 data 里的
 * type/object（Responses 与 Chat 的区分字段），都没有记 '?'。
 * 只在失败/零内容时进日志——成功的流不记内容（runlog 只记元数据）
 */
function tapSSE(source: AsyncIterable<SSEMessage>): StreamTap {
  let count = 0
  let last = ''
  const types: Record<string, number> = {}
  return {
    messages: (async function* () {
      for await (const msg of source) {
        count++
        last = msg.data
        const key = msg.event || sseDataType(msg.data)
        types[key] = (types[key] ?? 0) + 1
        yield msg
      }
    })(),
    summary: () => ({ count, types, last: last.slice(0, 300) }),
  }
}

function sseDataType(data: string): string {
  if (data === '[DONE]') return '[DONE]'
  try {
    const o: unknown = JSON.parse(data)
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>
      if (typeof r.type === 'string') return r.type
      if (typeof r.object === 'string') return r.object
    }
  } catch {
    // 不是 JSON：照样计数，归 '?'
  }
  return '?'
}

type IdleClock = {
  /** 传给 fetch 和用来中止读流。没配超时的话就是原来那个 signal */
  signal: AbortSignal
  /** 包住字节流，只透传不重置——重置在 touch（内容层） */
  watch(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array>
  /** 内容层重置：每产出一个真实 LLMEvent 调一次。心跳（注释行/ping）在
   * SSE 或协议层就被丢掉，够不到这里——这正是按内容不按字节的点 */
  touch(): void
  /** 已经因为空闲而开火了吗——用来把它和用户中断区分开 */
  readonly firedIdle: boolean
  stop(): void
}

/**
 * 空闲计时器。**口径是「两块内容之间的间隔」，不是「请求总时长」**——
 * 每产出一个真实 LLMEvent（touch）重置一次。曾经按字节（chunk）重置，
 * 被网关心跳续命成无限挂死（2026-09-21 修）。
 *
 * 总时长上限会误杀慢慢吐十分钟的长回答；空闲超时只在真的不动了时触发。
 */
function startIdleClock(timeoutMs: number | undefined, outer: AbortSignal): IdleClock {
  if (timeoutMs === undefined) {
    return { signal: outer, watch: readAll, touch: () => {}, firedIdle: false, stop: () => {} }
  }

  const controller = new AbortController()
  let fired = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const onOuterAbort = () => controller.abort(outer.reason)
  outer.addEventListener('abort', onOuterAbort, { once: true })

  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      fired = true
      controller.abort()
    }, timeoutMs)
  }
  arm()

  return {
    signal: controller.signal,
    watch: async function* (body) {
      const reader = body.getReader()
      try {
        for (;;) {
          // **不能只 await reader.read()。** abort 一个 AbortController 不会
          // 中止已经拿在手里的 reader 的 pending read——真实 fetch 的 body
          // 恰好和 signal 绑定所以看着像生效，但那是 fetch 实现的行为，
          // 流挂住时我们要自己醒来。踩过：三条测试直接跑到 vitest 超时
          const { done, value } = await Promise.race([reader.read(), abortsAsRejection(controller)])
          if (done) return
          if (value) yield value
        }
      } finally {
        // cancel 而不是 releaseLock：超时时底层连接还开着，不 cancel 就漏一条
        await reader.cancel().catch(() => {})
      }
    },
    // fetch 阶段（响应头之前）没有事件可 touch，靠创建时的初始 arm 覆盖：
    // 头一直不来就是「第一个内容永远不来」，到点开火
    touch: arm,
    get firedIdle() {
      return fired
    },
    stop: () => {
      clearTimeout(timer)
      outer.removeEventListener('abort', onOuterAbort)
    },
  }
}

/** 变成一个 abort 时 reject 的 promise，好跟 read 竞速 */
function abortsAsRejection(controller: AbortController): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = controller.signal
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    })
  })
}

/** 不带超时时的透传。ReadableStream 本身就是 AsyncIterable，但类型上不是 */
async function* readAll(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const idleTimeoutError = (ms: number): ProtocolError => ({
  kind: 'server',
  message: `模型响应停了 ${Math.round(ms / 1000)} 秒没有新内容，已中止本次请求`,
  // 可重试。挂起大多是网关抽风，重发一次通常就好了——不像截断：那个重发必然再次截断，这个不会
  retryable: true,
})

/**
 * 错误响应体可能不是 JSON（网关的 HTML 错误页、空 body）。解析失败就交个空对象，
 * 让 parseError 落到按状态码分类——在这里抛异常会把真正的错误信息盖掉
 */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * 协议取不到 message、兜底成「HTTP n」时附上响应体原文（折叠空白、前 200 字、
 * key 打码）——2026-09-30 某渠道连续 429 只剩「HTTP 429」，看不出网关说了什么。
 * 这条 message 同时进界面错误条与 runlog 的 llm/llm_retry 行
 */
function withRawBody(detail: ProtocolError, status: number, raw: string, key: string): ProtocolError {
  const text = raw.replace(/\s+/g, ' ').trim()
  if (detail.message !== `HTTP ${status}` || text === '') return detail
  const safe = key ? text.split(key).join('***') : text
  return { ...detail, message: `HTTP ${status}：${safe.slice(0, 200)}` }
}

const emptyBodyError = (status: number): ProtocolError => ({
  kind: 'server',
  message: `HTTP ${status} 响应没有 body，无法读取流`,
  retryable: true,
})
