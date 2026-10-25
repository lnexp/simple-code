import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { decayCutoff } from '../src/tools/decay.ts'
import { listEvents, searchEvents } from '../src/tools/events.ts'
import { listLessons, searchLessons } from '../src/tools/lesson.ts'
import { listNotes, searchNotes } from '../src/tools/note.ts'

// 时间衰减（memory-time-decay ②，2026-10-21 拍板）：超半年未用的条目
// 不进 list/search；--all 全量；护栏行报数；superseded 不受时间线影响。
// 「旧」用 2020 年（任何月份都远超 cutoff），「新」用当前时刻

const OLD = '2020-01-01 00:00:00'
const NOW = new Date()
const stamp = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 12:00:00`

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-decay-'))
  for (const lib of ['notes', 'lessons', 'events'])
    mkdirSync(join(root, '.simple-code', lib), { recursive: true })
})
afterAll(() => {
  for (const d of [root]) if (d) rmSync(d, { recursive: true, force: true })
})

describe('cutoff 月度锚点', () => {
  it('cutoff = 当月第一天 − 180 天：当月内恒定（缓存友好）', () => {
    const a = decayCutoff(new Date(2026, 9, 1))
    const b = decayCutoff(new Date(2026, 9, 31))
    expect(a).toBe(b)
    // 跨月跳变
    expect(decayCutoff(new Date(2026, 10, 1))).toBeGreaterThan(a)
  })
})

describe('note 衰减', () => {
  function writeNoteFile(name: string, created: string, extra = ''): void {
    writeFileSync(
      join(root, '.simple-code', 'notes', `${name}.md`),
      `---\nname: ${name}\ndescription: ${name} 的描述\ncreated: ${created}\n${extra}---\n\n正文提到缓存。\n`,
      'utf8',
    )
  }

  beforeEach(() => {
    writeNoteFile('old-note', OLD)
    writeNoteFile('fresh-note', stamp(NOW))
    writeNoteFile('old-superseded', OLD, 'status: superseded\nby: 接替者\n')
  })

  it('list：旧的收起、新的与 superseded 保留；护栏行报数；--all 全量', () => {
    const out = listNotes(root)
    expect(out).toContain('fresh-note')
    expect(out).toContain('old-superseded') // 语义退场线独立于时间线
    expect(out).not.toContain('old-note —') // 旧的非 superseded 被收起
    expect(out).toContain('另有 1 条超半年未用已收起')
    const all = listNotes(root, true)
    expect(all).toContain('old-note')
  })

  it('search：旧命中收起 + 护栏行；--all 看回', () => {
    const out = searchNotes(root, '缓存')
    expect(out).toContain('fresh-note')
    expect(out).not.toContain('old-note 的描述')
    expect(out).toContain('old-superseded')
    expect(out).toContain('另有 1 条超半年未用已收起')
    expect(searchNotes(root, '缓存', true)).toContain('old-note')
  })
})

describe('lesson 衰减（信号 = lastRead ?? mtime）', () => {
  beforeEach(() => {
    const dir = join(root, '.simple-code', 'lessons')
    for (const name of ['old-lesson', 'fresh-lesson']) {
      writeFileSync(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} 描述\n---\n\n正文含缓存。\n`,
        'utf8',
      )
    }
    // 旧教训：mtime 推到 2020；新的保持当下
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(dir, 'old-lesson.md'), old, old)
  })

  it('list / search 都收起旧的；--all 看回', () => {
    expect(listLessons(root)).not.toContain('old-lesson')
    expect(listLessons(root)).toContain('fresh-lesson')
    expect(listLessons(root)).toContain('另有 1 条超半年未用已收起')
    expect(searchLessons(root, '缓存')).not.toContain('old-lesson')
    expect(searchLessons(root, '缓存', true)).toContain('old-lesson')
  })

  it('fm 有 lastRead（read 心跳盖的）时优先于 mtime', () => {
    const p = join(root, '.simple-code', 'lessons', 'old-lesson.md')
    const text = readFileSync(p, 'utf8').replace(/^---$/m, `---\nlastRead: ${stamp(NOW)}`)
    writeFileSync(p, text, 'utf8')
    expect(listLessons(root)).toContain('old-lesson') // 心跳把它救回可见
  })
})

describe('event 衰减（信号 = max(lastRead, updated) ?? created）', () => {
  beforeEach(() => {
    const dir = join(root, '.simple-code', 'events')
    const make = (name: string, created: string, updated?: string): void => {
      writeFileSync(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} 描述\ncreated: ${created}${updated ? `\nupdated: ${updated}` : ''}\n---\n\n# ${name} — ${name} 描述\n\n## 进展\n\n- 一句\n`,
        'utf8',
      )
    }
    make('old-ev', OLD)
    make('fresh-ev', stamp(NOW))
    // created 很旧但上周 progress 过（updated 新）→ 活跃，不收
    make('active-ev', OLD, stamp(NOW))
  })

  it('list：休眠的收起、活跃的保留；--all 全量', () => {
    const out = listEvents(root)
    expect(out).toContain('fresh-ev')
    expect(out).toContain('active-ev')
    expect(out).not.toContain('old-ev —')
    expect(out).toContain('另有 1 条超半年未用已收起')
    expect(listEvents(root, true)).toContain('old-ev')
  })

  it('search 同口径', () => {
    const out = searchEvents(root, '描述')
    expect(out).not.toContain('old-ev —')
    expect(out).toContain('active-ev')
    expect(searchEvents(root, '描述', true)).toContain('old-ev')
  })
})
