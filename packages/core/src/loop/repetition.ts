/** 连续重复至少四次，且重复区至少 320 个字符，才判作输出循环。 */
const MIN_REPETITIONS = 4
const MIN_REPEATED_CHARS = 320
const MIN_UNIT_CHARS = 16
const MAX_UNIT_CHARS = 2048

/** 只保留最近这段正文就够检测，避免超长回答让检测器持有整篇文本。 */
export const REPETITION_SCAN_CHARS = 16_384

/** 检测到重复正文后，下一次请求使用的临时 user 提示。 */
export const REPETITION_RECOVERY_PROMPT =
  'SC 检测到上一轮响应出现重复输出，已中止该响应。\n' +
  '请不要重复上一轮文本，也不要输出写作过程。\n' +
  '请先根据当前工作区状态确认已完成的操作，不要重复已经执行的工具调用，\n' +
  '只继续当前任务；如果无法安全继续，请直接说明原因并停止。'

export type RepetitionMatch = {
  unit: string
  repeats: number
  start: number
}

export class RepetitionDetectedError extends Error {
  readonly match: RepetitionMatch
  readonly afterTool: boolean

  constructor(match: RepetitionMatch, afterTool: boolean) {
    super('检测到正文连续重复')
    this.name = 'RepetitionDetectedError'
    this.match = match
    this.afterTool = afterTool
  }
}

/** 在正文尾部找固定片段的连续重复；不看推理、工具或历史消息。 */
export function findRepeatedSuffix(text: string): RepetitionMatch | null {
  if (text.length < MIN_REPEATED_CHARS) return null
  const maxUnit = Math.min(MAX_UNIT_CHARS, Math.floor(text.length / MIN_REPETITIONS))
  const z = zValues(text.split('').reverse().join(''))
  for (let unitChars = MIN_UNIT_CHARS; unitChars <= maxUnit; unitChars++) {
    if ((z[unitChars] ?? 0) < unitChars * (MIN_REPETITIONS - 1)) continue

    const unit = text.slice(-unitChars)
    let start = text.length - unitChars * MIN_REPETITIONS
    let repeats = MIN_REPETITIONS
    while (start >= unitChars && text.slice(start - unitChars, start) === unit) {
      start -= unitChars
      repeats++
    }
    if (repeats * unitChars >= MIN_REPEATED_CHARS) return { unit, repeats, start }
  }
  return null
}

function zValues(text: string): number[] {
  const z = Array<number>(text.length).fill(0)
  let left = 0
  let right = 0
  for (let i = 1; i < text.length; i++) {
    const initial = i <= right ? Math.min(right - i + 1, z[i - left] ?? 0) : 0
    let match = initial
    while (i + match < text.length && text.charCodeAt(match) === text.charCodeAt(i + match)) match++
    z[i] = match
    if (i + match - 1 > right) {
      left = i
      right = i + match - 1
    }
  }
  return z
}
