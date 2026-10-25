import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, test } from 'vitest'
import { expandEnvTemplate } from '../src/config/env.ts'
import { createCredentialProxy, mcpRoutes, type RouteResolver } from '../src/proxy/credential-proxy.ts'
import { mcpProxyEndpoint } from '../src/proxy/endpoint.ts'
import { firstRoute, imageRoutes } from '../src/proxy/image-route.ts'
import { websearchRoutes } from '../src/proxy/websearch-route.ts'
import type { WebsearchConfig } from '../src/tools/websearch.ts'
import { callMcpTool, listMcpTools, McpNoProxyError, type McpServers } from '../src/tools/mcp.ts'

const TOKEN = 't'.repeat(48)
const open: Server[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function listen(server: Server): Promise<number> {
  open.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return (server.address() as AddressInfo).port
}

/** 假上游：记下收到的请求，回一段分两块写出的 SSE */
type Seen = { url: string | undefined; headers: IncomingHttpHeaders; body: string }
async function fakeUpstream(): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const port = await listen(createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's-1' })
      res.write('data: one\n\n')
      setTimeout(() => res.end('data: two\n\n'), 20)
    })
  }))
  return { url: `http://127.0.0.1:${port}/llm/mcp?mcp=serp-search`, seen }
}

async function startProxy(resolve: RouteResolver, logs: Record<string, unknown>[] = []): Promise<string> {
  const port = await listen(createCredentialProxy({ token: TOKEN, resolve, log: (ev) => logs.push(ev) }))
  return `http://127.0.0.1:${port}`
}

describe('expandEnvTemplate', () => {
  test('内插多个变量，缺变量报错只说名字', () => {
    expect(expandEnvTemplate('Bearer ${A}-${B}', { A: 'x', B: 'y' })).toBe('Bearer x-y')
    expect(expandEnvTemplate('plain', {})).toBe('plain')
    expect(() => expandEnvTemplate('Bearer ${NOPE}', {})).toThrow(/环境变量 NOPE/)
  })
})

describe('凭据代理：拦截', () => {
  const route: RouteResolver = async (p) => (p === '/mcp/a' ? { url: 'http://127.0.0.1:9/x', headers: {} } : undefined)

  test('无 token / 错 token → 401', async () => {
    const base = await startProxy(route)
    expect((await fetch(`${base}/mcp/a`, { method: 'POST' })).status).toBe(401)
    const wrong = await fetch(`${base}/mcp/a`, { method: 'POST', headers: { 'x-sc-token': 'x'.repeat(48) } })
    expect(wrong.status).toBe(401)
  })

  test('不在路由表 → 403；方法不对 → 403', async () => {
    const base = await startProxy(route)
    const h = { 'x-sc-token': TOKEN }
    expect((await fetch(`${base}/mcp/other`, { method: 'POST', headers: h })).status).toBe(403)
    expect((await fetch(`${base}/mcp/a`, { method: 'PUT', headers: h })).status).toBe(403)
  })

  test('配置错 → 500，消息不含值', async () => {
    const base = await startProxy(mcpRoutes(async () => ({ a: { url: 'http://x', headers: { authorization: 'Bearer ${NOPE_KEY}' } } }), {}))
    const res = await fetch(`${base}/mcp/a`, { method: 'POST', headers: { 'x-sc-token': TOKEN } })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('NOPE_KEY')
  })

  test('上游连不上 → 502', async () => {
    const base = await startProxy(route)
    const res = await fetch(`${base}/mcp/a`, { method: 'POST', headers: { 'x-sc-token': TOKEN }, body: '{}' })
    expect(res.status).toBe(502)
  })
})

describe('凭据代理：转发', () => {
  test('注入配置头、剥掉调用方凭据与 token，上游 URL 原样，SSE 流式回传', async () => {
    const up = await fakeUpstream()
    const servers: McpServers = { serp: { url: up.url, headers: { Authorization: 'Bearer ${K}' } } }
    const logs: Record<string, unknown>[] = []
    const base = await startProxy(mcpRoutes(async () => servers, { K: 'real-key' }), logs)
    const res = await fetch(`${base}/mcp/serp?evil=1`, {
      method: 'POST',
      headers: { 'x-sc-token': TOKEN, authorization: 'Bearer fake', 'content-type': 'application/json', 'mcp-session-id': 's-0' },
      body: '{"jsonrpc":"2.0"}',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBe('s-1')
    expect(await res.text()).toBe('data: one\n\ndata: two\n\n')
    const got = up.seen[0]
    expect(got?.url).toBe('/llm/mcp?mcp=serp-search')
    expect(got?.headers.authorization).toBe('Bearer real-key')
    expect(got?.headers['x-sc-token']).toBeUndefined()
    expect(got?.headers['mcp-session-id']).toBe('s-0')
    expect(got?.body).toBe('{"jsonrpc":"2.0"}')
    // 2xx 不记（每次 MCP 调用 4 个请求，正常时全是噪声）
    expect(logs).toEqual([])
  })

  test('日志只记非 2xx，排除 GET 405（SDK 每次都探测推送通道）；不含密钥', async () => {
    const port = await listen(createServer((req, res) => {
      res.writeHead(req.method === 'GET' ? 405 : 500).end()
    }))
    const servers: McpServers = { s: { url: `http://127.0.0.1:${port}/`, headers: { authorization: 'Bearer ${K}' } } }
    const logs: Record<string, unknown>[] = []
    const base = await startProxy(mcpRoutes(async () => servers, { K: 'real-key' }), logs)
    const h = { 'x-sc-token': TOKEN }
    expect((await fetch(`${base}/mcp/s`, { headers: h })).status).toBe(405)
    expect((await fetch(`${base}/mcp/s`, { method: 'POST', headers: h, body: '{}' })).status).toBe(500)
    expect((await fetch(`${base}/mcp/s`, { method: 'POST' })).status).toBe(401)
    expect(logs.map((l) => [l.method, l.status])).toEqual([['POST', 500], ['POST', 401]])
    expect(JSON.stringify(logs)).not.toContain('real-key')
  })

  test('stdio 型与原型链名字不进路由表', async () => {
    const resolve = mcpRoutes(async () => ({ local: { command: 'node' } }), {})
    expect(await resolve('/mcp/local', 'POST')).toBeUndefined()
    expect(await resolve('/mcp/constructor', 'POST')).toBeUndefined()
    expect(await resolve('/other', 'POST')).toBeUndefined()
  })
})

/** 真 MCP server（Streamable HTTP，无状态），要求带上代理注入的头 */
async function fakeMcpHttp(): Promise<string> {
  const port = await listen(createServer(async (req, res) => {
    if (req.headers['x-api-key'] !== 'k-123') {
      res.writeHead(401).end('no key')
      return
    }
    const s = new McpServer({ name: 'fake-http', version: '0.0.0' }, { capabilities: { tools: {} } })
    s.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'echo', description: '回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    }))
    s.setRequestHandler(CallToolRequestSchema, (r) => ({
      content: [{ type: 'text', text: `echo: ${String(r.params.arguments?.text)}` }],
    }))
    // 无状态模式（sessionIdGenerator 缺省）；SDK 类型在 exactOptionalPropertyTypes 下要绕一下
    const t = new StreamableHTTPServerTransport({} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
    await s.connect(t as unknown as Transport)
    await t.handleRequest(req, res)
  }))
  return `http://127.0.0.1:${port}/mcp`
}

describe('mcp：url 型经代理', () => {
  test('列工具、调用都通，密钥只在代理侧', async () => {
    const servers: McpServers = { remote: { url: await fakeMcpHttp(), headers: { 'X-Api-Key': '${KEY}' } } }
    const base = await startProxy(mcpRoutes(async () => servers, { KEY: 'k-123' }))
    const port = new URL(base).port
    const via = mcpProxyEndpoint('remote', { SIMPLE_CODE_PROXY_PORT: port, SIMPLE_CODE_PROXY_TOKEN: TOKEN })
    const cfg = { url: 'http://ignored', headers: { 'X-Api-Key': '${KEY}' } }
    expect((await listMcpTools(cfg, via)).map((t) => t.name)).toEqual(['echo'])
    expect(await callMcpTool(cfg, 'echo', '{"text":"你好"}', via)).toEqual({ isError: false, text: 'echo: 你好' })
  })

  test('没有代理 → McpNoProxyError', async () => {
    expect(mcpProxyEndpoint('remote', {})).toBeUndefined()
    await expect(listMcpTools({ url: 'http://x' })).rejects.toBeInstanceOf(McpNoProxyError)
  })
})

describe('生图路由', () => {
  test('只认 POST /image/generations；钉 model、注入 Bearer、拼上游路径', async () => {
    const resolve = imageRoutes(async () => ({ model: 'gpt-image-x', baseUrl: 'https://gw.example/', apiKey: 'k' }))
    expect(await resolve('/image/generations', 'POST')).toEqual({
      url: 'https://gw.example/v1/images/generations',
      headers: { authorization: 'Bearer k' },
      body: { model: 'gpt-image-x' },
    })
    expect(await resolve('/image/generations', 'GET')).toBeUndefined()
    expect(await resolve('/image/edits', 'POST')).toBeUndefined()
  })

  test('未配置 imageModel → 代理 500，不发上游', async () => {
    const base = await startProxy(imageRoutes(async () => null))
    const res = await fetch(`${base}/image/generations`, { method: 'POST', headers: { 'x-sc-token': TOKEN }, body: '{}' })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('未配置 imageModel')
  })

  test('调用方给的 model 被覆盖；请求体不是 JSON 对象 → 400', async () => {
    const up = await fakeUpstream()
    const base = await startProxy(imageRoutes(async () => ({ model: 'pinned', baseUrl: up.url.replace(/\/llm.*/, ''), apiKey: 'k' })))
    const h = { 'x-sc-token': TOKEN, 'content-type': 'application/json' }
    await (await fetch(`${base}/image/generations`, { method: 'POST', headers: h, body: '{"model":"evil","prompt":"猫"}' })).text()
    expect(JSON.parse(up.seen[0]?.body ?? '{}')).toEqual({ model: 'pinned', prompt: '猫' })
    expect(up.seen[0]?.url).toBe('/v1/images/generations')
    expect(up.seen[0]?.headers.authorization).toBe('Bearer k')
    expect((await fetch(`${base}/image/generations`, { method: 'POST', headers: h, body: '[1]' })).status).toBe(400)
  })

  test('firstRoute：mcp 与生图并存，各认各的', async () => {
    const resolve = firstRoute(
      mcpRoutes(async () => ({ s: { url: 'http://mcp' } }), {}),
      imageRoutes(async () => ({ model: 'm', baseUrl: 'http://img', apiKey: 'k' })),
    )
    expect((await resolve('/mcp/s', 'POST'))?.url).toBe('http://mcp')
    expect((await resolve('/image/generations', 'POST'))?.url).toBe('http://img/v1/images/generations')
    expect(await resolve('/nope', 'POST')).toBeUndefined()
  })
})

describe('websearch 路由', () => {
  test('只认 POST /websearch；每次现读配置，按 websearchEndpoint 拼上游', async () => {
    let cfg: WebsearchConfig = {}
    const resolve = websearchRoutes(async () => cfg)
    expect(await resolve('/websearch', 'POST')).toEqual({ url: 'https://mcp.exa.ai/mcp', headers: {} })
    cfg = { exaApiKey: 'k' }
    expect((await resolve('/websearch', 'POST'))?.url).toBe('https://mcp.exa.ai/mcp?exaApiKey=k')
    cfg = { url: 'https://gw/x', exaApiKey: 'g' }
    expect(await resolve('/websearch', 'POST')).toEqual({ url: 'https://gw/x', headers: { authorization: 'Bearer g' } })
    expect(await resolve('/websearch', 'GET')).toBeUndefined()
    expect(await resolve('/websearch/x', 'POST')).toBeUndefined()
  })

  test('经代理转发：key 拼进上游 URL，调用方看不到；配置错 → 500 带变量名', async () => {
    const up = await fakeUpstream()
    let fail = false
    const resolve = websearchRoutes(async () => {
      if (fail) throw new Error('配置引用了环境变量 EXA_API_KEY，但它没有设置（或为空）')
      return { url: `${up.url}&exaApiKey=secret` }
    })
    const base = await startProxy(resolve)
    const h = { 'x-sc-token': TOKEN, 'content-type': 'application/json' }
    const res = await fetch(`${base}/websearch`, { method: 'POST', headers: h, body: '{"jsonrpc":"2.0"}' })
    expect(res.status).toBe(200)
    expect(up.seen[0]?.url).toContain('exaApiKey=secret')
    expect(up.seen[0]?.body).toBe('{"jsonrpc":"2.0"}')
    fail = true
    const bad = await fetch(`${base}/websearch`, { method: 'POST', headers: h, body: '{}' })
    expect(bad.status).toBe(500)
    expect(await bad.text()).toContain('EXA_API_KEY')
  })
})
