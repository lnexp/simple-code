/**
 * REPL 的 Markdown 终端渲染（行内级 + 表格）。
 *
 * 挂载口径（与 colors.ts 同约定）：只作用于 tty 的 stdout 正文——
 * `sc > file` 时渲染自动关闭，文件里是模型的原样字节。代码围栏不在
 * 这层（render.ts 的高亮重放管），工具输出不是模型正文也不进。
 *
 * 范围刻意小：标题/加粗/行内 code/列表 bullet/分隔线/表格。不做的
 * （原样直出）：引用 >、链接 []()（保留原文可复制）、嵌套结构——
 * 终端是流式打字机，完整排版是 VS Code webview 的事。
 */
import type { Paint } from './colors.ts'

/**
 * 显示宽度（East Asian Width 的工程简化版）：CJK/全角/常用 emoji 记 2，
 * 其余记 1。组合字符（变音符、ZWJ 序列）不记 0——它们罕见于正文，
 * 少算 0 会把表格挤歪，多算 1 只是留宽一格，错方向可接受。
 */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
const WIDE_ASTRAL =
  /^[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]$/u

export function wcwidth(s: string): number {
  let w = 0
  for (const ch of s) w += WIDE.test(ch) || WIDE_ASTRAL.test(ch) ? 2 : 1
  return w
}

/**
 * 单行行内渲染。顺序：标题整行 bold → 加粗 → 行内 code → bullet 着色
 * → 分隔线让位。互相嵌套（`**x**` 里再套 code）不处理——正则各扫各的，
 * 坏了也只是显示原样，内容不丢
 */
export function renderInline(line: string, p: Paint): string {
  // 行已带尾换行（render.ts 的行单位）；标题/分隔线匹配要去掉再判
  const body = line.replace(/\n$/, '')
  const nl = line.endsWith('\n') ? '\n' : ''
  // 标题：# 保留（不换符号——层级信息是内容）整行 bold
  if (/^#{1,6} /.test(body)) return p.bold(body) + nl
  // 分隔线让位
  if (/^\s*(-{3,}|\*{3,})\s*$/.test(body)) return p.dim(body) + nl
  let out = body
  // 加粗 **x**（不跨行——单行处理天然满足）
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, x: string) => p.bold(x))
  // 行内 code：反色最像终端惯例（gh 等 CLI 同款），不与五类高亮撞色
  out = out.replace(/`([^`\n]+)`/g, (_m, x: string) => p.reverse(x))
  // 列表 bullet：- / * 换 • 着色（嵌套缩进保留）
  out = out.replace(/^(\s*)[-*] /, (_m, indent: string) => `${indent}${p.cyan('•')} `)
  return out + nl
}

/** | 开头的行才可能是表格（流式攒行的判定口径，与 render.ts 共用） */
export const isTableRow = (line: string): boolean => /^\s*\|/.test(line)

/** 分隔行（| --- | --- |）：表格的第二个组成部分 */
const isSeparator = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()) || c.trim() === '---')

const splitCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

/**
 * 表格整块渲染：列宽按显示宽取 max，表头 bold + dim 分隔线重画。
 * 攒到的行数 < 2 或第二行不是分隔行 → 不是 Markdown 表格（可能只是
 * 正文里带 | 的行），原样逐行返回，不硬渲染
 */
export function renderTable(lines: string[], p: Paint): string {
  const rows = lines.map(splitCells)
  if (rows.length < 2 || !isSeparator(rows[1]!)) return lines.join('')
  const data = rows.filter((_, i) => i !== 1)
  const cols = Math.max(...data.map((r) => r.length))
  const widths: number[] = []
  for (let c = 0; c < cols; c++) widths[c] = Math.max(...data.map((r) => wcwidth(r[c] ?? '')))
  // cell：样式先打、空格后补——pad 必须按纯文本宽算（样式串里的
  // 色码不是零宽，先 pad 再渲染会把列挤歪）
  const cell = (c: string, i: number, header: boolean) => {
    const styled = renderInline(c, p)
    const body = header ? p.bold(styled) : styled
    return ` ${body}${' '.repeat(Math.max(0, widths[i]! - wcwidth(c)))} `
  }
  const row = (cells: string[], header: boolean) =>
    p.dim('│') + cells.map((c, i) => cell(c, i, header)).join(p.dim('│')) + p.dim('│') + '\n'
  const line = (l: string, m: string, r: string) =>
    p.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r) + '\n'
  // 表头（第一行）bold；原分隔行用 ─ 重画
  const [head = [], ...bodyRows] = data
  let out = line('┌', '┬', '┐') + row(head, true) + line('├', '┼', '┤')
  for (const r of bodyRows) {
    // 补齐短行的缺列（模型偶尔少写尾列），缺列空串占位
    const cells = [...r]
    while (cells.length < cols) cells.push('')
    out += row(cells, false)
  }
  out += line('└', '┴', '┘')
  return out
}
