/** 四类型共用检索/写入；旧格式只读时不强制满足新写入格式。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { decayCutoff, decayNotice, parseStamp } from './decay.ts'
import { LESSON_SECTIONS } from './lesson.ts'
import { type NoteFile, type NoteType, noteWritePath, scanNoteFiles } from './note-files.ts'
import { matchTerms, splitSearchTerms } from './search-terms.ts'
import { localStamp } from './timestamp.ts'

type QueryOptions = { type?: NoteType; all?: boolean }
type WriteInput = { name: string; title: string; description: string; body: string }

export function noteFileSignal(file: NoteFile): number | null {
  // 历史 lesson 缺 lastRead 时一直使用 mtime，不能因统一类型改用旧 created 将其隐藏。
  const stamp = parseStamp(
    file.meta.lastRead ?? (file.type === 'lesson' ? '' : file.meta.created) ?? '',
  )
  return stamp ?? (file.type === 'lesson' ? Math.max(...file.copies.map((c) => c.mtimeMs)) : null)
}

function hidden(file: NoteFile, all?: boolean): boolean {
  if (
    all ||
    file.conflict ||
    file.issue ||
    file.type === 'principle' ||
    file.type === 'goal' ||
    file.meta.status === 'superseded'
  )
    return false
  const signal = noteFileSignal(file)
  return signal !== null && signal < decayCutoff()
}

function label(file: NoteFile): string {
  const state = file.meta.status ? `（${file.meta.status}）` : ''
  const issue = file.conflict ? '【同类型同名内容冲突】' : file.issue ? `【${file.issue}】` : ''
  return `[${file.type}] ${file.name}${state}${issue}${file.meta.description ? ` — ${file.meta.description}` : ''}`
}

export function listTypedNotes(root: string, options: QueryOptions = {}): string {
  const entries = scanNoteFiles(root, options.type).sort(
    (a, b) => (noteFileSignal(b) ?? 0) - (noteFileSignal(a) ?? 0) || a.name.localeCompare(b.name),
  )
  const visible = entries.filter((f) => !hidden(f, options.all))
  const lines = visible.map(
    (f) =>
      `- ${label(f)}${f.copies.length > 1 ? `\n  ${f.copies.map((c) => c.path).join('\n  ')}` : ''}`,
  )
  const count = entries.length - visible.length
  if (count) lines.push(decayNotice(count))
  return lines.join('\n') || '（还没有 note。用 note write 写入。）'
}

export function searchTypedNotes(root: string, query: string, options: QueryOptions = {}): string {
  const terms = splitSearchTerms(query)
  if (!terms.length) throw new Error('search 需要关键词，如 note search 审批')
  const hits: { count: number; line: string }[] = []
  let hiddenCount = 0
  for (const file of scanNoteFiles(root, options.type)) {
    const matches = file.copies
      .map((copy) => ({ copy, hit: matchTerms(copy.text, terms) }))
      .filter((m) => m.hit)
    if (!matches.length) continue
    if (hidden(file, options.all)) {
      hiddenCount++
      continue
    }
    // 冲突的每份原文必须可搜；相同副本则不重复渲染正文。
    for (const { copy, hit } of file.conflict ? matches : matches.slice(0, 1)) {
      const window = copy.text.slice(Math.max(0, hit!.at - 40), hit!.at + 80).replace(/\s+/g, ' ')
      hits.push({ count: hit!.count, line: `  ${label(file)}\n    ${copy.path}\n    …${window}…` })
    }
  }
  hits.sort((a, b) => b.count - a.count)
  const body = hits.length
    ? `${hits.length} 条命中：\n${hits.map((h) => h.line).join('\n')}`
    : `没有 note 命中「${query}」。`
  return hiddenCount ? `${body}\n${decayNotice(hiddenCount)}` : body
}

export function noteSection(body: string, name: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${name}`)
  if (start < 0) return ''
  let end = start + 1
  while (end < lines.length && !/^#{1,2} /.test(lines[end]!)) end++
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
}

export function validateNoteBody(body: string, type: NoteType): void {
  const required: Record<NoteType, readonly string[]> = {
    general: [],
    lesson: LESSON_SECTIONS.map((s) => s.label),
    principle: ['判断', '适用边界', '依据'],
    goal: ['这件事是什么', '目标', '当前范围与边界', '怎样算达到目标'],
  }
  const missing = required[type].filter((section) => !noteSection(body, section))
  // 旧手工原则使用「来源与推导」，可读和生效均接受；不要求为升级重写真实文件。
  if (type === 'principle' && noteSection(body, '来源与推导')) {
    const index = missing.indexOf('依据')
    if (index >= 0) missing.splice(index, 1)
  }
  if (missing.length)
    throw new Error(`${type} 缺少非空正文节：${missing.map((s) => `## ${s}`).join('、')}`)
}

export function writeTypedNote(
  root: string,
  input: WriteInput,
  type: NoteType = 'general',
): string {
  const name = input.name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-\u4e00-\u9fff]/g, '')
  if (!name) throw new Error('name 不能为空')
  if (!input.title.trim() || /[\r\n]/.test(input.title)) throw new Error('title 需要非空单行标题')
  validateNoteBody(input.body, type)
  const path = noteWritePath(root, name, type)
  const description = input.description.replace(/\s+/g, ' ').trim() || input.title.trim()
  const status = type === 'principle' ? 'candidate' : 'active'
  const text = `---\nname: ${name}\ntype: ${type}\ndescription: ${description}\nstatus: ${status}\ncreated: ${localStamp()}\n---\n\n# ${input.title.trim()}\n\n${input.body.trim()}\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
  return `已写入 ${path}（${type}/${name}）`
}
