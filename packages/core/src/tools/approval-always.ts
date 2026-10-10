/**
 * 审批 always 白名单的落盘与提示计算（approval.md §always）。
 *
 * 存 `.simple-code/approval.json`（项目级明文）：卡上「始终允许」写入，
 * 手编/删行即回收。不进 settings.json——那份是用户手写的，程序不偷偷
 * 改；这份是程序写、人可读可改，两侧各管各的。
 *
 * 三个力度（用户拍板）：
 * - leads：执行器白名单，粒度到命令名（python3），不做 arity 分档
 * - paths：路径白名单，展开后的绝对目录前缀
 * - nonPathFrom：命令名 → 位置参数起始位（0 基），该位起不当路径判
 *   （元素寻址工具「此参数位不是路径」的一键采集；settings 的
 *   bash.approval.nonPathFrom 是手写源，这里是卡上采集源，判定时合并）
 * - hiddenRead / hiddenWrite：隐藏路径前缀，读写分开记（2026-09-29 拍板，
 *   docs/proposals/hidden-path.md）。记到第一个隐藏段为止：卡上是
 *   `.idea/encodings.xml` 记 `.idea`；项目内存相对路径，项目外存绝对路径
 *
 * 隐藏路径原先**没有** always（t162 红线），2026-09-29 用户拍板给——
 * 读写分开记正是为了批读不连带批写。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface AlwaysData {
  leads: string[]
  paths: string[]
  nonPathFrom: Record<string, number>
  hiddenRead: string[]
  hiddenWrite: string[]
  /** 以下三个静态键（askCommands/hiddenAllow/networkAllow）与 nonPathFrom
   *  的手写部分：2026-09-27 拍板「审批配置只住用户级+项目级 approval.json，
   *  settings 不再出现」。项目级文件里手写的——append 类函数读改写时
   *  原样带回（否则卡上点一次「始终允许」就把手写规则冲掉）。用户级
   *  文件的同名键在 loadUserApproval 并进来 */
  askCommands?: string[] | undefined
  /** 隐藏目录首组件白名单（DEFAULT_HIDDEN_ALLOW 之外的） */
  hiddenAllow?: string[] | undefined
  /** 网络命令白名单（DEFAULT_NETWORK_ALLOW 之外的） */
  networkAllow?: string[] | undefined
}

/** 缺失/坏文件时的空数据。**每次现造**而不是共享一个 EMPTY 常量：
 * append 类函数会 mutate loadAlways 的返回值再落盘，共享引用会把
 * 第一个 root 的白名单污染给之后所有「无文件」的 root（真机踩过：
 * 测试里先 append 再开新 root，新 root 的判定读到了旧 root 的
 * nonPathFrom，免审静默扩散） */
const emptyAlways = (): AlwaysData => ({ leads: [], paths: [], nonPathFrom: {}, hiddenRead: [], hiddenWrite: [] })

/** 用户级静态审批配置：~/.simple-code/approval.json。纯手写（卡上的
 *  运行时采集只写项目级文件，不碰这份）；文件缺失/坏格式当空 */
export interface UserApprovalData {
  askCommands: string[]
  hiddenAllow: string[]
  networkAllow: string[]
  nonPathFrom: Record<string, number>
}
export function loadUserApproval(
  file: string = join(homedir(), '.simple-code', 'approval.json'),
): UserApprovalData {
  if (!existsSync(file)) return { askCommands: [], hiddenAllow: [], networkAllow: [], nonPathFrom: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UserApprovalData>
    return {
      askCommands: arrayOfStrings(raw.askCommands),
      hiddenAllow: arrayOfStrings(raw.hiddenAllow),
      networkAllow: arrayOfStrings(raw.networkAllow),
      nonPathFrom: pickNonPathFrom(raw.nonPathFrom),
    }
  } catch (err) {
    process.stderr.write(`用户级 approval.json 解析失败，按空处理：${err instanceof Error ? err.message : String(err)}\n`)
    return { askCommands: [], hiddenAllow: [], networkAllow: [], nonPathFrom: {} }
  }
}

const arrayOfStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []

/** `~/x` → 绝对路径。approval.json 与匹配两侧统一存展开形态 */
export const expandTilde = (t: string): string =>
  t === '~' || t.startsWith('~/') ? `${homedir()}${t.slice(1)}` : t

/** 读白名单。文件缺失/坏 JSON：当空（可选文件缺失是正常情况；坏格式
 * stderr 提醒一句，不炸——白名单坏了不该让 bash 全部弹卡 */
export function loadAlways(root: string): AlwaysData {
  const file = join(root, '.simple-code', 'approval.json')
  if (!existsSync(file)) return emptyAlways()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AlwaysData>
    // 三个静态键空数组归一成 undefined——append 落盘时不写空键
    const askCommands = arrayOfStrings(raw.askCommands)
    const hiddenAllow = arrayOfStrings(raw.hiddenAllow)
    const networkAllow = arrayOfStrings(raw.networkAllow)
    return {
      leads: arrayOfStrings(raw.leads),
      paths: arrayOfStrings(raw.paths),
      nonPathFrom: pickNonPathFrom(raw.nonPathFrom),
      hiddenRead: arrayOfStrings(raw.hiddenRead),
      hiddenWrite: arrayOfStrings(raw.hiddenWrite),
      askCommands: askCommands.length ? askCommands : undefined,
      hiddenAllow: hiddenAllow.length ? hiddenAllow : undefined,
      networkAllow: networkAllow.length ? networkAllow : undefined,
    }
  } catch (err) {
    process.stderr.write(`approval.json 解析失败，按空白名单处理：${err instanceof Error ? err.message : String(err)}\n`)
    return emptyAlways()
  }
}

/** nonPathFrom 的形状校验：值必须是 ≥0 的整数，坏的键丢弃（与 leads/
 * paths 的 filter 同口径——文件坏了不该让 bash 全部弹卡） */
function pickNonPathFrom(v: unknown): Record<string, number> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (Number.isInteger(n) && (n as number) >= 0) out[k] = n as number
  }
  return out
}

/** 追加一条（读改写，去重）。tmp+rename 原子落盘——写一半的 JSON 会让
 * 下次 load 走 catch 分支，白名单悄悄变空 */
function append(root: string, key: 'leads' | 'paths' | 'hiddenRead' | 'hiddenWrite', value: string): void {
  const data = loadAlways(root)
  if (data[key].includes(value)) return
  data[key].push(value)
  const dir = join(root, '.simple-code')
  // 项目还没初始化 memory（.simple-code 不存在）也可能先遇到审批
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'approval.json')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ $comment: COMMENT, ...data }, null, 2)}\n`)
  renameSync(tmp, file)
}

export const appendLead = (root: string, lead: string): void => append(root, 'leads', lead)
export const appendPath = (root: string, dir: string): void => append(root, 'paths', dir)
export const appendHidden = (root: string, path: string, write: boolean): void =>
  append(root, write ? 'hiddenWrite' : 'hiddenRead', path)

const COMMENT =
  '审批「始终允许」写这里（leads/paths/nonPathFrom/hiddenRead/hiddenWrite）；askCommands 是手写的静态审批规则。删行即回收'

/** 记一条「命令 lead 的第 from 位起不是路径」。同键已存在且位相同不重写；
 * 位不同取更小的（更早的豁免位覆盖更晚的——用户后点「第 2 位」时，
 * 已有第 3 位该收窄，不该并存两条歧义） */
export function appendNonPathFrom(root: string, lead: string, from: number): void {
  const data = loadAlways(root)
  const prev = data.nonPathFrom[lead]
  if (prev === from) return
  data.nonPathFrom[lead] = prev === undefined ? from : Math.min(prev, from)
  const dir = join(root, '.simple-code')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'approval.json')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ $comment: COMMENT, ...data }, null, 2)}\n`)
  renameSync(tmp, file)
}

/**
 * external_dir 触发 token → always 该记的目录。目标存在且是目录记本身，
 * 是文件记其父目录（批「这个项目」而不是批「这个 pom.xml」）。
 * 过宽防线返回 null（= 这条不给 always，UI 不出第三键）：
 * - 记出来是家目录本身（`~/.zshrc` 的 dirname 是 `~`）——整个家目录免审
 *   不是用户批一条文件时以为的幅度
 * - 是 `/`
 */
export function dirHint(token: string): string | null {
  const abs = expandTilde(token)
  let dir: string
  try {
    dir = statSync(abs).isDirectory() ? abs : dirname(abs)
  } catch {
    // 不存在（要创建的目标）：按文件处理记父目录
    dir = dirname(abs)
  }
  if (dir === homedir() || dir === '/') return null
  return dir
}
