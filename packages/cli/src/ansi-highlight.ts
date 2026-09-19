import hljs from 'highlight.js/lib/common'
import type { Paint } from './colors.ts'

/**
 * 代码块 → ANSI 高亮。webview 那侧是 hljs → HTML → CSS；终端没有 CSS，
 * 在 span → ANSI 这一步转换（cli-highlight 包做的就是这件事，40 行自己
 * 写掉，省一个依赖）。
 *
 * 逐块高亮而不是逐行：hljs 的状态跨行（注释/模板字符串/多行字符串），
 * 逐行独立高亮会把这些打回原形。块是天然完整单元（围栏缓冲在 render.ts）。
 *
 * 语言不认识就原样返回——高亮是增益不是正确性，绝不因它吞内容。
 */
const CLASS_PAINT: Record<string, keyof Paint> = {
  // hljs 11 的类名：空格分隔多词（"title function_"）、有下划线后缀——
  // 按词查表取第一个命中
  keyword: 'hlKeyword',
  'built_in': 'hlKeyword',
  type: 'hlKeyword',
  literal: 'hlNumber',
  number: 'hlNumber',
  string: 'hlString',
  regexp: 'hlString',
  char: 'hlString',
  attr: 'hlString',
  comment: 'hlComment',
  quote: 'hlComment',
  title: 'hlTitle',
  function: 'hlTitle',
}

/** class="hljs-title function_" → 词序列里第一个有映射的（title→hlTitle） */
const paintOf = (cls: string): keyof Paint | undefined => {
  for (const word of cls.split(/\s+/)) {
    // function_/class_/invoke_ 这类后缀词单独出现在表外，跳过
    const hit = CLASS_PAINT[word.replace(/_$/, '')]
    if (hit) return hit
  }
  return undefined
}

const unescapeHtml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

export function highlightAnsi(code: string, lang: string, paint: Paint): string {
  const name = lang.trim().toLowerCase()
  if (!name || !hljs.getLanguage(name)) return code
  let html: string
  try {
    html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return code
  }
  // 栈式解析：hljs 的 span 可嵌套（attr 里套 built_in），非贪婪正则会把
  // 嵌套的闭标签配错对。开标签压栈、闭标签弹栈，文本段按栈顶色着色
  const re = /<span class="hljs-([^"]*)">|<\/span>/g
  const stack: (keyof Paint | undefined)[] = []
  let out = ''
  let last = 0
  for (const m of html.matchAll(re)) {
    const at = m.index ?? 0
    // 文本段按「段开始时的栈顶」着色——栈只在标签处变化，段内不变。
    // 栈顶 undefined（未知类/已弹完）= 默认色，原样不包
    const top = stack[stack.length - 1]
    const text = unescapeHtml(html.slice(last, at))
    out += top ? paint[top](text) : text
    if (m[1] !== undefined) {
      stack.push(paintOf(m[1]))
    } else {
      stack.pop()
    }
    last = at + m[0].length
  }
  const tail = stack[stack.length - 1]
  const tailText = unescapeHtml(html.slice(last))
  return out + (tail ? paint[tail](tailText) : tailText)
}
