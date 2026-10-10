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
 * 重定向目标方向（> >> 2> 是写；< 是读） */
export type AstItem = { text: string, write: boolean }
/** nested：命令不只处在顺序结构里（program/list/redirected_statement 之外
 * 还有子 shell、管道、$( )、if/for 等）。只有顶层的 cd 会改变之后各段的
 * 当前目录，nested 的 cd 效果不确定（hidden-path.ts 第 2 层据此判「算不出」） */
export type AstSegment = { lead: string, items: AstItem[], unparseable?: string, nested?: true }

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
  for (const node of tree.rootNode.descendantsOfType('command').filter((n): n is SyntaxNode => Boolean(n))) {
    const seg = commandToSegment(node)
    if (seg) out.push(isTopLevel(node) ? seg : { ...seg, nested: true })
  }
  return out.length > 0 ? out : null
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
  return attempt(cmd) ?? (cmd.includes('((') ? attempt(cmd.replaceAll('((', '( (')) : null)
}

const TOP_TYPES = new Set(['program', 'list', 'redirected_statement'])
/** tree-sitter-bash 把 `cd x && a 2>/dev/null | b` 解析成
 * pipeline(redirected_statement(list(cd, a)), b)——管道被抬到 && 之上
 * （不带重定向的 `cd x && a | b` 解析正确，list 在外）。bash 的真实优先级是
 * cd x && (a 2>/dev/null | b)，cd 仍在顶层。所以 pipeline 祖先放行一种形态：
 * 从它的第一个子节点上来、且本命令不是那一块的最右一条（最右那条才真在
 * 管道里）。真机踩过：历史 10 条 `cd root && sqlite3 … ".tables" 2>/dev/null
 * | head` 里 3 条因此被判 cd 算不出 */
function isTopLevel(node: SyntaxNode): boolean {
  let from: SyntaxNode = node
  for (let up = node.parent; up; from = up, up = up.parent) {
    if (TOP_TYPES.has(up.type)) continue
    const first = up.namedChild(0)
    if (up.type === 'pipeline' && first?.id === from.id && TOP_TYPES.has(from.type) && lastCommandWithin(from)?.id !== node.id) continue
    return false
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
 * 内部——`a $(rm x) > f` 的重定向归 a，不归替换里的 rm */
const CONTAINER_TYPES = new Set(['list', 'pipeline', 'compound_statement', 'subshell', 'command_elements'])
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
  const flatten = (n: SyntaxNode): void => {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)
      if (!c) continue
      if (c.type === 'command_elements') flatten(c)
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
      if (c?.type !== 'file_redirect' && c?.type !== 'heredoc_redirect') continue
      children.push(c)
    }
  }

  const items: AstItem[] = []
  let unparseable: string | undefined
  for (const c of children) {
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
        // 目标是最后一个 word；方向看节点完整文本（> >> 2> 是写，< 是读）
        let arg: SyntaxNode | null = null
        for (let i = 0; i < c.namedChildCount; i++) {
          const w = c.namedChild(i)
          if (w && ['word', 'string', 'raw_string', 'concatenation'].includes(w.type)) arg = w
        }
        if (arg) items.push({ text: arg.text, write: /^\s*\d*&?>>?/.test(c.text) })
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
  }
  const lead = items[0]?.text ?? ''
  if (lead === '') return null
  return unparseable === undefined ? { lead, items: items.slice(1) } : { lead, items: items.slice(1), unparseable }
}
