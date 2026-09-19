// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 路径链接的**接线**（user-image-wiring 同款立场）：识别/替换的纯函数
 * 行为在 pathlink.test.ts，这里只验「从最外层驱动，user 行的路径真的成了
 * 可点链接，点击真的 post 了 openFile」。
 */

const sent: ToHost[] = []
let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  sent.length = 0
})

function mount() {
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => ({ postMessage: (msg: unknown) => sent.push(msg as ToHost) }),
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
  }
}

describe('user 行路径链接', () => {
  it('拖入路径发送后渲染成 a[data-open-path]，普通文字原样', () => {
    const { send } = mount()
    send({
      type: 'hydrate',
      items: [{ kind: 'user', text: '看下 packages/core/src/events.ts 这个' }],
    } satisfies ToWebview)
    const a = document.querySelector<HTMLAnchorElement>('.user a[data-open-path]')
    expect(a?.getAttribute('data-open-path')).toBe('packages/core/src/events.ts')
    expect(a?.textContent).toBe('packages/core/src/events.ts')
  })

  it('点击路径 → post openFile（委托在 .log 的 onLogClick）', () => {
    const { send } = mount()
    send({
      type: 'hydrate',
      items: [{ kind: 'user', text: 'packages/vscode/src/style.ts' }],
    } satisfies ToWebview)
    const a = document.querySelector<HTMLAnchorElement>('.user a[data-open-path]')
    expect(a).not.toBeNull() // 前提：链接在
    act(() => a?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(sent).toContainEqual({ type: 'openFile', path: 'packages/vscode/src/style.ts' })
  })

  it('没有路径的 user 行不产 a 标签', () => {
    const { send } = mount()
    send({ type: 'hydrate', items: [{ kind: 'user', text: '普通一句话' }] } satisfies ToWebview)
    expect(document.querySelector('.user a')).toBeNull()
  })
})
