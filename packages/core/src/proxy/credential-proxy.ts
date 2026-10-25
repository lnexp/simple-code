import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expandEnvTemplate } from '../config/env.ts'
import { MCP_CONFIG_PATH } from '../config/load.ts'
import { describeError } from '../tools/describe.ts'
import { isHttpServer, type McpServers } from '../tools/mcp.ts'
import { PROXY_PORT_ENV, PROXY_TOKEN_ENV, PROXY_TOKEN_HEADER } from './endpoint.ts'
import { firstRoute, imageRoutes, loadImageModel } from './image-route.ts'
import { loadWebsearchConfig, websearchRoutes } from './websearch-route.ts'

/**
 * 凭据代理（docs/proposals/credential-proxy.md）：密钥只留在宿主进程，bin 经
 * 127.0.0.1 访问，代理按**写死在配置里**的路由换上真实头、转发到固定上游。
 *
 * 目的地绑定是这个方案成立的前提：bin 只能说「走哪条路由」，不能说「发到
 * 哪」——否则模型让代理把带真 key 的请求发到任意地址，等于外送。先例：
 * CX codex-responses-api-proxy（只转发固定路径，其余 403）、network-proxy
 * credential_broker（按域名绑定注入）；本机桥形态同 lsp-bridge.ts。
 */

/**
 * 一条路由解析出的上游。headers 已展开、键名小写。body：钉死的 JSON 字段，
 * 覆盖调用方给的同名字段（生图的 model 由配置定，bin 选不了）
 */
export type ProxyRoute = { url: string; headers: Record<string, string>; body?: Record<string, unknown> }
/** 路径+方法 → 上游。undefined = 不在路由表（403）；抛错 = 配置错（500，消息只含变量名） */
export type RouteResolver = (path: string, method: string) => Promise<ProxyRoute | undefined>
type Log = (ev: Record<string, unknown>) => void
export type CredentialProxyOptions = { token: string; resolve: RouteResolver; log?: Log }

/** MCP Streamable HTTP 只用这三个方法 */
const METHODS = new Set(['GET', 'POST', 'DELETE'])
/** 入站不转发：逐跳头、长度/压缩交给 fetch 重算，以及任何调用方自带的凭据 */
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'content-length', 'accept-encoding', 'authorization', 'cookie', PROXY_TOKEN_HEADER,
])
/** 出站不回传：fetch 已解压，原长度/编码头会让客户端按错的格式读 */
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'])

export function createCredentialProxy(opts: CredentialProxyOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, opts)
  })
}

function tokenOk(got: string | string[] | undefined, want: string): boolean {
  if (typeof got !== 'string' || got.length !== want.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

function reject(res: ServerResponse, status: number, message: string): number {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`凭据代理：${message}\n`)
  return status
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  // 拷成独立 Uint8Array：Buffer 的 ArrayBufferLike 类型 fetch 的 BodyInit 不认
  return new Uint8Array(Buffer.concat(chunks))
}

/** 把路由钉死的字段叠进调用方的 JSON 体。不是 JSON 对象就抛（转 400） */
function pinBody(raw: Uint8Array<ArrayBuffer>, pinned: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  const parsed: unknown = JSON.parse(Buffer.from(raw).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体须是 JSON 对象')
  return new Uint8Array(Buffer.from(JSON.stringify({ ...parsed, ...pinned })))
}

/** 入站头去掉 DROP_REQUEST 与将要注入的同名头，再叠上路由的头 */
export function forwardHeaders(incoming: IncomingHttpHeaders, inject: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || DROP_REQUEST.has(key) || Object.hasOwn(inject, key)) continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return { ...out, ...inject }
}

/** 上游响应原样流式回写（MCP 会回 SSE，不能整包缓冲）。返回回写字节数 */
async function pipeResponse(upstream: Response, res: ServerResponse): Promise<number> {
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE.has(key)) headers[key] = value
  })
  res.writeHead(upstream.status, headers)
  let bytes = 0
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      bytes += chunk.byteLength
      res.write(chunk)
    }
  }
  res.end()
  return bytes
}

async function forward(req: IncomingMessage, res: ServerResponse, route: ProxyRoute): Promise<[number, number]> {
  let body = req.method === 'POST' ? await readBody(req) : undefined
  if (body && route.body) {
    try {
      body = pinBody(body, route.body)
    } catch (e) {
      return [reject(res, 400, `请求体不合法：${describeError(e)}`), 0]
    }
  }
  // bin 断开（超时/被杀）就停掉上游请求；正常结束后触发 abort 无副作用
  const ac = new AbortController()
  res.on('close', () => ac.abort())
  let upstream: Response
  try {
    upstream = await fetch(route.url, {
      method: req.method ?? 'GET',
      headers: forwardHeaders(req.headers, route.headers),
      ...(body ? { body } : {}),
      signal: ac.signal,
    })
  } catch (e) {
    return [reject(res, 502, `上游连不上：${describeError(e)}`), 0]
  }
  try {
    return [upstream.status, await pipeResponse(upstream, res)]
  } catch {
    res.destroy() // 头已发出，只能断开让客户端报错
    return [upstream.status, -1]
  }
}

/**
 * 只记出错的请求：一次 MCP 调用 4 个请求（initialize/initialized/GET 探测/
 * 调用），正常时全记是噪声。GET 405 是 SDK 每次都探测的推送通道、远端不支持
 * 的常态，也不记（2026-10-23 用户定）
 */
function worthLogging(method: string | undefined, status: number): boolean {
  if (status >= 200 && status < 300) return false
  return !(method === 'GET' && status === 405)
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: CredentialProxyOptions): Promise<void> {
  const started = Date.now()
  const path = (req.url ?? '/').split('?')[0] ?? '/'
  const log = (status: number, bytes = 0): void => {
    if (worthLogging(req.method, status))
      opts.log?.({ ev: 'proxy_req', path, method: req.method, status, ms: Date.now() - started, bytes })
  }
  if (!tokenOk(req.headers[PROXY_TOKEN_HEADER], opts.token)) return log(reject(res, 401, 'token 缺失或不对'))
  if (!METHODS.has(req.method ?? '')) return log(reject(res, 403, `不允许的方法 ${req.method ?? ''}`))
  let route: ProxyRoute | undefined
  try {
    route = await opts.resolve(path, req.method ?? '')
  } catch (e) {
    return log(reject(res, 500, describeError(e)))
  }
  if (!route) return log(reject(res, 403, `没有这条路由：${path}`))
  const [status, bytes] = await forward(req, res, route)
  log(status, bytes)
}

/** mcp.json 读不到 = 没配置；JSON 坏了要响（不能静默当成没有路由） */
async function readMcpServers(path: string): Promise<McpServers> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  try {
    return (JSON.parse(text) as { servers?: McpServers }).servers ?? {}
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON：${describeError(e)}`)
  }
}

/**
 * `/mcp/<server>` → mcp.json 里该 server 的 url 与 headers。每次请求现读，
 * 改了 mcp.json 不用 reload。stdio 型与未配置的 server 都不在路由表
 */
export function mcpRoutes(read: () => Promise<McpServers>, env: NodeJS.ProcessEnv = process.env): RouteResolver {
  return async (path) => {
    const m = /^\/mcp\/([^/]+)$/.exec(path)
    if (!m?.[1]) return undefined
    const name = decodeURIComponent(m[1])
    const servers = await read()
    const cfg = Object.hasOwn(servers, name) ? servers[name] : undefined
    if (!cfg || !isHttpServer(cfg)) return undefined
    const headers = Object.fromEntries(
      Object.entries(cfg.headers ?? {}).map(([k, v]) => [k.toLowerCase(), expandEnvTemplate(v, env)]),
    )
    return { url: cfg.url, headers }
  }
}

/** 宿主启动入口：随机端口 + 随机 token，写进 process.env 供 bash 透传 */
export async function startCredentialProxy(log?: Log): Promise<Server> {
  const token = randomBytes(24).toString('hex')
  const server = createCredentialProxy({
    token,
    resolve: firstRoute(
      mcpRoutes(() => readMcpServers(MCP_CONFIG_PATH)),
      imageRoutes(loadImageModel),
      websearchRoutes(loadWebsearchConfig),
    ),
    ...(log ? { log } : {}),
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  process.env[PROXY_PORT_ENV] = String((server.address() as AddressInfo).port)
  process.env[PROXY_TOKEN_ENV] = token
  return server
}
