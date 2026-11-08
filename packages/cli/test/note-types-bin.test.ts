import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const dirs: string[] = []
function fixture() {
  mkdirSync('.simple-code/tmp/note-bin-tests', { recursive: true })
  const root = mkdtempSync(resolve('.simple-code/tmp/note-bin-tests/case-'))
  dirs.push(root)
  mkdirSync(join(root, '.simple-code/memory'), { recursive: true })
  mkdirSync(join(root, '.simple-code/lessons'))
  mkdirSync(join(root, 'pkg'))
  writeFileSync(join(root, '.simple-code/lessons/old.md'), '---\nname: old\n---\n历史教训原文')
  return root
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const bin = resolve('packages/cli/src/note-bin.ts')
function run(root: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin, ...args], {
    cwd: join(root, 'pkg'),
    encoding: 'utf8',
    input,
    env: { ...process.env, HOME: root, SIMPLE_CODE_MEMORY_DIR: '' },
  })
}

it('NOTE 真进程读旧 lesson，类型参数前后位置一致，缺值与拼错不静默回退', () => {
  const root = fixture()
  for (const args of [
    ['read', 'old', '--type', 'lesson'],
    ['--type', 'lesson', 'read', 'old'],
  ]) {
    const out = run(root, args)
    expect(out.status, out.stderr).toBe(0)
    expect(out.stdout).toContain('历史教训原文')
  }
  expect(run(root, ['list', '--type']).status).not.toBe(0)
  expect(run(root, ['list', '--type', 'leson']).status).not.toBe(0)
  expect(run(root, ['list', '--wat']).status).not.toBe(0)
})

it('NOTE 真进程统一四类型 list/search，新写入分类目录且撞名拒绝', () => {
  const root = fixture()
  expect(run(root, ['list']).stdout).toContain('[lesson] old')
  expect(run(root, ['search', '历史', '--type', 'lesson']).stdout).toContain('old')
  const input =
    'name: rule\ntitle: 原则\ndescription: 判断时读\n---\n## 判断\n做法\n## 适用边界\n条件\n## 依据\nturn 1\n'
  const first = run(root, ['write', '--type', 'principle'], input)
  expect(first.status, first.stderr).toBe(0)
  expect(readFileSync(join(root, '.simple-code/notes/principle/rule.md'), 'utf8')).toContain(
    'status: candidate',
  )
  expect(run(root, ['write', '--type', 'principle'], input).status).toBe(1)
  // --- 可省（2026-11-06）：markdown 头部块习惯，字段行后直接正文
  const noSep =
    'name: nosep\ntitle: 无分隔\ndescription: 单行描述\n\n## 症状\n正文从空行后开始\n## 当时怎么误判的\n想当然\n## 根因\n习惯\n## 修法\n改了\n## 怎么验证的\n测了\n'
  const r = run(root, ['write', '--type', 'lesson'], noSep)
  expect(r.status, r.stderr).toBe(0)
  const written = readFileSync(join(root, '.simple-code/notes/lesson/nosep.md'), 'utf8')
  expect(written).toContain('## 症状')
  expect(written).not.toMatch(/^\n/) // 开头空行剥掉
  expect(run(root, ['list', '--type', 'lesson']).stdout).toContain('nosep')
  expect(run(root, ['list', '--type', 'principle']).stdout).not.toContain('[lesson]')
})
