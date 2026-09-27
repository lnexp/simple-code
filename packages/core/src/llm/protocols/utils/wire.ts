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
 * tool_call 的 input 归一成对象。非对象（截断残串 / 合法 JSON 但整体是
 * 字符串或数组）包成 { _raw: 原文 }——裸串能过工具层（校验给散文报错、
 * 模型自修正），但进历史后回传 API 必 500：Anthropic 的 tool_use.input
 * 必须是对象，OpenAI 的 arguments 必须是可 parse 成对象的 JSON。历史里
 * 一旦住进裸串，每次回传必炸、重试带同一颗毒、会话死锁到手动修数据
 * （2026-09-27 test 工作区实案：max_tokens=4000 把 SVG bash 参数拦腰
 * 截断）。出生侧（tool-stream）与回传侧（两个 adapter）共用这一把闸。
 */
export const asToolInput = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : { _raw: typeof v === 'string' ? v : JSON.stringify(v) }

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
