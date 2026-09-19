/**
 * wire 格式的读取器。JSON.parse 的结果是 unknown，直接当对象用需要断言——
 * 断言会在字段缺失时静默产生 undefined，而协议层最常见的失败恰恰是「网关多发
 * 或少发了一个字段」。这几个函数把断言收敛到一处，缺失时落到显式的兜底值。
 */

export const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

export const asNumber = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Retry-After 的读取顺序：先 ms 精度的私有头，
 * 再标准的 retry-after（秒数或 HTTP-date）。
 */
export function readRetryAfter(headers?: Headers): number | null {
  if (!headers) return null

  const ms = Number(headers.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms > 0) return ms

  const raw = headers.get('retry-after')
  if (!raw) return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000

  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now())
}
