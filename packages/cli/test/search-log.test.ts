import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'

/**
 * 2026-10-23：向量检索的重评条件是「看 2~3 周 search miss」，但 runlog 从不
 * 记 search——到期没有数据。五个库的 search 每次记一行：库、查询词、命中数。
 * memory 零命中走 process.exit(1)，日志必须在退出前已落盘。
 */
const repo = resolve(import.meta.dirname, '../../..')
const tmp = mkdtempSync(join(tmpdir(), 'sc-searchlog-'))
const home = join(tmp, 'home')
const ws = join(tmp, 'ws')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const md = (name: string) =>
  `---\nname: ${name}\ndescription: 金丝雀发布的结论\ncreated: 2026-10-23 10:00:00\n---\n\n金丝雀发布正文\n`
for (const d of ['notes', 'lessons', 'events', 'skills/demo', 'memory/turns']) mkdirSync(join(ws, '.simple-code', d), { recursive: true })
mkdirSync(home)
writeFileSync(join(ws, '.simple-code/notes/a.md'), md('a'))
// 超半年未用：search 默认收起，记进 hidden 而不是 hits
writeFileSync(join(ws, '.simple-code/notes/old.md'), md('old').replace('2026-10-23', '2025-01-01'))
writeFileSync(join(ws, '.simple-code/lessons/a.md'), md('a'))
writeFileSync(join(ws, '.simple-code/events/a.md'), md('a'))
writeFileSync(join(ws, '.simple-code/skills/demo/SKILL.md'), md('demo'))
writeFileSync(
  join(ws, '.simple-code/memory/turns/turn-000001.jsonl'),
  JSON.stringify({ role: 'user', parts: [{ type: 'text', text: '金丝雀发布怎么做' }] }) + '\n',
)

const search = (lib: string, query: string) =>
  spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(repo, `packages/cli/src/${lib}-bin.ts`), 'search', query],
    { cwd: ws, encoding: 'utf8', env: { ...process.env, HOME: home } },
  )

it('五个库的 search 每次记一行 runlog：库、查询词、命中数（零命中也记）', () => {
  const libs = ['note', 'lesson', 'event', 'skill', 'memory']
  for (const lib of libs) {
    search(lib, '金丝雀')
    search(lib, '不存在的词')
  }
  const dir = join(home, '.simple-code', 'logs')
  const rows = readdirSync(dir)
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.ev === 'search')
  const got = rows.map((e) => `${e.lib}|${e.query}|${e.hits}`).sort()
  const want = libs.flatMap((lib) => [`${lib}|金丝雀|1`, `${lib}|不存在的词|0`]).sort()
  expect(got).toEqual(want)
  expect(rows.find((e) => e.lib === 'note' && e.query === '金丝雀')?.hidden).toBe(1)
  expect(new Set(rows.map((e) => e.folder))).toEqual(new Set([realpathSync(ws)]))
}, 60_000)
