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

import { dirHint, expandTilde } from './approval-always.ts'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { astSegments } from './shell-ast.ts'
import { cdTarget, gitRevPath, hiddenVerdict, isHiddenSeg, localVarsOf, realPathOf, type RealCtx } from './hidden-path.ts'
import { findWorkspaceRoot } from './workspace-root.ts'

export type ApprovalVerdict =
  | { kind: 'allow' }
  | {
      kind: 'ask'
      category: ApprovalCategory
      detail: string
      reason: string
      /** 这条 ask 支持「始终允许」时，记什么才免审（解释器/网络命令记
       * 命令名）。没有这个字段 = 不给 always（隐藏路径、$( ) 这类无法
       * 收敛成安全粒度的），UI 出两键 */
      alwaysLead?: string
      /** 触发 token 是第 from 位（0 基）位置参数且 ≥2——「该命令从这位
       * 起不是路径」的采集依据（external_dir 专属：元素寻址工具的
       * 触发必然是 verb + 文件参数之后的位）。位 <2 的卡不给（cat
       * /etc/passwd 的参数全是路径，这个选项只是噪音） */
      nonPathFrom?: { lead: string; from: number }
      /** 方案 1（2026-09-21 拍板）：multi 触发点全是 external_dir、每个
       * 都收敛出合法目录（dirHint 非 null——家目录/根过宽不记）且去重
       * 后 ≤5 个时的批量 always 预览。掺任何别的类别（解释器/网络/
       * 隐藏路径）不给——粒度不一的东西一键全记，等于替用户批了
       * 没细看的 */
      alwaysPaths?: string[]
      /** 隐藏路径的始终允许预览（2026-09-29 拍板，hidden-path.md）：记到
       * 第一个隐藏段为止、读写分开。项目内是相对路径，项目外是绝对路径 */
      alwaysHidden?: { path: string; write: boolean }
    }

/** 审批类别。UI 用它显示标签（external_dir 等），detail 是触发物 */
export type ApprovalCategory =
  | 'external_dir'
  | 'hidden_path'
  | 'network_cmd'
  | 'ask_rule'
  | 'unparseable'
  | 'multi'

/** 类别标签的中文名。UI 与 CLI 共用（approval.md §4.3） */
export const CATEGORY_LABEL: Record<ApprovalCategory, string> = {
  external_dir: '项目外路径',
  hidden_path: '隐藏路径',
  network_cmd: '网络命令',
  ask_rule: '自定义规则',
  unparseable: '无法静态判定',
  multi: '多重触发',
}

export type ApprovalConfig = {
  /** 项目内隐藏路径的首组件白名单。命中即放行整个子树 */
  hiddenAllow: string[]
  /** 网络命令白名单（首 token 精确匹配）。默认那几个并不在网络命令集里，
   * 留着是「未来扩集时这些仍然放行」的声明位 */
  networkAllow: string[]
  /** 自定义审批规则（2026-09-27 拍板，当天二次拍板移出 settings.json）：
   *  lead / lead+子命令 / lead+子命令+子子命令（'appctl workloads apply'）
   *  命中即弹卡。来源（bash.ts 组合并集）：内置默认（发布闸）∪ 用户级
   *  ~/.simple-code/approval.json ∪ 项目级 .simple-code/approval.json。
   *  例外走 alwaysLeads（卡上「始终允许」），不走 networkAllow——那是
   *  网络命令的例外面，语义不同的东西不互相搭车 */
  askCommands: string[]
  /** always 执行器白名单（approval.json leads，运行时追加）。命中只免命令名
   * 那一层，路径照判（2026-09-30：lead 与路径是 AND） */
  alwaysLeads?: string[]
  /** always 路径白名单（approval.json paths，展开后的绝对目录前缀）。
   * 命中=该 token 免审。匹配前 token 也做 ~ 展开，两侧形态一致 */
  alwaysPaths?: string[]
  /** 命令名 → 从第几位位置参数起不判为路径（0 基，区间豁免）。
   * 元素寻址类的私有工具从这里配（settings），core 不内置条目 */
  nonPathFrom?: Record<string, number>
  /** 隐藏路径始终允许（approval.json hiddenRead/hiddenWrite，卡上采集）。
   * 条目是路径前缀：等于或以「条目/」开头即命中 */
  hiddenRead?: string[]
  hiddenWrite?: string[]
  /** bash 工具 spawn 的环境——第 2 层替换 $VAR 用。缺省 = 空（变量全算不出） */
  env?: Record<string, string>
  /** 存在检查。缺省 fs.existsSync；测试在假 root 下注入 */
  pathExists?: (abs: string) => boolean
}

/** 隐藏路径默认例外：空（2026-09-29 拍板 `.git` 移出，例外只剩
 * .simple-code 自己的四个目录，见 pathVerdict）。用户手写的 hiddenAllow
 * 仍从两级 approval.json 并进来 */
export const DEFAULT_HIDDEN_ALLOW: string[] = []
export const DEFAULT_NETWORK_ALLOW = ['npm', 'pnpm', 'yarn', 'git', 'node']
/** askCommands 的内置默认（发布闸兜底）。git/gh 不进 NETWORK_COMMANDS——
 *  add/commit/diff 是一天几十次的日常刚需，全拦等于审批疲劳；真正拦的
 *  只有出网写形态。用户级/项目级 approval.json 只往这份兜底上并 */
export const DEFAULT_ASK_COMMANDS = ['git push', 'gh']
/** 走网络的通用外传通道（§2 规则 2）。git/npm 不在这里——它们是刚需 */
const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'ssh',
  'scp',
  'rsync',
  'ftp',
  'telnet',
])

/** 任意代码解释器（§2 规则 1）。出现即问，不分参数 */
const INTERPRETERS = new Set(['python', 'python3', 'osascript', 'sudo'])

/** 同为任意代码，但只有带 -e 类开关才构成 eval（node script.js 是日常） */
const EVAL_FLAGGED = new Set(['node', 'perl', 'ruby'])

/** 裸 shell。管道喂 shell 是最典型的载荷路径（§3.3） */
const SHELLS = new Set(['sh', 'bash', 'zsh'])

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
  // 第 2 层的真实路径上下文（hidden-path.ts）：cwd 随顶层 cd 逐段更新
  const real: RealCtx = { cwd: root, env: cfg.env ?? {}, localVars: localVarsOf(cmd) }

  // 规则 0：自家 bin。引号形态固定（宿主注入的就是 "$SIMPLE_CODE_X"）。
  // 例外：APPLY_PATCH 的 heredoc 里藏着任意路径的写操作（补审批闭环的
  // 洞——别的自家 bin 都是固定语义，唯有它把「写哪」完全交给补丁内容），
  // 抽出路径逐个过 pathVerdict（写意图）
  if (cmd.startsWith('"$SIMPLE_CODE_')) {
    if (cmd.startsWith('"$SIMPLE_CODE_APPLY_PATCH"')) {
      const v = patchVerdict(cmd, root, cfg, real)
      if (v) return v
      // 不带引号的分隔符要一并查：body 会被 shell 展开（反引号替换
      // tree-sitter 不解析，看不见），同一条命令前面挂个 `cd X &&` 就拦、
      // 裸着就放，是两个答案（2026-09-21 修）。带引号的分隔符 body 是
      // 字面量，AST 判定不会误报——那正是本文件 AST 化的初衷
      const reason = unquotedHeredocReason(cmd)
      if (reason && !leadAllowed('"$SIMPLE_CODE_APPLY_PATCH"', [], cfg)) {
        return {
          kind: 'ask',
          category: 'unparseable',
          detail: 'unquoted heredoc',
          reason,
          // 与 AST 路径同语义：始终允许这个 bin 的一切内联形态（展开风险
          // 是批的时候自己接受的）
          alwaysLead: '$SIMPLE_CODE_APPLY_PATCH',
        }
      }
    }
    // 其余自家 bin（NOTE/LESSON 的 write 吃 heredoc stdin）：
    // 子命令语义固定，但**不带引号的分隔符 body 会被 shell 展开**（$( )
    // 任意命令，通道的不变式校验管不到 shell 层）——与 APPLY_PATCH 同
    // 语义弹卡。带引号的 heredoc（所有用法样例的形态）body 是字面量，照放
    // （2026-09-24 收口；patch 子命令 2026-09-27 退役，write 的洞继续堵着）
    const lead = /\S+/.exec(cmd)?.[0] ?? ''
    const heredocReason = unquotedHeredocReason(cmd)
    if (heredocReason && !leadAllowed(lead, [], cfg)) {
      return {
        kind: 'ask',
        category: 'unparseable',
        detail: 'unquoted heredoc',
        reason: heredocReason,
        alwaysLead: unquote(lead),
      }
    }
    return { kind: 'allow' }
  }

  // AST 路径：正则层那套「含 $( / 反引号就问」在这里不需要——$() 里的
  // 子命令被 descendantsOfType 递归枚举独立判定，heredoc body 是字面量
  // 不进 token。apply_patch 打含 Markdown 反引号的文档补丁不再误弹
  // 「无法静态判定」（本升级的直接动因）
  const segs = astSegments(cmd)
  if (segs) {
    const asks: Extract<ApprovalVerdict, { kind: 'ask' }>[] = []
    for (const s of segs) {
      if (s.unparseable) {
        // lead 白名单命中=段放行（judge 的同语义）：批过 python3 就是
        // 接受它的一切内联形态，heredoc 不例外。这条早退原本绕过白
        // 名单检查——同一条白名单两个行为（<<'EOF' 免审、<<EOF 照弹）
        // 命中后仍往下走 judge：lead 不能绕过隐藏路径（第 4 层）
        if (!leadAllowed(s.lead, s.items, cfg)) {
          return {
            kind: 'ask',
            category: 'unparseable',
            detail: 'unquoted heredoc',
            reason: s.unparseable,
            // 采集键=段 lead，与解释器卡同语义：始终允许这个命令的
            // 一切内联形态（展开风险是批的时候自己接受的）
            alwaysLead: unquote(s.lead),
          }
        }
      }
      const v = judge(s.lead, s.items, root, cfg, real, cmd)
      if (v.kind === 'ask') asks.push(v)
      trackCd(s.lead, s.items, s.nested !== true, real)
    }
    return mergeAsks(asks)
  }

  // 回退：正则保守路径。wasm 未就绪（冷启动窗口）/ 加载失败 / 命令含
  // 语法错误节点时走到这里
  // 规则 1a：命令替换 / 反引号，字符串级检测（跨 token 的 `$( ls )`
  // 在 token 级看不见）
  if (cmd.includes('$(') || cmd.includes('`')) {
    return {
      kind: 'ask',
      category: 'unparseable',
      detail: '$( ) 或反引号',
      reason: '命令含 $( ) 或反引号，无法静态判定安全性',
    }
  }

  // 全段收集后合并展示（2026-09-15 拍板）：首中即返会展示「最无害的段」——
  // `cd /Users/dev && python3 - <<EOF`（读 Downloads xlsx）弹的是 cd 的
  // 项目外路径，python3 任意代码被遮住。合并卡给全量触发点，用户点
  // 「允许一次」放行的是整条命令，理由该覆盖整条命令。multi 不给
  // alwaysLead——多处触发无法收敛成安全粒度（同隐藏路径的口径）
  const asks: Extract<ApprovalVerdict, { kind: 'ask' }>[] = []
  for (const seg of splitSegments(cmd)) {
    const v = classifySegment(seg, root, cfg, real, cmd)
    if (v.kind === 'ask') asks.push(v)
    trackCd(seg[0] ?? '', seg.slice(1).map((text) => ({ text })), true, real)
  }
  return mergeAsks(asks)
}

/** 段是 cd 时更新当前目录：顶层的按目标算，非顶层的（子 shell、管道、
 * $( )、if/for 里）效果不确定，之后一律算不出 */
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
 * multi 不给 alwaysLead——多处触发无法收敛成安全粒度（同隐藏路径的口径）；
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
  // 批量 always 的判据：全是 external_dir、每个 dirHint 都收敛出合法
  // 目录、去重后 ≤5 个（一笔大账逼你分开看）
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
  return {
    kind: 'ask',
    category: 'multi',
    detail: head.join('；'),
    reason: `命令有多处需要审批：\n${head.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    ...(batchAlways && dirs.size <= 5 ? { alwaysPaths: [...dirs] } : {}),
  }
}

/** lead 后第一个位置参数：跳 flag、赋值、骨架词、lead 占位（正则回退
 * 段的 items 含 lead，AST 段不含——`t === lead` 对 AST 段里恰好同名
 * 的参数也只是多跳一个，影响方向是收紧不是漏放）。子命令级白名单
 * ('agent-browser eval') 的匹配与采集共用它，两侧必须对称 */
function firstPositional(lead: string, items: { text: string }[]): string | undefined {
  for (const it of items) {
    const t = unquote(it.text)
    if (t === '' || t === '-' || t === lead) continue
    if (t.startsWith('-')) continue
    if (SHELL_RESERVED.has(t)) continue
    if (/^[^/"'.]*=/.test(t)) continue
    return t
  }
  return undefined
}

/** 位置参数序列（askCommands 规则与 alwaysLeads 豁免共用）：lead 后的
 *  位置参数按序收集，flag 跳过。不能直接用 firstPositional——git 的
 *  -C <path> / -c <k=v> 是带值全局 flag，值是普通 token，`git -C /tmp
 *  push` 会被取成 /tmp → 匹配不上 'git push' → fail-open 绕过。带值
 *  全局 flag 就 git 这两个 */
function positionalsOf(lead: string, items: { text: string }[]): string[] {
  const out: string[] = []
  let skipNext = false
  for (const it of items) {
    const t = unquote(it.text)
    if (skipNext) {
      skipNext = false
      continue
    }
    if (t === '' || t === '-' || t === unquote(lead)) continue
    if (t.startsWith('-')) {
      if (unquote(lead) === 'git' && (t === '-C' || t === '-c')) skipNext = true
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

/** lead 白名单命中（=段放行）。两轮精确等值，非前缀：先查子命令级
 * 条目（lead + 第一个位置参数，如 'agent-browser eval'——批 eval
 * 子命令不放行 screenshot），再查裸 lead（批过 python3 就是接受它
 * 的一切内联形态，-c/heredoc/脚本同权） */
function leadAllowed(lead: string, items: { text: string }[], cfg: ApprovalConfig): boolean {
  const leads = cfg.alwaysLeads
  if (!leads?.length) return false
  const bare = unquote(lead)
  // pathMatches 的词级匹配：'node eval'（既有形态）、'appctl workloads
  // apply'（三级，2026-09-27）都是条目=命令前 N 个 token。比旧的
  // `${bare} ${firstPositional}` 两级形态多罩一层，且 git -C 值跳过让
  // `git -C /tmp push` 也能命中 'git push' 的豁免
  const pos = positionalsOf(lead, items)
  return leads.some((e) => pathMatches(e, bare, pos))
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
 * 调用约定，内置对所有用户成立 */
const NONPATH_ALL_POSITIONAL = new Set(['echo', 'printf'])

/** 这些 flag 的**值**是脚本/模式/glob 而非路径：sed/grep/awk 的 -e、
 * find 的 -name/-path、tar/rsync 的 --exclude。等号形态（--regexp=x）
 * 值内嵌在 flag token 里，以 - 开头本就跳过 */
const NONPATH_FLAG_VALUES = new Set([
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
  items: { text: string; write: boolean }[],
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

  // always 执行器白名单：leadAllowed（含子命令级条目，见其注释）。
  // 必须在 lead 回填**之后**（回退路径进来时 lead 是 ''，靠上面回填
  // 成首 token）。命中只免掉命令名这一层（解释器/网络/自定义规则），
  // 路径照查——隐藏路径（2026-09-29 第 4 层）与项目外路径（2026-09-30）
  if (!leadAllowed(lead, items, cfg)) {
    const v = commandRules(lead, items, cfg)
    if (v) return v
  }
  return pathRules(lead, items, root, cfg, real, { fromFallback, head })
}

/** 规则 1b–2：看命令名就能判的（解释器、eval、自定义规则、网络命令）。
 * 不命中返回 null */
function commandRules(
  lead: string,
  items: { text: string; write: boolean }[],
  cfg: ApprovalConfig,
): ApprovalVerdict | null {
  // 规则 1b/1c：解释器、裸 shell、eval
  if (INTERPRETERS.has(lead) || SHELLS.has(lead)) {
    return {
      kind: 'ask',
      category: 'unparseable',
      detail: lead,
      reason: `命令以 ${lead} 开头，可执行任意代码`,
      alwaysLead: lead,
    }
  }
  if (EVAL_FLAGGED.has(lead) && items.some((i) => /^-[^-]*e/.test(i.text))) {
    return {
      kind: 'ask',
      category: 'unparseable',
      detail: lead,
      reason: `${lead} 带 -e 类开关，可执行任意代码`,
    }
  }
  if (items.some((i) => unquote(i.text) === 'eval')) {
    // eval 恰为第一个位置参数（'agent-browser eval …'）才有可收敛的
    // 子命令粒度；嵌在深处出现（'foo eval bar'）没有安全键，两键
    const sub = firstPositional(unquote(lead), items)
    return {
      kind: 'ask',
      category: 'unparseable',
      detail: 'eval',
      reason: '命令含 eval，无法静态判定',
      ...(sub === 'eval' ? { alwaysLead: `${unquote(lead)} eval` } : {}),
    }
  }

  // 规则 1.5：自定义审批规则（askCommands，2026-09-27 拍板）。优先于
  // 规则 2——appctl deploy /prod 这类带项目外路径的调用，报「自定义
  // 规则」比报「项目外路径」更接近用户配规则时的意图；且卡上的
  // alwaysLead（appctl deploy）比路径收敛（/prod）粒度更对。类别独立
  // （ask_rule）——appctl 不是网络命令，标签不能撒谎（用户拍板）。
  // 条目来源：内置默认（DEFAULT_ASK_COMMANDS，发布闸）∪ 用户级
  // ~/.simple-code/approval.json ∪ 项目级 .simple-code/approval.json
  // （2026-09-27 二次拍板：审批规则与 settings.json 隔离，独立文件）
  if (cfg.askCommands.length) {
    const bare = unquote(lead)
    const pos = positionalsOf(lead, items)
    // 多条命中取 token 最长的（最紧的）——卡上「始终允许」按最紧粒度
    // 收敛：'appctl workloads' 与 'appctl workloads apply' 都在时，
    // 弹卡给后者，批 apply 不外溢到 workloads 的其他子命令
    const hit = cfg.askCommands
      .filter((r) => pathMatches(r, bare, pos))
      .sort((a, b) => b.split(' ').length - a.split(' ').length)[0]
    if (hit && !leadAllowed(lead, items, cfg)) {
      return {
        kind: 'ask',
        category: 'ask_rule',
        detail: hit,
        reason: `${hit} 命中自定义审批规则`,
        alwaysLead: hit,
      }
    }
  }

  // 规则 2：网络命令
  if (NETWORK_COMMANDS.has(lead) && !cfg.networkAllow.includes(lead)) {
    return {
      kind: 'ask',
      category: 'network_cmd',
      detail: lead,
      reason: `${lead} 是网络命令，不在白名单里`,
      alwaysLead: lead,
    }
  }

  return null
}

/** 规则 3/4：逐 token 查路径 */
function pathRules(
  lead: string,
  items: { text: string; write: boolean }[],
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
  let exemptFromPosition = cfg.nonPathFrom?.[lead] ?? (NONPATH_ALL_POSITIONAL.has(lead) ? 0 : Infinity)
  // 子命令级条目（'agent-browser eval'）：与 alwaysLeads 的 pathMatches
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
  for (const [idx, item] of items.entries()) {
    const t = unquote(stripRedirect(item.text))
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
    if (firstPositionalLeft) {
      firstPositionalLeft = false
      continue // sed/grep/awk 的 script/pattern 位
    }
    // 豁免只罩「读形态」的 token：带写意图的（> /tmp/x 的重定向目标、
    // rm 类写动词的参数）不豁免——元素寻址工具的豁免位起没有写语义的
    // fs 路径参数，但重定向能把任意文件变成它的 token。真机踩过：
    // `xcli get f.pptx /body > ~/Desktop/y.txt` 曾被区间豁免放过
    if (positionalSeen >= exemptFromPosition && !item.write && !verbWrites) {
      positionalSeen++
      continue // nonPathFrom 豁免位起：元素路径与 flag 值，非 fs 路径
    }
    const at = positionalSeen
    positionalSeen++
    const write = item.write || verbWrites
    // git 的 REV:path：冒号后是仓库历史里的路径，磁盘上不一定有——不查
    // 存在，按第 1 层看名字（`git show HEAD:.env` 拦）
    const revPath = unquote(lead) === 'git' ? gitRevPath(t) : null
    if (revPath !== null) {
      if (revPath.split('/').some(isHiddenSeg)) {
        return { kind: 'ask', category: 'hidden_path', detail: t, reason: `要读取 git 历史里的隐藏路径：${t}` }
      }
      continue
    }
    const v = pathVerdict(t, root, cfg, write, real)
    // 项目外的点开头路径按隐藏路径判（2026-09-30，不论有无 lead）：卡上
    // 始终允许键收敛到隐藏段、读写分开（~/.ssh 读），不走 external_dir 记
    // 整个目录（读写全免）。存在且已批（hiddenRead/Write）= 过；不存在 =
    // 隐藏这层不管，落回项目外路径照弹（`echo x > ~/.newdir/f` 仍是往项目外写）。
    // lead 与路径是 AND（2026-09-30 拍板）：lead 只免命令名那一层，走到
    // 这里的路径判定与没批 lead 时完全相同
    if (v.kind === 'ask' && v.category === 'external_dir') {
      const abs = realPathOf(t, real)
      if (abs === null || abs.split('/').some(isHiddenSeg)) {
        const h = hiddenVerdict(t, root, cfg, write, real)
        if (h.kind === 'ask') return h
        if (abs !== null && !/[*?]/.test(abs) && (cfg.pathExists ?? existsSync)(abs)) continue
      }
    }
    // nonPathFrom 采集依据：触发位 ≥2 且是 external_dir（hidden_path 的
    // 触发物是真路径，这个选项是误导）。lead 在段首，元素寻址工具的
    // 结构必然是 verb（位0）+ 文件参数（位1）+ 元素路径（位2+）
    if (v.kind === 'ask')
      return { ...v, ...(at >= 2 && v.category === 'external_dir' ? { nonPathFrom: { lead, from: at } } : {}) }
  }
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
  const items: { text: string; write: boolean }[] = []
  let pendingRedirect = false
  for (const token of seg) {
    const redirectedWrite = /^\d*&?>>?/.test(token) || pendingRedirect
    pendingRedirect = /^\d*&?>>?$/.test(token)
    items.push({ text: token, write: redirectedWrite })
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
function patchVerdict(cmd: string, root: string, cfg: ApprovalConfig, real: RealCtx): ApprovalVerdict | null {
  const patchReal = { ...real, cwd: real.cwd === null ? null : findWorkspaceRoot(real.cwd) }
  for (const m of cmd.matchAll(PATCH_PATH_RE)) {
    const p = (m[1] ?? m[2] ?? '').trim()
    if (p === '') continue
    const v = pathVerdict(p, root, cfg, true, patchReal)
    if (v.kind === 'ask') return v
  }
  return null
}

/** 不带引号 heredoc 的展开风险（AST 判定）。解析器未就绪时返回 null——
 * 这里不能退化成字符串级「含 $() / 反引号就问」：引号 heredoc 的 body 是
 * 字面量，那正是 AST 化的初衷（approval-ast.test.ts 锁着这条行为） */
function unquotedHeredocReason(cmd: string): string | null {
  for (const s of astSegments(cmd) ?? []) if (s.unparseable) return s.unparseable
  return null
}

const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, '$2')

/** 剥掉粘在路径上的重定向前缀：`>file` `2>file` `<f` `2>&1`（剥完剩
 * `&1` 之类，不构成路径自然跳过）。
 * `>` `<` 必须出现（不能 `>?`）：可选会把 `0.4` `1.5` 这类纯数字
 * 参数剥掉前导数字变 `.4`，掉进隐藏路径误判——sleep 0.4 弹过卡 */
const stripRedirect = (t: string) => t.replace(/^\d*&?>>/, '').replace(/^\d*&?</, '')

/** 逐级 realpath：最长存在前缀的真实路径 + 剩余未创建段。无展开时原样返回 */
function resolveSymlinked(t: string, root: string): string {
  const abs = t.startsWith('~')
    ? expandTilde(t)
    : isAbsolute(t)
      ? t
      : resolve(root, t)
  const segs = abs.split('/')
  let i = segs.length
  while (i > 0) {
    const prefix = segs.slice(0, i).join('/') || '/'
    if (existsSync(prefix)) {
      let real: string
      try { real = realpathSync(prefix) } catch { return t }
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

  // root 先规范到真实形态：root 自身含链接（macOS /var→/private/var）
  // 时，路径的真实形态永远对不上字面 root，会全部误弹
  let rootReal = root
  try { rootReal = realpathSync(root) } catch { /* root 不存在（测试假路径）：用字面 */ }

  // symlink 逃逸：路径里的已存在链接段会被 OS 展开到真实位置，字符串
  // 判定却按字面——项目内 link-to-tmp → /tmp 时 `echo > link-to-tmp/x`
  // 判成项目内、实写 /tmp。逐级 realpath：取最长存在前缀的真实路径拼
  // 上剩余未创建部分，用真实形态继续判。不存在的新路径不受影响
  const rt = resolveSymlinked(t, rootReal)
  if (rt !== t) return pathVerdict(rt, rootReal, cfg, write, real)
  root = rootReal
  // 第 2 层算真实路径用原形态（下面项目内绝对路径会被剥成相对 root 的，
  // 而相对路径在 hiddenVerdict 里按当前目录解析）
  const orig = t

  // always 路径白名单：展开 ~ 后按目录前缀匹配（d + '/' 防
  // /a/bc 沾 /a/b 的光）。读写同权——批的是「这个目录可以碰」
  if (cfg.alwaysPaths) {
    const et = expandTilde(t)
    for (const d of cfg.alwaysPaths) {
      if (et === d || et.startsWith(d.endsWith('/') ? d : `${d}/`)) return { kind: 'allow' }
    }
  }

  const outside = (what: string): ApprovalVerdict => ({
    kind: 'ask',
    category: 'external_dir',
    detail: what,
    reason: `要${write ? '写' : '读'}项目外路径：${what}`,
  })

  // 项目外读放行的**唯一例外**（2026-09-17 用户澄清）：.simple-code 子树
  // ——SC 自家状态目录，工具描述引导 agent 跨项目直读（events/turns 原文），
  // 不放行则审批与产品机制打架。其余项目外读**仍弹**（~/.ssh、/etc、
  // 其他项目源码——泄露面在读）。写不论是否 .simple-code 都弹
  if (t.startsWith('~')) return write || !inSimpleCodeTree(t) ? outside(t) : { kind: 'allow' }

  if (t.startsWith('/')) {
    // 绝对路径：不在 root 前缀内即项目外
    const r = root.endsWith('/') ? root : `${root}/`
    if (t !== root && !t.startsWith(r)) return write || !inSimpleCodeTree(t) ? outside(t) : { kind: 'allow' }
    // root 内的绝对路径剥掉前缀转相对形态——下面的组件级规则（.simple-code
    // 读写分离、隐藏组件扫描）只看首组件，不剥的话 cat /abs/root/.simple-code/x
    // 的首组件是 Users，读写分离豁免失配、掉进通用隐藏扫描，读也误弹
    t = t.slice(r.length)
  }

  // 组件级：.. 逃逸（绝对与相对统一保守处理，foo/../bar 不逃逸也会问，
  // 换取不解析真实走向的简单性）+ 隐藏组件
  const parts = t.split('/').filter((p) => p !== '')
  // .simple-code 子树读写分离（用户拍板）：读放行——memory 检索通道
  // ($SIMPLE_CODE_MEMORY) 本就免审批，grep/cat 直读不该两样待遇；写弹卡
  // ——记忆完整性，被诱导往 turn 文件塞假记忆是真实攻击面。只认首组件，
  // 整树同规则。.env/.ssh 等其他隐藏路径**不**在豁免内：凭据的泄露面在
  // 读，读写分离对它们是削弱（2026-09-14 用户再次拍板：读彻底放行，
  // 连 settings.json 也读——翻打爆上下文的风险用户认了，弹卡的打扰更贵）
  if (parts[0] === '.simple-code') {
    const writeAsk = {
      kind: 'ask',
      category: 'hidden_path',
      detail: t,
      reason: `要写入 .simple-code 数据：${t}`,
    } as const
    // settings.json：读放行、写拦——apiKey 躺在里面，改配置走用户
    if (parts[1] === 'settings.json') return write ? writeAsk : { kind: 'allow' }
    // 默认例外（2026-09-29 拍板）：notes/lessons/events/skills 读写都放行
    // ——模型自助成长与事件归档区，各自有免审的通道，裸 shell 同待遇
    if (SC_OPEN_DIRS.has(parts[1] ?? '')) return { kind: 'allow' }
    // 其余整树：读放行（对话史、regions——用户拍板），写弹卡
    return write ? writeAsk : { kind: 'allow' }
  }
  if (parts.includes('..')) return write || !inSimpleCodeTree(t) ? outside(t) : { kind: 'allow' }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? ''
    // 省略号形态（纯点 ≥3，echo ... 的分隔符）与 `.` 不是隐藏段——isHiddenSeg
    // 排除（2026-09-14 实案：echo ... 弹「隐藏路径:...」，真报项目外路径被抢戏）
    if (isHiddenSeg(p)) {
      // 手写白名单只认首组件；中段隐藏（src/.env）一律进第 2 层
      if (i === 0 && cfg.hiddenAllow.includes(p)) continue
      // 第 1 层判出候选，第 2 层（hidden-path.ts）按真实路径定
      return hiddenVerdict(orig, root, cfg, write, real)
    }
  }
  return { kind: 'allow' }
}

/** .simple-code 下读写都免审的目录（2026-09-29 拍板） */
const SC_OPEN_DIRS = new Set(['notes', 'lessons', 'events', 'skills'])
