import type { LLMEvent } from '../llm/events.ts'
import { LLMStreamError, type ProtocolError } from '../llm/protocol.ts'
import { logRun } from '../runlog.ts'
import { describeError } from '../tools/describe.ts'

export type RetryConfig = {
  maxAttempts: number
  initialDelayMs: number
  backoffFactor: number
  maxDelayMs: number
}

/**
 * 重试层比协议层多产生一种东西：`restart`。
 *
 * 它不属于 LLMEvent——LLMEvent 只描述「模型说了什么」，重放不是模型说的
 * （跟 tool_result 被挡在外面是同一条理由）。所以在这里单独扩一个联合，
 * 而不是往 LLMEvent 里塞。
 */
export type StreamEvent = LLMEvent | { type: 'restart' }

/**
 * 分类重试，包住整个流。
 *
 * **流已经吐过事件之后再重试，必须先发 restart。** 请求是整个重发的
 * （design.md §5.2，续传在协议层就没有支持），所以第二次会把已经吐过的
 * 文本再吐一遍。消费方收到 restart 就丢掉本轮攒的半截 assistant 消息，
 * 不然用户会看到重复的段落，而且历史里会存下一条内容翻倍的消息。
 *
 * 这种重复不会报错，只会行为不对——正是最容易漏的一类。
 */
export async function* requestWithRetry(
  attempt: (signal: AbortSignal) => AsyncIterable<LLMEvent>,
  config: RetryConfig,
  signal: AbortSignal,
  /** 运行日志用：重试行里带上模型名和目录。不传就不带 */
  meta?: { model?: string; folder?: string },
): AsyncIterable<StreamEvent> {
  for (let tries = 0; ; tries++) {
    let emitted = false
    try {
      for await (const llmEv of attempt(signal)) {
        emitted = true
        yield llmEv
      }
      return
    } catch (error) {
      signal.throwIfAborted() // 用户中断不是失败，不重试也不改写
      const detail = classify(error)
      if (!detail.retryable || tries + 1 >= config.maxAttempts) {
        logRun({
        ev: 'llm_retry_giveup',
        ...(meta?.model ? { model: meta.model } : {}),
        ...(meta?.folder ? { folder: meta.folder } : {}),
          attempt: tries + 1,
          error: { kind: detail.kind, message: detail.message },
        })
        throw new LLMStreamError(detail)
      }
      const waitMs = delayFor(tries, detail, config)
      logRun({
        ev: 'llm_retry',
        ...(meta?.model ? { model: meta.model } : {}),
        ...(meta?.folder ? { folder: meta.folder } : {}),
        attempt: tries + 1,
        waitMs,
        error: { kind: detail.kind, message: detail.message },
      })
      await sleep(waitMs, signal)
      if (emitted) yield { type: 'restart' }
    }
  }
}

/**
 * 协议层分不清的那些错误在这里补。
 *
 * fetch 的网络错误是 `TypeError`，跟代码里真正的 TypeError 长得一模一样——
 * 只能靠「不是 LLMStreamError」这个否定条件兜住，宁可多重试一次也不能把
 * 网络抖动当成不可重试的致命错误。
 */
function classify(error: unknown): ProtocolError {
  if (error instanceof LLMStreamError) return error.detail
  return {
    kind: 'server',
    message: describeError(error),
    retryable: true,
  }
}

/**
 * 把 `cause` 链一起拼进消息。
 *
 * undici 的网络错误一律是 `TypeError: fetch failed`——**这五个字不含任何
 * 信息**，DNS 挂了、连接被重置、响应头超时、TLS 握手失败，抛出来长得一模
 * 一样。真正的原因全在 `cause` 里（`ECONNRESET` / `UND_ERR_HEADERS_TIMEOUT`
 * / `ENOTFOUND`），而这三种的处置完全不同。
 *
 * 2026-09-03 就栽在这里：用户报「fetch failed」，重试稳定复现，排掉网络、
 * 排掉体积之后仍然只有这五个字，等于没有任何线索。
 *
 * 只改文案不改分类——网络错误该重试还是重试。
 */

/**
 * Retry-After 优先于退避——服务端知道的比我们多。
 *
 * 抖动 0.9~1.1：不加的话所有失败的客户端会在同一毫秒重发，
 * 把刚缓过来的服务端再打死一次。
 */
function delayFor(tries: number, detail: ProtocolError, config: RetryConfig): number {
  if (detail.retryAfterMs !== undefined) return Math.min(detail.retryAfterMs, config.maxDelayMs)
  const backoff = config.initialDelayMs * config.backoffFactor ** tries
  return Math.min(backoff, config.maxDelayMs) * (0.9 + Math.random() * 0.2)
}

/** 等待期间用户按了中断要立刻醒来——否则最长要多等 maxDelayMs 才响应 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
