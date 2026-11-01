/**
 * 动作联想（note file-touch-recall-replay；2026-10-26 拍板四条）：agent 的
 * 命令碰到某个文件或某个程序，而某条 note/lesson 的 description 点名了它，
 * 就在工具结果后提一行——同〔recall·async〕的位置与形态。
 *
 * 为什么另起一路而不并进选择器：选择器在轮首看用户消息，失准却发生在动手
 * 时（2026-10-24 grep openai-chat.ts 看到注释就下结论，库里的 DeepSeek note
 * 没被想起）。动作与记忆共用同一个名字，纯字符串就连得上，零模型成本。
 *
 * 噪声控制全来自两周回放（627 轮，每轮 0.27 条、抽样约六成相关）：
 * - 只匹配 description，不匹配正文（正文每轮 4.7 条，太噪）
 * - 文件只认仓库里真实存在的：带目录的按路径后缀认，只写文件名的须全仓
 *   唯一；description 写了目录（loop/run.ts）就只撞那一个
 * - git commit/log/show 与读库命令里的文件名不算（是在说它，不是在碰它）
 * - 命令名整词匹配；cat/grep 这类人人都用的不单独算，git 只认带子命令
 */
import { execFileSync } from 'node:child_process'
import type { Message } from '../llm/types.ts'
import { loadSelectorCandidates, type SelectorCandidate } from './selector.ts'

const EXT = '(?:ts|tsx|mjs|cjs|js|py|json|sql|sh|toml)'
const FILE_RE = new RegExp(`((?:[\\w.\\-]+/)*[\\w\\-]+(?:\\.[\\w\\-]+)*\\.${EXT})(?![\\w\\-])`, 'g')
/** 几乎每个包都有一份，点名它等于没点名 */
const GENERIC = new Set(['package.json', 'settings.json', 'tsconfig.json', 'approval.json', 'mcp.json', 'index.ts', 'types.ts'])
/** 单独出现不算命令名（带子命令时照样生成「git push」这类键） */
const STOP = new Set(
  ('cd ls cat echo printf grep egrep rg sed awk head tail wc sort uniq cut tr xargs find mkdir rm cp mv touch ln ' +
    'chmod test true false date sleep env export set unset source eval exec for while if then do done fi case esac ' +
    'read wait kill ps tee diff file stat which basename dirname realpath python python3 node bash sh zsh pnpm npm ' +
    'git open time cmp md5 jq less more vim nano code').split(' '),
)
/** 包一层再跑真程序：取下一个词 */
const WRAPPERS = new Set(['npx', 'sudo', 'time', 'exec', 'command', 'env', 'nohup'])
const PER_CALL = 2

const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type RepoIndex = ReadonlyMap<string, readonly string[]>
export type TouchEntry = { c: SelectorCandidate; files: string[]; desc: string }
export type TouchHit = { c: SelectorCandidate; via: string }

/** git ls-files 的结果按文件名分桶 */
export function indexRepo(paths: readonly string[]): RepoIndex {
  const out = new Map<string, string[]>()
  for (const p of paths) out.set(baseOf(p), [...(out.get(baseOf(p)) ?? []), p])
  return out
}

function fileTokens(text: string): string[] {
  return [...text.matchAll(FILE_RE)].map((m) => m[1]!.replace(/^\.\//, '')).filter((t) => !GENERIC.has(baseOf(t)))
}

/** 每轮建一次：预先抽出 description 里点名的文件 */
export function indexTouchEntries(candidates: readonly SelectorCandidate[]): TouchEntry[] {
  return candidates.map((c) => ({ c, files: fileTokens(c.text), desc: c.text.replace(/\s+/g, ' ').trim() }))
}

/** 命令里提到、且能落到仓库真实文件的路径 */
function touchedPaths(command: string, repo: RepoIndex): string[] {
  if (/^\s*(cd [^&]+&&\s*)?git (commit|log|show)\b/.test(command)) return []
  const out = new Set<string>()
  for (const tok of fileTokens(command)) {
    const same = repo.get(baseOf(tok)) ?? []
    if (!tok.includes('/')) {
      if (same.length === 1) out.add(same[0]!)
      continue
    }
    for (const p of same) if (p === tok || p.endsWith(`/${tok}`) || tok.endsWith(`/${p}`)) out.add(p)
  }
  return [...out]
}

/** 每段简单命令的「程序」与「程序 子命令」，具体的在前。heredoc 正文与引号
 *  里的内容不是命令（python3 -c "…"、commit message 的换行后第一个词） */
function commandKeys(command: string): string[] {
  const body = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=[\n)]|$)/g, '')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
  const keys: string[] = []
  for (const seg of body.split(/&&|\|\||[;|\n`(]|\$\(/)) {
    const words = seg.trim().split(/\s+/)
    while (words.length > 0 && (/^[A-Za-z_]\w*=/.test(words[0]!) || WRAPPERS.has(words[0]!))) words.shift()
    const prog = baseOf(words[0] ?? '')
    // 小写开头：EOF/PATCH 这类 heredoc 定界符漏网时不当程序
    if (!/^[a-z][\w.+-]*$/.test(prog)) continue
    const sub = words[1] ?? ''
    if (/^[a-z][\w-]*$/.test(sub)) keys.push(`${prog} ${sub}`)
    if (!STOP.has(prog)) keys.push(prog)
  }
  return keys
}

function matchOne(command: string, entries: readonly TouchEntry[], repo: RepoIndex): TouchHit[] {
  // 读库命令（note read 等）：正在看记忆，不是在碰代码
  if (/SIMPLE_CODE_(NOTE|LESSON|EVENT|MEMORY)/.test(command) && !command.includes('APPLY_PATCH')) return []
  const paths = touchedPaths(command, repo)
  const keys = commandKeys(command).map((k) => ({ k, re: new RegExp(`(?<![\\w./-])${escape(k)}(?![\\w-])`, 'i') }))
  const hits: TouchHit[] = []
  for (const e of entries) {
    const file = e.files.find((f) => paths.some((p) => p === f || p.endsWith(`/${f}`)))
    const via = file ?? keys.find((x) => x.re.test(e.desc))?.k
    if (via !== undefined) hits.push({ c: e.c, via })
    if (hits.length === PER_CALL) break
  }
  return hits
}

/** 一步里的全部命令 → 要提醒的条目。exclude（kind:name）= 已在上下文里的 */
export function matchTouch(
  commands: readonly string[],
  entries: readonly TouchEntry[],
  repo: RepoIndex,
  exclude: ReadonlySet<string>,
): TouchHit[] {
  const fresh = entries.filter((e) => !exclude.has(`${e.c.kind}:${e.c.name}`))
  const out = new Map<string, TouchHit>()
  for (const command of commands)
    for (const h of matchOne(command, fresh, repo)) if (!out.has(`${h.c.kind}:${h.c.name}`)) out.set(`${h.c.kind}:${h.c.name}`, h)
  return [...out.values()]
}

export function renderTouch(hits: readonly TouchHit[]): string[] {
  return hits.map((h) => `〔recall·async〕${h.c.kind} ${h.c.name} — ${clip(h.c.text.replace(/\s+/g, ' ').trim(), 80)}（触及: ${h.via}）`)
}

/** 每轮建一次（session 按 turn 缓存）：仓库文件表 + note/lesson 条目。
 *  不是 git 仓库/没装 git → 文件表为空，只剩命令名联想 */
export function loadTouchContext(folder: string): { repo: RepoIndex; entries: TouchEntry[] } {
  let paths: string[] = []
  try {
    paths = execFileSync('git', ['ls-files'], { cwd: folder, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean)
  } catch {
    paths = []
  }
  const candidates = loadSelectorCandidates(folder).filter((c) => c.kind !== 'skill' && c.kind !== 'event')
  return { repo: indexRepo(paths), entries: indexTouchEntries(candidates) }
}

/** 刚执行完的那一步的 bash 命令（末条 assistant 的 tool_call） */
export function stepCommands(messages: readonly Message[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    return m.parts.flatMap((p) => {
      const command = p.type === 'tool_call' && p.name === 'bash' ? (p.input as { command?: unknown } | null)?.command : undefined
      return typeof command === 'string' ? [command] : []
    })
  }
  return []
}
