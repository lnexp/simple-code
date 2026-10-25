/**
 * 工作区配置的黑名单。
 *
 * `.simple-code/settings.json` **来自仓库内容**——clone 一个仓库，它可能自带
 * 一份：
 *
 * > Project-local config comes from repository contents, so it should not get
 * > to choose where a user's credentials are sent or which local commands are run.
 *
 * 路径用 `.` 分段，`*` 匹配一层任意键。
 */
const DENYLIST = [
  'provider', // 可指向一个被下面手段污染的 provider
  'model',
  'claudeAgentSdkPath', // 本地代码执行路径，不允许仓库选择
  'providers.*.models.*.claudeAgentSdk',
  'providers.*.models.*.presets.*.claudeAgentSdk',
  'providers.*.baseUrl', // 恶意仓库可把请求连同 key 指向自己的服务器
  'providers.*.apiKey',
  // 任意请求头注入，跟 baseUrl 同级的危险：加一个自己的 Authorization 或代理
  // 相关的头，就能把请求连同 key 送去别处，而用户看不出任何异常
  'providers.*.models.*.headers',
  // 任意请求体注入。覆盖不了协议自己的字段（mergeBody 挡着），但仍能塞进
  // 网关认识的路由参数，把请求导到另一个后端
  'providers.*.models.*.extraBody',
  'bash.envPassthrough', // 可以把 API key 加回白名单，绕过 §12 的裁剪
  'bash.sandbox', // 将来有沙箱时，不能让仓库自己关掉
] as const

export type StripResult = {
  value: unknown
  /** 被剥掉的字段路径。调用方负责 warn——静默剥离会让用户困惑半天 */
  stripped: string[]
}

/**
 * 剥掉黑名单字段。**必须在合并之前做**：合并后就分不清某个 baseUrl
 * 是全局来的还是工作区来的了。
 */
export function stripDenied(raw: unknown): StripResult {
  if (!isPlainObject(raw)) return { value: raw, stripped: [] }

  const stripped: string[] = []
  const value = structuredClone(raw)
  for (const pattern of DENYLIST) {
    removeByPattern(value, pattern.split('.'), [], stripped)
  }
  return { value, stripped }
}

function removeByPattern(
  node: unknown,
  pattern: string[],
  visited: string[],
  stripped: string[],
): void {
  const [head, ...rest] = pattern
  if (head === undefined || !isPlainObject(node)) return

  const keys = head === '*' ? Object.keys(node) : head in node ? [head] : []
  for (const key of keys) {
    if (rest.length === 0) {
      delete node[key]
      stripped.push([...visited, key].join('.'))
    } else {
      removeByPattern(node[key], rest, [...visited, key], stripped)
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 工作区覆盖全局。数组整体替换，不做逐项合并——合并数组的语义没人说得清 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override
  }
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value
  }
  return out
}
