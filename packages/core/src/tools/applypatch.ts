/**
 * apply_patch：V4A 补丁格式的解析与应用（Lark grammar 是格式权威），
 * 错误口径自己定。
 *
 * 为什么是补丁而不是 python heredoc：编辑意图（old/new 行）直接可见、
 * 没有样板税、多处匹配/找不到的错误信息标准化。CLI 壳在
 * packages/cli/src/apply-patch-bin.ts，经 $SIMPLE_CODE_APPLY_PATCH 进 bash。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DEL = '*** Delete File: '
const UPD = '*** Update File: '
const MOVE = '*** Move to: '
const EOF_MARK = '*** End of File'

export type PatchHunk =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] }

export interface PatchChunk {
  /** @@ 定位行（可多级）。只为可读性，不参与匹配 */
  context: string[]
  /** 原文件里必须连续出现的行（上下文 + `-` 行） */
  oldLines: string[]
  /** 替换后的行（上下文 + `+` 行） */
  newLines: string[]
  /** `*** End of File` 锚：oldLines 必须落在文件末尾 */
  endOfFile: boolean
  added: number
  removed: number
}

const fail = (line: number, msg: string): never => {
  throw new Error(`补丁第 ${line} 行：${msg}`)
}

/** lenient 容错：模型可能把 heredoc 壳一起塞进来，剥掉再解析 */
function stripHeredoc(raw: string): string {
  const m = /^<<'\w+'\n([\s\S]*?)\n\w+\n?$/.exec(raw)
  return m?.[1] ?? raw
}

/** 解析补丁文本为 hunk 列表。语法错误 throw（带行号），不做任何 IO */
export function parsePatch(raw: string): PatchHunk[] {
  const lines = stripHeredoc(raw).split('\n')
  if (lines[0]?.trim() !== BEGIN) fail(1, `补丁必须以 ${BEGIN} 开头`)
  const last = lines[lines.length - 1]?.trim()
  if (last === '' && lines[lines.length - 2]?.trim() !== END) {
    fail(lines.length, `补丁必须以 ${END} 结尾`)
  }
  if (last !== '' && last !== END) fail(lines.length, `补丁必须以 ${END} 结尾`)
  const endIdx = last === '' ? lines.length - 2 : lines.length - 1
  if (endIdx === 0) fail(1, '空补丁：Begin 和 End 之间没有任何文件操作')

  const hunks: PatchHunk[] = []
  let add: { kind: 'add'; path: string; lines: string[] } | null = null
  let upd: { kind: 'update'; path: string; moveTo?: string; chunks: PatchChunk[] } | null = null
  let chunk: PatchChunk | null = null
  const flushChunk = (): void => {
    if (upd && chunk) {
      if (chunk.oldLines.length === 0) {
        fail(chunkLineNo, 'chunk 里没有上下文行或删除行，无法定位（至少给一行上下文）')
      }
      upd.chunks.push(chunk)
    }
    chunk = null
  }
  let chunkLineNo = 0

  for (let i = 1; i < endIdx; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith(ADD) || line.startsWith(DEL) || line.startsWith(UPD)) {
      flushChunk()
      add = null
      upd = null
      if (line.startsWith(ADD)) {
        add = { kind: 'add', path: line.slice(ADD.length).trim(), lines: [] }
        hunks.push(add)
      } else if (line.startsWith(DEL)) {
        hunks.push({ kind: 'delete', path: line.slice(DEL.length).trim() })
      } else {
        upd = { kind: 'update', path: line.slice(UPD.length).trim(), chunks: [] }
        hunks.push(upd)
      }
      continue
    }
    if (add) {
      if (line.startsWith('+')) add.lines.push(line.slice(1))
      else if (line === '') add.lines.push('')
      else fail(i, `Add File 的内容行必须以 + 开头（收到了「${line.slice(0, 40)}」）`)
      continue
    }
    if (upd) {
      if (line.startsWith(MOVE)) {
        upd.moveTo = line.slice(MOVE.length).trim()
        continue
      }
      if (line.trim() === '@@' || line.startsWith('@@ ')) {
        flushChunk()
        chunk = { context: [], oldLines: [], newLines: [], endOfFile: false, added: 0, removed: 0 }
        chunkLineNo = i
        const ctx = line.slice(2).trim()
        if (ctx !== '') chunk.context.push(ctx)
        continue
      }
      if (line.trim() === EOF_MARK) {
        // 不用「if (!chunk) fail()」——TS 的 never-call 不在条件分支里做 narrowing
        if (chunk === null) fail(i, `${EOF_MARK} 只能出现在 @@ chunk 内`)
        else {
          chunk.endOfFile = true
          flushChunk()
        }
        continue
      }
      if (chunk === null) {
        chunk = { context: [], oldLines: [], newLines: [], endOfFile: false, added: 0, removed: 0 }
        chunkLineNo = i
      }
      if (line.startsWith('+')) {
        chunk.newLines.push(line.slice(1))
        chunk.added++
      } else if (line.startsWith('-')) {
        chunk.oldLines.push(line.slice(1))
        chunk.removed++
      } else {
        // 上下文行：规范是单个空格前缀；裸空行/漏写前缀按 lenient 收进上下文
        const content = line.startsWith(' ') ? line.slice(1) : line
        chunk.oldLines.push(content)
        chunk.newLines.push(content)
      }
    }
  }
  flushChunk()
  for (const h of hunks) {
    if (h.kind === 'update' && h.chunks.length === 0) {
      throw new Error(`${h.path}：Update File 至少要一个 @@ chunk`)
    }
  }
  return hunks
}

/** 三级模糊匹配：精确 → 忽略行尾空白 → 两边 trim（兼容 CRLF 的 \r 残留） */
function seekSequence(
  file: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start
  // trailing newline 在 JS split 下会产生末尾 ''（Rust lines() 不会）。eof
  // 锚的「倒数定位」要把它剥掉，否则永远差一行
  const f = eof && file[file.length - 1] === '' ? file.slice(0, -1) : file
  const lastStart = f.length - pattern.length
  if (lastStart < start) return undefined
  const from = eof ? lastStart : start
  const passes: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ]
  for (const eq of passes) {
    for (let i = from; i <= lastStart; i++) {
      let ok = true
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(f[i + j] ?? '', pattern[j] ?? '')) {
          ok = false
          break
        }
      }
      if (ok) return i
    }
  }
  return undefined
}

/** 应用补丁：全部 hunk 在内存中成功才写盘（原子），返回给人看的摘要 */
/**
 * 补丁里的路径解析成绝对路径。相对以工作区根为基准；绝对原样使用——
 * bash 工具本来就全权（python/sed 都能写任意路径），apply_patch 支持
 * 绝对路径不扩大权限面，反而让「改文件走 apply_patch」没有例外（家目录
 * 配置这类工作区外目标不再被迫绕道 python）。曾经是字符串拼接
 * `${cwd}/${path}`，绝对路径被拼成幽灵路径，报「不存在」——文件明明在，
 * 错误信息误导。
 */
const toAbs = (cwd: string, p: string): string => (isAbsolute(p) ? p : join(cwd, p))

export async function applyPatch(cwd: string, raw: string): Promise<string> {
  const hunks = parsePatch(raw)
  const seen = new Set<string>()
  for (const h of hunks) {
    if (seen.has(h.path)) throw new Error(`一个补丁里 ${h.path} 出现了两次`)
    seen.add(h.path)
  }
  const jobs: Job[] = []
  const summary: string[] = []
  for (const h of hunks) {
    const abs = toAbs(cwd, h.path)
    if (h.kind === 'add') {
      if (existsSync(abs)) {
        throw new Error(`${h.path}：已存在，Add File 不能覆盖（要改内容用 Update File）`)
      }
      const content = h.lines.length === 0 ? '' : `${h.lines.join('\n')}\n`
      jobs.push({ abs, content, rm: false, mkdir: true })
      summary.push(`${h.path} +${h.lines.length}/-0（新增）`)
    } else if (h.kind === 'delete') {
      requireExists(abs, h.path)
      jobs.push({ abs, content: null, rm: true, mkdir: false })
      summary.push(`${h.path} 删除`)
    } else {
      summary.push(...planUpdate(cwd, abs, h, jobs))
    }
  }
  for (const j of jobs) writeJob(j)
  return summary.join('\n')
}

/** 通道版补丁内核（note/lesson/skill 的 patch 子命令共用，2026-09-24）。
 *  与裸 apply_patch 的本质差异：**目标由通道的 <name> 锁死**，不由补丁
 *  内容决定——单 hunk、Update、路径与目标一致才落盘。applyPatch 落盘后
 *  调 validate 做通道不变式校验（note 的 front matter / lesson 的五段 /
 *  skill 的非空），抛错即回滚原文件——补丁永远留不下一条破不变式的文件。
 *  这样审批面也不用为通道开口子：自家 bin 固定语义照放（approval 规则 0），
 *  不变式由这里守。 */
export async function patchFile(
  root: string,
  absTarget: string,
  raw: string,
  validate: (patched: string) => void,
): Promise<string> {
  const hunks = parsePatch(raw)
  const h = hunks[0]
  if (hunks.length !== 1 || h?.kind !== 'update') {
    throw new Error('patch 通道只接受单个 Update File（新建走各通道的 write，多文件走 $SIMPLE_CODE_APPLY_PATCH）')
  }
  if (resolve(root, h.path) !== resolve(absTarget)) {
    throw new Error(`补丁目标是 ${h.path}，与要改的文件（${absTarget}）不一致——要改别的文件走 $SIMPLE_CODE_APPLY_PATCH`)
  }
  const original = readFileSync(absTarget, 'utf8')
  const summary = await applyPatch(root, raw)
  try {
    validate(readFileSync(absTarget, 'utf8'))
  } catch (e) {
    writeFileSync(absTarget, original, 'utf8') // 不变式破了不留盘
    throw e
  }
  return summary
}

/** update（含 Move to）的规划：读原文件、逐 chunk 匹配替换、产出写任务 */
function planUpdate(cwd: string, abs: string, h: UpdateHunk, jobs: Job[]): string[] {
  requireExists(abs, h.path)
  const original = readFileSync(abs, 'utf8')
  let file = original.split('\n')
  let pos = 0
  let added = 0
  let removed = 0
  for (const c of h.chunks) {
    const at = seekSequence(file, c.oldLines, pos, c.endOfFile)
    if (at === undefined) {
      throw new Error(
        `${h.path}：找不到要替换的行（第 1 行是「${c.oldLines[0] ?? ''}」）。` +
          '上下文必须与文件当前内容逐行一致；相邻的两处改动分成两个 @@ chunk，' +
          '别把上一处的上下文重复写进下一处',
      )
    }
    file = [...file.slice(0, at), ...c.newLines, ...file.slice(at + c.oldLines.length)]
    pos = at + c.newLines.length
    added += c.added
    removed += c.removed
  }
  const out = file.join('\n')
  const dest = h.moveTo !== undefined ? toAbs(cwd, h.moveTo) : abs
  if (h.moveTo !== undefined) {
    if (existsSync(dest)) throw new Error(`${h.moveTo}：已存在，Move to 不能覆盖`)
    jobs.push({ abs: dest, content: out, rm: false, mkdir: true })
    jobs.push({ abs, content: null, rm: true, mkdir: false })
  } else {
    jobs.push({ abs: dest, content: out, rm: false, mkdir: false })
  }
  return [`${h.moveTo ?? h.path} +${added}/-${removed}`]
}

interface Job {
  abs: string
  content: string | null
  rm: boolean
  /** 新路径的父目录可能不存在（Add File/Move to 到新目录） */
  mkdir: boolean
}

function writeJob(j: Job): void {
  if (j.rm) {
    unlinkSync(j.abs)
    return
  }
  if (j.mkdir) mkdirSync(dirname(j.abs), { recursive: true })
  writeFileSync(j.abs, j.content ?? '')
}

function requireExists(abs: string, display: string): void {
  if (!existsSync(abs)) throw new Error(`${display}：不存在`)
}

type UpdateHunk = Extract<PatchHunk, { kind: 'update' }>
