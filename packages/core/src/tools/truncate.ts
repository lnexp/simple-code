/**
 * 两端保留的截断。
 *
 * 错误信息通常在末尾，砍掉尾巴等于砍掉最有用的部分，
 * 所以两端都保留（design.md §6.3）。
 *
 * 按字符不按行：行数防不住单行超长，minified JS 一行能几十万字符。
 */
export function truncateOutput(text: string, maxChars: number, rawPath?: string): string {
  if (text.length <= maxChars) return text

  const notice = rawPath
    ? `\n[... 省略 ${text.length - maxChars} 字符，完整输出见 ${rawPath} ...]\n`
    : `\n[... 省略 ${text.length - maxChars} 字符 ...]\n`

  // 提示本身也占预算，否则「截断后」反而更长
  const budget = Math.max(0, maxChars - notice.length)
  const head = Math.ceil(budget / 2)
  const tail = budget - head
  return text.slice(0, head) + notice + (tail > 0 ? text.slice(-tail) : '')
}
