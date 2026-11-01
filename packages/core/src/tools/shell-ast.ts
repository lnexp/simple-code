/**
 * tree-sitter-bash 解析层——审批判定器（approval.ts）的 token 供给。
 *
 * 为什么上 AST（2026-09-08 拍板，approval.md §3.2 的预留升级条款）：正则
 * tokenizer 的结构性误报开始伤害审批信噪比——apply_patch 给文档打补丁时
 * heredoc body 里的 Markdown 反引号被「$()/反引号」字符串检测命中，弹
 * 「无法静态判定」。AST 把这些变成语法事实：
 * - heredoc body 是独立节点，根本不进命令 token（字面量，shell 不解释）
 * - `$( … )` 不是「看到就问」：descendantsOfType("command") 递归枚举
 *   所有嵌套命令，里面的 rm/ls 逐个走完整判定（比一刀切更准也更严）
 * - 引号、转义、`FOO=1 cmd` 前缀是节点类型，不靠正则猜
 *
 * 判定规则本身一行不动——本文件只产出 (lead, items)，judge() 在
 * approval.ts。解析失败/未就绪 → 返回 null，调用方回退正则保守路径，
 * 「看不懂就问」的取向不变。
 *
 * wasm 加载三形态：
 * - 源码直跑 / vitest：node_modules 里 resolve
 * - cli dist（esm）/ vscode dist（cjs）单文件产物：build.mjs 把 wasm 拷到
 *   dist 旁，按 import.meta.url / __dirname 定位（codicon 同款方案）
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Parser = import('web-tree-sitter').Parser
type SyntaxNode = import('web-tree-sitter').Node

/** 一个 token：text 是词面（引号留给 judge 的 unquote），write 标记
 * 重定向目标方向（> >> 2> 是写；< 是读）。redirect：重定向目标——
 * 不是命令参数，参数位豁免（echo/tr/nonPathFrom）罩不到它 */
export type AstItem = { text: string; write: boolean; redirect?: true }
/** nested：命令在所处作用域里不只处在顺序结构中（还有管道、if/for 等）。
 * 顺序结构里的 cd 改变之后各段的当前目录，nested 的 cd 效果不确定
 * （hidden-path.ts 第 2 层据此判「算不出」）。
 * scopes：命令所在的作用域节点 id，外层在前——子 shell、$( )、<( )、后面
 * 跟 `&` 的语句各带一份当前目录，里面的 cd 出来就作废（classify 据此恢复）。
 * assigns：上一段之后、本段之前按源码顺序出现的独立赋值（`W=x`、
 * `export W=x`；`W=x cmd` 的前缀只给那条命令，不算） */
export type AstSegment = {
  lead: string
  items: AstItem[]
  unparseable?: string
  nested?: true
  scopes?: number[]
  assigns?: AstAssign[]
}
/** definite：这个变量的每一处赋值都在最外层作用域的顺序结构里——执行到
 * 这里就一定赋了这个值。有一处在循环/分支/子 shell/函数体里，所有处都不算
 * （循环会回头、函数调用时才赋值，排在前面的赋值也可能被它覆盖）。
 * value：赋值的原文（引号、$VAR 留给 hidden-path 展开）；含 $( ) 等要
 * 执行才知道的、或 `+=` 追加 → null */
export type AstAssign = { name: string; value: string | null; definite: boolean }

let parser: Parser | null = null
let warmup: Promise<boolean> | null = null

/** 产物目录（esbuild 单文件 bundle 旁）。cjs 产物里 import.meta.url 被
 * esbuild 置 undefined，落回 __dirname；两者都拿不到（理论不会）返回 null */
function bundleDir(): string | null {
  try {
    if (typeof import.meta.url === 'string') return dirname(fileURLToPath(import.meta.url))
  } catch {
    /* cjs bundle */
  }
  // 不能走 globalThis：__dirname 是 cjs 模块作用域变量，不在全局上。
  // typeof 探测在 ESM（源码直跑/esm bundle）下安全返回 undefined，
  // cjs bundle 里 esbuild 保留 __dirname 原样、由 node 运行时给真值
  return typeof __dirname === 'string' ? __dirname : null
}

function locateWasm(pkg: string, file: string): string | null {
  const dir = bundleDir()
  if (dir) {
    const beside = join(dir, file)
    if (existsSync(beside)) return beside
  }
  try {
    return createRequire(import.meta.url).resolve(`${pkg}/${file}`)
  } catch {
    return null // 源码直跑时 createRequire 基准是 src/，resolve 失败正常
  }
}

/** 预热：session 启动时 fire-and-forget 调一次。wasm 找不到/加载抛错
 * 返回 false，此后不再重试（classify 永久走正则回退，产品照常工作） */
export function warmupShellParser(): Promise<boolean> {
  warmup ??= (async () => {
    const core = locateWasm('web-tree-sitter', 'tree-sitter.wasm')
    const bash = locateWasm('tree-sitter-bash', 'tree-sitter-bash.wasm')
    if (!core || !bash) return false
    const { Parser, Language } = await import('web-tree-sitter')
    await Parser.init({ locateFile: () => core })
    const language = await Language.load(bash)
    const p = new Parser()
    p.setLanguage(language)
    parser = p
    return true
  })().catch(() => false)
  return warmup
}

/** AST → 段列表。null = 未就绪/解析失败/含错误节点（调用方回退正则） */
export function astSegments(cmd: string): AstSegment[] | null {
  if (!parser) return null
  const tree = parseClean(cmd)
  if (!tree) return null
  const out: AstSegment[] = []
  let assigns: AstAssign[] = []
  // 前序遍历即源码顺序：赋值挂到它之后的第一段上
  for (const node of tree.rootNode
    .descendantsOfType(['command', 'variable_assignment'])
    .filter((n): n is SyntaxNode => Boolean(n))) {
    if (node.type === 'variable_assignment') {
      const a = assignOf(node)
      if (a) assigns.push(a)
      continue
    }
    const seg = commandToSegment(node)
    if (!seg) continue
    const scopes = scopesOf(node)
    out.push({
      ...seg,
      ...(isTopLevel(node) ? {} : { nested: true }),
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(assigns.length > 0 ? { assigns } : {}),
    })
    assigns = []
  }
  const all = [...out.flatMap((s) => s.assigns ?? []), ...assigns]
  const unstable = new Set(all.filter((a) => !a.definite).map((a) => a.name))
  for (const a of all) if (unstable.has(a.name)) a.definite = false
  return out.length > 0 ? out : null
}

const RUNTIME_VALUE_TYPES = [
  'command_substitution',
  'process_substitution',
  'arithmetic_expansion',
  'array',
]

function assignOf(node: SyntaxNode): AstAssign | null {
  const host = node.parent?.type === 'declaration_command' ? node.parent : node
  // 前缀赋值（父节点是 command）不改 shell 变量；下标赋值不跟踪
  if (host.parent?.type === 'command') return null
  const name = node.childForFieldName('name')
  if (name?.type !== 'variable_name') return null
  const value = node.childForFieldName('value')
  const runtime =
    node.children.some((c) => c?.type === '+=') ||
    (value !== null &&
      (RUNTIME_VALUE_TYPES.includes(value.type) ||
        value.descendantsOfType(RUNTIME_VALUE_TYPES).length > 0))
  return {
    name: name.text,
    value: runtime ? null : (value?.text ?? ''),
    definite: isTopLevel(host) && scopesOf(host).length === 0,
  }
}

/** 无错误的语法树；有错返回 null。
 *
 * tree-sitter-bash 0.25.0 grammar bug：双引号串里处在串首/行首的 `((`
 * （`"(() => 1)()"`、`"\n((…"`）被当算术开头报错，bash 本身合法——JS IIFE
 * 必中，agent-browser eval 整条退回正则路径、白名单失效（2026-09-30 实测
 * 近 7 天 114 条解析失败里 83 条是它）。首解析失败才把 `((` 换成 `( (` 重解析：
 * 引号内两者都是字面量；引号外算术 `((e))` 变子 shell 只会多枚举一个命令
 * ——判定只严不松，$(…) 里的子命令照样全量枚举。同类绕行见 isTopLevel */
function parseClean(cmd: string): ReturnType<Parser['parse']> | null {
  const attempt = (text: string): ReturnType<Parser['parse']> | null => {
    try {
      const tree = parser?.parse(text) ?? null
      return tree && !tree.rootNode.hasError ? tree : null
    } catch {
      return null
    }
  }
  const fixed = cmd.includes('((') ? cmd.replaceAll('((', '( (') : cmd
  const hoisted = hoistQuotedHeredocs(fixed)
  return (
    attempt(cmd) ??
    (fixed !== cmd ? attempt(fixed) : null) ??
    (hoisted !== fixed ? attempt(hoisted) : null)
  )
}

/** tree-sitter-bash 0.25.0 另一个 grammar bug：heredoc 起始符所在行，起始符
 * 后面再出现 `;`，或「别的重定向 + `|`」，报错（`cat <<'E' 2>/dev/null | head`、
 * `git commit -F - <<'E' && a | b; c`），bash 本身合法。2026-10-29 实测 14 天
 * 「$( ) 无法静态判定」卡里本项目两条都是它。首解析失败才把该行唯一一个
 * 带引号的起始符挪到行尾：带引号的 body 是字面量、commandToSegment 不给它
 * 出 token，挪动只改 stdin 挂在谁身上，命令与 token 集合不变。不带引号的
 * 不挪——body 展开标记（unparseable）挂在宿主命令上，挪了 alwaysLead 记错命令 */
const QUOTED_HEREDOC = /<<-?\s*(['"])\w+\1/g
function hoistQuotedHeredocs(cmd: string): string {
  return cmd
    .split('\n')
    .map((line) => {
      const hs = line.match(QUOTED_HEREDOC)
      if (hs?.length !== 1) return line
      return `${line.replace(hs[0], '').trimEnd()} ${hs[0]}`
    })
    .join('\n')
}

const TOP_TYPES = new Set(['program', 'list', 'redirected_statement'])
/** 花括号在当前 shell 里跑，里面的 cd 带得出来；但它不进下面的管道例外——
 * `{ cd a; b; } | c` 整块在管道的子 shell 里 */
const SEQ_TYPES = new Set([...TOP_TYPES, 'compound_statement'])
/** 自带一份当前目录的结构：子 shell、$( )、<( )，以及后面跟 `&` 的语句
 * （`cd a && b &` 整个在后台子 shell 里跑，cd 带不到 & 之后）。
 * 2026-10-30 审批复审：某真实项目 `(cd knowledge-server && mvn -s ../settings.xml …)`
 * 曾因子 shell 里的 cd 一律判「之后算不出」弹卡 */
const SCOPE_TYPES = new Set(['subshell', 'command_substitution', 'process_substitution'])
const isAsync = (n: SyntaxNode): boolean => n.nextSibling?.type === '&'

function scopesOf(node: SyntaxNode): number[] {
  const ids: number[] = []
  for (let n: SyntaxNode | null = node; n; n = n.parent)
    if (SCOPE_TYPES.has(n.type) || isAsync(n)) ids.unshift(n.id)
  return ids
}

/** tree-sitter-bash 把 `cd x && a 2>/dev/null | b` 解析成
 * pipeline(redirected_statement(list(cd, a)), b)——管道被抬到 && 之上
 * （不带重定向的 `cd x && a | b` 解析正确，list 在外）。bash 的真实优先级是
 * cd x && (a 2>/dev/null | b)，cd 仍在顶层。所以 pipeline 祖先放行一种形态：
 * 从它的第一个子节点上来、且本命令不是那一块的最右一条（最右那条才真在
 * 管道里）。真机踩过：历史 10 条 `cd root && sqlite3 … ".tables" 2>/dev/null
 * | head` 里 3 条因此被判 cd 算不出。
 *
 * 「顶层」指在最近的作用域（scopesOf）里顶层：走到子 shell/$( )/<( ) 即止；
 * 后台语句要先确认本命令在它里面是顺序位置才算——`cd x | a &` 的 cd 仍在管道里 */
function isTopLevel(node: SyntaxNode): boolean {
  if (isAsync(node)) return true
  let from: SyntaxNode = node
  for (let up = node.parent; up; from = up, up = up.parent) {
    if (SCOPE_TYPES.has(up.type)) return true
    const first = up.namedChild(0)
    const sequential =
      SEQ_TYPES.has(up.type) ||
      (up.type === 'pipeline' &&
        first?.id === from.id &&
        TOP_TYPES.has(from.type) &&
        lastCommandWithin(from)?.id !== node.id)
    if (!sequential) return false
    if (isAsync(up)) return true
  }
  return true
}

/** 沿祖先链找承载本命令重定向的 redirected_statement。
 *
 * 直接父节点就是它的情形最简单（`cat x > f`）；但 tree-sitter-bash 会把
 * 「列表 / 管道 / 复合语句里最右那条命令」的重定向抬到包住整个构造的
 * redirected_statement 上：
 *   a && b > f   => (redirected_statement body: (list a b) redirect: f)
 *   a | b > f    => redirect 挂在 pipeline 上
 *   { a; } > f   => body 是 compound_statement
 * 只往上看一层就会漏掉 b 的重定向目标——`cd X && echo x > /etc/passwd`、
 * `cd X && echo x > .env` 全放行（2026-09-21 修，实测矩阵见 note
 * approval-redirect-hoisting-hole）。判据：本命令必须是那个 body 里最右
 * 的命令——shell 语义上重定向只作用于最右一条，`a > f && b` 的 f 归 a，
 * `a && b > f` 的归 b。
 *
 * 找第一个 redirected_statement 祖先就够了：它是最近的，不匹配说明本命令
 * 不是被重定向的那条。 */
function redirectHostOf(node: SyntaxNode): SyntaxNode | null {
  for (let up = node.parent; up; up = up.parent) {
    if (up.type !== 'redirected_statement') continue
    const body = up.namedChild(0)
    return body && lastCommandWithin(body)?.id === node.id ? up : null
  }
  return null
}

/** body 里最右的 command 节点。只沿结构容器下行，不钻进 $() 之类的替换
 * 内部——`a $(rm x) > f` 的重定向归 a，不归替换里的 rm。
 * 循环与分支要进到体里（2026-10-31）：曾漏掉 do_group/case_item，
 * `for …; done > /etc/passwd` 的重定向没人认领而放行；`cd x && for …; done
 * 2>&1 | head` 的 cd 被当成最右那条、判进管道 */
const CONTAINER_TYPES = new Set([
  'list',
  'pipeline',
  'compound_statement',
  'subshell',
  'command_elements',
  'for_statement',
  'c_style_for_statement',
  'while_statement',
  'if_statement',
  'elif_clause',
  'else_clause',
  'case_statement',
  'case_item',
  'do_group',
])
function lastCommandWithin(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'command') return node
  let last: SyntaxNode | null = null
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (!c) continue
    if (c.type === 'command') last = c
    else if (CONTAINER_TYPES.has(c.type)) last = lastCommandWithin(c) ?? last
  }
  return last
}

/** command 节点 → (lead, items)。跳过的东西各有理由：
 * - variable_assignment（FOO=1 前缀）：不是参数
 * - command_substitution / process_substitution：内部命令已被
 *   descendantsOfType 全量枚举，外层的 text 含 $(…) 会污染路径判定
 * - heredoc_redirect：body 是字面量，shell 不解释——这就是本文件存在的
 *   原因，反引号/$() 在里面只是 Markdown 文本 */
function commandToSegment(node: SyntaxNode): AstSegment | null {
  // 0.25 版 grammar 多一层 command_elements 容器，先摊平
  const children: SyntaxNode[] = []
  // file_redirect 的目标之后的词是命令参数，跟在它后面当兄弟处理（见 redirectParts）
  const pushRedirect = (r: SyntaxNode): void => {
    children.push(r)
    children.push(...redirectParts(r).rest)
  }
  const flatten = (n: SyntaxNode): void => {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)
      if (!c) continue
      if (c.type === 'command_elements') flatten(c)
      else if (c.type === 'file_redirect') pushRedirect(c)
      else children.push(c)
    }
  }
  flatten(node)
  // file_redirect 是 command 的兄弟节点（挂在 redirected_statement 上），
  // 不收进来的话 `cat x > /etc/passwd` 的重定向目标整个漏扫——读写分离
  // 全靠它标 write。heredoc_redirect 也是这个位置的兄弟
  const host = redirectHostOf(node)
  if (host) {
    for (let i = 0; i < host.childCount; i++) {
      const c = host.child(i)
      // 只收重定向：host 可能是包住 list / pipeline / 复合语句的节点
      // （见 redirectHostOf），把结构子节点收进来会把整条命令串当路径判
      if (c?.type === 'file_redirect') pushRedirect(c)
      else if (c?.type === 'heredoc_redirect') {
        children.push(c)
        // 起始符同一行后面的重定向（`cat <<'E' > /tmp/x`）挂在 heredoc_redirect
        // 里面，不进来就整个漏扫（2026-10-30：14 天 52 次，多为写 /tmp——那三个
        // 项目恰好都批过 /tmp；去掉 alwaysPaths 重放，29 条由放行变弹卡）
        for (let j = 0; j < c.childCount; j++) {
          const r = c.child(j)
          if (r?.type === 'file_redirect') pushRedirect(r)
        }
      }
    }
  }

  const items: AstItem[] = []
  // 重定向目标单独收、最后接在参数后面：`> f echo x` 里 f 排在 command_name
  // 前面，混进 items 就被当成 lead（命令名规则全部失效）
  const redirs: AstItem[] = []
  let unparseable: string | undefined
  let argEnd = -1 // 上一个参数 token 的结束位置（拼词用）
  for (const c of children) {
    const before = items.length
    switch (c.type) {
      case 'variable_assignment':
      case 'command_substitution':
      case 'process_substitution':
        break
      case 'heredoc_redirect': {
        // 分隔符带引号（'X' / "X"）→ body 是字面量，shell 不解释，跳过。
        // 不带引号 → body 会被展开：$() 子命令虽已被全量枚举（descendants
        // ofType 不分位置），但 tree-sitter 不解析 body 内的反引号替换
        // （纯文本节点），判不全——标记 unparseable 交给 judge 弹
        //
        // 展开字符只认 $、反引号、转义反斜杠（\\ 会吃掉一个、\ 换行续行）。
        // 裸 ( 不展开：原来字符类写成 [$(]，凡 body 里有函数调用的补丁
        // （几乎全部）都误报 unquoted heredoc（2026-09-21 修）
        const start = c.namedChild(0)?.text ?? ''
        if (!/^['"]/.test(start) && /(\$|`|\\\n|\\[\\$`])/.test(c.text)) {
          unparseable = '不带引号的 heredoc body 含 $/反引号/转义反斜杠，会被 shell 展开'
        }
        break
      }
      case 'file_redirect': {
        // 方向看节点完整文本（> >> 2> 是写，< 是读）。`>&2`、`> $LOG` 这类
        // 目标里没有字面词的不出 token（原样保留）
        const { target } = redirectParts(c)
        if (
          target.some((w) => ['word', 'string', 'raw_string', 'concatenation'].includes(w.type))
        ) {
          const text = target.map((w) => w.text).join('')
          redirs.push({ text, write: /^\s*\d*&?>>?/.test(c.text), redirect: true })
        }
        break
      }
      case 'concatenation': {
        // "a$(x)b" 混合体：拼字面子节点，跳过替换（内部命令已独立枚举）
        let text = ''
        for (let i = 0; i < c.childCount; i++) {
          const p = c.child(i)
          if (p && p.type !== 'command_substitution' && p.type !== 'process_substitution') text += p.text
        }
        if (text !== '') items.push({ text, write: false })
        break
      }
      default:
        // 双引号 string 里嵌的 $() 会被 shell 展开，整 token 参与路径
        // 判定会把字符串里的 .ssh 等片段误判成路径（替换本体已作为独立
        // 段枚举）——下钻只留字面子节点。word / raw_string / command_name
        // 无展开语义，整体收
        if (!c.isNamed) break
        if (c.type === 'string') {
          let text = ''
          for (let i = 0; i < c.namedChildCount; i++) {
            const p = c.namedChild(i)
            if (p && p.type !== 'command_substitution' && p.type !== 'process_substitution') text += p.text
          }
          if (text !== '') items.push({ text, write: false })
        } else {
          items.push({ text: c.text, write: false })
        }
    }
    // grammar bug（tree-sitter-bash 0.25）：`x/$v-$w.png` 被切成
    // concatenation«x/$v-$» + word«w.png» 两个紧挨的兄弟。中间没有空白
    // 就是同一个 shell 词，拼回去——否则 $w 丢失、前半截剩个裸 $ 算不出
    // （2026-10-29 真机九张「隐藏路径」卡）。重定向不参与（`x>o` 是两样东西）
    if (items.length === before + 1 && c.type !== 'file_redirect') {
      if (c.startIndex === argEnd && before > 0) {
        const tail = items.pop() as AstItem
        const head = items[before - 1] as AstItem
        head.text += tail.text
      }
      argEnd = c.endIndex
    } else argEnd = -1
  }
  const lead = items[0]?.text ?? ''
  if (lead === '') return null
  const rest = [...items.slice(1), ...redirs]
  return unparseable === undefined ? { lead, items: rest } : { lead, items: rest, unparseable }
}

/** file_redirect 的目标与多出来的参数。0.25 grammar 的 destination 是
 *  repeat1：`echo > f x` 把 x 也挂进来，原来取最后一个词当目标——f 丢了、
 *  x 成了写目标（`echo > /etc/passwd x` 放行）。bash 语义：操作符后第一个
 *  词是目标，其余是命令参数。「第一个词」= 首个节点连同紧挨着它的碎片
 *  （`$T/final_$l.properties` 被切成 concatenation + word，同上面的拼词 bug） */
function redirectParts(r: SyntaxNode): { target: SyntaxNode[]; rest: SyntaxNode[] } {
  const dest: SyntaxNode[] = []
  for (let i = 0; i < r.namedChildCount; i++) {
    const w = r.namedChild(i)
    if (w && w.type !== 'file_descriptor') dest.push(w)
  }
  let k = 1
  while (k < dest.length && dest[k]?.startIndex === dest[k - 1]?.endIndex) k++
  return { target: dest.slice(0, k), rest: dest.slice(k) }
}
