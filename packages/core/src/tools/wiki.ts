/**
 * wiki 词条（note 第五类型，`.simple-code/notes/wiki/`）的目录页、过时提示与检查。
 *
 * 词条由反思任务维护（reflect.ts 任务书）：一个机制一条、原地改写；目录页
 * index.md 按大块分组、每条一行，全文常驻 system prompt。不走 note 的 LRU
 * 索引：词条和普通记录挤同一份额度时，排在后面的被挤出，主任务就不知道
 * 有这条（2026-11-13 用户定：回到 t21615/t21627 的设计——独立类型 + 目录页，
 * 推翻 t21629 的「general 加 wiki- 前缀」，那次改动没单独请用户定）。
 *
 * 检查只提示、不拦截：read 只报本条的，NOTE lint / write 与 APPLY_PATCH
 * 改到词条目录时报全部。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { NoteFile } from './note-files.ts'

export const WIKI_INDEX_NAME = 'index'
export const WIKI_SECTIONS = ['现在怎么工作', '为什么这样', '坑', '没解决的'] as const
export type WikiProblem = { entries: string[]; text: string }

const indexPath = (root: string): string =>
  join(root, '.simple-code', 'notes', 'wiki', `${WIKI_INDEX_NAME}.md`)

function readIndex(root: string): string | null {
  try {
    return readFileSync(indexPath(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** system prompt 的目录段；没有目录页 = 没有段 */
export function wikiIndexSection(root: string): string | null {
  const text = readIndex(root)?.trim()
  if (!text) return null
  // 目录页用 ## 分组；嵌进 notes 段要降一级，否则和「## note 普通记录」同级
  return `## wiki 词条目录（--type wiki；一个机制一条，反思维护，read 时提示是否过时）\n${text.replace(/^(#{1,5}) /gm, '#$1 ')}`
}

/** 目录页里每个列表项开头的名字（`- name — …` 或 `- [[name]] — …`） */
function listedNames(index: string): string[] {
  return [...index.matchAll(/^\s*[-*]\s+(?:\[\[)?([a-z0-9\u4e00-\u9fff-]+)/gm)].map((m) => m[1]!)
}

/** 目录页列着的词条名——常驻的是目录页，「可见」按它算（memory-stats.ts） */
export function wikiListed(root: string): Set<string> {
  return new Set(listedNames(readIndex(root) ?? ''))
}

function indexProblems(root: string, entries: NoteFile[], live: NoteFile[]): WikiProblem[] {
  const index = readIndex(root)
  if (index === null)
    return live.length
      ? [{ entries: [], text: `缺目录页 ${indexPath(root)}，${live.length} 个词条不在目录里` }]
      : []
  const listed = new Set(listedNames(index))
  const byName = new Map(entries.map((e) => [e.name, e]))
  const out = live
    .filter((e) => !listed.has(e.name))
    .map((e) => ({ entries: [e.name], text: `index.md 没列 ${e.name}` }))
  for (const name of listed) {
    const entry = byName.get(name)
    if (!entry) out.push({ entries: [], text: `index.md 列了不存在的词条 ${name}` })
    else if (entry.meta.status === 'superseded')
      out.push({ entries: [name], text: `index.md 仍列着已作废的 ${name}` })
  }
  return out
}

function linkProblems(live: NoteFile[], names: Set<string>): WikiProblem[] {
  return live.flatMap((e) =>
    [...e.copies[0]!.text.matchAll(/\[\[([^\]\n]+)\]\]/g)]
      .map((m) => m[1]!.trim())
      .filter((target) => !names.has(target))
      .map((target) => ({
        entries: [e.name],
        text: `${e.name} 里的 [[${target}]] 指向不存在的词条`,
      })),
  )
}

function aliasProblems(live: NoteFile[]): WikiProblem[] {
  const owners = new Map<string, Set<string>>()
  for (const e of live)
    for (const alias of (e.meta.aliases ?? '').split(/[,，、]/)) {
      const key = alias.trim().toLowerCase()
      if (key) owners.set(key, (owners.get(key) ?? new Set()).add(e.name))
    }
  return [...owners]
    .filter(([, names]) => names.size > 1)
    .map(([alias, names]) => ({
      entries: [...names],
      text: `别名「${alias}」同时出现在 ${[...names].join('、')}`,
    }))
}

function headerProblems(live: NoteFile[]): WikiProblem[] {
  return live
    .filter((e) => !e.meta.files || !e.meta.verified)
    .map((e) => ({
      entries: [e.name],
      text: `${e.name} 头部缺 files 或 verified，读时无法判断是否过时`,
    }))
}

export function lintWiki(root: string, entries: NoteFile[]): WikiProblem[] {
  const live = entries.filter((e) => e.meta.status !== 'superseded')
  const names = new Set(entries.map((e) => e.name))
  return [
    ...indexProblems(root, entries, live),
    ...linkProblems(live, names),
    ...aliasProblems(live),
    ...headerProblems(live),
  ]
}

export function lintReport(root: string, entries: NoteFile[]): string {
  const problems = lintWiki(root, entries)
  return problems.length
    ? `wiki 检查：${problems.length} 处问题（只提示，不拦截）\n${problems.map((p) => `- ${p.text}`).join('\n')}`
    : `wiki 检查：没有问题（${entries.length} 个词条）`
}

/** verified 之后 files 有没有新提交。词条写的是代码现状，代码一改就可能过时；
 *  两次反思之间（最多隔一天）主任务读到的就是这种词条 */
function staleness(root: string, verified: string, files: string[]): string | null {
  let out: string
  try {
    out = execFileSync('git', ['log', '--oneline', `${verified}..HEAD`, '--', ...files], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    })
  } catch (error) {
    const detail = String((error as { stderr?: unknown }).stderr || error).trim()
    return `无法判断词条是否过时（git log ${verified}..HEAD 失败：${detail.split('\n')[0]}）`
  }
  const commits = out.trim().split('\n').filter(Boolean)
  if (!commits.length) return null
  const shown = commits.slice(0, 5).join('；') + (commits.length > 5 ? '；…' : '')
  return `verified ${verified} 之后 files 有 ${commits.length} 个新提交，相关的句子按代码现状核实后再用：${shown}`
}

/** read 一条词条时开头的提示：是否过时 + 涉及本条的检查问题 */
export function wikiReadWarnings(root: string, entry: NoteFile, entries: NoteFile[]): string[] {
  const files = entry.meta.files?.split(/\s+/).filter(Boolean) ?? []
  const stale =
    entry.meta.verified && files.length ? staleness(root, entry.meta.verified, files) : null
  const own = lintWiki(root, entries)
    .filter((p) => p.entries.includes(entry.name))
    .map((p) => p.text)
  return [...(stale ? [stale] : []), ...own]
}

/** 补丁改到的词条目录各属哪个项目根——绝对路径可能指向别的项目的词条 */
export function wikiRootsOf(cwd: string, paths: string[]): string[] {
  const roots = new Set<string>()
  for (const p of paths) {
    const m = /^(.*)[\\/]\.simple-code[\\/]notes[\\/]wiki[\\/][^\\/]+$/.exec(
      isAbsolute(p) ? p : join(cwd, p),
    )
    if (m) roots.add(m[1]!)
  }
  return [...roots]
}
