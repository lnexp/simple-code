import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GLOBAL_CONFIG_PATH } from '../config/load.ts'
import { EVENTS_INDEX_LIMIT, eventsDir, loadEvents } from '../tools/events.ts'
import { scanNoteFiles, type NoteType } from '../tools/note-files.ts'
import { buildNoteBudget, DEFAULT_NOTE_BUDGET, type NoteBudgetConfig } from './note-budget.ts'

/** 记忆面板的计数（docs/proposals/reflect-trigger.md §3.2）：真实可见性
 *  四元组，不是静态上限。可见数与 system prompt 索引**同源**——直接用
 *  同一套 buildNoteBudget / loadEvents 重算，不另写第二套判定。
 *  重算口径 = 下一次会话装配将看到的索引；agent 当前眼中的索引要等到
 *  下个压缩点 reloadSystem 才换——差值即「已写未进索引」的真实状态 */
export type LibraryStat = { total: number; visible: number; hidden: number; superseded: number }
export type LastReflect = { date: string; theme: string }
export type MemoryStats = {
  /** 仅 general；四种 note 类型分别计数，不相互包含。 */
  notes: LibraryStat
  lessons: LibraryStat
  principles: LibraryStat
  goals: LibraryStat
  events: LibraryStat
  skills: number
  summaries: number
  lastReflect: LastReflect | null
}

export function computeMemoryStats(
  root: string,
  globalDir: string = dirname(GLOBAL_CONFIG_PATH),
  budget: NoteBudgetConfig = DEFAULT_NOTE_BUDGET,
): MemoryStats {
  // 新旧目录的同类型同名副本按一个逻辑条目计数。
  const files = scanNoteFiles(root)
  const selected = buildNoteBudget(root, budget).selected
  const stat = (type: NoteType): LibraryStat => {
    const group = files.filter((f) => f.type === type)
    const superseded = group.filter((f) => f.meta.status === 'superseded').length
    const visible = selected.filter((f) => f.type === type).length
    return { total: group.length, visible, hidden: group.length - visible - superseded, superseded }
  }
  // events 按 updated/created 倒序取前 EVENTS_INDEX_LIMIT；无作废概念
  const eventTotal = loadEvents(root).length
  const eventVisible = Math.min(eventTotal, EVENTS_INDEX_LIMIT)
  const events: LibraryStat = {
    total: eventTotal,
    visible: eventVisible,
    hidden: eventTotal - eventVisible,
    superseded: 0,
  }
  return {
    notes: stat('general'),
    lessons: stat('lesson'),
    principles: stat('principle'),
    goals: stat('goal'),
    events,
    skills:
      countSkills(join(root, '.simple-code', 'skills')) + countSkills(join(globalDir, 'skills')),
    summaries: countSummaries(join(root, '.simple-code', 'memory', 'summaries')),
    lastReflect: lastReflectOf(root),
  }
}

const countSkills = (dir: string): number => {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')),
  ).length
}

const countSummaries = (dir: string): number => {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.md')).length
}

/** 上次反思：events/memory-reflect-*.md 里 created（回退 mtime）最新的一条。
 *  失败任务不写收尾事件——这个口径天然 = 上次**成功**的反思 */
const lastReflectOf = (root: string): LastReflect | null => {
  const dir = eventsDir(root)
  if (!existsSync(dir)) return null
  let best: LastReflect | null = null
  let bestAt = 0
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('memory-reflect-') || !f.endsWith('.md')) continue
    const path = join(dir, f)
    const m = /^created:\s*(.+)$/m.exec(readFileSync(path, 'utf8'))
    const at = (m !== null && Date.parse(m[1]!.trim())) || statSync(path).mtimeMs
    if (at > bestAt) {
      bestAt = at
      const d = new Date(at)
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      best = {
        date: `${d.getFullYear()}-${mm}-${dd}`,
        theme: f.slice('memory-reflect-'.length, -'.md'.length),
      }
    }
  }
  return best
}
