import { estimateTextTokens as tokens } from '../loop/tokens.ts'
import { NOTE_TYPES, type NoteFile, type NoteType, scanNoteFiles } from '../tools/note-files.ts'
import {
  GOAL_SECTIONS,
  noteFileSignal,
  noteSection,
  validateNoteBody,
} from '../tools/note-library.ts'

const DEFAULT_NOTE_RATIOS = { general: 0.35, lesson: 0.1, principle: 0.2, goal: 0.35 }
export type NoteBudgetConfig = { noteBudgetTokens: number; noteRatios: Record<NoteType, number> }
export const DEFAULT_NOTE_BUDGET: NoteBudgetConfig = {
  noteBudgetTokens: 2100,
  noteRatios: DEFAULT_NOTE_RATIOS,
}
type NoteBudgetResult = { text: string | null; selected: NoteFile[]; warnings: string[] }

export function noteEligible(file: NoteFile): boolean {
  if (file.conflict || file.issue) return false
  const status = file.meta.status ?? (file.type === 'principle' ? 'candidate' : 'active')
  if (status !== 'active') return false
  if (file.type === 'principle' || file.type === 'goal') {
    try {
      validateNoteBody(file.copies[0]!.text, file.type)
    } catch {
      return false
    }
  }
  return true
}

const sectionNames = {
  principle: ['判断', '适用边界'],
  goal: GOAL_SECTIONS,
}
function render(file: NoteFile): string {
  if (file.type === 'general')
    return `- ${file.name}${file.meta.description ? ` — ${file.meta.description}` : ''}`
  if (file.type === 'lesson') return `- ${file.name}`
  return (
    `### ${file.name}\n` +
    sectionNames[file.type]
      .map((s) => `#### ${s}\n${noteSection(file.copies[0]!.text, s)}`)
      .join('\n')
  )
}
const titles = { general: '普通记录', lesson: '教训', principle: '原则', goal: '当前目标' }
function renderAll(files: NoteFile[]): string {
  return NOTE_TYPES.map((type) => {
    const entries = files.filter((f) => f.type === type)
    return entries.length
      ? `## note ${titles[type]}（--type ${type}）\n${entries.map(render).join('\n')}`
      : ''
  })
    .filter(Boolean)
    .join('\n\n')
}

function fileWarnings(files: NoteFile[]): string[] {
  return files
    .filter(
      (f) =>
        f.conflict ||
        f.issue ||
        ((f.type === 'principle' || f.type === 'goal') &&
          f.meta.status === 'active' &&
          !noteEligible(f)),
    )
    .map(
      (f) =>
        `${f.type}/${f.name} 格式缺节、类型不符或新旧内容冲突，请用 NOTE read 或按路径核对：${f.copies.map((c) => c.path).join('、')}`,
    )
}

function currentGoal(files: NoteFile[], warnings: string[]): NoteFile[] {
  let current = files.filter(
    (f) =>
      f.type === 'goal' && f.meta.current === 'true' && (f.meta.status ?? 'active') === 'active',
  )
  if (current.length > 1) {
    // goal 是 agent 自管的（写入/取消 current 都是 agent 做），出问题不该
    // 阻塞 session 让用户买单（2026-11-03 真实用户连炸三次
    // task_session_fail，报错让他「精简表述」，而他不知道 goal 是什么）。
    // 降级：按序取第一个，其余警告
    warnings.push(
      `多个 current goal：${current.map((f) => f.name).join('、')}——按序取 ${current[0]!.name}，其余请取消 current: true`,
    )
    current = [current[0]!]
  }
  return current.filter((f) => {
    if (noteEligible(f)) return true
    // 不可读的 current goal 跳过（fileWarnings 同步报格式问题），不阻塞
    warnings.push(
      `当前 goal ${f.name} 无法完整读取（冲突或缺节），本轮跳过：${f.copies.map((c) => c.path).join('、')}`,
    )
    return false
  })
}

/** goal 渲染超预算：四节标题保住，节内截断，尾注让 agent 每轮可见
 *（常驻区只在压缩点重读，尾注变化不破前缀不变式）。 */
function clipGoal(file: NoteFile, budget: number): string {
  const secs = GOAL_SECTIONS.map((s) => `#### ${s}\n${noteSection(file.copies[0]!.text, s)}`)
  let limit = Math.floor((budget * 2) / GOAL_SECTIONS.length) // 中文 1 token≈1.5-2 字符，从宽起
  for (;;) {
    const text =
      `## note 当前目标（--type goal）\n### ${file.name}\n` +
      secs
        .map((s) =>
          s.length > limit ? `${s.slice(0, limit)}\n…（本节截断，全文 note read ${file.name}）` : s,
        )
        .join('\n') +
      `\n\n> ⚠ 当前 goal 超过 note 总预算 ${budget}，已截断；请精简表述（进展细节移事件档案，目标与边界保留要点）`
    if (tokens(text) <= budget || limit <= 100) return text
    limit = Math.floor(limit * 0.8)
  }
}

/** 完整条目按 LRU 选择。goal 先保留，再让其超份额依次占空闲、普通/教训/原则尾部额度。 */
export function buildNoteBudget(
  root: string,
  config: NoteBudgetConfig = DEFAULT_NOTE_BUDGET,
): NoteBudgetResult {
  const files = scanNoteFiles(root)
  const warnings = fileWarnings(files)
  const current = currentGoal(files, warnings)
  const selected = [...current]
  const eligible = files
    .filter((f) => f.type !== 'goal' && noteEligible(f))
    .sort(
      (a, b) => (noteFileSignal(b) ?? 0) - (noteFileSignal(a) ?? 0) || a.name.localeCompare(b.name),
    )
  for (const type of ['general', 'lesson', 'principle'] as const) {
    const group: NoteFile[] = []
    for (const file of eligible.filter((f) => f.type === type)) {
      if (tokens(renderAll([...group, file])) > config.noteBudgetTokens * config.noteRatios[type])
        break
      group.push(file)
    }
    selected.push(...group)
  }
  for (const type of ['general', 'lesson', 'principle'] as const) {
    while (tokens(renderAll(selected)) > config.noteBudgetTokens) {
      const index = selected.findLastIndex((f) => f.type === type)
      if (index < 0) break
      selected.splice(index, 1)
    }
  }
  // goal 独占预算仍超：截断 goal 而不是阻塞 session（同 currentGoal 注释）
  const clipped =
    current.length === 1 && tokens(renderAll(current)) > config.noteBudgetTokens
      ? clipGoal(current[0]!, config.noteBudgetTokens)
      : null
  return {
    text: clipped ?? (renderAll(selected) || null),
    selected: clipped ? [current[0]!] : selected,
    warnings: clipped
      ? [
          ...warnings,
          `当前 goal ${current[0]!.name} 渲染超预算已截断（原文全量在 note 文件），请精简表述`,
        ]
      : warnings,
  }
}
