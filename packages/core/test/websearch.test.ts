import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.ts'
import { createWebsearchTool, parseSseData } from '../src/tools/websearch.ts'

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
