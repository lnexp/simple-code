import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listTypedNotes, searchTypedNotes, writeTypedNote } from '../src/tools/note-library.ts'

const roots: string[] = []
function root() {
  mkdirSync('.simple-code/tmp/note-library-tests', { recursive: true })
  const r = mkdtempSync(resolve('.simple-code/tmp/note-library-tests/case-'))
  roots.push(r)
  return r
}
function put(r: string, p: string, body: string) {
  const path = join(r, '.simple-code', p)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

it('list/search 默认覆盖四类型和旧位置，冲突的两份原文均可搜索', () => {
  const r = root()
  put(r, 'notes/a.md', '# 普通记录')
  put(r, 'lessons/b.md', '# 旧版教训 审批')
  put(r, 'notes/lesson/b.md', '# 新版教训 缓存')
  put(r, 'principles/c.md', '# 原则')
  put(r, 'notes/goal/d.md', '# 目标')
  const all = listTypedNotes(r, { all: true })
  for (const type of ['general', 'lesson', 'principle', 'goal']) expect(all).toContain(`[${type}]`)
  expect(all).toContain('冲突')
  expect(searchTypedNotes(r, '审批', { all: true })).toContain('lessons/b.md')
  expect(searchTypedNotes(r, '缓存', { all: true })).toContain('notes/lesson/b.md')
  expect(listTypedNotes(r, { type: 'goal' })).not.toContain('[lesson]')
})

it('严格写入格式不妨碍旧文件读搜，新原则为候选，旧名不得覆盖', () => {
  const r = root()
  put(r, 'lessons/old.md', '历史裸正文')
  const input = { name: 'new', title: '新原则', description: '决策时读', body: '正文' }
  expect(() => writeTypedNote(r, input, 'principle')).toThrow('判断')
  expect(() => writeTypedNote(r, input, 'lesson')).toThrow('症状')
  expect(() => writeTypedNote(r, input, 'goal')).toThrow('这件事是什么')
  const body = '## 判断\n做法\n## 适用边界\n条件\n## 依据\nturn 1'
  writeTypedNote(r, { ...input, body }, 'principle')
  const text = readFileSync(join(r, '.simple-code/notes/principle/new.md'), 'utf8')
  expect(text).toContain('status: candidate')
  expect(text).toContain('type: principle')
  expect(() => writeTypedNote(r, { ...input, body }, 'principle')).toThrow('已存在')
  expect(searchTypedNotes(r, '历史裸正文')).toContain('old')
})

it('状态和时间收起沿用语义，原则不按年龄收起', () => {
  const r = root()
  const old = '---\ncreated: 2000-01-01\nlastRead: 2000-01-01\n'
  put(r, 'notes/old.md', `${old}---\n旧记录`)
  put(r, 'notes/sup.md', `${old}status: superseded\n---\n旧结论`)
  put(r, 'principles/rule.md', `${old}status: active\n---\n旧原则`)
  expect(listTypedNotes(r)).not.toContain('[general] old')
  expect(listTypedNotes(r)).toContain('[general] sup')
  expect(listTypedNotes(r)).toContain('[principle] rule')
  expect(listTypedNotes(r, { all: true })).toContain('[general] old')
})

it('旧 lesson 无 lastRead 时按 mtime 回退，不能被历史 created 误收起', () => {
  const r = root()
  put(r, 'lessons/old.md', '---\ncreated: 2000-01-01\n---\n近期修订的教训')
  expect(listTypedNotes(r)).toContain('[lesson] old')
  expect(searchTypedNotes(r, '近期修订')).toContain('old')
})
