/**
 * ANSI 着色。与 webview 的 CSS 分层同语义：模型的话是正文（默认色），
 * 元信息让位（暗灰），工具与状态用亮色锚点。
 *
 * **非 TTY 必须零色码**：`sc -q "..." > answer.txt` 拿到的必须是干净文本，
 * 色码混进去下游就废了（grep / diff / 重定向文件全是脏的）。所以每个
 * 调用方显式传 tty 布尔，函数式无全局状态——测试和管道天然无色。
 */
export type Paint = {
  dim: (s: string) => string
  yellow: (s: string) => string
  cyan: (s: string) => string
  green: (s: string) => string
  /** 代码高亮的五类（hljs span 类 → ANSI，见 ansi-highlight.ts） */
  hlKeyword: (s: string) => string
  hlString: (s: string) => string
  hlComment: (s: string) => string
  hlNumber: (s: string) => string
  hlTitle: (s: string) => string
  /** 行内 Markdown 的两个（标题/加粗用 bold，行内 code 用 reverse） */
  bold: (s: string) => string
  reverse: (s: string) => string
}

export const makePaint = (tty: boolean): Paint => {
  const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
  return {
    dim: wrap('90'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    green: wrap('32'),
    hlKeyword: wrap('35'),
    hlString: wrap('32'),
    hlComment: wrap('90'),
    hlNumber: wrap('33'),
    hlTitle: wrap('34'),
    bold: wrap('1'),
    reverse: wrap('7'),
  }
}
