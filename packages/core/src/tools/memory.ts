/**
 * $SIMPLE_CODE_MEMORY 的核心：把 .simple-code/memory 的 jsonl/md 变成人能读
 * （模型能读）的形态。为什么需要它：turn jsonl 单行可达 144KB，cat/grep 直接
 * 灌进上下文既炸窗口又切坏 UTF-8；这里按 part 结构裁剪，按 step 分组。
 *
 * step 的划分同 session/store.ts 的权威定义：
 *   stepBoundary = index === 0 || role === 'assistant'
 * 即「从一条 assistant 行起、到下一条 assistant 行之前的全部行」是一个 step。
 * jsonl 侧可独立复算，不需要开 state.db。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { listBucketFiles, resolveBucketFile } from '../session/buckets.ts'
import { openDbReadOnly } from '../session/db.ts'
import { archivePath, ftsSearch, renderStepText } from '../session/search-index.ts'

/** jsonl 一行。parts 走宽松解析——历史数据缺字段不炸 */
export type MemoryLine = { role: string; parts: Record<string, unknown>[] }

const HEAD = 300
const TAIL = 200

/** log 子命令的默认行数。bash 工具描述引用它拼「[-n 20]」——两处同源，
 * 描述永远真话（改这里别忘不了描述，它自己跟着变） */
export const LOG_DEFAULT_LINES = 20

/** 从 cwd 向上冒泡找 .simple-code/memory（bash 的 cwd 可能是子目录） */
export function findMemoryRoot(cwd: string): string | undefined {
  let dir = cwd
  for (;;) {
    const candidate = join(dir, '.simple-code', 'memory')
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) return undefined
    dir = parent
  }
}

/** codepoint 安全裁剪：Array.from 按字符切，中文/emoji 不会碎成乱码 */
export function clip(text: string, head = HEAD, tail = TAIL): string {
  const chars = Array.from(text)
  if (chars.length <= head + tail) return text
  return `${chars.slice(0, head).join('')} …（共 ${chars.length} 字符，已裁剪）… ${chars.slice(-tail).join('')}`
}

export function parseLines(text: string): MemoryLine[] {
  const out: MemoryLine[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const obj = JSON.parse(line) as { role?: unknown; parts?: unknown }
      out.push({
        role: typeof obj.role === 'string' ? obj.role : '?',
        parts: Array.isArray(obj.parts) ? (obj.parts as Record<string, unknown>[]) : [],
      })
    } catch {
      // 坏行跳过——读历史不该因为一行坏数据全盘失败
    }
  }
  return out
}

/** 按 assistant 边界切 step。返回数组的下标 +1 就是「turn 内 step 号」（covers: 1-3 的口径） */
export function splitSteps(lines: MemoryLine[]): MemoryLine[][] {
  const steps: MemoryLine[][] = []
  for (const [i, line] of lines.entries()) {
    if (i === 0 || line.role === 'assistant') steps.push([line])
    else steps[steps.length - 1]?.push(line)
  }
  return steps
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function renderPart(part: Record<string, unknown>, full: boolean): string[] {
  const out: string[] = []
  switch (part.type) {
    case 'text':
      out.push(`  text      ${full ? str(part.text) : clip(str(part.text))}`)
      break
    case 'reasoning':
      out.push(`  reasoning ${full ? str(part.text) : clip(str(part.text))}`)
      break
    case 'tool_call': {
      const input = part.input as Record<string, unknown> | undefined
      const cmd = str(input?.command)
      out.push(`  tool_call ${str(part.name)}  ${clip(cmd, 200, 100)}`)
      break
    }
    case 'tool_result': {
      const err = part.isError ? '（错误）' : ''
      out.push(`  output${err}  ${full ? str(part.output) : clip(str(part.output))}`)
      break
    }
    default:
      out.push(`  ${String(part.type ?? '?')} …`)
  }
  return out
}

/** step 范围参数："3" 或 "3-5" */
export function parseStepRange(arg: string): { from: number; to: number } | undefined {
  const m = /^(\d+)(?:-(\d+))?$/.exec(arg)
  if (!m) return undefined
  const from = Number(m[1])
  return { from, to: m[2] === undefined ? from : Number(m[2]) }
}

export function renderTurn(
  lines: MemoryLine[],
  opts: { range?: { from: number; to: number } | undefined; full?: boolean | undefined } = {},
): string {
  const steps = splitSteps(lines)
  const out: string[] = [`${steps.length} steps`]
  steps.forEach((step, idx) => {
    const no = idx + 1
    if (opts.range && (no < opts.range.from || no > opts.range.to)) return
    out.push(...renderStep(step, no, opts.full ?? false))
  })
  return out.join('\n')
}

/** 单个 step 的渲染行。renderTurn 与 search --ctx 共用同一套排版 */
function renderStep(step: MemoryLine[], no: number, full: boolean): string[] {
  const roles = [...new Set(step.map((l) => l.role))].join('/')
  return [
    `── step ${no}（${step.length} 行，${roles}）`,
    ...step.flatMap((l) => l.parts.flatMap((p) => renderPart(p, full))),
  ]
}

/** 一行里可检索的文本段。tool_call 检索命令本身——「当时跑了什么」是高频问法 */
export function searchable(line: MemoryLine): { kind: string; text: string }[] {
  const out: { kind: string; text: string }[] = []
  for (const p of line.parts) {
    if (p.type === 'text' || p.type === 'reasoning')
      out.push({ kind: String(p.type), text: str(p.text) })
    else if (p.type === 'tool_call') {
      const input = p.input as Record<string, unknown> | undefined
      out.push({ kind: 'tool_call', text: str(input?.command) })
    } else if (p.type === 'tool_result') out.push({ kind: 'output', text: str(p.output) })
  }
  return out
}

/** codepoint 安全的命中窗口 */
export function windowAround(text: string, at: number, span = 160): string {
  const chars = Array.from(text)
  const cp = Array.from(text.slice(0, at)).length // byte-ish 索引 → codepoint 位置
  const from = Math.max(0, cp - span)
  const to = Math.min(chars.length, cp + span)
  return `${from > 0 ? '…' : ''}${chars.slice(from, to).join('')}${to < chars.length ? '…' : ''}`
}

export async function runShow(
  cwd: string,
  turnArg: string,
  opts: { steps?: string | undefined; full?: boolean } = {},
): Promise<string> {
  const root = findMemoryRoot(cwd)
  if (!root) throw new Error('找不到 .simple-code/memory（从工作区目录内调用）')
  // last = 最大号。统计「上次任务干了什么」时省一次 ls | tail
  const no = turnArg === 'last' ? await latestTurn(root) : Number(turnArg)
  if (!Number.isInteger(no) || no < 1) throw new Error(`turn 参数「${turnArg}」无效，应为数字如 12`)
  const file = resolveBucketFile(root, 'turns', `turn-${String(no).padStart(6, '0')}.jsonl`)
  if (!existsSync(file)) throw new Error(`turn ${no} 不存在（${file}）`)
  const range = opts.steps === undefined ? undefined : parseStepRange(opts.steps)
  if (opts.steps !== undefined && !range)
    throw new Error(`--steps「${opts.steps}」无效，应为 3 或 3-5`)
  return `turn ${no}\n${renderTurn(parseLines(await readFile(file, 'utf8')), { range, full: opts.full })}\n`
}

async function latestTurn(root: string): Promise<number> {
  const files = listBucketFiles(root, 'turns', '.jsonl') // 平铺 + 桶两层
  const nos = files.map((f) => Number(basename(f).replace(/\D/g, ''))).filter(Number.isInteger)
  if (nos.length === 0) throw new Error('turns 目录是空的')
  return Math.max(...nos)
}

/**
 * 每 turn 一行的总览，近似 git log 的「先扫一眼再下钻」。我的高频路径：
 * 「上次任务做到哪了」——不用再 ls turns + show 逐个翻。首列取该 turn
 * 第一条 user 消息的文本截断（换行压平），那是一个 turn 最稳的「标题」
 */
export async function runLog(cwd: string, opts: { n?: number | undefined } = {}): Promise<string> {
  const root = findMemoryRoot(cwd)
  if (!root) throw new Error('找不到 .simple-code/memory（从工作区目录内调用）')
  const n = opts.n ?? LOG_DEFAULT_LINES
  const files = listBucketFiles(root, 'turns', '.jsonl')
  const out: string[] = []
  for (const f of files.slice(-n)) {
    const no = Number(basename(f).replace(/\D/g, ''))
    const lines = parseLines(await readFile(f, 'utf8'))
    const firstUser = lines.find((l) => l.role === 'user')
    const text = str((firstUser?.parts[0] as { text?: string } | undefined)?.text)
    const head = text.replace(/\s+/g, ' ').slice(0, 72)
    out.push(
      `turn ${String(no).padStart(3, ' ')}  ${String(splitSteps(lines).length).padStart(3)} steps  ${head}`,
    )
  }
  return out.join('\n')
}

export type SearchHit = { where: string; kind: string; excerpt: string }
/** --ctx：命中所在 step 的完整渲染（排版与 show 相同），看前后文不用再跑一次 show */
export type SearchHitWithContext = SearchHit & { context?: string[] }

export async function runSearch(
  cwd: string,
  query: string,
  opts: { max?: number | undefined; perFile?: number | undefined; ctx?: boolean } = {},
): Promise<SearchHitWithContext[]> {
  const root = findMemoryRoot(cwd)
  if (!root) throw new Error('找不到 .simple-code/memory（从工作区目录内调用）')
  const max = opts.max ?? 25
  const perFile = opts.perFile ?? 3
  // turns 走 FTS 倒排（有 db 且查询切得出 term 时）；FTS 是词/短语匹配，
  // 英文子串（搜 oldest 命中 pickoldeststeps 内部）会漏——命中为空时回退
  // 老全扫兜底。summaries 永远走轻量文件扫描（MB 级，不值得进索引）
  const turns =
    (await tryFtsTurns(root, query, max, perFile, opts.ctx === true)) ??
    (await scanTurns(root, query, max, perFile, opts.ctx === true))
  return [...turns, ...(await scanSummaries(root, query, max, perFile))].slice(0, max)
}

/** FTS 查询。返回 null = 用不了（无 db / 切不出 term / 0 命中），调用方回退老扫描 */
async function tryFtsTurns(
  root: string,
  query: string,
  max: number,
  perFile: number,
  ctx: boolean,
): Promise<SearchHitWithContext[] | null> {
  const dbPath = join(root, 'state.db')
  if (!existsSync(dbPath)) return null
  let db: ReturnType<typeof openDbReadOnly> | undefined
  try {
    db = openDbReadOnly(dbPath)
    const rows = ftsSearch(db, query, max * perFile)
    if (rows.length === 0) return null
    const hits: SearchHitWithContext[] = []
    const perTurn = new Map<number, number>()
    for (const r of rows) {
      if (hits.length >= max) break
      const seen = perTurn.get(r.turn) ?? 0
      if (seen >= perFile) continue
      const text = await renderStepText(root, r.turn, r.step)
      if (text === null) continue // 幽灵 turn：归档文件不在，跳过
      const at = firstHitAt(text, query)
      const hit: SearchHitWithContext = {
        where: `turn-${String(r.turn).padStart(6, '0')}:step${r.step}`,
        // FTS 按 step 聚合索引，分不出段落类型，kind 统一 text（excerpt 里看得见原文）
        kind: 'text',
        excerpt: at === -1 ? text.slice(0, 160) : windowAround(text, at),
      }
      if (ctx) {
        const steps = splitSteps(
          parseLines(
            await readFile(resolveBucketFile(root, 'turns', basename(archivePath(r.turn))), 'utf8'),
          ),
        )
        const step = steps[r.step - 1]
        if (step) hit.context = renderStep(step, r.step, false)
      }
      hits.push(hit)
      perTurn.set(r.turn, seen + 1)
    }
    return hits
  } catch {
    return null // 只读连接失败、表不存在等——一切回退老路径
  } finally {
    db?.close()
  }
}

/** query 里第一个在 text 里找得到的片段（FTS 是词命中，完整串可能不是子串） */
function firstHitAt(text: string, query: string): number {
  const lower = text.toLowerCase()
  const direct = lower.indexOf(query.toLowerCase())
  if (direct !== -1) return direct
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = lower.indexOf(term)
    if (at !== -1) return at
  }
  return -1
}

/** turns 的全量文件扫描（老路径，FTS 的兜底 + 无 db 夹具的默认） */
async function scanTurns(
  root: string,
  query: string,
  max: number,
  perFile: number,
  ctx: boolean,
): Promise<SearchHitWithContext[]> {
  const needle = query.toLowerCase()
  const hits: SearchHitWithContext[] = []
  const files = listBucketFiles(root, 'turns', '.jsonl')
  for (const f of files) {
    if (hits.length >= max) break
    const steps = splitSteps(parseLines(await readFile(f, 'utf8')))
    let inFile = 0
    for (const [idx, step] of steps.entries()) {
      if (inFile >= perFile || hits.length >= max) break
      for (const line of step) {
        for (const seg of searchable(line)) {
          const at = seg.text.toLowerCase().indexOf(needle)
          if (at === -1) continue
          const hit: SearchHitWithContext = {
            where: `${basename(f).replace('.jsonl', '')}:step${idx + 1}`,
            kind: seg.kind,
            excerpt: windowAround(seg.text, at),
          }
          if (ctx) hit.context = renderStep(step, idx + 1, false)
          hits.push(hit)
          inFile++
          break
        }
      }
    }
  }
  return hits
}

/** summaries 的轻量文件扫描（永不进 FTS：MB 级、涨得慢） */
async function scanSummaries(
  root: string,
  query: string,
  max: number,
  perFile: number,
): Promise<SearchHitWithContext[]> {
  const needle = query.toLowerCase()
  const hits: SearchHitWithContext[] = []
  for (const f of listBucketFiles(root, 'summaries', '.md')) {
    if (hits.length >= max) break
    let inFile = 0
    const lines = (await readFile(f, 'utf8')).split('\n')
    for (const [i, text] of lines.entries()) {
      if (inFile >= perFile || hits.length >= max) break
      const at = text.toLowerCase().indexOf(needle)
      if (at === -1) continue
      hits.push({
        where: `${relative(root, f)}:${i + 1}`,
        kind: 'summary',
        excerpt: windowAround(text, at),
      })
      inFile++
    }
  }
  return hits
}
