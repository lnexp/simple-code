import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.ts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWebsearchTool, parseSseData, readWebsearchConfig, websearchEndpoint } from '../src/tools/websearch.ts'

const ctx: ToolContext = { root: '/tmp', signal: new AbortController().signal }

describe('parseSseData（纯函数）', () => {
  it('整体 JSON 直接取 result.content[0].text', () => {
    expect(parseSseData('{"result":{"content":[{"type":"text","text":"结果"}]}}')).toBe('结果')
  })
  it('SSE 逐行找 data:，非 JSON 行跳过', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":1}',
      'data: {"result":{"content":[{"text":"命中"}]}}',
      '',
    ].join('\n')
    expect(parseSseData(body)).toBe('命中')
  })
  it('JSON 不在开头也没有 data: 前缀 → 不命中', () => {
    expect(parseSseData('垃圾行\n{"result":{"content":[{"text":"x"}]}}')).toBeUndefined()
  })
  it('空 body / 纯垃圾 → undefined', () => {
    expect(parseSseData('')).toBeUndefined()
    expect(parseSseData('event: x\ndata: not-json')).toBeUndefined()
  })
  it('content 里没有 text 项 → undefined', () => {
    expect(parseSseData('{"result":{"content":[{"type":"image"}]}}')).toBeUndefined()
  })
})

describe('websearch / 参数', () => {
  const tool = createWebsearchTool({})
  it('query 必填', async () => {
    const out = await tool.execute({ numResults: 3 }, ctx)
    expect(out.isError).toBe(true)
    expect(out.output).toContain('query')
  })
  it('numResults 上限 10', async () => {
    // 走到网络层才算过了参数校验——mock fetch 抓 body 断言
    const calls: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return new Response('{"result":{"content":[{"text":"ok"}]}}')
      }),
    )
    try {
      await tool.execute({ query: 'q', numResults: 99 }, ctx)
      const args = (calls[0] as { params: { arguments: Record<string, unknown> } }).params.arguments
      expect(args.numResults).toBe(10)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('websearch / 网络', () => {
  it('key 进 URL，匿名走裸端点', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        urls.push(String(url))
        return new Response('{"result":{"content":[{"text":"ok"}]}}')
      }),
    )
    try {
      await createWebsearchTool({}).execute({ query: 'q' }, ctx)
      await createWebsearchTool({ exaApiKey: 'k&y' }).execute({ query: 'q' }, ctx)
      expect(urls[0]).toBe('https://mcp.exa.ai/mcp')
      expect(urls[1]).toBe('https://mcp.exa.ai/mcp?exaApiKey=k%26y')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('配了 url → 打自定义端点，key 走 Bearer 头', async () => {
    const seen: { url: string; auth: string | undefined }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        seen.push({
          url: String(url),
          auth: (init?.headers as Record<string, string>)?.authorization,
        })
        return new Response('{"result":{"content":[{"text":"ok"}]}}')
      }),
    )
    try {
      await createWebsearchTool({
        url: 'https://gateway.example.com/llm/mcp?mcp=dashboard.exa.ai',
        exaApiKey: 'gw-key',
      }).execute({ query: 'q' }, ctx)
      expect(seen[0]).toEqual({
        url: 'https://gateway.example.com/llm/mcp?mcp=dashboard.exa.ai',
        auth: 'Bearer gw-key',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('非 200 → isError 且提示 webfetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    )
    try {
      const out = await createWebsearchTool({}).execute({ query: 'q' }, ctx)
      expect(out.isError).toBe(true)
      expect(out.output).toContain('429')
      expect(out.output).toContain('webfetch')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('超时/网络错 → isError，cause 可见', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.reject(
          new Error('fetch failed', {
            cause: Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
          }),
        ),
      ),
    )
    try {
      const out = await createWebsearchTool({}).execute({ query: 'q' }, ctx)
      expect(out.isError).toBe(true)
      expect(out.output).toContain('UND_ERR_CONNECT_TIMEOUT')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('格式异常 → isError 且带响应片段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>login</html>')),
    )
    try {
      const out = await createWebsearchTool({}).execute({ query: 'q' }, ctx)
      expect(out.isError).toBe(true)
      expect(out.output).toContain('html')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('正常路径：text 原样返回', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('data: {"result":{"content":[{"text":"## 结果"}]}}')),
    )
    try {
      const out = await createWebsearchTool({}).execute({ query: 'q' }, ctx)
      expect(out).toMatchObject({ isError: false, output: '## 结果', exitCode: 0 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('经凭据代理（2026-10-23 websearch 迁代理）', () => {
  it('headers 透传；非 200 带响应原文前 200 字（代理 500 的原因要能看到）', async () => {
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>)
        return new Response('凭据代理：配置引用了环境变量 EXA_API_KEY，但它没有设置', { status: 500 })
      }),
    )
    try {
      const out = await createWebsearchTool({ url: 'http://127.0.0.1:1/websearch', headers: { 'x-sc-token': 't' } }).execute({ query: 'q' }, ctx)
      expect(seen[0]?.['x-sc-token']).toBe('t')
      expect(seen[0]?.authorization).toBeUndefined()
      expect(out.output).toContain('HTTP 500')
      expect(out.output).toContain('EXA_API_KEY')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('websearchEndpoint：匿名 / key 进 URL / 自定义 url 走 Bearer', () => {
    expect(websearchEndpoint({})).toEqual({ url: 'https://mcp.exa.ai/mcp', headers: {} })
    expect(websearchEndpoint({ exaApiKey: 'k&y' })).toEqual({ url: 'https://mcp.exa.ai/mcp?exaApiKey=k%26y', headers: {} })
    expect(websearchEndpoint({ url: 'https://gw/x', exaApiKey: 'g' })).toEqual({ url: 'https://gw/x', headers: { authorization: 'Bearer g' } })
  })

  it('readWebsearchConfig：缺文件 = 匿名；${VAR} 展开；缺变量抛；坏 JSON 抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-'))
    const p = join(dir, 'websearch.json')
    expect(await readWebsearchConfig(p, {})).toEqual({})
    await writeFile(p, '{"exaApiKey":"${EXA_API_KEY}"}')
    expect(await readWebsearchConfig(p, { EXA_API_KEY: 'k' })).toEqual({ exaApiKey: 'k' })
    await expect(readWebsearchConfig(p, {})).rejects.toThrow(/EXA_API_KEY/)
    await writeFile(p, '{bad')
    await expect(readWebsearchConfig(p, {})).rejects.toThrow()
  })
})
