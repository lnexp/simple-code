// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 历史回放的**接线**（同 footer-wiring 的立场：单测全绿而接线断了这种事
 * 在页脚上真实发生过一次）。从最外层 postMessage 驱动：
 * - hydrate 到达 → 基线渲染出来
 * - 滚到顶 → fetchHistory 发给宿主
 * - historyPage 到达 → 更早的内容 prepend、翻页游标推进
 */

let cleanup: (() => void) | null = null

/**
 * 捕获发往宿主的消息。**文件级共享**而不是每个 mount 一个：vscode.ts 的
 * api 是模块级缓存（第一次 post 时获取），第一条测试的桩会被缓存到底，
 * 后面再怎么 defineProperty 都换不掉——每条测试各建 sent 的话，第二条
 * 起断言的全是空数组（真实踩过）
 */
const sent: ToHost[] = []

afterEach(() => {
  cleanup?.()
  cleanup = null
  sent.length = 0
})

function mount() {
  // jsdom 没有 acquireVsCodeApi：塞一个捕获 postMessage 的桩，才能断言
  // 「触顶真的发了 fetchHistory」
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
  const log = () => host.querySelector<HTMLDivElement>('.log')
  return {
    send: (msg: ToWebview) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      }),
    scrollToTop: () =>
      act(() => {
        const el = log()
        if (!el) throw new Error('.log 没渲染出来')
        el.scrollTop = 0
        el.dispatchEvent(new Event('scroll', { bubbles: true }))
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

describe('历史回放接线', () => {
  it('hydrate 到达 → 基线内容渲染（重开面板看得到历史）', () => {
    const app = mount()
    app.send(state)
    app.send({
      type: 'hydrate',
      items: [
        { kind: 'user', text: '上周的问题' },
        { kind: 'assistant', text: '上周的回答' },
      ],
    })
    expect(app.html()).toContain('上周的问题')
    expect(app.html()).toContain('上周的回答')
  })

  it('滚到顶 → 发 fetchHistory；页回来 → prepend 且游标推进', () => {
    const app = mount()
    app.send(state)
    app.send({ type: 'hydrate', items: [{ kind: 'user', text: '最新' }] })
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '答' }, at: 1 })

    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'fetchHistory')).toEqual([
      { type: 'fetchHistory', cursor: null },
    ])

    app.send({
      type: 'historyPage',
      items: [{ kind: 'user', text: '更早的一页' }],
      next: 42,
    })
    expect(app.html()).toContain('更早的一页')
    expect(app.html()).toContain('最新') // prepend 不冲掉既有内容

    // 下一拉带上返回的游标
    app.scrollToTop()
    expect(sent.at(-1)).toEqual({ type: 'fetchHistory', cursor: 42 })
  })

  it('next=null 到底后不再发；加载中不重发', () => {
    const app = mount()
    app.send(state)
    app.send({ type: 'hydrate', items: [{ kind: 'user', text: '最新' }] })

    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'fetchHistory')).toHaveLength(1)
    app.scrollToTop() // 加载中（没回页）不重发
    expect(sent.filter((m) => m.type === 'fetchHistory')).toHaveLength(1)

    app.send({ type: 'historyPage', items: [], next: null }) // 到底了
    expect(app.html()).toContain('没有更早的了')
    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'fetchHistory')).toHaveLength(1) // more=false，不再发
  })
})
