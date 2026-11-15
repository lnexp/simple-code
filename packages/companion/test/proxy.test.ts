import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createProxyServer,
  type LocalSettings,
  remoteSettingsPayload,
  SETTINGS_PATH,
} from '../src/proxy.ts'

const servers: import('node:http').Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

const fixture: LocalSettings = {
  provider: 'p1',
  model: 'm1',
  providers: {
    p1: { baseUrl: 'https://up1.example.com/', apiKey: '${TEST_KEY_1}' },
    p2: { baseUrl: 'https://up2.example.com/v2', apiKey: 'literal-key' },
  },
  mcp: { servers: { x: { args: ['sk-secret'] } } },
  bash: { approval: {} },
}

/** 模型选择引用键 + SDK 模型都在（2026-11-12：远端要用/要剥） */
const fixtureRich: LocalSettings = {
  ...fixture,
  imageModel: { provider: 'p1', model: 'img' },
  taskModels: [{ provider: 'p1', model: 'm1', use: '子任务' }],
  model: 'm1',
  providers: {
    ...fixture.providers,
    p1: {
      ...fixture.providers!.p1,
      baseUrl: 'https://up1.example.com/',
      models: { m1: {}, img: { claudeAgentSdk: true } },
    },
  },
}

/** 起临时口的服务器，返回 base url 和捕获的转发调用 */
const start = async (readSettings: () => LocalSettings) => {
  const seen: { url?: URL; headers?: Record<string, string>; body?: string }[] = []
  const server = createProxyServer({
    readSettings,
    fetchImpl: (async (url: URL | string, init?: RequestInit) => {
      seen.push({
        url: new URL(String(url)),
        headers: init?.headers as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : String(init?.body ?? ''),
      })
      return new Response('stream-ok', { status: 200 })
    }) as typeof fetch,
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, seen }
}

describe('本机代理（伴生扩展）', () => {
  it('${VAR} 引用的 apiKey 用进程环境展开（与 core loadConfig 同款语义）', async () => {
    process.env.TEST_KEY_1 = 'env-key-1'
    const { base, seen } = await start(() => fixture)
    const res = await fetch(`${base}/sc-p/p1/v1/messages`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(200)
    expect(seen[0]?.url?.href).toBe('https://up1.example.com/v1/messages')
    expect(seen[0]?.headers?.['x-api-key']).toBe('env-key-1')
    delete process.env.TEST_KEY_1
  })
  it('settings 端点：白名单带出、providers 指前缀路由口、假 key、mcp/bash 不带', async () => {
    const { base } = await start(() => fixture)
    const res = await fetch(`${base}${SETTINGS_PATH}`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as Record<string, any>
    expect(Object.keys(payload).sort()).toEqual(
      ['memory', 'model', 'provider', 'providers', 'request', 'visionModel']
        .sort()
        .filter((k) => k in payload || ['providers'].includes(k))
        .filter((k) => k in payload),
    )
    expect(payload.mcp).toBeUndefined()
    expect(payload.bash).toBeUndefined()
    // baseUrl 指向实际监听口（localPort），apiKey 换假值
    expect(payload.providers.p1.baseUrl).toBe(`${base}/sc-p/p1`)
    expect(payload.providers.p1.apiKey).toBe('via-local-proxy')
    expect(payload.providers.p2.baseUrl).toBe(`${base}/sc-p/p2`)
  })

  it('前缀路由转发：路径还原到各 provider 的真实 baseUrl，认证头替换成真 key', async () => {
    const { base, seen } = await start(() => fixture)
    const res = await fetch(`${base}/sc-p/p2/chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer via-local-proxy', 'x-api-key': 'via-local-proxy' },
      body: 'hello',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('stream-ok')
    // p2 的 baseUrl 不带尾斜杠、带路径前缀——还原成真实上游路径
    expect(seen[0]?.url?.href).toBe('https://up2.example.com/v2/chat')
    expect(seen[0]?.headers?.['x-api-key']).toBe('literal-key')
    expect(seen[0]?.headers?.authorization).toBe('Bearer literal-key')
    expect(seen[0]?.body).toContain('hello')
  })

  it('settings 端点：带出 imageModel/taskModels；providers 里的 claudeAgentSdk 剥掉；不污染原对象', async () => {
    const { base } = await start(() => fixtureRich)
    const res = await fetch(`${base}${SETTINGS_PATH}`)
    const payload = (await res.json()) as Record<string, any>
    // 白名单补的两个键（2026-11-12：漏带导致远端 task --models 丢清单、生图 500）
    expect(payload.imageModel).toEqual({ provider: 'p1', model: 'img' })
    expect(payload.taskModels).toEqual([{ provider: 'p1', model: 'm1', use: '子任务' }])
    // SDK 标记剥掉：远端没有 claudeAgentSdkPath，留着 true 会让 loadConfig 三道校验炸
    expect(payload.providers.p1.models.img.claudeAgentSdk).toBeUndefined()
    expect('claudeAgentSdk' in payload.providers.p1.models.img).toBe(false)
    expect(payload.providers.p1.models.m1).toEqual({})
    // 纯函数：原对象的 models 不被改写（readSettings 可能被缓存）
    expect(
      (fixtureRich.providers!.p1 as { models?: Record<string, any> }).models?.img,
    ).toMatchObject({ claudeAgentSdk: true })
  })

  it('转发响应剥 content-encoding / content-length：fetch 已解压，原头会让远端二次解压失败', async () => {
    const server = createProxyServer({
      // apiKey 用字面量：fixture.p1 的 ${TEST_KEY_1} 要环境变量，与本用例无关
      readSettings: () => ({
        ...fixture,
        providers: { p1: { baseUrl: 'https://up1.example.com/', apiKey: 'literal' } },
      }),
      fetchImpl: (async () =>
        new Response('decoded-bytes', {
          status: 200,
          headers: { 'content-encoding': 'gzip', 'content-length': '999', 'x-upstream': 'keep' },
        })) as typeof fetch,
    })
    servers.push(server)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/sc-p/p1/v1/messages`, {
      method: 'POST',
      body: 'x',
    })
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('x-upstream')).toBe('keep')
    expect(await res.text()).toBe('decoded-bytes')
  })

  it('同一端口多上游：两个 provider 各回各自 baseUrl（launchd 版做不到的）', async () => {
    process.env.TEST_KEY_1 = 'env-key-1'
    const { base, seen } = await start(() => fixture)
    await fetch(`${base}/sc-p/p1/v1/messages`, { method: 'POST', body: 'a' })
    await fetch(`${base}/sc-p/p2/v1/messages`, { method: 'POST', body: 'b' })
    expect(seen[0]?.url?.href).toBe('https://up1.example.com/v1/messages')
    expect(seen[1]?.url?.href).toBe('https://up2.example.com/v2/v1/messages')
    delete process.env.TEST_KEY_1
  })

  it('未知 provider / 非路由路径 → 404', async () => {
    const { base } = await start(() => fixture)
    expect((await fetch(`${base}/sc-p/nope/x`)).status).toBe(404)
    expect((await fetch(`${base}/v1/messages`)).status).toBe(404)
  })

  it('settings 读失败 → 500；${VAR} 缺失 → 502 且不回显值', async () => {
    const broken = await start(() => {
      throw new Error('boom')
    })
    expect((await fetch(`${broken.base}${SETTINGS_PATH}`)).status).toBe(500)
    const envMissing = await start(() => ({
      providers: { p: { baseUrl: 'https://x.example.com', apiKey: '${NO_SUCH_VAR_42}' } },
    }))
    const res = await fetch(`${envMissing.base}/sc-p/p/v1/x`, { method: 'POST', body: 'x' })
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('NO_SUCH_VAR_42')
  })

  it('payload 纯函数：port 决定 baseUrl', () => {
    const p = remoteSettingsPayload(
      { providers: { a: { baseUrl: 'https://real', apiKey: 'k' } } },
      15432,
    )
    expect((p.providers as Record<string, any>).a.baseUrl).toBe('http://127.0.0.1:15432/sc-p/a')
  })
})
