/**
 * 教训库（.simple-code/lessons/）的读写检索函数。
 *
 * 形态与 memory 一致（用户拍板）：CLI bin 在 bash 里调用，输出可管道
 * 组合（sed 取段、grep 过滤）；write 走 bash，审批规则对 .simple-code/
 * lessons 写放行（用户明示允许）。lesson 格式的权威定义在这里
 * （LESSON_SECTIONS），CLI 和未来的任何入口共用这一套组装。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decayCutoff, decayNotice, parseStamp, splitByDecay } from './decay.ts'
import { stampLastRead } from './last-read.ts'
import { matchTerms, splitSearchTerms } from './search-terms.ts'

/** 五段固定，顺序即展示顺序。key 是 write 参数名（连字符折成驼峰），label 是正文标题 */
export const LESSON_SECTIONS = [
  { key: 'symptom', label: '症状' },
  { key: 'misjudged', label: '当时怎么误判的' },
  { key: 'rootCause', label: '根因' },
  { key: 'fix', label: '修法' },
  { key: 'verified', label: '怎么验证的' },
] as const

export type LessonWriteInput = {
  name: string
  title: string
  description: string
  symptom: string
  misjudged: string
  rootCause: string
  fix: string
  verified: string
}

export const lessonsDir = (root: string) => join(root, '.simple-code', 'lessons')

/** name → 合法文件名：小写、空白/下划线折成 -、去非法字符 */
export function slugifyLessonName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

/** front matter 的 description 单行化（YAML 头里换行会破坏解析） */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export function parseLessonFrontMatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of m[1]?.split('\n') ?? []) {
    const kv = line.match(/^(name|description):\s*(.*)$/)
    if (kv?.[1] === 'name' && kv[2]) out.name = kv[2].trim()
    if (kv?.[1] === 'description' && kv[2]) out.description = kv[2].trim()
  }
  return out
}

export function renderLesson(input: LessonWriteInput): string {
  const sections = LESSON_SECTIONS.map(
    (s) => `## ${s.label}\n\n${String(input[s.key] ?? '').trim()}\n`,
  ).join('\n')
  return `---\nname: ${input.name}\ndescription: ${oneLine(input.description)}\n---\n\n# ${input.title.trim()}\n\n${sections}\n`
}

/** list：全部教训的 name + description（front matter 的程序化消费者）。
 * 默认收起超半年未用，--all 全量（memory-time-decay ②） */
export function listLessons(root: string, all = false): string {
  const dir = lessonsDir(root)
  if (!existsSync(dir)) return '还没有任何教训（.simple-code/lessons/ 不存在）。'
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
  const { visible, hidden } = splitByDecay(files, (f) => lessonSignal(join(dir, f)))
  const rows = (all ? files : visible).map((f) => {
    const fm = parseLessonFrontMatter(readFileSync(join(dir, f), 'utf8'))
    return `  ${f.replace('.md', '')}  —  ${fm.description ?? '(缺 front matter description)'}`
  })
  const head = rows.length === 0 ? '教训库为空。' : `${rows.length} 条教训：\n${rows.join('\n')}`
  return !all && hidden > 0 ? `${head}\n${decayNotice(hidden)}` : head
}

/** 时间衰减信号：fm 的 lastRead（read 心跳盖的），没有则文件 mtime
 *  （lesson 无 created 字段，写入/盖章都会推 mtime） */
export function lessonSignal(file: string): number | null {
  const lr = /^lastRead:\s*(.+)$/m.exec(readFileSync(file, 'utf8'))?.[1]?.trim()
  return (lr ? parseStamp(lr) : null) ?? statSync(file).mtimeMs
}

/**
 * name 清单（system prompt 注入用，2026-09-17 拍板的方案 A）：只列文件名，
 * 一行一条——name 本身就是一症状一文件的症状句（webview-asset-cache、
 * sse-clean-eof-is-not-complete），name 即索引即症状，看到名字就能对上
 * 「是不是在踩这个坑」，对症再 read 全文。与 events 名称索引同一「占位」
 * 哲学：只让 agent 知道「有这个东西」，细节按需捞。
 *
 * 为什么从零注入改为清单注入：实测三目录 86 次 lesson 调用里 write 60 /
 * read 9 / search 1——只写不读，教训库成了档案不是检查表；零注入省了
 * token 但把复用链路堵死（调试受挫想不起来查 + name 不可见导致不知道
 * 有没有对症的）。~5 token/条的常驻成本换「看得见」。
 *
 * mtime 降序（教训是 append-only，无 update——mtime 即记录时间，最近
 * 踩的坑排前面）。空库返回 null 不进段。LEARN…上限对齐 events 的 30。
 */
export const LESSONS_INDEX_LIMIT = 30

export function lessonNamesIndex(root: string): string | null {
  const dir = lessonsDir(root)
  if (!existsSync(dir)) return null
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f.replace('.md', ''), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, LESSONS_INDEX_LIMIT)
    .map((x) => `- ${x.name}`)
  return names.length === 0 ? null : names.join('\n')
}

export function readLesson(root: string, name: string): string {
  const path = join(lessonsDir(root), `${slugifyLessonName(name)}.md`)
  if (!slugifyLessonName(name))
    throw new Error('read 需要 name（kebab-case 文件名），如 lesson read webview-asset-cache')
  if (!existsSync(path))
    throw new Error(`教训 ${slugifyLessonName(name)} 不存在。先 list --all 看全部名字。`)
  const text = readFileSync(path, 'utf8')
  const stamped = stampLastRead(text)
  if (stamped !== null) writeFileSync(path, stamped, 'utf8')
  return stamped ?? text
}

export function searchLessons(root: string, query: string, all = false): string {
  const terms = splitSearchTerms(query)
  if (terms.length === 0) throw new Error('search 需要 query，如 lesson search 缓存')
  const dir = lessonsDir(root)
  if (!existsSync(dir)) return '还没有任何教训。'
  const hits: { n: number; line: string }[] = []
  let hidden = 0
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.md'))
    .sort()) {
    const text = readFileSync(join(dir, f), 'utf8')
    const m = matchTerms(text, terms)
    if (!m) continue
    // 时间衰减：超期命中收起；--all 全量
    const s = lessonSignal(join(dir, f))
    if (!all && s !== null && s < decayCutoff()) {
      hidden++
      continue
    }
    const fm = parseLessonFrontMatter(text)
    const window = text.slice(Math.max(0, m.at - 40), m.at + 80).replace(/\s+/g, ' ')
    hits.push({
      n: m.count,
      line: `  ${f.replace('.md', '')}  —  ${fm.description ?? ''}\n    …${window}…`,
    })
  }
  const body =
    hits.length === 0
      ? `没有教训命中「${query}」。`
      : `${hits.length} 条命中：\n${hits
          .map((h, i) => ({ h, i }))
          .sort((a, b) => b.h.n - a.h.n || a.i - b.i)
          .map((r) => r.h.line)
          .join('\n')}`
  return !all && hidden > 0 ? `${body}\n${decayNotice(hidden)}` : body
}

/** write：五段缺段抛错（缺段的教训没有复读价值）；同名覆盖=修订 */
export function writeLesson(root: string, input: LessonWriteInput): string {
  const name = slugifyLessonName(input.name)
  if (!name) throw new Error('write 需要 name。用症状导向的 kebab-case（如 webview-asset-cache）。')
  const missing = LESSON_SECTIONS.filter((s) => String(input[s.key] ?? '').trim() === '')
  if (missing.length > 0)
    throw new Error(
      `write 五段缺：${missing.map((s) => s.key).join('、')}。每段都要有内容——缺段的教训没有复读价值。`,
    )
  if (!input.title.trim() || !input.description.trim())
    throw new Error(
      'write 需要 title（一句话症状总标题）和 description（front matter 一行，写清治什么症状、什么时候读）。',
    )
  const dir = lessonsDir(root)
  const file = join(dir, `${name}.md`)
  const existed = existsSync(file)
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, renderLesson({ ...input, name }))
  return existed
    ? `已修订 ${name}.md（旧版被整文件覆盖；要找旧版去 memory 归档）。`
    : `已写入 ${name}.md。`
}

/** lesson write 的 stdin 形态：文本 → 五段对象。空文本返回 null（调用方
 * 走 --flag 形态）；非空但不是 JSON 对象**抛错不回退**——静默回退会把
 * 「heredoc 引号打错」伪装成「五段全缺」，查因多绕一圈。字段缺失不在这
 * 层查，writeLesson 的缺段校验对两种形态一视同仁 */
export function parseStdinLessonInput(text: string): Partial<LessonWriteInput> | null {
  if (text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Partial<LessonWriteInput>
    }
    throw new Error('顶层不是对象')
  } catch (e) {
    throw new Error(
      `write 的 stdin 有内容但不是合法 JSON 对象：${e instanceof Error ? e.message : e}。` +
        '五段用 heredoc JSON 传（lesson help 有样例），或去掉 heredoc 用 --flag 形态。',
    )
  }
}
