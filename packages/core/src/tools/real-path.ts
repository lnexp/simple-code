/**
 * 路径真实化：算出命令 token 实际指向的绝对路径。
 *
 * 名字源自 2026-09-29 的「隐藏路径判定第 2 层」——该判定 2026-11-04
 * 拆掉（项目外一律 ask），这份「真实化」能力（$VAR 代入、cd 跟踪、
 * 循环取值、.. 回退）被项目外判定的准确性要求留下来，2026-11-05
 * 改名归位。消费方：approval.ts（pathVerdict 的 .. 解析、classify
 * 的 real 上下文）。
 */
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
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
  /** 命令内赋值执行到当前段时的值（applyAssigns 按段更新）；null = 算不出 */
  vars: Map<string, string | null>
}

/** 路径段是隐藏段：点开头，排除 `.` `..` 与省略号（echo ...） */
export const isHiddenSeg = (p: string): boolean =>
  p.startsWith('.') && p !== '.' && p !== '..' && !/^\.{3,}$/.test(p)

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
export function applyAssigns(
  assigns: AstAssign[] | undefined,
  real: RealCtx,
  runtime: Set<string>,
): void {
  for (const a of assigns ?? []) {
    if (runtime.has(a.name)) continue
    real.vars.set(a.name, a.definite && a.value !== null ? expandToken(a.value, real) : null)
  }
}

/** token → 绝对路径。shell 引号先去掉（`"$HOME"/.ssh` 的形态），
 * `$VAR`/`${VAR}` 用 env 替换；命令内变量、env 里没有的、其他 `$` 形态
 * （`$1` `${x:-y}`）→ null */
function realPathOf(token: string, real: RealCtx): string | null {
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
      try {
        r = realpathSync(cur)
      } catch {
        /* 不存在：按字面 */
      }
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
  // PWD 不特判（2026-11-04 试过接 real.cwd 后撤回）：单引号 '$PWD/x' 的
  // 字面量语义与双引号混在一起分不开，`W=$PWD/x` 的场景归「算不出」
  // ——放行 + onUnparsed 日志（用户拍板），不在这里猜
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
  // git REV:path 的历史路径：仓库相对即项目内，全放（2026-11-04 简化
  // 拍板）；绝对路径形态（~/、git 的 :/ 魔法前缀）罕见，按项目外弹，
  // 批键与磁盘路径同键（读写同权）
  if (!revPath.startsWith('/') && !revPath.startsWith('~')) return { kind: 'allow' }
  const granted = cfg.alwaysPaths ?? []
  const hit = granted.some(
    (e) => revPath === e || revPath.startsWith(e.endsWith('/') ? e : `${e}/`),
  )
  return hit
    ? { kind: 'allow' }
    : {
        kind: 'ask',
        category: 'external_dir',
        detail: t,
        reason: `要读 git 历史里的项目外路径：${t}`,
      }
}
