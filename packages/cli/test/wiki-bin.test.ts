import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const dirs: string[] = []
function fixture() {
  mkdirSync('.simple-code/tmp/wiki-bin-tests', { recursive: true })
  const root = mkdtempSync(resolve('.simple-code/tmp/wiki-bin-tests/case-'))
  dirs.push(root)
  mkdirSync(join(root, '.simple-code/memory'), { recursive: true })
  mkdirSync(join(root, '.simple-code/notes/wiki'), { recursive: true })
  writeFileSync(
    join(root, '.simple-code/notes/wiki/fold.md'),
    '---\nname: fold\ntype: wiki\ndescription: 底稿\nfiles: a.ts\nverified: abc1234\n---\n\n# fold\n',
  )
  writeFileSync(join(root, 'readme.md'), 'v1\n')
  return root
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function run(root: string, file: string, args: string[], input?: string) {
  return spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', resolve('packages/cli/src', file), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { ...process.env, HOME: root, SIMPLE_CODE_MEMORY_DIR: '' },
    },
  )
}
const patch = (path: string, from: string, to: string) =>
  `*** Begin Patch\n*** Update File: ${path}\n@@\n-${from}\n+${to}\n*** End Patch\n`

it('NOTE lint 真进程报目录页缺失；--type wiki 被接受', () => {
  const root = fixture()
  const lint = run(root, 'note-bin.ts', ['lint'])
  expect(lint.status, lint.stderr).toBe(0)
  expect(lint.stdout).toContain('缺目录页')
  const list = run(root, 'note-bin.ts', ['list', '--type', 'wiki'])
  expect(list.stdout).toContain('[wiki] fold')
})

it('APPLY_PATCH 改到词条目录才附检查；改别处不附', () => {
  const root = fixture()
  const wiki = run(
    root,
    'apply-patch-bin.ts',
    [],
    patch('.simple-code/notes/wiki/fold.md', '# fold', '# fold 底稿'),
  )
  expect(wiki.status, wiki.stderr).toBe(0)
  expect(wiki.stdout).toContain('wiki 检查：1 处问题')
  const other = run(root, 'apply-patch-bin.ts', [], patch('readme.md', 'v1', 'v2'))
  expect(other.status, other.stderr).toBe(0) // 前提：补丁本身成功
  expect(other.stdout).not.toContain('wiki 检查')
})
