import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureGitIgnored } from '../src/session/gitignore.ts'

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

/** 真 git init（不用 --bare），排除掉全局/用户级配置干扰 */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-gitignore-'))
  mkdirSync(join(dir, '.simple-code', 'memory'), { recursive: true })
  execFileSync('git', ['-C', dir, 'init'], { encoding: 'utf8' })
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { encoding: 'utf8' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { encoding: 'utf8' })
  return dir
}

afterEach(() => vi.restoreAllMocks())

describe('ensureGitIgnored', () => {
  it('git 仓库 + 未忽略 → 自动写 .git/info/exclude，git status 干净', () => {
    const dir = gitRepo()
    ensureGitIgnored(dir)
    expect(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.simple-code/')
    expect(sh(dir, 'status', '--porcelain')).toBe('')
  })

  it('幂等：调两次只有一行', () => {
    const dir = gitRepo()
    ensureGitIgnored(dir)
    ensureGitIgnored(dir)
    const lines = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.simple-code/')
    expect(lines.length).toBe(1)
  })

  it('已被 .gitignore 覆住 → 不写 exclude（check-ignore 放行即完成）', () => {
    const dir = gitRepo()
    writeFileSync(join(dir, '.gitignore'), '.simple-code/\n')
    ensureGitIgnored(dir)
    // git init 模板自带带注释的 exclude——断言没追加我们的行
    const lines = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.simple-code/')
    expect(lines.length).toBe(0)
  })

  it('已被 track → 不写 exclude，只警告', () => {
    const dir = gitRepo()
    writeFileSync(join(dir, '.simple-code', 'memory', 'a.jsonl'), 'x')
    sh(dir, 'add', '.simple-code')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ensureGitIgnored(dir)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).toContain('git rm -r --cached')
    const lines = readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '.simple-code/')
    expect(lines.length).toBe(0)
  })

  it('非 git 目录 → 静默', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-nogit-'))
    expect(() => ensureGitIgnored(dir)).not.toThrow()
  })
})
