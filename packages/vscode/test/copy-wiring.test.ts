// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 代码块复制的**接线**（footer-wiring 同款立场：渲染函数的测试全绿、
 * 点击链路断掉是真实发生过的失败模式）。从最外层驱动：hydrate 一条带
 * 代码块的 assistant 消息 → 真点 .code-copy → 断言剪贴板收到的是
 * <code> 的文本而不是按钮文案
 */

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  copied.length = 0
})

const copied: string[] = []

function mount() {
  // jsdom 没有 clipboard API（copyCode 走到 execCommand 兜底），塞桩
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (t: string) => copied.push(t) },
    configurable: true,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return {
    send: (msg: ToWebview) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      }),
    clickCopy: () =>
      act(() => {
        host.querySelector('.code-copy')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }),
    html: () => host.innerHTML,
  }
}

const state: ToWebview = {
  type: 'state',
  running: false,
  folder: '/tmp/x',
  current: null,
  models: [],
  effort: null,
  effortOverridden: false,
      presets: [],
  approvalOn: true,
  imagesEnabled: false,
  contextWindow: 0,
}

describe('代码块复制接线', () => {
  it('点复制按钮 → 剪贴板收到代码文本', async () => {
    const app = mount()
    app.send(state)
    app.send({
      type: 'hydrate',
      items: [{ kind: 'assistant', text: '改法：\n\n```ts\nconst answer = 42\n```\n' }],
    })
    // 高亮 span 不影响复制：textContent 仍是纯文本。html 断言改认 token 片段
    expect(app.html()).toContain('<span class="hljs-keyword">const</span> answer')

    app.clickCopy()
    await act(async () => {})
    expect(copied).toEqual(['const answer = 42\n'])
    // 按钮反馈
    expect(app.html()).toContain('已复制')
  })

  it('没有代码块时点别处不发疯、链接委托不受影响', () => {
    const app = mount()
    app.send(state)
    app.send({ type: 'hydrate', items: [{ kind: 'assistant', text: '纯文本' }] })
    app.clickCopy() // 没有 .code-copy，querySelector 返回 null——不抛
    expect(copied).toEqual([])
  })
})
