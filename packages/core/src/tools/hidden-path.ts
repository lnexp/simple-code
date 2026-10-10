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
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ApprovalConfig, ApprovalVerdict } from './approval.ts'
import { expandTilde } from './approval-always.ts'

/** 算真实路径要用的上下文，classify 按段维护 */
export type RealCtx = {
  /** 当前目录；null = 算不出（之后的隐藏候选一律拦） */
  cwd: string | null
  /** 与 bash 工具 spawn 同一份环境 */
  env: Record<string, string>
  /** 命令里自己定义的变量名——值要执行时才知道 */
  localVars: Set<string>
}

/** 路径段是隐藏段：点开头，排除 `.` `..` 与省略号（echo ...） */
export const isHiddenSeg = (p: string): boolean =>
  p.startsWith('.') && p !== '.' && p !== '..' && !/^\.{3,}$/.test(p)

/** 命令里自己定义的变量：赋值、for 循环变量、read 读入 */
export function localVarsOf(cmd: string): Set<string> {
  const out = new Set<string>()
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=/g)) out.add(m[1]!)
  for (const m of cmd.matchAll(/\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) out.add(m[1]!)
  for (const m of cmd.matchAll(/\bread\s+(?:-\S+\s+)*([A-Za-z_]\w*)/g)) out.add(m[1]!)
  return out
}

/** token → 绝对路径。shell 引号先去掉（`"$HOME"/.ssh` 的形态），
 * `$VAR`/`${VAR}` 用 env 替换；命令内变量、env 里没有的、其他 `$` 形态
 * （`$1` `${x:-y}`）→ null */
export function realPathOf(token: string, real: RealCtx): string | null {
  let unknown = false
  const t = token.replace(/["']/g, '').replace(/\$(?:\{(\w+)\}|([A-Za-z_]\w*))/g, (_, a, b) => {
    const name = (a ?? b) as string
    const v = real.localVars.has(name) ? undefined : real.env[name]
    if (v === undefined) unknown = true
    return v ?? ''
  })
  if (unknown || t.includes('$')) return null
  const e = expandTilde(t)
  if (isAbsolute(e)) return resolve(e)
  return real.cwd === null ? null : resolve(real.cwd, e)
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
  if (t.startsWith('/') || t.startsWith('~') || t.includes('://') || t.includes('@')) return null
  const i = t.indexOf(':')
  return i < 0 ? null : t.slice(i + 1)
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
  return i < 0 ? loc : segs.slice(0, i + 1).join('/')
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
  if (abs === null) return ask()
  if (/[*?]/.test(abs)) {
    const hit = globHits(abs)
    return hit === false ? { kind: 'allow' } : ask()
  }
  if (!(cfg.pathExists ?? existsSync)(abs)) return { kind: 'allow' }
  // 存在就取真实形态：root 已被 pathVerdict 规整成 realpath，cwd 可能还是
  // 字面（macOS /var → /private/var），不规整的话项目内文件会被当成项目外
  let realAbs = abs
  try { realAbs = realpathSync(abs) } catch { /* 测试注入的 pathExists：用字面 */ }
  const loc = locOf(realAbs, root)
  const granted = (write ? cfg.hiddenWrite : cfg.hiddenRead) ?? []
  if (granted.some((e) => loc === e || loc.startsWith(`${e}/`))) return { kind: 'allow' }
  return ask({ path: keyOf(loc), write })
}
