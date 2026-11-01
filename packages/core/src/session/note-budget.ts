import { estimateTextTokens as tokens } from '../loop/tokens.ts'
import { NOTE_TYPES, type NoteFile, type NoteType, scanNoteFiles } from '../tools/note-files.ts'
import { noteFileSignal, noteSection, validateNoteBody } from '../tools/note-library.ts'

export const DEFAULT_NOTE_RATIOS = { general: 0.35, lesson: 0.1, principle: 0.2, goal: 0.35 }
export type NoteBudgetConfig = { noteBudgetTokens: number; noteRatios: Record<NoteType, number> }
export const DEFAULT_NOTE_BUDGET: NoteBudgetConfig = {
  noteBudgetTokens: 2100,
  noteRatios: DEFAULT_NOTE_RATIOS,
}
export type NoteBudgetResult = { text: string | null; selected: NoteFile[]; warnings: string[] }

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
  goal: ['这件事是什么', '目标', '当前范围与边界', '怎样算达到目标'],
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

function currentGoal(files: NoteFile[], budget: number): NoteFile[] {
  const current = files.filter(
    (f) =>
      f.type === 'goal' && f.meta.current === 'true' && (f.meta.status ?? 'active') === 'active',
  )
  if (current.length > 1)
    throw new Error(
      `多个当前 goal：${current.map((f) => f.name).join('、')}。仅保留一个 current: true。`,
    )
  if (current.some((f) => !noteEligible(f)))
    throw new Error(
      `当前 goal 无法完整读取：${current[0]!.copies.map((c) => c.path).join('、')}。请修正冲突或必填章节。`,
    )
  if (tokens(renderAll(current)) > budget)
    throw new Error(
      `当前 goal 超过 note 总预算 ${budget}，请精简表述；不会截断目标或边界。`,
    )
  return current
}

/** 完整条目按 LRU 选择。goal 先保留，再让其超份额依次占空闲、普通/教训/原则尾部额度。 */
export function buildNoteBudget(
  root: string,
  config: NoteBudgetConfig = DEFAULT_NOTE_BUDGET,
): NoteBudgetResult {
  const files = scanNoteFiles(root)
  const warnings = fileWarnings(files)
  const current = currentGoal(files, config.noteBudgetTokens)
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
  return { text: renderAll(selected) || null, selected, warnings }
}
