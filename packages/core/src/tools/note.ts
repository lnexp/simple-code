/**
 * note：agent 的结论记忆（决策/约定/一次性事实），一笔记一事。
 * 与 lesson（教训库）同目录形态：`<root>/.simple-code/notes/<name>.md`。
 * **与 lesson 的本质差异：lesson 是事件史（append-only，踩坑经过写完
 * 就是历史）；note 是活文档（结论会演进，必须跟着改）**——索引里躺着
 * 过时描述比没有更糟，模型会按旧结论行事。所以有 update，且 created
 * 跨修改保留（「这条结论多老了」的信息不因改写丢失）。
 *
 * 与 lesson 的关键差异——**有 LRU**：描述索引是 system 常驻区的一部分，
 * 条数无上限的话常驻区会被慢慢吃掉。所以文件带 yaml 头记 created/lastRead，
 * 索引只收最近使用的 30 条；被挤出索引的文件**永远不删**，`$SIMPLE_CODE_NOTE
 * list` 全量可列、read 照常——淘汰失去的只是常驻提醒，不是记忆本身。
 *
 * 「最近使用」的定义是 `$SIMPLE_CODE_NOTE read`（工具可见的读取），
 * 不是文件 mtime：git checkout 会把 mtime 全部重置为检出时刻，跨机器
 * 复制后排序失真；yaml 头是文档内容，跟着文件走。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localStamp } from './timestamp.ts'

/** 进 system 索引的最大条数。30 条 × ~20 token ≈ 600 token 常驻成本 */
export const NOTES_INDEX_LIMIT = 30

const notesDir = (root: string) => join(root, '.simple-code', 'notes')

const slug = (name: string) =>
  name.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-\u4e00-\u9fff]/g, '')

export type NoteMeta = { name?: string; description?: string; created?: string; lastRead?: string }

/** 手写解析 yaml 头（与 lesson 的 front matter 同款思路，不引库） */
export function parseNoteMeta(text: string): NoteMeta {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out: NoteMeta = {}
  for (const line of m[1]?.split('\n') ?? []) {
    const kv = line.match(/^(name|description|created|lastRead):\s*(.*)$/)
    if (kv?.[1] === 'name' && kv[2]) out.name = kv[2].trim()
    if (kv?.[1] === 'description' && kv[2]) out.description = kv[2].trim()
    if (kv?.[1] === 'created' && kv[2]) out.created = kv[2].trim()
    if (kv?.[1] === 'lastRead' && kv[2]) out.lastRead = kv[2].trim()
  }
  return out
}

/** yaml 头之后的首个 `# 标题`。只是给人看的门面——索引用的是 front matter
 *  的 description，# 标题不进 system（对齐 lesson 的双字段分工） */
export function noteTitle(text: string): string | undefined {
  const body = text.replace(/^---\s*\n[\s\S]*?\n---/, '')
  return body.split('\n').find((line) => line.startsWith('# '))?.slice(2).trim()
}

export type NoteCard = {
  name: string
  /** 一行描述，进 system 索引 */
  description?: string | undefined
  meta: NoteMeta
  /** LRU 排序键：lastRead ?? created ?? ''——读过最「热」，没读过按创建时间 */
  sortKey: string
}

function loadNotes(root: string): NoteCard[] {
  let files: string[]
  try {
    files = readdirSync(notesDir(root)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files
    .map((f) => {
      const text = readFileSync(join(notesDir(root), f), 'utf8')
      const meta = parseNoteMeta(text)
      return {
        name: f.replace(/\.md$/, ''),
        description: meta.description,
        meta,
        sortKey: meta.lastRead ?? meta.created ?? '',
      }
    })
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
}

/** LRU 序全量卡片（新→旧）。索引取前 NOTES_INDEX_LIMIT 条，list 用全量 */
export function listNoteCards(root: string): NoteCard[] {
  return loadNotes(root)
}

export function writeNote(
  root: string,
  input: { name: string; title: string; description: string; body: string },
): string {
  const name = slug(input.name)
  if (!name) throw new Error('name 不能为空（kebab-case，如 deny-list）')
  if (!input.title.trim()) throw new Error('title 不能为空（# 标题，给人看的门面）')
  // description 单行化（YAML 头里换行破坏解析），与 lesson 同款
  const description = input.description.replace(/\s+/g, ' ').trim() || input.title.trim()
  const exists = () => {
    try {
      readFileSync(join(notesDir(root), `${name}.md`))
      return true
    } catch {
      return false
    }
  }
  if (exists()) throw new Error(`${name} 已存在。note 是活文档，改内容用 update ${name}（静默覆盖会丢旧结论）`)
  const text =
    `---\nname: ${name}\ndescription: ${description}\ncreated: ${localStamp()}\n---\n\n` +
    `# ${input.title.trim()}\n\n${input.body.trim()}\n`
  mkdirSync(notesDir(root), { recursive: true })
  const path = join(notesDir(root), `${name}.md`)
  writeFileSync(path, text, 'utf8')
  return `已写入 ${path}（${name}）`
}

/**
 * 改写一条 note：**给哪段改哪段**（title/description/body 皆可省，省略的
 * 保留旧值）。created 保留；lastRead 更新——修改是比读更强的使用信号，
 * 改过的结论理应浮到 LRU 前排。
 */
export function updateNote(
  root: string,
  name: string,
  patch: { title?: string; description?: string; body?: string },
): string {
  const path = join(notesDir(root), `${slug(name)}.md`)
  let old: string
  try {
    old = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`没有这条 note：${name}（list 看全部；新结论用 write）`)
  }
  const meta = parseNoteMeta(old)
  const oldTitle = noteTitle(old)
  const oldBody = old.replace(/^---\s*\n[\s\S]*?\n---\n?/, '').replace(/^#\s.*\n+/, '').trim()
  const title = patch.title?.trim() || oldTitle || ''
  const description =
    (patch.description ?? '').replace(/\s+/g, ' ').trim() || meta.description || title
  const body = patch.body !== undefined ? patch.body.trim() : oldBody
  if (!patch.title && !patch.description && patch.body === undefined) {
    throw new Error('update 至少给一段（title:/description:/---/正文），全不给就什么都不改了')
  }
  const now = localStamp()
  const text =
    `---\nname: ${slug(name)}\ndescription: ${description}\ncreated: ${meta.created ?? now}\nlastRead: ${now}\n---\n\n` +
    `# ${title}\n\n${body}\n`
  writeFileSync(path, text, 'utf8')
  return `已更新 ${path}（title${patch.title ? '✓' : '—'} description${patch.description ? '✓' : '—'} 正文${patch.body !== undefined ? '✓' : '—'}）`
}

/**
 * 读一条全文，并把 lastRead 更新为现在——这就是 LRU 的心跳。只有走本工具
 * 的读取才算「使用」（bash cat 不更新，裸读是文件给人看的用法）。
 */
export function readNote(root: string, name: string): string {
  const path = join(notesDir(root), `${slug(name)}.md`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`没有这条 note：${name}（$SIMPLE_CODE_NOTE list 看全部）`)
  }
  const now = localStamp()
  const updated = /^---\s*\n[\s\S]*?\n---/.test(text)
    ? text.replace(/^(---\s*\n[\s\S]*?\n---)/, (fm) =>
        /\nlastRead:/.test(fm) ? fm.replace(/\nlastRead:.*$/, `\nlastRead: ${now}`) : fm.replace(/\n---$/, `\nlastRead: ${now}\n---`),
      )
    : `---\ncreated: ${now}\nlastRead: ${now}\n---\n\n${text}` // 裸文件补头——旧格式迁移
  writeFileSync(path, updated, 'utf8')
  return updated
}

/** 全量清单（含被挤出索引的）。人看 + agent 兜底检索两用 */
export function listNotes(root: string): string {
  const cards = loadNotes(root)
  if (cards.length === 0) return '（还没有 note。写："$SIMPLE_CODE_NOTE" write，决策/约定/一次性结论，一笔记一事）'
  return cards
    .map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''}`)
    .join('\n')
}
