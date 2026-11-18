import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildNoteBudget, DEFAULT_NOTE_BUDGET } from '../src/session/note-budget.ts'
import { loadSelectorCandidates } from '../src/session/selector.ts'
import { noteWritePath, readNoteFile, scanNoteFiles } from '../src/tools/note-files.ts'
import { listTypedNotes, writeTypedNote } from '../src/tools/note-library.ts'
import { lintWiki, wikiIndexSection, wikiRootsOf } from '../src/tools/wiki.ts'

const roots: string[] = []
function workspace() {
  const base = resolve('.simple-code/tmp/wiki-tests')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'case-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function put(root: string, path: string, text: string) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const FOUR = '## 现在怎么工作\n现状\n## 为什么这样\n理由\n## 坑\n坑\n## 没解决的\n无\n'
/** 一条词条；head 是追加在头部的行（aliases/files/verified/status） */
function entry(root: string, name: string, head = 'files: a.ts\nverified: abc1234\n', body = FOUR) {
  put(
    root,
    `.simple-code/notes/wiki/${name}.md`,
    `---\nname: ${name}\ntype: wiki\ndescription: ${name} 机制（a.ts）\n${head}---\n\n# ${name}\n\n${body}`,
  )
}
const index = (root: string, text: string) => put(root, '.simple-code/notes/wiki/index.md', text)
const texts = (root: string) => lintWiki(root, scanNoteFiles(root, 'wiki')).map((p) => p.text)

describe('wiki 类型', () => {
  it('词条在 notes/wiki/；目录页不算词条，名字也不让词条占用；write 缺节拒绝', () => {
    const root = workspace()
    index(root, '## 审批\n- approval — 审批判定\n')
    entry(root, 'approval')
    expect(scanNoteFiles(root).map((f) => `${f.type}:${f.name}`)).toEqual(['wiki:approval'])
    expect(() => noteWritePath(root, 'index', 'wiki')).toThrow('目录页')
    const input = { name: 'fold', title: 'fold', description: '底稿（bridge.ts）' }
    expect(() => writeTypedNote(root, { ...input, body: '## 现在怎么工作\n有' }, 'wiki')).toThrow(
      '## 为什么这样',
    )
    expect(writeTypedNote(root, { ...input, body: FOUR }, 'wiki')).toContain('wiki/fold')
    expect(existsSync(join(root, '.simple-code/notes/wiki/fold.md'))).toBe(true)
    expect(listTypedNotes(root, { type: 'wiki' })).toContain('[wiki] fold')
    expect(loadSelectorCandidates(root).map((c) => `${c.kind}:${c.name}`)).toContain('wiki:fold')
  })

  it('词条不分 note 预算；目录页整页成段、分组降一级；没有目录页不出段', () => {
    const root = workspace()
    put(root, '.simple-code/notes/record.md', '---\nname: record\ndescription: 普通记录\n---\n')
    entry(root, 'approval')
    index(root, '## 审批\n- approval — 审批判定（approval.ts）\n')
    const budget = buildNoteBudget(root, DEFAULT_NOTE_BUDGET)
    expect(budget.selected.map((f) => f.name)).toEqual(['record']) // 前提：普通记录照常入选
    expect(budget.text).not.toContain('approval')
    expect(wikiIndexSection(root)).toBe(
      '## wiki 词条目录（--type wiki；一个机制一条，反思维护，read 时提示是否过时）\n' +
        '### 审批\n- approval — 审批判定（approval.ts）',
    )
    rmSync(join(root, '.simple-code/notes/wiki/index.md'))
    expect(wikiIndexSection(root)).toBeNull()
  })
})

describe('wiki 检查', () => {
  it('对照：目录齐、链接通、别名不重、头部齐时零问题', () => {
    const root = workspace()
    entry(
      root,
      'a',
      'aliases: 翻页, historyPage\nfiles: a.ts\nverified: abc1234\n',
      `${FOUR}见 [[b]]\n`,
    )
    entry(root, 'b', 'aliases: 审批\nfiles: b.ts\nverified: abc1234\n')
    index(root, '## 面板\n- a — 翻页\n## 审批\n- [[b]] — 审批\n')
    expect(texts(root)).toEqual([])
  })

  it('漏列、多列、列作废、断链、别名重复、缺头部各报一条', () => {
    const root = workspace()
    entry(root, 'a', 'aliases: 翻页\nfiles: a.ts\nverified: abc1234\n', `${FOUR}见 [[nope]]\n`)
    entry(root, 'c', 'aliases: 翻页\nfiles: c.ts\n')
    entry(root, 'd', 'status: superseded\nby: a\n')
    index(root, '- a — 翻页\n- ghost — 不存在\n- d — 作废了\n')
    const got = texts(root)
    expect(got).toEqual(
      expect.arrayContaining([
        'index.md 没列 c',
        'index.md 列了不存在的词条 ghost',
        'index.md 仍列着已作废的 d',
        'a 里的 [[nope]] 指向不存在的词条',
        '别名「翻页」同时出现在 a、c',
        'c 头部缺 files 或 verified，读时无法判断是否过时',
      ]),
    )
    expect(got).toHaveLength(6)
  })

  it('没有目录页只报一条，不逐个词条刷屏', () => {
    const root = workspace()
    entry(root, 'a')
    entry(root, 'b')
    const got = texts(root)
    expect(got).toHaveLength(1)
    expect(got[0]).toContain('缺目录页')
  })

  it('补丁路径里只认词条目录，绝对路径归各自的项目根', () => {
    expect(
      wikiRootsOf('/w/p', [
        '.simple-code/notes/wiki/a.md',
        '/w/other/.simple-code/notes/wiki/index.md',
        '.simple-code/notes/record.md',
        'src/wiki/a.md',
      ]),
    ).toEqual(['/w/p', '/w/other'])
  })
})

describe('read 词条时的提示', () => {
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
  function repo() {
    const root = workspace()
    git(root, 'init', '-q')
    put(root, 'src/a.ts', 'v1\n')
    put(root, 'src/other.ts', 'v1\n')
    git(root, 'add', 'src')
    git(root, 'commit', '-qm', 'init')
    return { root, verified: git(root, 'rev-parse', '--short', 'HEAD') }
  }

  it('verified 之后 files 有新提交才提示，只数 files 里的文件', () => {
    const { root, verified } = repo()
    entry(root, 'a', `files: src/a.ts\nverified: ${verified}\n`)
    index(root, '- a — a 机制\n')
    expect(readNoteFile(root, 'a')).not.toContain('新提交') // 对照：没改过不提示
    put(root, 'src/other.ts', 'v2\n')
    git(root, 'commit', '-qam', 'touch other')
    expect(readNoteFile(root, 'a')).not.toContain('新提交')
    put(root, 'src/a.ts', 'v2\n')
    git(root, 'commit', '-qam', 'change a')
    const text = readNoteFile(root, 'a')
    expect(text).toContain(`【verified ${verified} 之后 files 有 1 个新提交`)
    expect(text).toContain('change a')
  })

  it('verified 查不到时明说无法判断；只带本条的检查问题', () => {
    const { root } = repo()
    entry(root, 'a', 'files: src/a.ts\nverified: deadbee\n')
    entry(root, 'b')
    index(root, '- a — a 机制\n')
    const a = readNoteFile(root, 'a')
    expect(a).toContain('无法判断词条是否过时')
    expect(a).not.toContain('没列 b')
    expect(readNoteFile(root, 'b')).toContain('【index.md 没列 b】')
  })
})
