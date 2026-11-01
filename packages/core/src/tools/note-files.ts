/** 新旧目录共用文件身份；不自动搬迁，不把新位置视为更权威。
 * CC memdir/memoryTypes.ts 接受缺 type 的历史文件；目录冲突策略是本项目取舍。
 * 此层只发现与定位原文，是否能作为生效规则由常驻/recall 层校验。 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stampLastRead } from './last-read.ts'

export const NOTE_TYPES = ['general', 'lesson', 'principle', 'goal'] as const
export type NoteType = (typeof NOTE_TYPES)[number]
export type NoteFileCopy = { path: string; text: string; mtimeMs: number }
export type NoteFile = {
  type: NoteType
  name: string
  meta: Record<string, string>
  copies: NoteFileCopy[]
  conflict: boolean
  issue?: string
}

export function parseNoteType(value: string): NoteType {
  if (NOTE_TYPES.includes(value as NoteType)) return value as NoteType
  throw new Error(`未知 note 类型：${value}。可用：${NOTE_TYPES.join('、')}`)
}

function directories(root: string, type: NoteType): string[] {
  const base = join(root, '.simple-code')
  const current = type === 'general' ? join(base, 'notes') : join(base, 'notes', type)
  return type === 'lesson' || type === 'principle' ? [current, join(base, `${type}s`)] : [current]
}

export function noteFileMeta(text: string): Record<string, string> {
  const header = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1]
  const meta: Record<string, string> = {}
  for (const line of header?.split('\n') ?? []) {
    const field = /^(name|type|description|created|lastRead|status|by|current):\s*(.*)$/.exec(line)
    if (field) meta[field[1]!] = field[2]!.trim()
  }
  return meta
}

function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.md'))
      .map((f) => join(dir, f.name))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** 每次重读实际文件：旧版进程仍可能向旧位置写，不能缓存一次发现的迁移状态。 */
export function scanNoteFiles(root: string, type?: NoteType): NoteFile[] {
  const entries = new Map<string, NoteFile>()
  for (const kind of type ? [type] : NOTE_TYPES) {
    for (const path of directories(root, kind).flatMap(filesIn)) {
      const name = path.split(/[\\/]/).pop()!.slice(0, -3)
      const copy = { path, text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }
      const key = `${kind}:${name}`
      const existing = entries.get(key)
      if (existing) {
        existing.copies.push(copy)
        existing.conflict ||= existing.copies[0]!.text !== copy.text
        continue
      }
      const meta = noteFileMeta(copy.text)
      const issue =
        meta.type && meta.type !== kind
          ? `${path} 的 type: ${meta.type} 与目录类型 ${kind} 不一致；请核对后修正。`
          : undefined
      entries.set(key, {
        type: kind,
        name,
        meta,
        copies: [copy],
        conflict: false,
        ...(issue ? { issue } : {}),
      })
    }
  }
  return [...entries.values()]
}

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name))
    throw new Error('name 需要文件名，不得包含目录、路径分隔符或空字符。')
}

export function resolveNoteFile(root: string, name: string, type?: NoteType): NoteFile {
  checkName(name)
  const matches = scanNoteFiles(root, type).filter((f) => f.name === name)
  if (!matches.length) throw new Error(`没有这条 note：${name}。用 note list --all 查看。`)
  if (matches.length > 1)
    throw new Error(
      `${name} 存在于多个类型，请用 --type 指定：\n${matches.flatMap((f) => f.copies.map((c) => c.path)).join('\n')}`,
    )
  const entry = matches[0]!
  if (entry.conflict)
    throw new Error(
      `同类型同名内容冲突：${entry.type}/${name}。请按路径查看原文并处理，不自动选择：\n${entry.copies.map((c) => c.path).join('\n')}`,
    )
  return entry
}

export function readNoteFile(root: string, name: string, type?: NoteType): string {
  const entry = resolveNoteFile(root, name, type)
  const copy = entry.copies[0]!
  const warnings = entry.issue ? [entry.issue] : []
  const allowed =
    entry.type === 'goal'
      ? ['active', 'paused', 'completed', 'superseded']
      : entry.type === 'principle'
        ? ['candidate', 'active', 'superseded']
        : ['active', 'superseded']
  if (entry.meta.status && !allowed.includes(entry.meta.status))
    warnings.push(`未知状态：${entry.meta.status}，请修正。`)
  if (entry.meta.status === 'superseded')
    warnings.push(`已作废${entry.meta.by ? `，现行见 ${entry.meta.by}` : ''}`)
  else if (entry.meta.status && entry.meta.status !== 'active')
    warnings.push(`状态：${entry.meta.status}，不作为当前生效规则`)
  let text = copy.text
  // 相同副本只给一份盖章会在下一次扫描制造冲突；也不把一次 read 扩成双写。
  if (entry.copies.length > 1) warnings.push('存在相同副本，未更新 lastRead；请先按路径消除重复。')
  else if (!entry.issue) {
    const stamped = stampLastRead(text)
    if (stamped !== null) {
      writeFileSync(copy.path, stamped, 'utf8')
      text = stamped
    }
  }
  return [...warnings.map((w) => `【${w}】`), text].join('\n')
}

/** 只解析写入位置，不创建文件；实际写入仍必须用 wx 防止覆盖并发创建的文件。 */
export function noteWritePath(root: string, name: string, type: NoteType): string {
  checkName(name)
  const existing = scanNoteFiles(root, type).find((f) => f.name === name)
  if (existing)
    throw new Error(
      `${type}/${name} 已存在，write 不覆盖。修改实际文件：\n${existing.copies.map((c) => c.path).join('\n')}`,
    )
  return join(directories(root, type)[0]!, `${name}.md`)
}
