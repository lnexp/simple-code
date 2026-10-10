import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findWorkspaceRoot } from '../src/tools/workspace-root.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sc-wsroot-'))
  dirs.push(d)
  return d
}

describe('findWorkspaceRoot（bin 从子目录认工作区根）', () => {
  it('子目录往上找到带 .simple-code/memory 的根', () => {
    const root = tmp()
    mkdirSync(join(root, '.simple-code', 'memory'), { recursive: true })
    const sub = join(root, 'packages', 'vscode', 'webview')
    mkdirSync(sub, { recursive: true })
    expect(findWorkspaceRoot(sub)).toBe(root)
    expect(findWorkspaceRoot(root)).toBe(root)
  })

  it('只有 .simple-code 没有 memory（≈ ~/.simple-code）不算根，退回 cwd', () => {
    const home = tmp()
    mkdirSync(join(home, '.simple-code', 'skills'), { recursive: true })
    const proj = join(home, 'Code', 'no-sc-yet')
    mkdirSync(proj, { recursive: true })
    expect(findWorkspaceRoot(proj)).toBe(proj)
  })

  it('嵌套时取最近的一层', () => {
    const outer = tmp()
    mkdirSync(join(outer, '.simple-code', 'memory'), { recursive: true })
    const inner = join(outer, 'sub-project')
    mkdirSync(join(inner, '.simple-code', 'memory'), { recursive: true })
    mkdirSync(join(inner, 'src'))
    expect(findWorkspaceRoot(join(inner, 'src'))).toBe(inner)
  })
})
