/**
 * 本机 LLM 代理（方案 C 的产品化宿主，2026-09-25 拍板）：伴生扩展（UI kind，
 * 跑在用户自己的电脑上）监听 127.0.0.1:LLM_PROXY_PORT，Remote-SSH 时远端
 * exthost 的模型请求经 ssh RemoteForward 隧道回到这里，由它带真 key 转发给
 * 服务商——key 与网络只在本机。
 *
 * 与 launchd 版 llm-proxy.mjs（老用户自装）的关系：同一个端口先到先得，
 * 这里被占（EADDRINUSE）就静默让位，转发交给已存在的那个。
 *
 * 多上游用**前缀路由**：settings 端点给远端的 providers.baseUrl 全部指向
 * `http://127.0.0.1:<port>/sc-p/<provider 名>`，转发时按前缀还原到各自
 * 真实的 baseUrl 和 apiKey——launchd 版「一个端口一个上游」在多服务商
 * 用户（不同 provider 不同 host）下不成立，这是产品版与它的唯一语义差。
 *
 * 本模块**不 import vscode**（接线纪律）：settings 读取、fetch、日志全注入。
 */

import { createServer, type Server } from 'node:http'
import { LLM_PROXY_PORT } from '@simple-code/core/src/remote.ts'
import { expandEnv } from '@simple-code/core/src/config/env.ts'

/** 远端扩展拉配置的只读端点（主扩展 remote.ts 的 syncRemoteSettings 对接这里） */
export const SETTINGS_PATH = '/simplecode/settings'

/** 前缀路由：/sc-p/<provider 名>/<真实路径> */
const ROUTE = /^\/sc-p\/([^/]+)(\/.*)?$/

/** settings 端点白名单带出的段。mcp/bash 不带——里面是本机命令和真实凭据，
 * 端点挂在远端 localhost 上对远端任何本地进程开放（泄露面实测抓到过），
 * 远端也没有那些本机路径 */
const WHITELIST = ['provider', 'model', 'request', 'memory', 'visionModel'] as const

export type ProviderConn = { baseUrl: string; apiKey?: string } & Record<string, unknown>

/** 本机 settings.json 的形状——这里只关心 providers 的连接字段，完整校验在
 * 远端 loadConfig 做（拉到的配置最终从远端的 loadConfig 过一遍） */
export type LocalSettings = { providers?: Record<string, ProviderConn> } & Record<string, unknown>

/**
 * settings 端点的负载：白名单段 + providers 改指前缀路由口、apiKey 换假值。
 * 真 key 只在本机进程里，转发路径上认证头一律替换。
 */
export function remoteSettingsPayload(raw: LocalSettings, port: number): Record<string, unknown> {
  const providers: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(raw.providers ?? {}))
    providers[name] = {
      ...v,
      baseUrl: `http://127.0.0.1:${port}/sc-p/${encodeURIComponent(name)}`,
      apiKey: 'via-local-proxy',
    }
  const pick: Record<string, unknown> = {}
  for (const k of WHITELIST) if (raw[k] !== undefined) pick[k] = raw[k]
  return { ...pick, providers }
}

export type ProxyDeps = {
  /** 读本机 settings.json；抛错 = 端点 500 / 转发 502 */
  readSettings: () => LocalSettings
  fetchImpl?: typeof fetch
  log?: (entry: Record<string, unknown>) => void
}

export function createProxyServer(deps: ProxyDeps): Server {
  const fetchImpl = deps.fetchImpl ?? fetch
  const log = deps.log ?? (() => {})
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === SETTINGS_PATH) {
      try {
        // localPort 是这条连接真正落在的监听口（经隧道进来也是它）——
        // 测试里 listen(0) 拿临时口也能对上
        const raw = deps.readSettings()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(remoteSettingsPayload(raw, req.socket.localPort ?? LLM_PROXY_PORT)))
        log({ path: req.url, status: 200 })
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `读本机 settings.json 失败: ${err(e)}` }))
        log({ path: req.url, status: 500 })
      }
      return
    }
    const route = ROUTE.exec(req.url ?? '')
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `不是 SimpleCode 的转发路径（${SETTINGS_PATH} 或 /sc-p/<provider>/…）` }))
      return
    }
    const name = decodeURIComponent(route[1] ?? '')
    const rest = route[2] ?? '/'
    let provider: ProviderConn | undefined
    try {
      provider = deps.readSettings().providers?.[name]
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `读本机 settings.json 失败: ${err(e)}` }))
      log({ path: req.url, status: 502 })
      return
    }
    if (!provider) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `provider "${name}" 不在本机 settings.json 里` }))
      log({ path: req.url, status: 404 })
      return
    }
    // 认证头一律替换：远端配的是假 key，真 key 只在这里展开（${VAR} 引用
    // 与 core loadConfig 同款语义：整值引用、缺失即报错、绝不回显值）
    let key: string
    try {
      key = provider.apiKey ? expandEnv(provider.apiKey) : ''
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err(e) }))
      log({ path: req.url, status: 502, provider: name })
      return
    }
    if (!key) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `provider "${name}" 没配 apiKey，转发会带着空 key 吃 401——先在本机 settings.json 里配好` }))
      log({ path: req.url, status: 502, provider: name })
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const headers = { ...req.headers }
    delete headers.host
    delete headers['x-api-key']
    delete headers.authorization
    headers['x-api-key'] = key
    headers.authorization = `Bearer ${key}`
    const url = provider.baseUrl.replace(/\/+$/, '') + rest
    try {
      // headers 是 IncomingHttpHeaders（值可为数组）——fetch 只收单值，请求头
      // 里数组值本就不存在于 HTTP 语义，收窄成 Record<string, string>
      // req.method 的类型是 string | undefined——HTTP 请求必有方法，兜 GET
      const init: RequestInit = { method: req.method ?? 'GET', headers: headers as Record<string, string> }
      if (body) init.body = body
      const up = await fetchImpl(url, init)
      res.writeHead(up.status, Object.fromEntries(up.headers))
      if (up.body) {
        // SSE 流式：读一块转一块，模型 token 逐个到达
        const reader = up.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
      log({ method: req.method, path: req.url, status: up.status })
    } catch (e) {
      log({ method: req.method, path: req.url, error: err(e) })
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `伴生代理转发失败: ${err(e)}` }))
    }
  })
}

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e))
