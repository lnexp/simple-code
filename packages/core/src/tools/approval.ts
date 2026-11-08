/**
 * bash 审批判定器（docs/proposals/approval.md §2/§3）。
 *
 * 纯函数：command + root + 白名单 → 放行或「问」。
 *
 * token 供给两层（2026-09-08 起）：tree-sitter AST 优先（shell-ast.ts，
 * heredoc body 不进 token、$() 子命令全量枚举、引号是语法事实），AST
 * 未就绪/解析失败时回退正则保守版——「看不懂就问」的取向两层一致
 * （§3.3 的残余风险就是为这个简单性付的价）。
 *
 * 这不是安全边界，是「被骗后的顺手破坏」的闸门：防的是注入诱导的
 * 低复杂度命令（cat 凭证、curl 载荷），不防针对性攻破。
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { dirHint, expandTilde } from './approval-always.ts'
import {
  applyAssigns,
  cdTarget,
  dotdotPathOf,
  gitRevPath,
  localVarsOf,
  type RealCtx,
  revPathVerdict,
  runtimeVarsOf,
} from './real-path.ts'
import { astSegments } from './shell-ast.ts'
import { findWorkspaceRoot } from './workspace-root.ts'

export type ApprovalVerdict =
  | { kind: 'allow' }
  | {
      /** 禁令档（v2 §2.2，2026-11-04 拍板）：不弹卡，直接拒绝并说明。
       *  memory 写——篡改自己的历史没有正当 bash 场景，SC 进程独占；
       *  sudo——提权后一切判定失效 */
      kind: 'deny'
      reason: string
    }
  | {
      kind: 'ask'
      category: ApprovalCategory
      detail: string
      reason: string
      /** 触发 token 是第 from 位（0 基）位置参数且 ≥2——「该命令从这位
       * 起不是路径」的采集依据（external_dir 专属：元素寻址工具的
       * 触发必然是 verb + 文件参数之后的位）。位 <2 的卡不给（cat
       * /etc/passwd 的参数全是路径，这个选项只是噪音） */
      nonPathFrom?: { lead: string; from: number }
      /** 方案 1（2026-09-21 拍板）：multi 触发点全是能记的路径时的批量
       * always 预览——项目外目录收敛出合法目录（dirHint 非 null——家目录/
       * 算不出/凭据）不给——粒度不一的东西一键全记，等于替用户批了没细看的 */
      alwaysPaths?: string[]
      /** multi 专属：合并前各段的类别（去重）。detail/reason 是给人看的
       * 拼接文本，类别在里面已丢——桌面机器人要据此判「git push 跟别的
       * 命令 && 在一起」只能回窗口处理（desktop-robot.md §5.2：两周 10 张
       * 含 git push 的卡，2 张是 multi） */
      parts?: ApprovalCategory[]
    }

/** 审批类别。UI 用它显示标签（external_dir 等），detail 是触发物。
 * 只留有触发点的（2026-11-05 检视清理）：network_cmd/system_op/
 * unparseable 在 11-04 拆名单与放行拍板后成了永不触发的空挂 */
export type ApprovalCategory = 'external_dir' | 'ask_rule' | 'multi'

/** 类别标签的中文名。UI 与 CLI 共用（approval.md §4.3） */
export const CATEGORY_LABEL: Record<ApprovalCategory, string> = {
  external_dir: '项目外路径',
  ask_rule: '自定义规则',
  multi: '多重触发',
}

export type ApprovalConfig = {
  /** 自定义审批规则（2026-09-27 拍板，当天二次拍板移出 settings.json）：
   *  lead / lead+子命令 / lead+子命令+子子命令（'appctl workloads apply'）
   *  词级前缀匹配；含 * 的条目按 glob 匹配整条命令词串（2026-11-04），
   *  通配命中不给「始终允许」键（批一次=放行整个通配面，太宽）。
   *  来源：用户级 ~/.simple-code/approval.json ∪ 项目级（bash.ts 并集） */
  askCommands: string[]
  /** 用户点名拒绝（2026-11-04）：匹配逻辑同 askCommands（词级/通配），
   *  命中直接 deny——优先于 lead 白名单与一切判定 */
  denyCommands: string[]
  /** 算不出路径的放行经此记日志（2026-11-04 拍板不弹卡）；
   *  bash.ts 注入写 ~/.simple-code/logs/approval-unparsed.jsonl */
  onUnparsed?: (token: string, reason: string) => void
  /** always 路径白名单（approval.json paths，展开后的绝对目录前缀）。
   * 命中=该 token 免审。匹配前 token 也做 ~ 展开，两侧形态一致 */
  alwaysPaths?: string[]
  /** 命令名 → 从第几位位置参数起不判为路径（0 基，区间豁免）。
   * 元素寻址类的私有工具从这里配（settings），core 不内置条目 */
  nonPathFrom?: Record<string, number>
  /** bash 工具 spawn 的环境——第 2 层替换 $VAR 用。缺省 = 空（变量全算不出） */
  env?: Record<string, string>
  /** 存在检查。缺省 fs.existsSync；测试在假 root 下注入 */
  pathExists?: (abs: string) => boolean
}

/** 无论在哪个 root 下都放行的绝对路径。/dev/null 是 `2>/dev/null` 的
 * 日常高频，不特例的话每条测试命令都要问一遍 */
const PATH_ALLOWLIST = new Set(['/dev/null'])

/** 路径的某个目录组件是 .simple-code（跨项目/用户级 ~/ 均命中）。
 *  字符串组件判定，不解析真实走向——与下方 .. 逃逸的保守策略一致 */
const inSimpleCodeTree = (p: string): boolean => p.split('/').includes('.simple-code')

/** 变更文件系统的动词（§2 规则 3 的写意图）。不做参数位置分析——
 * `cp .simple-code/a /tmp`（读侧）也弹卡：把数据带出 memory 目录
 * 同样是敏感动作，简单换安全，拍板见 approval.md */
const WRITE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'tee',
  'touch',
  'chmod',
  'chown',
  'truncate',
  'shred',
  'dd',
  'mkdir',
  'rmdir',
  'ln',
  'install',
  'rsync',
  'scp',
  'vim',
  'vi',
  'ed',
])

const TOKEN_RE = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
const SEGMENT_SPLIT_RE = /(?:&&|\|\||[;|&])/

export function classify(command: string, root: string, cfg: ApprovalConfig): ApprovalVerdict {
  const cmd = command.trim()
  // 第 2 层的真实路径上下文（real-path.ts）：cwd 随顶层 cd 逐段更新
  const real: RealCtx = {
    cwd: root,
    env: cfg.env ?? {},
    localVars: localVarsOf(cmd),
    vars: new Map(),
  }

  // 规则 0：自家 bin。引号形态固定（宿主注入的就是 "$SIMPLE_CODE_X"）。
  // 例外：APPLY_PATCH 的 heredoc 里藏着任意路径的写操作（补审批闭环的
  // 洞——别的自家 bin 都是固定语义，唯有它把「写哪」完全交给补丁内容），
  // 抽出路径逐个过 pathVerdict（写意图）
  if (cmd.startsWith('"$SIMPLE_CODE_')) {
    if (cmd.startsWith('"$SIMPLE_CODE_APPLY_PATCH"')) {
      const v = patchVerdict(cmd, root, cfg, real)
      if (v) return v
      // 无引号 heredoc 的 body 展开风险不再弹卡（2026-11-04 拍板——
      // 解释器与 $( ) 均已放行，同层风险一并接受）
    }
    // 其余自家 bin（NOTE/LESSON 的 write 吃 heredoc stdin）语义固定，照放
    return { kind: 'allow' }
  }

  // AST 路径：正则层那套「含 $( / 反引号就问」在这里不需要——$() 里的
  // 子命令被 descendantsOfType 递归枚举独立判定，heredoc body 是字面量
  // 不进 token。apply_patch 打含 Markdown 反引号的文档补丁不再误弹
  // 「无法静态判定」（本升级的直接动因）
  const segs = astSegments(cmd)
  if (segs) {
    const asks: Extract<ApprovalVerdict, { kind: 'ask' }>[] = []
    const entered: ScopeEntry[] = []
    const runtime = runtimeVarsOf(cmd)
    for (const s of segs) {
      followScopes(entered, s.scopes ?? [], real)
      applyAssigns(s.assigns, real, runtime)
      const v = judge(s.lead, s.items, root, cfg, real, cmd)
      // deny（禁令档）立即短路：memory 写、sudo 不参与段合并——合并卡
      // 是 ask 语义（always 键采集），禁令没有「允许一次」可谈
      if (v.kind === 'deny') return v
      if (v.kind === 'ask') asks.push(v)
      trackCd(s.lead, s.items, s.nested !== true, real)
    }
    return mergeAsks(asks)
  }

  // 回退：正则保守路径。wasm 未就绪（冷启动窗口）/ 加载失败 / 命令含
  // 语法错误节点时走到这里
  // $( ) / 反引号不拦（2026-11-04 用户拍板：触发实在太多）：AST 可用时
  // 子命令本就被枚举判定，这里的整条弹卡只兜 wasm 未就绪窗口和解析失败，
  // 代价是全错杀——宁可放过。剩余 token 照常分段判定，$( ) 里的内容
  // 被空格切出来的路径部分仍会判到

  // 全段收集后合并展示（2026-09-15 拍板）：首中即返会展示「最无害的段」——
  // `cd /Users/dev && python3 - <<EOF`（读 Downloads xlsx）弹的是 cd 的
  // 项目外路径，python3 任意代码被遮住。合并卡给全量触发点，用户点
  // 「允许一次」放行的是整条命令，理由该覆盖整条命令。multi 不给
  // always 键——多处触发无法收敛成安全粒度（同隐藏路径的口径）
  const asks: Extract<ApprovalVerdict, { kind: 'ask' }>[] = []
  for (const seg of splitSegments(cmd)) {
    const v = classifySegment(seg, root, cfg, real, cmd)
    if (v.kind === 'deny') return v
    if (v.kind === 'ask') asks.push(v)
    trackCd(
      seg[0] ?? '',
      seg.slice(1).map((text) => ({ text })),
      true,
      real,
    )
  }
  return mergeAsks(asks)
}

type ScopeEntry = { id: number; cwd: string | null }

/** 子 shell、$( )、<( )、后台语句各带一份当前目录（shell-ast scopesOf）：
 * 出了作用域恢复进入前的目录，进新作用域记下当时的目录。段按源码顺序来，
 * entered 始终是上一段的作用域链 */
function followScopes(entered: ScopeEntry[], scopes: number[], real: RealCtx): void {
  for (let top = entered.at(-1); top && !scopes.includes(top.id); top = entered.at(-1)) {
    entered.pop()
    real.cwd = top.cwd
  }
  for (const id of scopes)
    if (!entered.some((e) => e.id === id)) entered.push({ id, cwd: real.cwd })
}

/** 段是 cd 时更新当前目录：作用域里顶层的按目标算，非顶层的（管道、
 * if/for 里）效果不确定，之后一律算不出（出了所在作用域才恢复） */
function trackCd(lead: string, items: { text: string }[], topLevel: boolean, real: RealCtx): void {
  if (unquote(lead) !== 'cd') return
  if (!topLevel) {
    real.cwd = null
    return
  }
  const arg = items.map((i) => unquote(i.text)).find((t) => !t.startsWith('-') || t === '-')
  real.cwd = cdTarget(arg, real)
}

/** 多段触发的合并展示（2026-09-15 拍板）：首中即返会展示「最无害的段」——
 * `cd /Users/dev && python3 - <<EOF` 弹的是 cd 的项目外路径，python3
 * 任意代码被遮住。点「允许一次」放行的是整条命令，理由该覆盖整条命令。
 * multi 不给 always——多处触发无法收敛成安全粒度（同隐藏路径的口径）；
 * 唯一的例外是同质 external_dir（2026-09-21 方案 1）：一次看多个目录是
 * 常态场景，逐个批是纯摩擦，给「始终允许这 N 个目录」的批量 always。
 * 段内（单命令多 token）仍是首中即返：judge 核心流收集化侵入大，
 * 单命令双触发场景边缘 */
function mergeAsks(asks: Extract<ApprovalVerdict, { kind: 'ask' }>[]): ApprovalVerdict {
  if (asks.length === 0) return { kind: 'allow' }
  if (asks.length === 1) return asks[0]!
  const seen = new Set<string>()
  const lines: string[] = []
  for (const a of asks) {
    const key = `${a.category}:${a.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`${CATEGORY_LABEL[a.category] ?? a.category}：${a.detail}`)
  }
  // 上限 8 条：长脚本逐行触发会收集出几十条，全列反而读不动
  const head = lines.length > 8 ? [...lines.slice(0, 8)!, `等 ${lines.length} 处`] : lines
  // 批量 always 的判据：每处都是 external_dir 且 dirHint 收敛出合法目录
  // （2026-11-04 简化后只剩这一类可记），去重后 ≤5 项（一笔大账逼分开看）
  const dirs = new Set<string>()
  let batchAlways = true
  for (const a of asks) {
    if (a.category !== 'external_dir') {
      batchAlways = false
      break
    }
    const d = dirHint(a.detail)
    if (d === null) {
      batchAlways = false
      break
    }
    dirs.add(d)
  }
  const batch = batchAlways && dirs.size <= 5
  return {
    kind: 'ask',
    category: 'multi',
    detail: head.join('；'),
    reason: `命令有多处需要审批：\n${head.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    parts: [...new Set(asks.map((a) => a.category))],
    ...(batch && dirs.size > 0 ? { alwaysPaths: [...dirs] } : {}),
  }
}

/** 子命令之前的带值全局 flag：值是普通 token，不跳过会被当成子命令。
 *  git：`git -C /tmp push` 取成 /tmp → 匹配不上 'git push' → fail-open
 *  绕过。agent-browser：`--session s1 eval` 取成 s1 → 已批的
 *  'agent-browser eval' 对不上、卡上也没有采集键（2026-10-29，真机
 *  某真实项目两天 28 张卡；三个是近两月真机命令里子命令前出现过的） */
const VALUE_FLAGS: Record<string, string[]> = {
  git: ['-C', '-c'],
  'agent-browser': ['--session', '--cdp', '--profile'],
}

/** 透传前缀：自己不做事，把后面的参数当命令跑。valueFlags 是带值选项
 *  （值单独占一个 token 时连值跳过；`-n10`、`--signal=KILL` 粘连形态
 *  本就是一个 token）；pos 是命令前的固定位置参数（timeout 的时长）；
 *  noRun 出现即不执行后续（`command -v jq` 是查询） */
const PASSTHROUGH: Record<string, { valueFlags?: string[]; pos?: number; noRun?: string[] }> = {
  nohup: {},
  time: { valueFlags: ['-o'] },
  nice: { valueFlags: ['-n', '--adjustment'] },
  timeout: { valueFlags: ['-s', '-k', '--signal', '--kill-after'], pos: 1 },
  env: { valueFlags: ['-u', '-C', '-S', '-P', '--unset', '--chdir', '--split-string'] },
  exec: { valueFlags: ['-a'] },
  command: { noRun: ['-v', '-V'] },
  stdbuf: { valueFlags: ['-i', '-o', '-e', '--input', '--output', '--error'] },
  caffeinate: { valueFlags: ['-t', '-w'] },
  xargs: { valueFlags: ['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-R', '-S', '-a', '-d'] },
}

/** 段内 token：AST 的 AstItem 与回退分词（classifySegment）同形 */
type Item = { text: string; write: boolean; redirect?: boolean; subst?: true }

/** 透传前缀后面真正执行的命令（AST 段形态：items 不含 lead）。不是透传
 *  前缀、或后面没有命令（`xargs` 默认 echo、`exec > log`）返回 null */
function passthroughInner(lead: string, rest: Item[]): { lead: string; items: Item[] } | null {
  const spec = PASSTHROUGH[unquote(lead)]
  if (!spec) return null
  let pos = spec.pos ?? 0
  for (let i = 0; i < rest.length; i++) {
    const it = rest[i]
    if (!it) break
    const t = unquote(it.text)
    if (it.write || /^\d*&?[<>]/.test(t)) continue // 重定向符与目标不是命令
    if (spec.noRun?.includes(t)) return null
    if (t.startsWith('-')) {
      if (spec.valueFlags?.includes(t)) i++
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue // env 的 FOO=bar
    if (pos > 0) {
      pos--
      continue
    }
    return { lead: t, items: rest.slice(i + 1) }
  }
  return null
}

/** 位置参数序列（askCommands 规则、eval 卡的采集键
 *  共用——匹配与采集必须对称）：lead 后的位置参数按序收集，flag 跳过，
 *  VALUE_FLAGS 里的 flag 连值一起跳过。正则回退段的 items 含 lead，AST
 *  段不含——`t === lead` 对 AST 段里恰好同名的参数也只是多跳一个 */
function positionalsOf(lead: string, items: { text: string }[]): string[] {
  const out: string[] = []
  const valueFlags = VALUE_FLAGS[unquote(lead)] ?? []
  let skipNext = false
  for (const it of items) {
    const t = unquote(it.text)
    if (skipNext) {
      skipNext = false
      continue
    }
    if (t === '' || t === '-' || t === unquote(lead)) continue
    if (t.startsWith('-')) {
      if (valueFlags.includes(t)) skipNext = true
      continue
    }
    if (SHELL_RESERVED.has(t)) continue
    if (/^[^/"'.]*=/.test(t)) continue // 形如 foo=bar 的赋值不是子命令
    out.push(t)
  }
  return out
}

/** 命令路径匹配：条目按空格切 token，与命令的 [lead, ...位置参数] 前 N
 *  个 token 逐个相等才命中（词级，非字符串前缀——'appctl deployx' 不
 *  命中 'appctl deploy'）。一级=整个 CLI（'appctl'），两级=子命令
 *  （'git push'），三级=子命令的子命令（'appctl workloads apply'——
 *  apply/delete 弹卡、list/get 自由需要这个粒度） */
function pathMatches(entry: string, bare: string, positionals: string[]): boolean {
  const et = entry.split(' ')
  const ct = [bare, ...positionals]
  if (et.length > ct.length) return false
  return et.every((t, i) => t === ct[i])
}

/** 含 * 的条目：把命令的 [lead, ...位置参数] 拼成词串做 glob 匹配。
 *  * 匹配任意字符序列（含空格），首尾段锚定（globMatch('a *', 'a b c')
 *  命中，('a *', 'x a b') 不命中） */
function globMatch(pattern: string, text: string): boolean {
  const parts = pattern.split('*')
  let i = 0
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k] ?? ''
    if (k === 0) {
      if (!text.startsWith(p)) return false
      i = p.length
    } else if (k === parts.length - 1) {
      if (p === '') return true
      if (!text.endsWith(p) || i > text.length - p.length) return false
    } else {
      const at = text.indexOf(p, i)
      if (at === -1) return false
      i = at + p.length
    }
  }
  return true
}

/** 通配匹配面：段内全部词（lead + flags + 位置参数，跳重定向与骨架词）。
 *  positionalsOf 会跳过 flags——'rm -rf /' 会成 'rm /'，'rm -rf *' 罩不住 */
function globWords(lead: string, items: { text: string }[]): string {
  const words: string[] = []
  for (const it of items) {
    const t = unquote(it.text)
    // 回退段 items 含 lead、AST 段不含——跳过同名词两条路都对；
    // 保留字与重定向不进匹配面，flags（-rf）保留——通配就是要罩形态
    if (t === '' || t === unquote(lead)) continue
    if (SHELL_RESERVED.has(t)) continue
    if (/^[^/"'.]*=/.test(t)) continue
    if (/^[<>]/.test(t)) continue
    words.push(t)
  }
  return [unquote(lead), ...words].join(' ')
}

/** askCommands/denyCommands 共用：无 * 词级前缀（存量语义），含 * glob */
function cmdRuleMatches(entry: string, lead: string, items: { text: string }[]): boolean {
  if (!entry.includes('*')) return pathMatches(entry, unquote(lead), positionalsOf(lead, items))
  return globMatch(entry, globWords(lead, items))
}

/** `&&` `;` `|` 是 shell 控制符——token 粘连时切开分段。引号内含 | 的
 * 字符串会被误切，只影响判定收紧方向（多问一次），不影响放行 */
export function splitSegments(cmd: string): string[][] {
  // 换行是命令分隔符（等价 `;`），必须先按行切——否则下一行命令粘进
  // 上一行末尾的管道段，lead 成了上行的尾命令，按位置参数计的
  // nonPathFrom 豁免整个失效。真机踩过：连发两行元素寻址命令
  // （`xcli get … | head` ×2），第二行的 `/slide[4]/shape[@id=…]`
  // 被判「项目外路径」误弹
  const out: string[][] = []
  for (const line of cmd.split('\n')) {
    const segments: string[][] = [[]]
    for (const raw of line.match(TOKEN_RE) ?? []) {
      if (!/[;|&]/.test(raw)) {
        segments[segments.length - 1]?.push(raw)
        continue
      }
      const parts = raw.split(SEGMENT_SPLIT_RE)
      parts.forEach((p, i) => {
        if (i > 0) segments.push([])
        const cur = segments[segments.length - 1]
        // 空片段跳过内容但保留「开新段」动作：分隔符粘在 token 尾部
        //（`"print(1)";`）时尾部 split 出空串，过滤掉它会把开段也吞了，
        // 后续命令混进前段——lead 白名单时代这会让 `python3 -c "…";
        // rm /etc/x` 的 rm 搭车放行（AST 路径无此问题，`;` 是语法分隔）
        if (cur && p !== '') cur.push(p)
      })
    }
    out.push(...segments.filter((s) => s.length > 0))
  }
  return out
}

/** 这些命令的**第一个位置参数**是脚本/模式而非路径：sed 的地址范围
 * （`'/## 13/,/## 附录/p'`）、grep 的 pattern（`'/^turn/'`）、awk 的
 * program（`'/x/{print}'`）。它们长着绝对路径的脸（/ 开头），进
 * pathVerdict 就是「要触碰项目外路径」误弹——这是实弹撞出来的
 * （sed -n '/## 13/,/## 附录/p' docs/design.md 被拦）。只豁免第一个
 * 位置参数，**文件参数照常判**：`sed -i 's/x/y/' /etc/hosts` 的 /etc
 * 依然拦。find 不在此列——它的第一个位置参数正是要搜索的路径 */
const NONPATH_FIRST_POSITIONAL = new Set(['sed', 'grep', 'egrep', 'fgrep', 'awk', 'rg'])

/** 纯输出工具：位置参数**全部**是要打印的文本，不是路径。echo/printf
 * 唯一的文件系统接触是重定向——目标已被 stripRedirect 单独判定，
 * 位置参数里出现的任何「路径形态」文本（`echo '.env 里有 key'`、
 * `echo "...[中略]..."`）都不构成触碰（2026-09-15 实案：echo
 * 省略号分隔文本弹「隐藏路径」卡，抢了同命令里真报的戏）。写成
 * 表而非塞进 nonPathFrom 配置：与 sed/grep 表同性质——通用工具的
 * 调用约定，内置对所有用户成立。tr 同理：只有字符集参数、只读 stdin
 * （2026-10-30 实弹：`tr '\t' '/'` 报「要读项目外路径：/」） */
const NONPATH_ALL_POSITIONAL = new Set(['echo', 'printf', 'tr'])

/** 这些 flag 的**值**是脚本/模式/glob 而非路径：sed/grep/awk 的 -e、
 * find 的 -name/-path、tar/rsync 的 --exclude。等号形态（--regexp=x）
 * 值内嵌在 flag token 里，以 - 开头本就跳过。
 * -m/--message（2026-11-05 实弹）：git commit -m 的消息以 ~/.simple-code
 * 开头时被当路径弹卡（消息文本里有空格中文也拦不住——looksLikeCode 要
 * 语句符号）。grep -m/curl -m 的值是数字，跳过无影响 */
const NONPATH_FLAG_VALUES = new Set([
  '-m',
  '--message',
  '-e',
  '--expression',
  '--regexp',
  '--name',
  '-iname',
  '-path',
  '-ipath',
  '-regex',
  '-iregex',
  '--include',
  '--exclude',
  '--exclude-dir',
])

/** 值是**脚本文件**的 flag（sed/grep/awk 的 -f）：值是真路径，照常判。
 * 且它出现意味着 script 已由 flag 给出——**位置参数全是文件**，上面的
 * 第一个位置参数豁免随之关闭（`sed -f /etc/s file` 的 file 不能沾
 * script 位的光；-e 同理关闭豁免） */
const PATH_FLAG_VALUES = new Set(['-f', '--file'])

/** 组合短 flag 的等价识别：`sed -ne '/x/p'` = -n + -e（值非路径）、
 * `sed -nf /etc/s` = -n + -f（值是路径）。长短形态分开认，-F（grep
 * 的 fixed-strings 开关，无值）不沾小写 f 的光 */
const isNonPathScriptFlag = (t: string) => NONPATH_FLAG_VALUES.has(t) || /^-[^-]*e$/.test(t)
const isPathScriptFlag = (t: string) => PATH_FLAG_VALUES.has(t) || /^-[^-]*f$/.test(t)

/** shell 保留字：语法骨架，永远不是命令也不是参数。AST 路径的 command
 * 节点天然不含它们；正则回退的分段会带进来（`do xcli …` 段首的 do）。
 * 不剥的话 lead 成 do，一切按 lead 匹配的豁免（nonPathFrom 这类）
 * 整体失效——真机踩过：for 循环里的元素寻址命令被误弹项目外。 */
const SHELL_RESERVED = new Set(['do', 'then', 'else', 'elif', 'fi', 'done', 'esac'])

/** 判定核心：lead + 带 write 标记的 token 列表。AST 与正则回退两条
 * 路径共用——供给不同，规则必须同一套 */
function judge(
  lead: string,
  items: Item[],
  root: string,
  cfg: ApprovalConfig,
  real: RealCtx,
  rawCmd?: string,
): ApprovalVerdict {
  // 段级自家 bin（规则 0 的分段形态：`cd x && "$SIMPLE_CODE_Y" <<'H' …`）。
  // 两条路径都需要：AST 下 heredoc body 本就不进 token，这条让正则回退
  // 在冷启动窗口也能放行 apply_patch 补丁
  if (unquote(lead).startsWith('$SIMPLE_CODE_')) {
    if (unquote(lead) === '$SIMPLE_CODE_APPLY_PATCH' && rawCmd) {
      const v = patchVerdict(rawCmd, root, cfg, real)
      if (v) return v
    }
    return { kind: 'allow' }
  }

  let head = 0
  while (head < items.length && /^[^/"'.=]*=/.test(items[head]?.text ?? '')) head++
  // 正则回退段的骨架词剥掉（AST 段没有它们，循环是 no-op）。lead 回填
  // 与逐 token 判定都要跳过：只跳 lead 位的话，do 会占掉一个位置参数，
  // nonPathFrom 的豁免位照样错位
  while (head < items.length && SHELL_RESERVED.has(unquote(items[head]?.text ?? ''))) head++

  // AST 供给已剥 variable_assignment，这个循环对它是 no-op；正则路径靠它
  // 剥 FOO=1 curl … 前缀。fromFallback 标记回填发生过——回退路径的 items
  // 含 lead 占位，AST 不含，后面「第一个位置参数」的起算要区分
  const fromFallback = lead === ''
  if (fromFallback && head < items.length) lead = unquote(items[head]?.text ?? '')

  // 透传前缀（nohup/timeout/env/xargs …）后面才是真正执行的命令：内层
  // 整段先判一次，再按外层照旧判（只收紧不放宽）。按命令名判的规则只
  // 看 lead，包一层就全部失效——2026-10-30 实案：`nohup appctl build run
  // … &`、`nohup appctl release create …` 发布闸静默放行
  const inner = passthroughInner(lead, fromFallback ? items.slice(head + 1) : items)
  if (inner) {
    const v = judge(inner.lead, inner.items, root, cfg, real, rawCmd)
    if (v.kind !== 'allow') return v
  }

  // denyCommands（2026-11-04）：用户点名拒绝，优先于 lead 白名单——
  // 「点名永不可」压过「批过白名单」，否则批过 python3 的会话里
  // deny 形同虚设
  if (cfg.denyCommands.length) {
    const hit = cfg.denyCommands.find((e) => cmdRuleMatches(e, lead, items))
    if (hit)
      return {
        kind: 'deny',
        reason: `denyCommands 点名拒绝（${hit}）——用户点名禁止这条命令，不要执行`,
      }
  }

  const v = commandRules(lead, items, cfg)
  if (v) return v
  return pathRules(lead, items, root, cfg, real, { fromFallback, head })
}

/** 自定义审批规则（askCommands）。2026-11-04 拍板：命令维彻底 OC 化——
 *  内置名单（系统操作/kill/sudo）全拆，默认全放，用户在两级
 *  approval.json 自己加 askCommands/denyCommands。路径维照常兜底 */
function commandRules(lead: string, items: Item[], cfg: ApprovalConfig): ApprovalVerdict | null {
  // 解释器/裸 shell/-e 不拦（2026-11-04 用户拍板：触发实在太多）：
  // python3 script.py、node -e、sh -c 全放。AST 下 $( ) 子命令仍被
  // 枚举判定，路径维照常兜底；剩余风险=代码体内动作（用户已接受
  // 该风险换低打扰——与 OC 的「bash 全权裸放」对齐）

  // sudo 是唯一保留的内置禁令（2026-11-04 OC 化时用户点名留下）：
  // 提权后一切判定失效——审批体系自身的前提而非偏好
  if (lead === 'sudo') {
    return {
      kind: 'deny',
      reason: 'sudo 已禁用：提权后审批判定全部失效。需要系统级操作时请让用户执行',
    }
  }

  // 规则 1.5：自定义审批规则（askCommands，2026-09-27 拍板）。优先于
  // 规则 2——appctl deploy /prod 这类带项目外路径的调用，报「自定义
  // 规则」比报「项目外路径」更接近用户配规则时的意图。类别独立
  // （ask_rule）——appctl 不是网络命令，标签不能撒谎（用户拍板）。
  // 条目来源：用户级 ~/.simple-code/approval.json ∪ 项目级
  // .simple-code/approval.json（2026-09-27 二次拍板：审批规则与
  // settings.json 隔离，独立文件；内置默认已清空，2026-11-04 拍板）
  if (cfg.askCommands.length) {
    // 多条命中取 token 最长的（最紧的）——卡上「始终允许」按最紧粒度
    // 收敛：'appctl workloads' 与 'appctl workloads apply' 都在时，
    // 弹卡给后者，批 apply 不外溢到 workloads 的其他子命令
    const hit = cfg.askCommands
      .filter((r) => cmdRuleMatches(r, lead, items))
      .sort((a, b) => b.split(' ').length - a.split(' ').length)[0]
    // 2026-11-05 拍板：askCommands 的卡不给「始终允许」——命令维全是
    // 用户手写的高风险规则（发布/写操作），想放行删配置那一行，
    // 不做「一个文件写 ask、另一个文件跳过」的双文件豁免
    if (hit) {
      return {
        kind: 'ask',
        category: 'ask_rule',
        detail: hit,
        reason: `${hit} 命中自定义审批规则`,
      }
    }
  }

  return null
}

/** 规则 3/4：逐 token 查路径 */
function pathRules(
  lead: string,
  items: Item[],
  root: string,
  cfg: ApprovalConfig,
  real: RealCtx,
  seg: { fromFallback: boolean; head: number },
): ApprovalVerdict {
  const { fromFallback, head } = seg
  // 写意图 = 首动词在写表，或 sed 就地改（-i / --in-place）
  const verbWrites =
    WRITE_COMMANDS.has(lead) ||
    (lead === 'sed' && items.some((i) => /^-[^-]*i/.test(i.text) || i.text === '--in-place'))
  // 非路径参数位豁免（见两张表的注释）
  const nonPathFirst = NONPATH_FIRST_POSITIONAL.has(lead)
  // 与 nonPathFirst 同构但来自配置：元素寻址类的工具（settings 的
  // nonPathFrom）只有**前几位**位置参数是真文件参数，之后全是元素
  // 路径和 flag 值——豁免是区间不是单点（flag 值会被数进位置参数，
  // 单点豁免挡不住 `--from /slide[7]/…` 这类）
  // 配置可覆盖内置（用户想收紧 echo 也行）
  let exemptFromPosition =
    cfg.nonPathFrom?.[lead] ?? (NONPATH_ALL_POSITIONAL.has(lead) ? 0 : Infinity)
  // 子命令级条目（'agent-browser eval'）：词级的 pathMatches
  // 同款词级匹配。裸 lead 条目罩不住「同 CLI 不同子命令吃不同参数」的
  // 形态——批 eval 的 JS 参数不能连带批 upload 的文件参数（真机实卡：
  // agent-browser 既有 eval <js>（JS 里的 /…/ 正则字面量被切成 .test(
  // 假隐藏段）也有 upload <sel> <files>（真文件路径，读形态）。裸 lead
  // from=1 会让 `upload x ~/.ssh/id_rsa` 静默——窃取面，开不得。from
  // 从匹配到的子命令之后起数；裸 lead 条目在前，优先级高于子命令条目
  if (exemptFromPosition === Infinity && cfg.nonPathFrom) {
    const bare = unquote(lead)
    const posList = positionalsOf(lead, items)
    for (const [entry, from] of Object.entries(cfg.nonPathFrom)) {
      if (!entry.includes(' ')) continue
      if (!pathMatches(entry, bare, posList)) continue
      exemptFromPosition = Math.min(exemptFromPosition, entry.split(' ').length - 1 + from)
      break // 词级前缀互斥：命中一条即停，多条命中是配置写重叠
    }
  }
  let positionalSeen = 0
  let skipNextValue = false
  let firstPositionalLeft = nonPathFirst
  // 禁令优先于弹卡：先攒 ask，扫完整段，deny 一票否决（cp /tmp/x
  // memory/… 报禁令而非外部源弹卡——memory 的保护不该被另一个触发点遮住）
  let firstAsk: Extract<ApprovalVerdict, { kind: 'ask' }> | null = null
  for (const [idx, item] of items.entries()) {
    let t = unquote(stripRedirect(item.text))
    // 在丢掉引号信息前解析确定的变量路径，随后走全部审批规则。
    // 只在 hiddenVerdict 展开会漏掉 paths 白名单与 .simple-code 读豁免。
    t = expandPathPrefix(item.text, t, real)
    // $( ) 拼接的残片（shell-ast 的 subst 标记）：真实落点要执行替换才知道，
    // 静态判不出——归「算不出」放行 + 日志，不能把残片当绝对路径判
    // （2026-11-05 真机：ls "$(git rev-parse --show-toplevel)/common/…" 弹卡）
    if (item.subst) {
      cfg.onUnparsed?.(t, `路径算不出（$( ) 替换的拼接串）：${t}`)
      continue
    }
    if (t === '' || t === '-') continue
    if (SHELL_RESERVED.has(t)) continue // 段中/段尾骨架词（done 等）
    if (skipNextValue) {
      skipNextValue = false
      continue
    }
    if (t.startsWith('-')) {
      // script 类 flag（-e/-f，含组合形态）一出现，位置参数全是文件——
      // 位置参数豁免整体关闭。-f 的值不走 skipNextValue，落回正常判定
      if (isNonPathScriptFlag(t)) skipNextValue = true
      if (isNonPathScriptFlag(t) || isPathScriptFlag(t)) firstPositionalLeft = false
      continue // 选项
    }
    if (fromFallback && idx === head && t === lead) continue // 回退路径的 lead 占位
    if (firstPositionalLeft && !item.redirect) {
      firstPositionalLeft = false
      continue // sed/grep/awk 的 script/pattern 位
    }
    // 豁免只罩「读形态」的 token：带写意图的（> /tmp/x 的重定向目标、
    // rm 类写动词的参数）不豁免——元素寻址工具的豁免位起没有写语义的
    // fs 路径参数，但重定向能把任意文件变成它的 token。真机踩过：
    // `xcli get f.pptx /body > ~/Desktop/y.txt` 曾被区间豁免放过。
    // 读重定向同理（`tr a b < ~/.ssh/id_rsa` 把文件打到输出，2026-10-30）
    if (positionalSeen >= exemptFromPosition && !item.write && !item.redirect && !verbWrites) {
      positionalSeen++
      continue // nonPathFrom 豁免位起：元素路径与 flag 值，非 fs 路径
    }
    const at = positionalSeen
    positionalSeen++
    const write = item.write || verbWrites
    // git 的 REV:path：冒号后是仓库历史里的路径，磁盘上不一定有——不查
    // 存在，按第 1 层看名字（`git show HEAD:.env` 拦）；始终允许与磁盘读同键
    const revPath = unquote(lead) === 'git' ? gitRevPath(t) : null
    if (revPath !== null) {
      const rv = revPathVerdict(revPath, t, cfg)
      if (rv.kind !== 'allow') return rv
      continue
    }
    const v = pathVerdict(t, root, cfg, write, real)
    // nonPathFrom 采集依据：触发位 ≥2 且是 external_dir（hidden_path 的
    // 触发物是真路径，这个选项是误导）。lead 在段首，元素寻址工具的
    // 结构必然是 verb（位0）+ 文件参数（位1）+ 元素路径（位2+）
    // 拷贝/链接类的 memory **源**位是读（备份 state.db、ln 缩略图的
    // 真实高频形态——2026-11-04 全量回放 18 条误伤由此收掉）；目标位
    // （后面没有别的位置参数）才是写，照 deny。mv 不在此列：移走=破坏
    // 源文件，mv 的 memory 端点不论方向都禁
    if (
      v.kind === 'deny' &&
      ['cp', 'ln', 'rsync'].includes(unquote(lead)) &&
      items.slice(idx + 1).some((i) => !i.text.startsWith('-') && i.text !== '')
    ) {
      continue
    }
    if (v.kind === 'deny') return v // 禁令优先：cp /tmp/x memory/… 不被外部源弹卡遮住
    if (v.kind === 'ask')
      firstAsk ??= {
        ...v,
        ...(at >= 2 && v.category === 'external_dir' ? { nonPathFrom: { lead, from: at } } : {}),
      }
  }
  if (firstAsk) return firstAsk
  return { kind: 'allow' }
}

/** 正则回退路径的 adapter：token 数组 → 带 write 标记的 items。
 * `> .simple-code/x`（空格分隔）时 > 和路径是两个 token：裸重定向符
 * 置位，作用到下一个 token 上（紧贴形态 `>x` 在同 token 里已被 stripRedirect
 * 连同 write 标记处理） */
function classifySegment(
  seg: string[],
  root: string,
  cfg: ApprovalConfig,
  real: RealCtx,
  rawCmd?: string,
): ApprovalVerdict {
  const items: Item[] = []
  let pendingRedirect: 'write' | 'read' | false = false
  for (const token of seg) {
    // 读写两个方向都标 redirect（参数位豁免罩不到），write 只认 >
    const redirect = /^\d*&?[<>]/.test(token) || pendingRedirect !== false
    const redirectedWrite = /^\d*&?>>?/.test(token) || pendingRedirect === 'write'
    pendingRedirect = /^\d*&?>>?$/.test(token) ? 'write' : /^\d*<$/.test(token) ? 'read' : false
    items.push({ text: token, write: redirectedWrite, redirect })
  }
  return judge('', items, root, cfg, real, rawCmd)
}

/** 补丁标记行抽路径：Update/Add/Delete File 与 Move to（目标也是写——
 * 删除同样是破坏性写，源的 rm 也不该比目标松）。正则抽标记行而非真
 * parsePatch：AST 与回退两条路径拿到的都是原始命令串，heredoc body
 * 原样在内，两边通用。补丁上下文里的同名行**抽不到也不该抽到**——补丁
 * 格式的所有内容行必带 +/-/空格前缀，行首 *** 只能是真标记 */
const PATCH_PATH_RE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm

/** 补丁相对路径的真实位置与 apply-patch-bin 同口径：从 bin 的 cwd（命令里
 * cd 之后的目录）往上找工作区根——`cd 别的项目 && "$SIMPLE_CODE_APPLY_PATCH"`
 * 改的是那个项目里的文件。cwd 算不出时 cwd=null，隐藏候选按原则拦。
 * .simple-code 成长区（notes/lessons/events/skills）的免审
 * 由 pathVerdict 统一给——2026-09-29 起裸 shell 与补丁同待遇，原
 * patchChannelExempt 通道豁免随之删除 */
function patchVerdict(
  cmd: string,
  root: string,
  cfg: ApprovalConfig,
  real: RealCtx,
): ApprovalVerdict | null {
  const patchReal = { ...real, cwd: real.cwd === null ? null : findWorkspaceRoot(real.cwd) }
  for (const m of cmd.matchAll(PATCH_PATH_RE)) {
    const p = (m[1] ?? m[2] ?? '').trim()
    if (p === '') continue
    // 走 pathVerdict 与 bash 路径完全同一套（v2 2026-11-04 统一）：补丁
    // 写 ~/.simple-code 的弹卡类别与 always 键（⑤第二级）和裸 shell 一致，
    // 不再一边 hidden_path 一边 external_dir
    const v = pathVerdict(p, root, cfg, true, patchReal)
    if (v.kind !== 'allow') return v
  }
  return null
}

const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, '$2')

/** /tmp 下的 .simple-code/memory 是 agent 自建的仿真夹具（SC 开发自测、
 *  数据库试验），不是任何活 SC 的对话记录——禁令档（防篡改记忆）不罩它，
 *  落回普通路径判定（/tmp 写弹 external 卡，可批）。真记忆的防线不受
 *  影响：把夹具内容拷回真 memory 是写目标位，照 deny
 *  （2026-11-04 全量回放 28687 条：8 条夹具 mkdir 误伤由此收掉） */
const tmpFixture = (abs: string): boolean =>
  abs === '/tmp' ||
  abs.startsWith('/tmp/') ||
  abs === '/private/tmp' ||
  abs.startsWith('/private/tmp/')

/** 剥掉粘在路径上的重定向前缀：`>file` `2>file` `<f` `2>&1`（剥完剩
 * `&1` 之类，不构成路径自然跳过）。
 * `>` `<` 必须出现（不能 `>?`）：可选会把 `0.4` `1.5` 这类纯数字
 * 参数剥掉前导数字变 `.4`，掉进隐藏路径误判——sleep 0.4 弹过卡 */
const stripRedirect = (t: string) => t.replace(/^\d*&?>>/, '').replace(/^\d*&?</, '')

/** 延续 PWD 的窄范围展开：单引号、转义、复杂替换不猜；不执行 shell。
 * 保留 link/.. 给 dotdotPathOf，不能先 resolve 折叠掉真实路径。 */
function expandPathPrefix(raw: string, token: string, real: RealCtx): string {
  if (/['\\]/.test(raw)) return token
  const plain = token.replace(/"/g, '')
  const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))(\/[^$`]*|)$/.exec(plain)
  if (!m) return token
  const name = m[1] ?? m[2]!
  // 命令内确定的赋值（applyAssigns）：相对值也代——之后按普通相对路径判
  if (real.vars.has(name)) {
    const v = real.vars.get(name)
    return v == null || /[$`'"\\*?[\]{}]/.test(v) ? token : `${v}${m[3] ?? ''}`
  }
  if (real.localVars.has(name)) return token
  const value = name === 'PWD' ? real.cwd : real.env[name]
  if (!value || !isAbsolute(value) || /[$`'"\\*?[\]{}]/.test(value)) return token
  return value + m[3]!
}

/** 逐级 realpath：最长存在前缀的真实路径 + 剩余未创建段。无展开时原样返回 */
function resolveSymlinked(t: string, root: string): string {
  const abs = t.startsWith('~') ? expandTilde(t) : isAbsolute(t) ? t : resolve(root, t)
  const segs = abs.split('/')
  let i = segs.length
  while (i > 0) {
    const prefix = segs.slice(0, i).join('/') || '/'
    if (existsSync(prefix)) {
      let real: string
      try {
        real = realpathSync(prefix)
      } catch {
        return t
      }
      const rest = segs.slice(i)
      // real 是 / 时直接拼会成 //x（第一级目录不存在），白名单前缀失配
      const out = rest.length ? `${real === '/' ? '' : real}/${rest.join('/')}` : real
      return out === abs ? t : out
    }
    i--
  }
  return t
}

function pathVerdict(
  t: string,
  root: string,
  cfg: ApprovalConfig,
  write: boolean,
  real: RealCtx,
): ApprovalVerdict {
  if (PATH_ALLOWLIST.has(t)) return { kind: 'allow' }

  // 代码文本不是路径（python -c / sh -c 的脚本被切出的参数）——只豁免
  // 读，写目标（`> "/etc/a b;c"`）照判
  if (!write && looksLikeCode(t)) return { kind: 'allow' }

  // $SIMPLE_CODE_DOC 指向的拷贝（2026-11-04 用户点名例外）：系统提示
  // 引导 agent 在任何项目 grep 它，读不拦；写照常按项目外弹
  if (
    !write &&
    (t.startsWith('~') ? expandTilde(t) : t) ===
      join(real.env.HOME ?? homedir(), '.simple-code/bin/self.md')
  )
    return { kind: 'allow' }

  // `..` 先算出实际位置再判（2026-10-26 审计：`cd packages/vscode && … ;
  // cd ../..` 两周弹 98 张）。算不出（变量、当前目录未知）→ 放行 +
  // onUnparsed 日志（2026-11-04 拍板：算不出不弹卡）
  if (t.split('/').includes('..')) {
    const abs = dotdotPathOf(t, real)
    if (abs !== null) return pathVerdict(abs, root, cfg, write, real)
    cfg.onUnparsed?.(t, `路径算不出（.. 回退算不出）：${t}`)
    return { kind: 'allow' }
  }

  // root 先规范到真实形态（macOS /var→/private/var，真实形态对字面 root
  // 会全部误弹）
  let rootReal = root
  try {
    rootReal = realpathSync(root)
  } catch {
    /* root 不存在（测试假路径）：用字面 */
  }

  // symlink 逃逸：路径里的已存在链接段会被 OS 展开到真实位置——项目内
  // link-to-tmp → /tmp 时 `echo > link-to-tmp/x` 字面判是项目内、实写
  // /tmp。逐级 realpath 取真实形态继续判
  const rt = resolveSymlinked(t, rootReal)
  if (rt !== t) return pathVerdict(rt, rootReal, cfg, write, real)
  root = rootReal

  // cd 后的相对路径按 cwd 解析（2026-11-04 修）：`cd .simple-code/memory
  // && echo x > g` 的 g 落在 memory——主判定曾按 root 判，禁令漏。cwd
  // 算不出时保持按 root：字面普通名的落点未知没有保守价值。只收像
  // 路径段的 token——含空白/括号/控制符的（python3 -c "print(1)" 无空白
  // 躲过 looksLikeCode）不是路径，cd 不能把它们带偏
  if (
    !t.startsWith('/') &&
    !t.startsWith('~') &&
    t !== '' &&
    !/[()\s;|&<>]/.test(t) &&
    real.cwd !== null &&
    real.cwd !== root
  ) {
    return pathVerdict(resolve(real.cwd, t), root, cfg, write, real)
  }

  const et = expandTilde(t)

  // memory 写（任何位置的 .simple-code/memory，禁令档）——/tmp 下的
  // 同构路径是 agent 自建仿真夹具，不罩
  if (write && inSimpleCodeTree(et) && et.split('/').includes('memory') && !tmpFixture(et))
    return {
      kind: 'deny',
      reason: `memory 是对话与记忆的原始记录，禁止用 bash 写（SC 进程独占）：${t}`,
    }

  // 项目内/项目外的绝对落点（相对按 root 起算，绝对剥前缀同判）
  const absT = t.startsWith('~') ? et : isAbsolute(t) ? t : resolve(root, t)

  // 审批配置写（2026-11-05 拍板，deny 档）：审批配置是审批的根基——
  // denyCommands 被拒的模型可以改它解除自己的约束，必须硬拦，且压过
  // 批键（用户批过 ~/.simple-code 目录写时未必意识到含审批配置）。
  // 项目级 + 用户级两处。读保持放行（看配置不是威胁）
  const cfgAbs = [
    resolve(root, '.simple-code/approval.json'),
    resolve(homedir(), '.simple-code/approval.json'),
    resolve(real.env.HOME ?? homedir(), '.simple-code/approval.json'),
  ]
  if (write && cfgAbs.includes(absT))
    return {
      kind: 'deny',
      reason: `审批配置（${t}）是审批规则自身的根基，禁止模型写。需要调整时请用户自己修改`,
    }

  // ~/.simple-code 子树（2026-11-05 拍板）：SC 自管的用户级区——notes、
  // skills、logs、run 等，读写免审。审批卡不该拦 agent 的求证流程
  // （读教训/查 bin/self.md）。例外是配置文件：approval.json 写在上面
  // deny 档已拦（memory 写同理在前面），settings.json 落原判定弹卡
  const homeSc = resolve(real.env.HOME ?? homedir(), '.simple-code')
  if (
    (absT === homeSc || absT.startsWith(`${homeSc}/`)) &&
    absT !== resolve(homeSc, 'settings.json')
  )
    return { kind: 'allow' }

  // 批键（读写同权，2026-11-04 拍板项目外一律可始终允许）：目录前缀
  // 匹配（hiddenRead/hiddenWrite 存量已在 loadAlways 并进 paths）
  const granted = cfg.alwaysPaths ?? []
  for (const d of granted)
    if (et === d || et.startsWith(d.endsWith('/') ? d : `${d}/`)) return { kind: 'allow' }

  // 项目内（2026-11-04 拍板全部允许——.env 不例外，用户要拦自己配
  // askCommands）
  const r = root.endsWith('/') ? root : `${root}/`
  if (absT === root || absT.startsWith(r)) return { kind: 'allow' }

  // 项目外：一律 ask，读带「始终允许」键（最深存在目录；家/根过宽不记）
  return {
    kind: 'ask',
    category: 'external_dir',
    detail: t,
    reason: `要${write ? '写' : '读'}项目外路径：${t}`,
    ...(write || dirHint(absT) === null ? {} : { alwaysPaths: [dirHint(absT) as string] }),
  }
}

/** 像代码而不像路径：空白加语句符号（`Application Support`、`x (1).txt`
 * 这类带空格的真路径不中）。换行到这里已被剥掉，不能拿来判 */
const looksLikeCode = (t: string): boolean => /\s/.test(t) && /[;&|{}=]/.test(t)
