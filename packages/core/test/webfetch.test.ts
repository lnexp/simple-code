import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.ts'
import { createWebfetchTool } from '../src/tools/webfetch.ts'

const CONFIG = { defaultTimeoutMs: 30_000, maxTimeoutMs: 120_000, maxOutputChars: 100_000 }
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  root: '/tmp',
  signal: new AbortController().signal,
  ...extra,
})

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  })

describe('webfetch / 参数', () => {
  const tool = createWebfetchTool(CONFIG)
  const bad = async (input: unknown) => {
    const out = await tool.execute(input, ctx())
    return out.isError && out.output
  }

  it('非 http/https 协议拒绝', async () => {
    expect(await bad({ url: 'ftp://x.test/f' })).toContain('http/https')
  })
  it('带 username/password 的 URL 拒绝——凭据会进日志', async () => {
    expect(await bad({ url: 'http://key:secret@x.test/' })).toContain('username/password')
  })
  it('非法 URL 拒绝', async () => {
    expect(await bad({ url: 'not a url' })).toContain('解析失败')
  })
  it('非对象输入拒绝', async () => {
    expect(await bad('x')).toContain('参数必须是对象')
  })
})

describe('webfetch / 抓取与转换', () => {
  it('style/script/noscript 不进正文，可见内容保留', async () => {
    const page =
      '<html><head><style>body { color: red }</style></head>' +
      '<body><h1>Real</h1><script>alert(1)</script>' +
      '<noscript>enable js</noscript><p>Content</p></body></html>'
    const fetchMock = vi.fn(async () => html(page))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/dirty' }, ctx())
      expect(out.isError).toBe(false)
      expect(out.output).toContain('# Real')
      expect(out.output).toContain('Content')
      expect(out.output).not.toContain('color: red')
      expect(out.output).not.toContain('alert(1)')
      expect(out.output).not.toContain('enable js')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('HTML 转 markdown，原始响应走 onRawOutput', async () => {
    const fetchMock = vi.fn(async () => html('<h1>Title</h1><p>Some <a href="/x">link</a></p>'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const raw: string[] = []
      const out = await createWebfetchTool(CONFIG).execute(
        { url: 'https://x.test/doc' },
        ctx({ onRawOutput: (c) => raw.push(c) }),
      )
      expect(out.isError).toBe(false)
      expect(out.output).toContain('# Title')
      expect(out.output).toContain('[link](/x)')
      expect(raw.join('')).toContain('<h1>Title</h1>')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超长 markdown 截断并提示 rawPath', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => html(`<p>${'word '.repeat(60_000)}</p>`)),
    )
    try {
      const out = await createWebfetchTool({ ...CONFIG, maxOutputChars: 2_000 }).execute(
        { url: 'https://x.test/big' },
        ctx({ rawPath: 'memory/raw/c1.log' }),
      )
      expect(out.output).toContain('省略')
      expect(out.output).toContain('memory/raw/c1.log')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('图片 URL：base64 进 images，输出是说明行', async () => {
    const png = Buffer.from('fake-png-bytes')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } })),
    )
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/img.png' }, ctx())
      expect(out.isError).toBe(false)
      expect(out.output).toContain('image/png')
      expect(out.images?.[0]).toEqual({
        data: png.toString('base64'),
        mimeType: 'image/png',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Cloudflare 403 challenge：换诚实 UA 重试一次', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const ua = String((init?.headers as Record<string, string>)['user-agent'])
        calls.push(ua)
        return ua.startsWith('Mozilla')
          ? new Response('blocked', { status: 403, headers: { 'cf-mitigated': 'challenge' } })
          : html('<p>ok</p>')
      }),
    )
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/' }, ctx())
      expect(calls).toHaveLength(2)
      expect(calls[1]?.startsWith('Mozilla')).toBe(false)
      expect(out.isError).toBe(false)
      expect(out.output).toContain('ok')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('webfetch / 错误路径', () => {
  it('404 → isError 带状态码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    )
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/404' }, ctx())
      expect(out.isError).toBe(true)
      expect(out.output).toContain('404')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('网络失败 → isError，cause 链可见', async () => {
    const dns = new Error('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND x.test'), { code: 'ENOTFOUND' }),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(dns)),
    )
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/' }, ctx())
      expect(out.isError).toBe(true)
      expect(out.output).toContain('ENOTFOUND')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('未知二进制 → 降级说明，不算错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(Buffer.from([0x50, 0x4b]), {
            headers: { 'content-type': 'application/zip' },
          }),
      ),
    )
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/a.zip' }, ctx())
      expect(out.isError).toBe(false)
      expect(out.output).toContain('application/zip')
      expect(out.output).toContain('curl')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('超过 5MB → isError 提示 curl', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1))),
    )
    try {
      const out = await createWebfetchTool(CONFIG).execute({ url: 'https://x.test/huge' }, ctx())
      expect(out.isError).toBe(true)
      expect(out.output).toContain('curl')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('工具描述说真话', () => {
  it('timeout 描述里的默认/上限秒数来自配置，不是写死的数字', () => {
    // 同 bash.test：描述与行为漂移比没有描述更糟（2026-09-09 事故）
    const spec = createWebfetchTool({
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 120_000,
      maxOutputChars: 100_000,
    }).definition.parameters as { properties?: { timeout?: { description?: string } } }
    expect(spec.properties?.timeout?.description).toContain('默认 30')
    expect(spec.properties?.timeout?.description).toContain('最大 120')
  })
})
