// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { renderHtml } from '../src/html.ts'

/**
 * 只有肉眼能发现的 CSS 行为。共用一个「注入真实样式表 + getComputedStyle」
 * 的壳子，目前覆盖两类：流式/结束态排版一致、折叠态真的收得干净。
 *
 * 背景（流式）：C3 之前流式期间是原文直出，`.assistant.streaming` 带 pre-wrap 是对的；
 * C3 之后流式也渲染 markdown，两个 class 同时挂在一个元素上，pre-wrap 就作用
 * 到了 marked 生成的 HTML 上——块级标签之间的 \n 被渲成真实换行，每个块之间
 * 凭空多一行。实测同一段内容流式 320px、结束 155px。
 *
 * **这个 bug 三道关卡全放行**：不是 JS 错误、不是类型错误、CSS 也完全合法，
 * 只有盯着流式输出才看得出来「输出时很散，输出完突然收拢」。
 */

const STYLE = /<style[^>]*>([\s\S]*?)<\/style>/.exec(
  renderHtml({
    scriptUri: 'https://example/webview.js',
    codiconUri: 'https://example/codicon.css',
    cspSource: 'vscode-webview://x',
  }),
)?.[1]

/** marked 在每个块级标签之间输出 \n——正是 pre-wrap 会渲成换行的那些 */
const MARKDOWN_HTML = '<p>段落一</p>\n<h3>标题</h3>\n<p>段落二</p>\n'

const mk = (className: string): HTMLElement => {
  const el = document.createElement('div')
  el.className = className
  el.innerHTML = MARKDOWN_HTML
  document.body.appendChild(el)
  return el
}

beforeAll(() => {
  expect(STYLE, '没能从 renderHtml 里取出 <style>').toBeTruthy()
  const style = document.createElement('style')
  style.textContent = STYLE ?? ''
  document.head.appendChild(style)
})

describe('对照组：确认 jsdom 真的在做层叠', () => {
  /**
   * §6.1——jsdom 的 getComputedStyle 若不应用样式表，下面所有断言都会
   * 变成「''===''」而假绿。先拿一条**确定会命中**的规则钉死这一点：
   * `.user { white-space: pre-wrap }`（html.ts 里 user 气泡保留原文换行）
   */
  it('.user 的 white-space 确实被样式表解析出来', () => {
    expect(getComputedStyle(mk('item user')).whiteSpace).toBe('pre-wrap')
  })
})

describe('流式态与结束态排版一致', () => {
  it('white-space 不因 streaming 而变（否则块间 \\n 被渲成换行）', () => {
    const streaming = getComputedStyle(mk('item assistant markdown streaming')).whiteSpace
    expect(streaming).not.toBe('pre-wrap')
    expect(streaming).toBe(getComputedStyle(mk('item assistant markdown')).whiteSpace)
  })

  it('line-height 不因 streaming 而变（否则结束瞬间整段跳一下）', () => {
    expect(getComputedStyle(mk('item assistant markdown streaming')).lineHeight).toBe(
      getComputedStyle(mk('item assistant markdown')).lineHeight,
    )
  })
})

/**
 * 折叠态必须真的收干净。
 *
 * `grid-template-rows: 0fr` 只压得扁**内容**，压不掉 grid item 自己的
 * padding/margin——`min-height: 0` 和 `overflow: hidden` 对它们都不起作用。
 * 留着的话每条折叠的命令下面吊一条灰带，还漏出半行输出。
 * 实测：`.tool-body pre` 带 `padding: 8px 10px` 时，容器的
 * grid-template-rows 解析成 16px 而不是 0px（正好是上下 padding 之和）。
 */
describe('折叠态不留残高', () => {
  const padOf = (className: string, open: boolean): string => {
    const wrap = document.createElement('div')
    wrap.className = className
    wrap.setAttribute('data-open', String(open))
    const inner = document.createElement(className === 'tool-body' ? 'pre' : 'div')
    if (className !== 'tool-body') inner.className = 'thinking-body'
    wrap.appendChild(inner)
    document.body.appendChild(wrap)
    return getComputedStyle(inner)[className === 'tool-body' ? 'padding' : 'margin']
  }

  it('工具输出：收起时 padding 归零，展开时回来', () => {
    expect(padOf('tool-body', false)).toBe('0px')
    // 对照组——只断言收起为 0 的话，把 padding 整个删掉也会绿，
    // 那样展开后文字会贴着边框
    expect(padOf('tool-body', true)).not.toBe('0px')
  })

  it('thinking 块：收起时 margin 归零，展开时回来', () => {
    expect(padOf('thinking-wrap', false)).toBe('0px')
    expect(padOf('thinking-wrap', true)).not.toBe('0px')
  })
})
