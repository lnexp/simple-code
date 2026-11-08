import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { estimateTextTokens } from '../src/loop/tokens.ts'
import { buildNoteBudget } from '../src/session/note-budget.ts'
import { loadSelectorCandidates, parseSelection } from '../src/session/selector.ts'
import { loadTouchContext } from '../src/session/touch-cue.ts'

const roots: string[] = []
function fixture() {
  mkdirSync('.simple-code/tmp/note-budget-tests', { recursive: true })
  const root = mkdtempSync(resolve('.simple-code/tmp/note-budget-tests/case-'))
  roots.push(root)
  return root
}
function put(root: string, path: string, meta: string, body: string) {
  const p = join(root, '.simple-code', path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `---\n${meta}\n---\n${body}`)
}
const goal = (text: string) =>
  `## 这件事是什么\n事\n## 目标\n${text}\n## 当前范围与边界\n不可越权\n## 怎样算达到目标\n有证据`
const principle = '## 判断\n先验证\n## 适用边界\n不可跳过安全\n## 依据\n用户 turn 1 已认可'
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

it('原则只收 active、LRU，当前目标不随历史读取切换，引用不常驻', () => {
  const root = fixture()
  put(root, 'notes/goal/now.md', 'status: active\ncurrent: true', goal('当前目标'))
  put(root, 'notes/goal/old.md', 'status: active\nlastRead: 2099-01-01', goal('历史目标'))
  put(root, 'principles/rule.md', 'status: active', principle)
  put(root, 'notes/principle/candidate.md', 'status: candidate', principle)
  const result = buildNoteBudget(root)
  expect(result.text).toContain('当前目标')
  expect(result.text).not.toContain('历史目标')
  expect(result.text).not.toContain('candidate')
  expect(result.text).not.toContain('turn 1')
  expect(result.text).toContain('不可跳过安全')
  expect(estimateTextTokens(result.text!)).toBeLessThanOrEqual(2100)
})

it('goal 超份额借额度，完整且总量不增加，优先使用空余再减少其他条目', () => {
  const root = fixture()
  put(root, 'notes/goal/now.md', 'status: active\ncurrent: true', goal('中'.repeat(200)))
  for (let i = 0; i < 30; i++)
    put(root, `notes/n${i}.md`, 'description: 普通记录'.repeat(1), '正文')
  const result = buildNoteBudget(root, {
    noteBudgetTokens: 400,
    noteRatios: { general: 0.7, lesson: 0.1, principle: 0.1, goal: 0.1 },
  })
  expect(result.text).toContain('中'.repeat(200))
  expect(result.text).toContain('不可越权')
  expect(estimateTextTokens(result.text!)).toBeLessThanOrEqual(400)
})

it('超总量截断、多个当前目标降级取首个——都不阻塞；缺节原则报告但不作规则', () => {
  const root = fixture()
  put(root, 'notes/goal/a.md', 'status: active\ncurrent: true', goal('中'.repeat(5000)))
  const over = buildNoteBudget(root)
  expect(over.text).toContain('#### 目标')
  expect(over.text).toContain('已截断')
  expect(estimateTextTokens(over.text!)).toBeLessThanOrEqual(2100)
  expect(over.warnings.join()).toContain('a 渲染超预算')
  put(root, 'notes/goal/b.md', 'status: active\ncurrent: true', goal('另一个'))
  const multi = buildNoteBudget(root)
  expect(multi.text).toContain('### a')
  expect(multi.text).not.toContain('### b')
  expect(multi.warnings.join()).toContain('多个 current goal')
  const other = fixture()
  put(other, 'principles/bad.md', 'status: active', '## 判断\n不完整')
  expect(buildNoteBudget(other).warnings.join()).toContain('bad')
  expect(buildNoteBudget(other).selected).toHaveLength(0)
})

it('不可读 current goal 跳过不阻塞（2026-11-03 降级修复：goal 是 agent 自管的，炸 session 由用户买单）', () => {
  const root = fixture()
  put(root, 'notes/goal/bad.md', 'status: active\ncurrent: true', '## 缺节的正文')
  const result = buildNoteBudget(root)
  expect(result.text ?? '').not.toContain('### bad')
  expect(result.warnings.join()).toContain('bad')
  expect(result.selected).toHaveLength(0)
})

it('同名冲突不注入，LRU 选择，正文边界整条保留', () => {
  const root = fixture()
  put(root, 'principles/a.md', 'status: active\nlastRead: 2000-01-01', principle)
  put(root, 'notes/principle/b.md', 'status: active\nlastRead: 2099-01-01', principle)
  const result = buildNoteBudget(root, {
    noteBudgetTokens: 160,
    noteRatios: { general: 0, lesson: 0, principle: 1, goal: 0 },
  })
  expect(result.selected[0]?.name).toBe('b')
  put(root, 'principles/b.md', 'status: active', principle + '\n冲突')
  expect(buildNoteBudget(root).selected.map((f) => f.name)).not.toContain('b')
})

it('四类型召回与动作联想读取新旧位置；候选/过期/冲突不推，同名不猜', () => {
  const root = fixture()
  put(root, 'notes/shared.md', 'description: note-files.ts', '记录')
  put(root, 'notes/lesson/new.md', 'description: note-files.ts', '旧格式教训')
  put(root, 'principles/shared.md', 'status: active\ndescription: note-files.ts', principle)
  put(root, 'notes/principle/candidate.md', 'status: candidate', principle)
  put(root, 'notes/goal/done.md', 'status: completed', goal('结束'))
  put(
    root,
    'notes/goal/now.md',
    'status: active\ncurrent: true\ndescription: note-files.ts',
    goal('现在'),
  )
  const candidates = loadSelectorCandidates(root)
  expect(candidates.map((c) => `${c.kind}:${c.name}`)).toEqual(
    expect.arrayContaining(['note:shared', 'principle:shared', 'goal:now', 'lesson:new']),
  )
  expect(candidates.map((c) => c.name)).not.toContain('candidate')
  expect(candidates.map((c) => c.name)).not.toContain('done')
  expect(parseSelection('shared', candidates)).toEqual([])
  expect(parseSelection('principle shared', candidates)[0]?.kind).toBe('principle')
  expect(loadTouchContext(root).entries.some((e) => e.c.kind === 'principle')).toBe(true)
  put(root, 'notes/principle/shared.md', 'status: active', principle + '冲突')
  expect(loadSelectorCandidates(root).some((c) => c.kind === 'principle')).toBe(false)
})
