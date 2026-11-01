import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  noteWritePath,
  readNoteFile,
  resolveNoteFile,
  scanNoteFiles,
} from '../src/tools/note-files.ts'

const roots: string[] = []
function workspace() {
  const base = resolve('.simple-code/tmp/note-files-tests')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'case-'))
  roots.push(root)
  return root
}
function put(root: string, path: string, text = '# 历史正文\n审批错误') {
  const file = join(root, '.simple-code', path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('四类型 note 的新旧位置', () => {
  it('历史状态在 read 中明确提示，不因统一入口丢掉作废标记', () => {
    const root = workspace()
    put(root, 'notes/retired.md', '---\nstatus: superseded\nby: newer\n---\n旧结论')
    expect(readNoteFile(root, 'retired')).toContain('【已作废，现行见 newer】')
    put(root, 'notes/principle/candidate.md', '---\nstatus: candidate\n---\n候选')
    expect(readNoteFile(root, 'candidate')).toContain('不作为当前生效规则')
  })

  it('全新项目静默为空，扫描不创建任何目录', () => {
    const root = workspace()
    expect(scanNoteFiles(root)).toEqual([])
    expect(() => statSync(join(root, '.simple-code'))).toThrow()
  })

  it('混存新旧类型，缺 type 按目录识别，不扫描任意子目录', () => {
    const root = workspace()
    put(root, 'notes/record.md')
    put(root, 'lessons/old.md')
    put(root, 'notes/lesson/new.md')
    put(root, 'principles/old-rule.md')
    put(root, 'notes/principle/new-rule.md')
    put(root, 'notes/goal/current.md')
    put(root, 'notes/archive/ignore.md')
    expect(
      scanNoteFiles(root)
        .map((f) => `${f.type}:${f.name}`)
        .sort(),
    ).toEqual([
      'general:record',
      'goal:current',
      'lesson:new',
      'lesson:old',
      'principle:new-rule',
      'principle:old-rule',
    ])
  })

  it('原文和 mtime 不因扫描变化；不伪造历史字段', () => {
    const root = workspace()
    const path = put(root, 'lessons/old.md')
    utimesSync(path, new Date('2024-01-01'), new Date('2024-01-01'))
    const before = statSync(path).mtimeMs
    const [entry] = scanNoteFiles(root)
    expect(entry?.copies[0]?.mtimeMs).toBe(before)
    expect(entry?.meta.created).toBeUndefined()
    expect(statSync(path).mtimeMs).toBe(before)
    expect(readFileSync(path, 'utf8')).toBe('# 历史正文\n审批错误')
  })

  it('新旧同名相同只展示一次，不删除且 read 不制造心跳冲突', () => {
    const root = workspace()
    const text = '---\nname: same\n---\n正文'
    const old = put(root, 'lessons/same.md', text)
    const fresh = put(root, 'notes/lesson/same.md', text)
    const [entry] = scanNoteFiles(root)
    expect(entry?.copies).toHaveLength(2)
    expect(entry?.conflict).toBe(false)
    expect(readNoteFile(root, 'same', 'lesson')).toContain('未更新 lastRead')
    expect(readFileSync(old, 'utf8')).toBe(text)
    expect(readFileSync(fresh, 'utf8')).toBe(text)
    expect(scanNoteFiles(root)[0]?.conflict).toBe(false)
  })

  it('不同内容冲突不选赢家；旧进程后写也会重新发现', () => {
    const root = workspace()
    const old = put(root, 'lessons/same.md')
    const fresh = put(root, 'notes/lesson/same.md')
    expect(scanNoteFiles(root)[0]?.conflict).toBe(false)
    writeFileSync(old, '旧程序后来写的新内容')
    const entry = scanNoteFiles(root)[0]!
    expect(entry.conflict).toBe(true)
    expect(entry.copies.map((c) => c.path)).toEqual([fresh, old])
    expect(() => readNoteFile(root, 'same', 'lesson')).toThrow('同类型同名内容冲突')
    try {
      readNoteFile(root, 'same', 'lesson')
    } catch (e) {
      expect(String(e)).toContain(old)
      expect(String(e)).toContain(fresh)
    }
  })

  it('不同类型同名必须消歧，类型与目录矛盾保留原文并报告', () => {
    const root = workspace()
    put(root, 'notes/shared.md')
    put(root, 'notes/goal/shared.md', '---\ntype: lesson\n---\n目标')
    expect(() => resolveNoteFile(root, 'shared')).toThrow('--type')
    const goal = resolveNoteFile(root, 'shared', 'goal')
    expect(goal.issue).toContain('type: lesson')
    expect(readNoteFile(root, 'shared', 'goal')).toContain('目标')
  })

  it('读单份旧文件只盖实际路径，不改 created，不搬迁', () => {
    const root = workspace()
    const path = put(root, 'lessons/old.md', '---\ncreated: 2024-01-01\n---\n正文')
    expect(readNoteFile(root, 'old', 'lesson')).toContain('lastRead:')
    expect(readFileSync(path, 'utf8')).toContain('created: 2024-01-01')
    expect(() => statSync(join(root, '.simple-code/notes/lesson/old.md'))).toThrow()
    put(root, 'lessons/raw.md', '没有头的原文')
    expect(readNoteFile(root, 'raw', 'lesson')).toContain('没有头的原文')
    expect(readFileSync(join(root, '.simple-code/lessons/raw.md'), 'utf8')).toBe('没有头的原文')
  })

  it('新写入路径按类型归类，跨新旧位置检查重名，拒绝路径逃逸', () => {
    const root = workspace()
    expect(noteWritePath(root, 'new', 'lesson')).toBe(
      join(root, '.simple-code/notes/lesson/new.md'),
    )
    expect(noteWritePath(root, 'new', 'general')).toBe(join(root, '.simple-code/notes/new.md'))
    put(root, 'lessons/old.md')
    expect(() => noteWritePath(root, 'old', 'lesson')).toThrow('已存在')
    expect(() => noteWritePath(root, '../escape', 'goal')).toThrow('name')
    expect(() => resolveNoteFile(root, '../escape')).toThrow('name')
  })
})
