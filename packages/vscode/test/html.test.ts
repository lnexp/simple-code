import { describe, expect, it } from 'vitest'
import { renderHtml } from '../src/html.ts'

/**
 * CSP 配错了**不报错**，只是某类资源静默加载不出来（或者反过来：该拦的没拦
 * 却看不出来）。所以这里既测「该有的在」也测「不该有的不在」。
 */

const OPTIONS = {
  scriptUri: 'https://file%2B.vscode-resource.example/dist/webview.js',
  codiconUri: 'https://file%2B.vscode-resource.example/dist/codicon.css',
  cspSource: 'vscode-webview://abc123',
}

const cspOf = (html: string): string =>
  /content="([^"]*)"/.exec(html.split('Content-Security-Policy')[1] ?? '')?.[1] ?? ''

describe('codicon 样式表', () => {
  /**
   * 图标字体挂了不报错，只是图标位置空着。这里钉住 CSP 放行的两项——
   * **外链样式表不能靠 nonce**（nonce 只对内联 style 生效），它和字体都
   * 只能走 cspSource
   */
  it('link 引了 codicon.css，且 CSP 放行样式表和字体', () => {
    const html = renderHtml(OPTIONS)
    expect(html).toContain(`<link rel="stylesheet" href="${OPTIONS.codiconUri}">`)
    expect(cspOf(html)).toContain(`style-src ${OPTIONS.cspSource}`)
    expect(cspOf(html)).toContain(`font-src ${OPTIONS.cspSource}`)
  })
})

describe('webview HTML', () => {
  it('脚本带 nonce，且 nonce 和 CSP 里的一致', () => {
    // 不一致的话脚本被 CSP 拦掉，界面全白且控制台才看得到原因
    const html = renderHtml(OPTIONS)
    const scriptNonce = /<script[^>]*nonce="([^"]+)"/.exec(html)?.[1]
    expect(scriptNonce).toBeTruthy()
    expect(cspOf(html)).toContain(`script-src 'nonce-${scriptNonce}'`)
  })

  it('内联 style 也带同一个 nonce', () => {
    const html = renderHtml(OPTIONS)
    const styleNonce = /<style[^>]*nonce="([^"]+)"/.exec(html)?.[1]
    expect(styleNonce).toBeTruthy()
    expect(cspOf(html)).toContain(`'nonce-${styleNonce}'`)
  })

  it('**每次生成的 nonce 都不同**', () => {
    // 固定 nonce 等于没有 nonce——注入的脚本猜得到它就能执行
    const a = /nonce="([^"]+)"/.exec(renderHtml(OPTIONS))?.[1]
    const b = /nonce="([^"]+)"/.exec(renderHtml(OPTIONS))?.[1]
    expect(a).not.toBe(b)
  })

  it('**不含 unsafe-inline / unsafe-eval**', () => {
    // 不开 eval 是刻意为之（跑 vite HMR 才必须开 eval）。
    // 哪天有人为了图省事加回来，这条会红
    const csp = cspOf(renderHtml(OPTIONS))
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('unsafe-eval')
  })

  it('default-src 是 none —— 白名单而不是黑名单', () => {
    expect(cspOf(renderHtml(OPTIONS))).toContain("default-src 'none'")
  })

  it('**没有 connect-src**——webview 不该发任何网络请求', () => {
    // 数据全从扩展 postMessage 推过来。default-src 'none' 已经挡住了，
    // 这条断言防的是将来有人"顺手"加上
    expect(cspOf(renderHtml(OPTIONS))).not.toContain('connect-src')
  })

  it('脚本地址原样进 src', () => {
    expect(renderHtml(OPTIONS)).toContain(`src="${OPTIONS.scriptUri}"`)
  })

  it('cspSource 进了 style/img/font', () => {
    // VS Code 自己往 webview 注入主题样式表，不放行的话所有主题变量失效——
    // 界面能显示，但是黑底黑字
    const csp = cspOf(renderHtml(OPTIONS))
    for (const directive of ['style-src', 'img-src', 'font-src']) {
      expect(csp).toContain(`${directive} ${OPTIONS.cspSource}`)
    }
  })
})
