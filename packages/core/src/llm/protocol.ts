import type { LLMEvent, SSEMessage } from './events.ts'
import type { Request } from './types.ts'

export type ProtocolName = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

/** config 解析后交给协议层的东西。协议层不认识 config 的结构 */
export type ProviderContext = {
  baseUrl: string
  apiKey: string
  /**
   * 网关要的额外请求头 / 请求体字段，用户按模型配的，原样透传。
   *
   * 协议层**不解释它们**——里面装的是各网关私有的路由参数
   * （`providerId` 这类），给它们建模就等于把某一家网关的
   * 私有约定刻进协议层。
   */
  headers?: Passthrough
  extraBody?: Passthrough
}

/** 透传字段。只允许标量，理由见 config/schema.ts 的 passthrough */
export type Passthrough = Record<string, string | number | boolean>

/**
 * 协议自己的头 + 用户加的头。**用户的在后，同名时覆盖协议的。**
 *
 * 允许覆盖是有意的：网关要求换一种认证头（比如要 `Authorization` 而不是
 * `x-api-key`）时，不允许覆盖就没法配。风险由工作区黑名单挡住——`headers`
 * 只能写在用户自己的全局配置里，仓库带的那份写了会被剥掉并警告。
 *
 * 键名统一转小写：HTTP 头本来就大小写不敏感，不归一化的话用户写
 * `Authorization`、协议写 `authorization`，两条会同时发出去。
 */
export function mergeHeaders(
  own: Record<string, string>,
  extra?: Passthrough,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(own)) out[key.toLowerCase()] = value
  for (const [key, value] of Object.entries(extra ?? {})) out[key.toLowerCase()] = String(value)
  return out
}

/**
 * 协议自己的 body + 用户加的字段。**用户的在前，协议的覆盖它。**
 *
 * 跟 headers 相反，这里不许覆盖：`model` / `stream` / `messages` 是协议的骨架，
 * 被覆盖之后的现象极难排查——比如 `stream: false` 塞进来，流式读取会一直等到
 * 空闲超时才报错，看起来像网络问题。想换模型改 `model` 字段，不走这条路。
 */
export function mergeBody<T extends object>(own: T, extra?: Passthrough): T & Passthrough {
  return { ...(extra ?? {}), ...own }
}

export type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_overflow'
  | 'doom_loop'
  | 'invalid_request'
  | 'server'
  | 'unknown'

export type ProtocolError = {
  kind: ErrorKind
  /** 给用户看的消息。不含 API key，也不回显请求体 */
  message: string
  retryable: boolean
  /** 来自 Retry-After 或 body 里的提示，单位毫秒 */
  retryAfterMs?: number
}

/**
 * 流中途出现的错误。
 *
 * 不做成一种 LLMEvent：LLMEvent 描述「模型说了什么」，错误不是模型说的。
 * 抛出去由 requestWithRetry 接住做分类重试——它本来就要包住整个流。
 *
 * 教训（design.md §5.2）：流式错误只在 body 里，HTTP 状态码是 200。
 * 只看状态码的重试逻辑会把这种错误当成功。
 */
export class LLMStreamError extends Error {
  // 不用 `constructor(readonly detail: ...)` 那种参数属性：Node 的 strip-only
  // 模式转不了它（那需要生成赋值代码，不只是删类型），CLI 会直接起不来
  readonly detail: ProtocolError

  constructor(detail: ProtocolError) {
    super(detail.message)
    this.name = 'LLMStreamError'
    this.detail = detail
  }
}

export interface Protocol {
  readonly name: ProtocolName

  /**
   * 只描述请求长什么样，不发。发 HTTP 是共用的（重试、超时、abort 都在一处），
   * 这也让协议层能纯函数测试：给一个 Request，断言 body 正确，不碰网络。
   */
  buildRequest(
    req: Request,
    ctx: ProviderContext,
  ): {
    url: string
    headers: Record<string, string>
    body: unknown
  }

  /** 输入是已解析的 SSE message 而不是原始字节——行解析三个协议完全一样 */
  parseStream(raw: AsyncIterable<SSEMessage>): AsyncIterable<LLMEvent>

  parseError(status: number, body: unknown, headers?: Headers): ProtocolError
}
