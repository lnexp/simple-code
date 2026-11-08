import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdownLang from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import { marked } from 'marked'
import { linkifyDom } from './pathlink.ts'

/**
 * assistant 文本的 markdown 渲染。纯函数：marked 解析 → DOMPurify 消毒，
 * 输出一段可以进 dangerouslySetInnerHTML 的 HTML。
 *
 * **为什么是 dangerouslySetInnerHTML 而不是 React 组件树**：流式期间不渲
 * （App.tsx 的 isStreaming 分流），渲染只发生在气泡结束时，没有「React
 * 节点和外部 DOM 混住」的状态同步问题；换组件树（react-markdown 那类）
 * 要拖进整棵 remark 依赖树，marked 是单包。
 *
 * **消毒不是装饰**：这段 HTML 的来源是模型输出，模型输出不可信——
 * prompt 注入可以让它吐 `<script>` 或 `onerror=`。DOMPurify 默认配置
 * 就剥这些，不额外放宽。
 */
/**
 * 语法高亮（2026-09-12 拍板）：hljs **精选语言子集**（约 40KB 本地文件），
 * 不整包。对话里出现频率排序：bash/ts/js/json/css/html/python/md/diff
 * ——diff 尤其值（apply_patch 输出的 +/- 行直接绿红）。没注册的语言
 * （冷门或没标）回落 marked 默认纯文本，不猜（highlightAuto 慢且常错）。
 *
 * renderer 返回 false = 交给 marked 默认渲染（v5+ 契约）。
 * hljs.highlight 的输出自带 HTML 转义，DOMPurify 后面的消毒管线照常走
 * （span/class 在默认白名单内）。
 */
hljs.registerLanguage('bash', bash)
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerLanguage('css', css)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdownLang)
hljs.registerLanguage('python', python)
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerLanguage('typescript', typescript)
hljs.registerAliases(['ts'], { languageName: 'typescript' })
hljs.registerLanguage('javascript', javascript)
hljs.registerAliases(['js'], { languageName: 'javascript' })
hljs.registerLanguage('xml', xml)
hljs.registerAliases(['html'], { languageName: 'xml' })

marked.use({
  gfm: true,
  renderer: {
    code(token: { text?: string; lang?: string }): string | false {
      const id = (token.lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      if (id === '' || token.text === undefined || !hljs.getLanguage(id)) return false
      const text = token.text
      // marked v18 给 renderer 的 text 已被剥尾换行（默认渲染会补回），
      // 自己接管就得自己补——复制语义不变（bash 块复制直接跑）
      const tail = '\n'
      return `<pre><code class="hljs language-${id}">${hljs.highlight(text, { language: id }).value}${tail}</code></pre>`
    },
  },
})

// 链接统一新开。webview 里点击会被 App.tsx 拦下来转给宿主 openExternal，
// 但 target 仍要写对：万一拦截漏了（比如键盘激活），内嵌导航在 webview 里
// 就是一次白屏。afterSanitizeAttributes 是 DOMPurify 文档推荐的挂点
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
  // 代码块角落的复制按钮。**在消毒钩子里注入**而不是渲染后改 DOM：
  // 这样它天然经过同一层管线，不会成为「绕过消毒的后门」。按钮本身
  // 不带任何内联处理器（CSP 也拦 onclick），点击走 .log 上的事件委托
  // （App.tsx 的 onLogClick，和链接外开同一个入口）
  if (node.tagName === 'PRE') {
    const btn = node.ownerDocument.createElement('button')
    btn.type = 'button'
    btn.className = 'code-copy'
    btn.textContent = '复制'
    btn.setAttribute('aria-label', '复制代码')
    node.prepend(btn)
  }
})

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false })
  const clean = DOMPurify.sanitize(html)
  // 消毒之后再链接化：linkifyDom 产出的节点结构是固定的（纯 text + 单属
  // 性 a，setAttribute 自带转义），不构成绕过消毒的注入面。链接化产物也不
  // 需要再过 DOMPurify——它只认危险结构，data-* 属性原样放行
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html')
  markBoldHeadings(doc.body)
  wrapPlainCode(doc.body)
  linkifyDom(doc.body)
  return doc.body.innerHTML
}

/**
 * 整段只有一处加粗的段落（「**验证情况**」「**请你决定：**」）按小标题显示。
 * 模型分节习惯写加粗行而不是 `###`，不标出来的话它和「**改动效果**：……」
 * 这种加粗开头的正文长得一样，层级读不出来（2026-10-28 回答排版改版）。
 * 只看顶层段落：列表项里的加粗是条目内容，不是分节
 */
function markBoldHeadings(body: HTMLElement): void {
  for (const p of body.children) {
    if (p.tagName !== 'P') continue
    const nodes = [...p.childNodes].filter((n) => n.nodeType !== 3 || n.textContent?.trim() !== '')
    if (nodes.length === 1 && (nodes[0] as Element).tagName === 'STRONG') p.classList.add('md-sec')
  }
}

/**
 * 没标语言的代码块按行包一层，超宽行折行、续行比本行多缩进 2 格。
 * 这类块多是文字图、目录树、日志——横向滚动时右半截看不到；标了语言的
 * 是真代码，折行会破坏对齐，不包（仍横滚）。
 *
 * 每行一个 `.ln`，整行原文（含行首空格）原样放在里面，行首空白的列数记在
 * data-i；style.ts 按 data-i 给悬挂缩进（CSP 禁内联 style，只能按属性值
 * 预生成规则）。行尾 \n 留在文本里：复制按钮取 code.textContent，拷出来
 * 必须和原文一字不差。
 *
 * 不能把缩进拆成单独的 span 再用 flex 排：鼠标选中再 Cmd+C 时，浏览器在
 * 每个 flex 子项之间插换行，缩进行全被拆成两行（2026-10-29 实测）
 */
function wrapPlainCode(body: HTMLElement): void {
  for (const code of body.querySelectorAll('pre > code')) {
    if (code.className !== '') continue // hljs 或未注册语言的 language-xxx
    const doc = code.ownerDocument
    const lines = (code.textContent ?? '').split(/(?<=\n)/)
    code.textContent = ''
    for (const line of lines) {
      const row = Object.assign(doc.createElement('span'), { className: 'ln', textContent: line })
      const cols = indentCols(line)
      if (cols > 0) row.dataset.i = String(Math.min(cols, MAX_INDENT))
      code.append(row)
    }
    code.parentElement?.classList.add('wrap')
  }
}

/** style.ts 预生成的悬挂缩进规则只到这么多列，更深的续行按这个缩进 */
export const MAX_INDENT = 40

/** 行首空白占几列：tab 跳到下一个 8 的倍数（同 CSS tab-size 默认值） */
function indentCols(line: string): number {
  let col = 0
  for (const ch of line) {
    if (ch === ' ') col++
    else if (ch === '\t') col = (Math.floor(col / 8) + 1) * 8
    else break
  }
  return col
}

/**
 * 流式渲染的围栏隔离（D2b）。返回 null = 没有未闭合围栏，
 * 整段正常渲；有则拆成「围栏前的
 * 稳定部分（正常渲）」和「未闭合围栏起（含）——按纯文本渲」。半截围栏让
 * marked 容错解析会把上方稳定内容一起重排，观感是整段跳一下，这是流式
 * 渲染最大的痛点
 */
export function splitOpenFence(text: string): { settled: string; raw: string } | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i] ?? '')
    if (!m) continue
    const mark = m[1] ?? ''
    const char = mark[0]
    const size = mark.length
    if (char === undefined) continue
    // 向后找闭合围栏：同字符、长度不小于开栏、行内只有它自己
    const closing = new RegExp(`^ {0,3}${char}{${size},} *$`)
    let next = i + 1
    while (next < lines.length) {
      if (closing.test(lines[next] ?? '')) break
      next++
    }
    if (next < lines.length) {
      i = next // 闭合之后继续找下一个可能未闭合的围栏
      continue
    }
    return { settled: lines.slice(0, i).join('\n'), raw: lines.slice(i).join('\n') }
  }
  return null
}
