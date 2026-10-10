// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'

/**
 * 「继续」按钮的接线（turn-resume.md，2026-09-29）：报错/中断落下的 notice，
 * 停稳后是最后一条时给按钮；点了 = 替用户说一句「继续」（气泡上屏 + post
 * send），core 续进上一轮。从最外层驱动：往 window 发真的 postMessage。
 */

vi.mock('../webview/vscode.ts', () => ({ post: vi.fn() }))
const { post } = await import('../webview/vscode.ts')
const { App } = await import('../webview/App.tsx')

let cleanup: (() => void) | null = null
beforeEach(() => vi.mocked(post).mockClear())
afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mount() {
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
    buttons: (label: string) => [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label),
    click: (b: Element) =>
      act(() => {
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }),
    html: () => host.innerHTML,
  }
}

const state = (running: boolean): ToWebview => ({
  type: 'state',
  running,
  folder: '/tmp/x',
  current: { provider: 'p', model: 'm' },
  models: [{ provider: 'p', model: 'm' }],
  effort: 'high',
  effortOverridden: false,
  presets: [],
  approvalOn: true,
  imagesEnabled: false,
  contextWindow: 0,
})

const sent = () =>
  vi
    .mocked(post)
    .mock.calls.map(([m]) => m)
    .filter((m) => m.type === 'send')

describe('「继续」按钮', () => {
  it('报错停稳后出现；点了发「继续」、气泡上屏，按钮随即过期', () => {
    const app = mount()
    app.send(state(false))
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'error', message: '上游服务错误[502]', retryable: true, kind: 'unknown' }, at: 1 })
    // 还在跑：不给按钮（core 可能还在收尾）
    expect(app.buttons('继续')).toHaveLength(0)
    app.send(state(false))
    const [btn] = app.buttons('继续')
    expect(btn).toBeDefined()
    app.click(btn as Element)
    expect(sent()).toEqual([{ type: 'send', text: '继续' }])
    expect(app.html()).toContain('继续')
    // 用户气泡成了最后一条：旧 notice 上的按钮不再出现
    expect(app.buttons('继续')).toHaveLength(0)
  })

  it('不可重试的错也给（改完配置可以接着做）', () => {
    const app = mount()
    app.send(state(false))
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'error', message: '渠道未启用', retryable: false }, at: 1 })
    app.send(state(false))
    expect(app.buttons('继续')).toHaveLength(1)
  })

  it('用户中断停稳后，「已中断」上出现按钮', () => {
    const app = mount()
    app.send(state(false))
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '我先看看' }, at: 1 })
    const stop = document.querySelector('button[aria-label="停止"]')
    expect(stop).not.toBeNull()
    app.click(stop as Element)
    app.send(state(false))
    expect(app.html()).toContain('已中断')
    expect(app.buttons('继续')).toHaveLength(1)
  })

  it('对照：正常结束没有按钮', () => {
    const app = mount()
    app.send(state(false))
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '答完了' }, at: 1 })
    app.send(state(false))
    expect(app.buttons('继续')).toHaveLength(0)
  })
})
