import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 2026-09-29 实案：bin 拿 process.cwd() 当工作区根，bash 先 cd 进子目录后
 * apply-patch 报「不存在」、note/lesson/event/skill read 报找不到。这里真起
 * bin 进程、cwd 放在子目录，测的是各 bin 的接线（找根本身在 core 测）。
 */
const repo = resolve(import.meta.dirname, '../../..')
const bin = (name: string) => join(repo, 'packages/cli/src', `${name}-bin.ts`)
let root = ''
let sub = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-binroot-'))
  const sc = join(root, '.simple-code')
  mkdirSync(join(sc, 'memory'), { recursive: true })
  mkdirSync(join(sc, 'notes'))
  writeFileSync(join(sc, 'notes', 'n1.md'), '---\nname: n1\ntitle: 标题\ndescription: 描述 n1\n---\n正文 n1\n')
  mkdirSync(join(sc, 'lessons'))
  writeFileSync(
    join(sc, 'lessons', 'l1.md'),
    '---\nname: l1\ndescription: 描述 l1\n---\n# 教训 l1\n\n## 症状\n症状 l1\n',
  )
  mkdirSync(join(sc, 'events'))
  writeFileSync(join(sc, 'events', 'e1.md'), '---\nname: e1\ndescription: 描述 e1\n---\n# e1 — 描述 e1\n')
  mkdirSync(join(sc, 'skills', 's1'), { recursive: true })
  writeFileSync(join(sc, 'skills', 's1', 'SKILL.md'), '---\nname: s1\ndescription: 描述 s1\n---\n正文 s1\n')
  mkdirSync(join(root, 'pkg', 'src'), { recursive: true })
  writeFileSync(join(root, 'pkg', 'src', 'a.txt'), 'old\n')
  sub = join(root, 'pkg')
}, 30_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (name: string, args: string[], input?: string) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin(name), ...args], {
    cwd: sub,
    input,
    encoding: 'utf8',
    env: { ...process.env, SIMPLE_CODE_MEMORY_DIR: '' },
  })

describe('bin 在子目录下认工作区根', () => {
  it('note / lesson / event / skill read 找得到', () => {
    expect(run('note', ['read', 'n1']).stdout).toContain('正文 n1')
    expect(run('lesson', ['read', 'l1']).stdout).toContain('症状 l1')
    expect(run('event', ['read', 'e1']).stdout).toContain('描述 e1')
    expect(run('skill', ['read', 's1']).stdout).toContain('正文 s1')
  }, 60_000)

  it('apply-patch 的相对路径按工作区根解析', () => {
    const r = run('apply-patch', [], '*** Begin Patch\n*** Update File: pkg/src/a.txt\n@@\n-old\n+new\n*** End Patch\n')
    expect(r.stderr).toBe('')
    expect(readFileSync(join(root, 'pkg', 'src', 'a.txt'), 'utf8')).toBe('new\n')
  }, 30_000)
})
