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
export type AstSegment = { lead: string, items: AstItem[], unparseable?: string }

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
  let tree: ReturnType<Parser['parse']> | null = null
  try {
    tree = parser.parse(cmd)
  } catch {
    return null
  }
  if (!tree || tree.rootNode.hasError) return null
  const out: AstSegment[] = []
  for (const node of tree.rootNode.descendantsOfType('command').filter((n): n is SyntaxNode => Boolean(n))) {
    const seg = commandToSegment(node)
    if (seg) out.push(seg)
  }
  return out.length > 0 ? out : null
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
  // file_redirect 是 command 的兄弟节点（redirected_statement 的直接子
  // 节点），不收进来的话 `cat x > /etc/passwd` 的重定向目标整个漏扫——
  // 读写分离全靠它标 write。heredoc_redirect 也是这个位置的兄弟
  const host = node.parent?.type === 'redirected_statement' ? node.parent : null
  if (host) {
    for (let i = 0; i < host.childCount; i++) {
      const c = host.child(i)
      // command 自身已在上面 flatten 过，别重复收。注意 child() 每次返回
      // 新的 JS 包装对象，=== 比不了身份，得用 AST 节点 id
      if (c && c.id !== node.id) children.push(c)
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
        const start = c.namedChild(0)?.text ?? ''
        if (!/^['"]/.test(start) && /[$(`]/.test(c.text)) {
          unparseable = '不带引号的 heredoc body 含 $/反引号，会被 shell 展开'
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
