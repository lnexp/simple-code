import { describe, expect, it } from 'vitest'
import { handleQuery, type Exec } from '../src/lsp-query.ts'

/** 位置构造器：与 vscode.Uri/Position 的 JSON 形态对齐（query 只读这几个字段） */
const uri = (p: string) => ({ fsPath: p, scheme: 'file' })
const range = (line: number) => ({ start: { line, character: 0 } })

describe('lsp-query 格式化', () => {
  it('definition/refs：位置列表 path:行（1-based）', async () => {
    const exec: Exec = async () => [{ uri: uri('/a/src/run.ts'), range: range(119) }]
    const text = await handleQuery(exec, { cmd: 'refs', file: '/a/src/run.ts', line: 120, col: 5 })
    expect(text).toBe('/a/src/run.ts:120')
  })

  it('symbols：递归树带缩进', async () => {
    const exec: Exec = async () => [
      { name: 'run', range: range(0), children: [{ name: 'step', range: range(9), children: [] }] },
    ]
    const text = await handleQuery(exec, { cmd: 'symbols', file: '/a/run.ts', line: 1, col: 1 })
    expect(text.split('\n')).toEqual(['1  run', '  10  step'])
  })

  it('hover：markdown 内容抽成文本', async () => {
    const exec: Exec = async () => [{ contents: [{ value: '```ts\nfunction run()\n```' }] }]
    const text = await handleQuery(exec, { cmd: 'hover', file: '/a/run.ts', line: 3, col: 1 })
    expect(text).toContain('function run()')
  })

  it('calls-in：宿主未公开展开命令——refs 近似并明确标注', async () => {
    const exec: Exec = async (command) => {
      if (command.includes('Reference')) return [{ uri: uri('/a/cli.ts'), range: range(30) }]
      return []
    }
    const text = await handleQuery(exec, { cmd: 'calls-in', file: '/a/run.ts', line: 120, col: 1 })
    expect(text).toContain('近似')
    expect(text).toContain('/a/cli.ts')
  })

  it('空结果不是错误——给「无结果」让模型换路', async () => {
    const exec: Exec = async () => []
    const text = await handleQuery(exec, { cmd: 'refs', file: '/a/run.ts', line: 1, col: 1 })
    expect(text).toContain('无结果')
  })

  it('未知命令列出可用命令', async () => {
    const text = await handleQuery(async () => [], { cmd: 'nope', file: '/a', line: 1, col: 1 })
    expect(text).toContain('refs')
    expect(text).toContain('calls-out')
  })
})
