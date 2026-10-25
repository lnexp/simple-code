/**
 * 凭据代理的本机端点约定——宿主侧（credential-proxy.ts）与 bin 侧共用，
 * 零依赖（bin 深 import，不拖 barrel）。
 *
 * 端口、token 由宿主写进 process.env，经 schema.ts envPassthrough 进 bash
 * （两处成对，lesson env-passthrough-pair-with-inject）。token 模型可见无妨：
 * 它挡的是本机其他进程与网页对 127.0.0.1 的请求，不是模型。
 */
export const PROXY_PORT_ENV = 'SIMPLE_CODE_PROXY_PORT'
export const PROXY_TOKEN_ENV = 'SIMPLE_CODE_PROXY_TOKEN'
export const PROXY_TOKEN_HEADER = 'x-sc-token'

export type ProxyEndpoint = { url: string; token: string }

/** 某 MCP server 的本机路由。代理不在（env 缺）返回 undefined，bin 报无代理 */
export function mcpProxyEndpoint(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ProxyEndpoint | undefined {
  const port = env[PROXY_PORT_ENV]
  const token = env[PROXY_TOKEN_ENV]
  if (!port || !token) return undefined
  return { url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(name)}`, token }
}
