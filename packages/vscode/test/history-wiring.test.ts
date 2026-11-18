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
  /** jsdom 不排版：scrollHeight/clientHeight 都是 0，scrollTop 也不夹。
   *  桩成浏览器的样子（scrollTop 夹在 0..scrollHeight-clientHeight）；默认
   *  「内容满屏」（跟随到底 scrollTop=4500），不满一屏的用例自己改 */
  const layout = (scrollHeight: number, clientHeight: number) => {
    const el = log()
    if (!el) throw new Error('.log 没渲染出来')
    let top = 0
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, scrollHeight - clientHeight))
      },
    })
  }
  layout(5000, 500)
  return {
    layout,
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

  it('任务分支翻页：滚到顶发 task_fetchHistory（带任务名）；页回来 prepend 且游标推进', () => {
    const task = (name: string) => ({
      name,
      status: 'idle' as const,
      lastText: '',
      current: null,
      effort: null,
      effortOverridden: false,
      presets: [],
      imagesEnabled: false,
      contextWindow: 0,
      approvalOn: true,
    })
    const app = mount()
    app.send(state)
    app.send({ type: 'tasks', folder: state.folder, tasks: [task('goal 任务')] })
    app.send({
      type: 'task_hydrate',
      name: 'goal 任务',
      folder: state.folder,
      items: [{ kind: 'user', text: '任务最新' }],
    })
    app.send({ type: 'select_task', task: 'goal 任务' })

    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'task_fetchHistory')).toEqual([
      { type: 'task_fetchHistory', task: 'goal 任务', cursor: null },
    ])

    app.send({
      type: 'task_historyPage',
      name: 'goal 任务',
      items: [{ kind: 'user', text: '任务更早' }],
      next: 7,
    })
    expect(app.html()).toContain('任务更早')
    expect(app.html()).toContain('任务最新') // prepend 不冲掉既有内容

    // 下一拉带上返回的游标
    app.scrollToTop()
    expect(sent.at(-1)).toEqual({ type: 'task_fetchHistory', task: 'goal 任务', cursor: 7 })

    // 到底：more=false 不再发，提示「没有更早的了」
    app.send({ type: 'task_historyPage', name: 'goal 任务', items: [], next: null })
    expect(app.html()).toContain('没有更早的了')
    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'task_fetchHistory')).toHaveLength(2)

    // 新一轮定稿推了新窗口底稿（task_hydrate）：翻页游标重置，再次滚到顶从新起点（cursor=null）拉
    app.send({
      type: 'task_hydrate',
      name: 'goal 任务',
      folder: '/tmp/x',
      items: [{ kind: 'user', text: '任务新一轮底稿' }],
    })
    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'task_fetchHistory').at(-1)).toEqual({
      type: 'task_fetchHistory',
      task: 'goal 任务',
      cursor: null,
    })
  })

  it('切目录清空视图时的 scroll 不拉历史：基线到了再滚到顶才拉', () => {
    const app = mount()
    app.send(state)
    app.send({ type: 'hydrate', items: [{ kind: 'user', text: '旧目录' }] })
    // 切目录：state 带新 folder → swapFolder 清空视图，scrollTop 夹到 0
    app.send({ ...state, folder: '/tmp/y' })
    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'fetchHistory')).toEqual([])

    app.send({ type: 'hydrate', items: [{ kind: 'user', text: '新目录' }] })
    app.scrollToTop()
    expect(sent.filter((m) => m.type === 'fetchHistory')).toEqual([
      { type: 'fetchHistory', cursor: null },
    ])
  })
})

describe('底稿不满一屏（2026-11-11 真项目：最近 100 步全在一轮里，折叠后一屏装得下）', () => {
  it('滚不动就没有 scroll 事件：不等滚动，渲染后在顶上就接着拉，拉到底为止', () => {
    const app = mount()
    app.layout(673, 673) // 夹具实测：内容不满一屏，scrollTop 恒为 0
    app.send(state)
    app.send({ type: 'hydrate', items: [{ kind: 'assistant', text: '最后一轮的回答' }] })
    expect(sent.filter((m) => m.type === 'fetchHistory')).toEqual([
      { type: 'fetchHistory', cursor: null },
    ])

    // 页并进同一个折叠过程、没长高：视口还在顶上，接着拉
    app.send({ type: 'historyPage', items: [{ kind: 'user', text: '插话' }], next: 42 })
    expect(sent.filter((m) => m.type === 'fetchHistory').at(-1)).toEqual({
      type: 'fetchHistory',
      cursor: 42,
    })

    app.send({ type: 'historyPage', items: [], next: null })
    expect(app.html()).toContain('没有更早的了')
    expect(sent.filter((m) => m.type === 'fetchHistory')).toHaveLength(2)
  })

  it('满屏且跟随在底部：不自动拉（只在用户滚到顶时拉）', () => {
    const app = mount()
    app.send(state)
    app.send({ type: 'hydrate', items: [{ kind: 'user', text: '最新' }] })
    expect(sent.filter((m) => m.type === 'fetchHistory')).toEqual([])
  })

  it('同拍连发 scroll 不重入；旧 epoch 与重复 from 回包被丢弃（防双链乒乓重复 prepend）', () => {
    const page = (epoch: number, text: string): ToWebview => ({
      type: 'historyPage',
      epoch,
      from: null,
      items: [{ kind: 'user', text }],
      next: 9,
    })
    const app = mount()
    app.send(state)
    app.send({ type: 'hydrate', epoch: 1, items: [{ kind: 'user', text: '底稿一' }] })
    // 同一 act 内连续两次原生 scroll（重渲染前）：ref 同步加锁，只发 1 条
    act(() => {
      const el = document.querySelector<HTMLDivElement>('.log')!
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(sent.filter((m) => m.type === 'fetchHistory')).toHaveLength(1)

    // 基线重推升到 epoch=2，随后 epoch=1 的旧在途回包迟到 → 丢弃
    app.send({ type: 'hydrate', epoch: 2, items: [{ kind: 'user', text: '底稿二' }] })
    app.scrollToTop()
    app.send(page(1, '过期页'))
    expect(app.html()).not.toContain('过期页')

    // epoch=2 的回包正常接上；紧跟到达的同 from=null 重复副本被丢弃
    app.send(page(2, '唯一真页'))
    app.send(page(2, '唯一真页'))
    expect(app.html().match(/唯一真页/g)).toHaveLength(1)
  })
})
