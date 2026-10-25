import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GLOBAL_CONFIG_PATH } from '../config/load.ts'
import { EVENTS_INDEX_LIMIT, eventsDir, loadEvents } from './events.ts'
import { LESSONS_INDEX_LIMIT, lessonsDir } from './lesson.ts'
import { activeNoteCards, listNoteCards, NOTES_INDEX_LIMIT } from './note.ts'

/** 记忆面板的计数（docs/proposals/reflect-trigger.md §3.2）：真实可见性
 *  四元组，不是静态上限。可见数与 system prompt 索引**同源**——直接用
 *  同一套底层数据函数（activeNoteCards / loadEvents / lessons 文件数 +
 *  各自 LIMIT）重算，不另写第二套判定（两套逻辑必漂移，面板数字就撒谎）。
 *  重算口径 = 下一次会话装配将看到的索引；agent 当前眼中的索引要等到
 *  下个压缩点 reloadSystem 才换——差值即「已写未进索引」的真实状态 */
export type LibraryStat = { total: number; visible: number; hidden: number; superseded: number }
export type LastReflect = { date: string; theme: string }
export type MemoryStats = {
  notes: LibraryStat
  lessons: LibraryStat
  events: LibraryStat
  skills: number
  summaries: number
  lastReflect: LastReflect | null
}

export function computeMemoryStats(
  root: string,
  globalDir: string = dirname(GLOBAL_CONFIG_PATH),
): MemoryStats {
  // note：superseded 不进索引也不算收起（主动退场）；active 的前
  // NOTES_INDEX_LIMIT 条常驻，其余被 LRU 挤出 = 收起
  const noteTotal = listNoteCards(root).length
  const noteActive = activeNoteCards(root).length
  const noteVisible = Math.min(noteActive, NOTES_INDEX_LIMIT)
  const notes: LibraryStat = {
    total: noteTotal,
    visible: noteVisible,
    hidden: noteActive - noteVisible,
    superseded: noteTotal - noteActive,
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
  // lessons 按 mtime 倒序取前 LESSONS_INDEX_LIMIT
  const lessonTotal = existsSync(lessonsDir(root))
    ? readdirSync(lessonsDir(root)).filter((f) => f.endsWith('.md')).length
    : 0
  const lessonVisible = Math.min(lessonTotal, LESSONS_INDEX_LIMIT)
  const lessons: LibraryStat = {
    total: lessonTotal,
    visible: lessonVisible,
    hidden: lessonTotal - lessonVisible,
    superseded: 0,
  }
  return {
    notes,
    lessons,
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
