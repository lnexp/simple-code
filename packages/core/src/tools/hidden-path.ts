/**
 * 隐藏路径判定的第 2 层：算出命令实际指向的路径，只拦真实存在的
 * （docs/proposals/hidden-path.md，2026-09-29 拍板）。
 *
 * 第 1 层「点开头一律拦」由 approval.ts pathVerdict 按字面判出候选，
 * 候选交给这里：
 * - 真实路径算不出（cd -、命令里自己定义的变量、嵌套结构里的 cd）→ 拦
 * - 算得出、磁盘上不存在 → 放行（新建隐藏文件不拦，用户确认过风险）
 * - 存在 → 查「始终允许」记录（读写分开），没记过 → 拦，并带上可记的键
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ApprovalConfig, ApprovalVerdict } from './approval.ts'
import { expandTilde } from './approval-always.ts'
import type { AstAssign } from './shell-ast.ts'

/** 算真实路径要用的上下文，classify 按段维护 */
export type RealCtx = {
  /** 当前目录；null = 算不出（之后的隐藏候选一律拦） */
  cwd: string | null
  /** 与 bash 工具 spawn 同一份环境 */
  env: Record<string, string>
  /** 命令里自己定义的变量名——值要执行时才知道（vars 里有的除外） */
  localVars: Set<string>
  /** for 循环变量的全部取值（loopValuesOf）；路径 token 逐值代入再判 */
  loopValues: Map<string, string[]>
  /** 命令内赋值执行到当前段时的值（applyAssigns 按段更新）；null = 算不出 */
  vars: Map<string, string | null>
}

/** 路径段是隐藏段：点开头，排除 `.` `..` 与省略号（echo ...） */
export const isHiddenSeg = (p: string): boolean =>
  p.startsWith('.') && p !== '.' && p !== '..' && !/^\.{3,}$/.test(p)

/** 始终允许「肯定不能」的两类（2026-10-29 拍板）：不给键，已批的记录也不算，
 * 每次都弹。凭据类：任一段命中；`.env` 前缀含 .env.local、.envrc 与 `.env*` 通配 */
const CREDENTIAL_SEGS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  '.npmrc',
  '.docker',
  '.zshrc',
  '.bashrc',
  '.zsh_history',
  '.bash_history',
])
/** SC 控制文件：approval.json 能给自己批权限、settings.json 有密钥、memory 是对话记录 */
const SC_GUARDED = new Set(['approval.json', 'settings.json', 'memory'])
export function neverAlways(p: string): boolean {
  const segs = p.split('/')
  return segs.some(
    (s, i) =>
      CREDENTIAL_SEGS.has(s) ||
      s.startsWith('.env') ||
      (s === '.simple-code' && SC_GUARDED.has(segs[i + 1] ?? '')),
  )
}

/** 命令里自己定义的变量：赋值、for 循环变量、read 读入 */
export function localVarsOf(cmd: string): Set<string> {
  const out = assignedVarsOf(cmd)
  for (const m of cmd.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) out.add(m[1]!)
  return out
}

/** for 以外的定义：赋值、read、unset */
function assignedVarsOf(cmd: string): Set<string> {
  const out = readUnsetVarsOf(cmd)
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=/g)) out.add(m[1]!)
  return out
}

function readUnsetVarsOf(cmd: string): Set<string> {
  const out = new Set<string>()
  for (const m of cmd.matchAll(/\bread\s+(?:-\S+\s+)*([A-Za-z_]\w*)/g)) out.add(m[1]!)
  for (const m of cmd.matchAll(/\bunset\s+([^;&|\n]+)/g)) {
    for (const name of m[1]!.split(/\s+/)) if (/^[A-Za-z_]\w*$/.test(name)) out.add(name)
  }
  return out
}

/** read、unset、for 定义的变量：值跟着执行走，applyAssigns 不收 */
export function runtimeVarsOf(cmd: string): Set<string> {
  const out = readUnsetVarsOf(cmd)
  for (const [, name = ''] of cmd.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) out.add(name)
  return out
}

/** 段前的独立赋值按源码顺序生效（2026-10-31）：确定的字面赋值记下展开后的
 * 值，`W=.simple-code/tmp/wt; cd $W` 的 cd 算得出；不确定的（shell-ast
 * AstAssign.definite）、要执行才知道的值 → null，之后用到照旧算不出 */
export function applyAssigns(assigns: AstAssign[] | undefined, real: RealCtx, runtime: Set<string>): void {
  for (const a of assigns ?? []) {
    if (runtime.has(a.name)) continue
    real.vars.set(a.name, a.definite && a.value !== null ? expandToken(a.value, real) : null)
  }
}

/** for 循环变量 → 全部取值。列表到 `;`/换行为止、每个词都是字面量
 * （无 $、引号、通配、花括号、~）且变量没在别处赋值/read/unset 才收——
 * 值就是这几个。任何一处 for 列表不是字面量，这个变量整个不收，照旧
 * 「算不出」（2026-10-29：`for v in a b; do … ../x/$v` 曾一律判隐藏路径） */
export function loopValuesOf(cmd: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const bad = assignedVarsOf(cmd)
  for (const [, name = '', list = ''] of cmd.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b([^;\n]*)/g)) {
    const words = list.trim().split(/\s+/).filter(Boolean)
    if (words.length > 0 && words.every((w) => /^[\w.,:@%+=/-]+$/.test(w))) {
      out.set(name, [...(out.get(name) ?? []), ...words])
    } else bad.add(name)
  }
  for (const name of bad) out.delete(name)
  return out
}

/** token 里的循环变量（$v / ${v}）逐值代入，返回全部组合。没有循环变量
 * 或组合超过 64 个 → 原样（照旧算不出）：嵌套循环的乘积会让一次审批
 * 做成百上千次路径判定 */
export function loopVariants(token: string, loopValues: Map<string, string[]>): string[] {
  let out = [token]
  for (const [name, values] of loopValues) {
    const re = new RegExp(`\\$(?:\\{${name}\\}|${name}(?!\\w))`, 'g')
    if (!token.match(re)) continue
    out = out.flatMap((s) => values.map((v) => s.replace(re, () => v)))
    if (out.length > 64) return [token]
  }
  return out
}

/** token → 绝对路径。shell 引号先去掉（`"$HOME"/.ssh` 的形态），
 * `$VAR`/`${VAR}` 用 env 替换；命令内变量、env 里没有的、其他 `$` 形态
 * （`$1` `${x:-y}`）→ null */
export function realPathOf(token: string, real: RealCtx): string | null {
  const e = expandToken(token, real)
  if (e === null) return null
  if (isAbsolute(e)) return resolve(e)
  return real.cwd === null ? null : resolve(real.cwd, e)
}

/** 含 `..` 的 token → 内核实际访问的绝对路径。`..` 按真实路径回退：
 * 前缀已存在就先 realpath（项目内 `link-to-tmp/..` 是 /tmp 的上级，
 * 不是字面上级），不存在按字面。算不出（变量、当前目录未知）→ null */
export function dotdotPathOf(token: string, real: RealCtx): string | null {
  const e = expandToken(token, real)
  if (e === null || (!isAbsolute(e) && real.cwd === null)) return null
  let cur = '/'
  for (const s of (isAbsolute(e) ? e : `${real.cwd}/${e}`).split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') {
      let r = cur
      try { r = realpathSync(cur) } catch { /* 不存在：按字面 */ }
      cur = dirname(r)
      continue
    }
    cur = cur === '/' ? `/${s}` : `${cur}/${s}`
  }
  return cur
}

/** 去引号、替换变量、展开 ~；有算不出的变量 → null。
 * 引号一律去掉再展开：调用方拿到的 token 已剥过外层引号（approval.ts
 * unquote），分不清 `'$X'` 与 `"$X"`，这里不按引号规则猜 */
function expandToken(token: string, real: RealCtx): string | null {
  let unknown = false
  const t = token.replace(/["']/g, '').replace(/\$(?:\{(\w+)\}|([A-Za-z_]\w*))/g, (_, a, b) => {
    const v = varValue((a ?? b) as string, real)
    if (v === undefined) unknown = true
    return v ?? ''
  })
  if (unknown || t.includes('$')) return null
  return expandTilde(t)
}

/** 命令内确定的赋值 → 命令内其他定义（算不出）→ spawn 环境 */
function varValue(name: string, real: RealCtx): string | undefined {
  if (real.vars.has(name)) return real.vars.get(name) ?? undefined
  return real.localVars.has(name) ? undefined : real.env[name]
}

/** `cd` 的目标。无参数 = 家目录；`cd -` 算不出 */
export function cdTarget(arg: string | undefined, real: RealCtx): string | null {
  if (arg === undefined || arg === '~') return expandTilde('~')
  if (arg === '-') return null
  return realPathOf(arg, real)
}

/** git 的 `REV:path` 写法（`HEAD:.env`、`origin/main:web/.env`、`:.env`）
 * → 冒号后的仓库路径；不是这种写法返回 null。URL（`://`、`git@host:`）不算 */
export function gitRevPath(t: string): string | null {
  // 带空白的不是（`git commit -m 'fix: a/.x'` 的提交说明，2026-10-29 实案）
  if (
    t.startsWith('/') ||
    t.startsWith('~') ||
    t.includes('://') ||
    t.includes('@') ||
    /\s/.test(t)
  )
    return null
  const i = t.indexOf(':')
  return i < 0 ? null : t.slice(i + 1)
}

/** git 历史里的路径：与磁盘读同一套键（`main:.gitignore` 与 `cat .gitignore`
 * 共用 hiddenRead 记录）。不查存在——历史里有、磁盘上不一定有 */
export function revPathVerdict(revPath: string, t: string, cfg: ApprovalConfig): ApprovalVerdict {
  const segs = revPath.split('/')
  // .simple-code 照磁盘：读放行（含 settings.json，用户 09-14 拍板）
  if (!segs.some(isHiddenSeg) || segs[0] === '.simple-code') return { kind: 'allow' }
  const ask = {
    kind: 'ask',
    category: 'hidden_path',
    detail: t,
    reason: `要读取 git 历史里的隐藏路径：${t}`,
  } as const
  if (neverAlways(revPath)) return ask
  if ((cfg.hiddenRead ?? []).some((e) => revPath === e || revPath.startsWith(`${e}/`)))
    return { kind: 'allow' }
  return { ...ask, alwaysHidden: { path: keyOf(revPath), write: false } }
}

/** 始终允许的记录键与匹配位置：项目内用相对路径，项目外用绝对路径。
 * 键 = 截到第一个隐藏段为止（`.idea/encodings.xml` → `.idea`） */
function locOf(abs: string, root: string): string {
  const rel = relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs
}
function keyOf(loc: string): string {
  const segs = loc.split('/')
  const i = segs.findIndex(isHiddenSeg)
  if (i < 0) return loc
  // .simple-code 记到第二级（2026-10-29）：整树一键批会连 approval.json 一起批
  return segs.slice(0, segs[i] === '.simple-code' ? i + 2 : i + 1).join('/')
}

/** 通配只认 `*` `?`、只认最后一段（列父目录匹配）；中间段带通配 → null
 * （算不出）。`[` 按字面——token 可能是整段被剥了引号的代码文本，拿它拼
 * 字符类会构造出非法正则抛错（历史重放实案：python -c 的代码串） */
function globHits(abs: string): boolean | null {
  const dir = dirname(abs)
  if (/[*?]/.test(dir)) return null
  const re = new RegExp(`^${basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  try {
    return readdirSync(dir).some((f) => re.test(f))
  } catch {
    return false
  }
}

/** 算不出实际位置、字面里也没有点开头段的路径（2026-10-31）：如实说算不出，
 * 不挂「隐藏路径」「项目外路径」的牌子——真机 `W=…; cd $W && mvn -s
 * ../../../settings.xml` 被写成「要触碰隐藏路径」，实为项目根的普通文件，
 * 超时拒绝后模型读到的理由也是错的。照样弹、不给始终允许（同 neverAlways 的
 * 算不出一类） */
export function unknownPathAsk(t: string): ApprovalVerdict {
  return {
    kind: 'ask',
    category: 'unparseable',
    detail: t,
    reason: `路径算不出，不确定是否在项目内：${t}（含算不出的变量——命令里才赋值或环境里没有，或之前的 cd 让当前目录无法确定）`,
  }
}

/** 第 1 层判出的隐藏候选 → 第 2 层判定 */
export function hiddenVerdict(
  t: string,
  root: string,
  cfg: ApprovalConfig,
  write: boolean,
  real: RealCtx,
): ApprovalVerdict {
  const ask = (always?: { path: string; write: boolean }): ApprovalVerdict => ({
    kind: 'ask',
    category: 'hidden_path',
    detail: t,
    reason: `要触碰隐藏路径：${t}`,
    ...(always ? { alwaysHidden: always } : {}),
  })
  const abs = realPathOf(t, real)
  if (abs === null) return t.split('/').some(isHiddenSeg) ? ask() : unknownPathAsk(t)
  // 已批（读写分开）→ 放行；没批 → 带键弹。neverAlways 的不给键、已批不算
  const keyed = (loc: string, at: string): ApprovalVerdict => {
    if (neverAlways(at)) return ask()
    const granted = (write ? cfg.hiddenWrite : cfg.hiddenRead) ?? []
    if (granted.some((e) => loc === e || loc.startsWith(`${e}/`))) return { kind: 'allow' }
    const key = keyOf(loc)
    return /[*?]/.test(key) ? ask() : ask({ path: key, write }) // 隐藏段本身带通配（`.gi*`）记不成键
  }
  if (/[*?]/.test(abs)) {
    const hit = globHits(abs)
    if (hit === false) return { kind: 'allow' }
    if (hit === null) return ask()
    // 通配只在最后一段（globHits 保证）：目录取真实形态再拼回（2026-10-29 起给键）
    let dir = dirname(abs)
    try {
      dir = realpathSync(dir)
    } catch {
      /* 用字面 */
    }
    const g = join(dir, basename(abs))
    return keyed(locOf(g, root), g)
  }
  if (!(cfg.pathExists ?? existsSync)(abs)) return { kind: 'allow' }
  // 存在就取真实形态：root 已被 pathVerdict 规整成 realpath，cwd 可能还是
  // 字面（macOS /var → /private/var），不规整的话项目内文件会被当成项目外
  let realAbs = abs
  try { realAbs = realpathSync(abs) } catch { /* 测试注入的 pathExists：用字面 */ }
  return keyed(locOf(realAbs, root), realAbs)
}
