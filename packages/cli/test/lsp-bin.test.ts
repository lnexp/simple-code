import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { lspMain, parseLspArgs } from '../src/lsp-bin.ts'

describe('lsp-bin 参数解析', () => {
  it('file:行:列 完整形态，file 解析成绝对路径', () => {
    const p = parseLspArgs(['refs', 'src/run.ts:120:5'])
    expect(p.ok).toBe(true)
    if (p.ok) {
      expect(p.cmd).toBe('refs')
      expect(p.file).toMatch(/src\/run\.ts$/)
    expect(p.line).toBe(120)
      expect(p.col).toBe(5)
      expect(p.colGiven).toBe(true)
    }
  })

  it('列可省（缺省 1）', () => {
    const p = parseLspArgs(['definition', 'a.ts:7'])
    expect(p.ok && p.col).toBe(1)
    expect(p.ok && p.colGiven).toBe(false)
  })

  it('symbols 只给文件也行；其他命令缺行号报错', () => {
    expect(parseLspArgs(['symbols', 'a.ts']).ok).toBe(true)
    const bad = parseLspArgs(['refs', 'a.ts'])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('需要位置')
  })

  it('缺参数给用法', () => {
    const p = parseLspArgs([])
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.error).toContain('用法')
  })
})

describe('lspMain', () => {
  const saved = process.env.SIMPLE_CODE_LSP_PORT
  afterEach(() => {
    if (saved === undefined) delete process.env.SIMPLE_CODE_LSP_PORT
    else process.env.SIMPLE_CODE_LSP_PORT = saved
  })

  it('无桥（env 缺失）退 2，明确说回落 grep', async () => {
    delete process.env.SIMPLE_CODE_LSP_PORT
    expect(await lspMain(['refs', 'a.ts:1'])).toBe(2)
  })

  it('参数错退 3', async () => {
    process.env.SIMPLE_CODE_LSP_PORT = '59999'
    expect(await lspMain([])).toBe(3)
  })

  // 2026-09-30：历史调用 refs store.ts:620 → 无结果、:620:11 → 命中——缺列
  // 落在第 1 列（缩进/修饰符）上，「无结果」读起来像「真没引用」
  describe('无结果时缺列提示', () => {
    let server: Server | undefined
    const out: string[] = []
    const fakeBridge = async (text: string) => {
      server = createServer((_req, res) => res.end(JSON.stringify({ ok: true, text })))
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
      const addr = server.address()
      process.env.SIMPLE_CODE_LSP_PORT = String(typeof addr === 'object' && addr ? addr.port : 0)
    }
    const run = async (argv: string[]) => {
      out.length = 0
      const orig = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stdout.write
      try {
        return await lspMain(argv)
      } finally {
        process.stdout.write = orig
      }
    }
    afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

    it('没给列 + 无结果：补一句列号说明', async () => {
      await fakeBridge('无结果：没找到定义/引用（或该文件类型没有语言服务）')
      expect(await run(['refs', 'a.ts:620'])).toBe(0)
      expect(out.join('')).toContain('未给列号')
    })

    it('给了列、symbols、或有结果：不补', async () => {
      await fakeBridge('无结果：没找到定义/引用（或该文件类型没有语言服务）')
      await run(['refs', 'a.ts:620:11'])
      expect(out.join('')).not.toContain('未给列号')
      await run(['symbols', 'a.ts'])
      expect(out.join('')).not.toContain('未给列号')
    })

    it('有结果不补', async () => {
      await fakeBridge('/x/a.ts:3')
      await run(['refs', 'a.ts:620'])
      expect(out.join('')).not.toContain('未给列号')
    })
  })
})
