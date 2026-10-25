import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { computeMemoryStats, NOTES_INDEX_LIMIT } from '../src/index.ts'

/** 记忆面板计数（reflect-trigger.md §3.2）：四元组必须与索引选取同源——
 *  fixture 造出超限（收起）、作废（superseded）、双源 skill、memory-reflect
 *  收尾事件，断言每一元都算对 */
const root = mkdtempSync(join(tmpdir(), 'memstats-'))
const globalDir = mkdtempSync(join(tmpdir(), 'memstats-global-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(globalDir, { recursive: true, force: true })
})

const note = (name: string, extra = ''): void => {
  mkdirSync(join(root, '.simple-code', 'notes'), { recursive: true })
  writeFileSync(
    join(root, '.simple-code', 'notes', `${name}.md`),
    `---\nname: ${name}\ndescription: d\ncreated: 2026-01-01 00:00:00\n${extra}---\n\n# ${name}\n`,
  )
}

// 27 条 note：1 条作废、26 条 active、前 NOTES_INDEX_LIMIT(20) 条常驻
note('gone', 'status: superseded\nby: keeper\n')
note('keeper')
for (let i = 1; i <= 25; i++) note(`n${String(i).padStart(2, '0')}`)

// lessons 3 条（无 front matter 要求，文件数即可）
mkdirSync(join(root, '.simple-code', 'lessons'), { recursive: true })
for (const n of ['l1', 'l2', 'l3']) writeFileSync(join(root, '.simple-code', 'lessons', `${n}.md`), '# x\n')

// events：一条普通、一条 memory-reflect 收尾（created 最新）
mkdirSync(join(root, '.simple-code', 'events'), { recursive: true })
writeFileSync(
  join(root, '.simple-code', 'events', 'some-battle.md'),
  '---\nname: some-battle\ndescription: x\ncreated: 2026-01-01 00:00:00\n---\n',
)
writeFileSync(
  join(root, '.simple-code', 'events', 'memory-reflect-recall-review.md'),
  '---\nname: memory-reflect-recall-review\ndescription: x\ncreated: 2026-10-22 08:00:00\n---\n',
)

// skill 双源 + summary 嵌套目录
mkdirSync(join(root, '.simple-code', 'skills', 'alpha'), { recursive: true })
writeFileSync(join(root, '.simple-code', 'skills', 'alpha', 'SKILL.md'), '# alpha\n')
mkdirSync(join(globalDir, 'skills', 'beta'), { recursive: true })
writeFileSync(join(globalDir, 'skills', 'beta', 'SKILL.md'), '# beta\n')
for (const d of ['000', '001']) mkdirSync(join(root, '.simple-code', 'memory', 'summaries', d), { recursive: true })
writeFileSync(join(root, '.simple-code', 'memory', 'summaries', '000', 'a.md'), 'x')
writeFileSync(join(root, '.simple-code', 'memory', 'summaries', '000', 'b.md'), 'x')
writeFileSync(join(root, '.simple-code', 'memory', 'summaries', '001', 'c.md'), 'x')

describe('computeMemoryStats', () => {
  it('note 四元组：作废踢出 active，active 前 20 条常驻，余下是收起', () => {
    const s = computeMemoryStats(root, globalDir)
    expect(s.notes.total).toBe(27)
    expect(s.notes.superseded).toBe(1)
    expect(s.notes.visible).toBe(NOTES_INDEX_LIMIT)
    expect(s.notes.hidden).toBe(26 - NOTES_INDEX_LIMIT)
  })

  it('上次反思：memory-reflect- 前缀里 created 最新的一条，主题取文件名', () => {
    const s = computeMemoryStats(root, globalDir)
    expect(s.lastReflect).toEqual({ date: '2026-10-22', theme: 'recall-review' })
  })

  it('events / lessons：不超限时可见=总数、收起=0', () => {
    const s = computeMemoryStats(root, globalDir)
    expect(s.events).toEqual({ total: 2, visible: 2, hidden: 0, superseded: 0 })
    expect(s.lessons).toEqual({ total: 3, visible: 3, hidden: 0, superseded: 0 })
  })

  it('skill 双源合计、summary 递归计数', () => {
    const s = computeMemoryStats(root, globalDir)
    expect(s.skills).toBe(2)
    expect(s.summaries).toBe(3)
  })
})
