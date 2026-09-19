import { afterEach, describe, expect, it } from 'vitest'
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
    }
  })

  it('列可省（缺省 1）', () => {
    const p = parseLspArgs(['definition', 'a.ts:7'])
    expect(p.ok && p.col).toBe(1)
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
})
