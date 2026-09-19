import { randomBytes } from 'node:crypto'

import { STYLE } from './style.ts'

/**
 * webview 的 HTML 外壳。样式表在 style.ts，这里只管外壳和 CSP。
 *
 * **不 import 'vscode'**，需要的几个值（两个 URI、cspSource）作为参数传进来。
 * 这样 CSP 拼装能直接单测——而它正是那种「配错了不报错，只是某类资源静默
 * 加载不出来」的地方。同 core 的 §1.1，只是这里是自愿的。
 */

export type HtmlOptions = {
  /** `webview.asWebviewUri(...)` 转换过的脚本地址 */
  scriptUri: string
  /** `webview.cspSource`，形如 `vscode-webview://...` */
  cspSource: string
  /**
   * `asWebviewUri` 转换过的 codicon.css 地址。
   *
   * **这是外部样式表，不带 nonce**——CSP 的 nonce 只对内联 `<style>` 生效，
   * 外链靠 `style-src` 里的 cspSource 放行。字体同理走 `font-src`。
   */
  codiconUri: string
}

export function renderHtml({ scriptUri, cspSource, codiconUri }: HtmlOptions): string {
  const nonce = randomBytes(16).toString('base64')
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp(cspSource, nonce)}">
<link rel="stylesheet" href="${codiconUri}">
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}

/**
 * `default-src 'none'` 起手，逐项放开——白名单而不是黑名单。
 *
 * **没有 `'unsafe-inline'` 也没有 `'unsafe-eval'`**：我们不跑 HMR（eval），
 * webview 也不发任何网络请求——数据全从
 * 扩展 postMessage 推过来。实测 esbuild 打的 React 产物里 eval 和
 * new Function 各 0 处，所以严格 CSP 下能跑（vscode-impl.md §3）。
 *
 * `style-src` 带 cspSource 是因为 VS Code 自己会往 webview 里注入主题样式表。
 */
const csp = (cspSource: string, nonce: string): string =>
  [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
  ].join('; ')
