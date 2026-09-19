/**
 * 错误 cause 链的统一拼法。工具层和 loop 的重试层都要把网络错误讲成人话
 * （undici 的包装深达 4 层，只打最外层等于什么都没说），抽在这共用。
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const chain: string[] = []
  // 深度上限防自引用的 cause 链把这里转死；4 层足够穿透 undici 的包装
  for (let cause = error.cause, depth = 0; cause instanceof Error && depth < 4; depth++) {
    const code = (cause as { code?: unknown }).code
    chain.push(typeof code === 'string' ? `${cause.message} [${code}]` : cause.message)
    cause = cause.cause
  }
  return chain.length === 0 ? error.message : `${error.message}（原因：${chain.join(' ← ')}）`
}
