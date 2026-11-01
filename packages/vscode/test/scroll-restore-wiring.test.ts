// @vitest-environment jsdom
// 切任务再切回，滚动位置要还原（2026-10-30 用户：「切换到另一个任务，再
// 切换回来，内容就不是之前的位置了」）。.log 是主任务和各任务共用的同一
// 个元素，只换 view——不按任务存位置的话 scrollTop 沿用上一个任务的值。
// jsdom 不排版：scrollHeight/clientHeight 桩成定值，scrollTop 照存不夹
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../webview/vscode.ts', () => ({ post: vi.fn() }))

const feed = (msg: unknown): void => {
  window.dispatchEvent(new MessageEvent('message', { data: msg }))
}
const FOLDER = '/tmp/x'
const conv = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => [
    { kind: 'user', text: `${tag} 问 ${i}` },
    { kind: 'assistant', text: `${tag} 答 ${i}` },
  ]).flat()
const task = (name: string) => ({
  name,
  status: 'idle',
  lastText: '',
  current: null,
  effort: null,
  effortOverridden: false,
  presets: [],
  imagesEnabled: false,
  contextWindow: 200000,
  approvalOn: true,
})

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

async function mount() {
  const { App } = await import('../webview/App.tsx')
  const div = document.createElement('div')
  document.body.appendChild(div)
  const root = createRoot(div)
  await act(async () => root.render(React.createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    div.remove()
  }
  const send = (msg: unknown) => act(() => feed(msg))
  send({
    type: 'state',
    running: false,
    folder: FOLDER,
    current: null,
    models: [],
    effort: null,
    effortOverridden: false,
    presets: [],
    imagesEnabled: false,
    approvalOn: true,
    contextWindow: 256000,
  })
  send({ type: 'hydrate', items: conv('主', 40) })
  send({ type: 'tasks', folder: FOLDER, tasks: [task('甲'), task('乙')] })
  const log = div.querySelector<HTMLDivElement>('.log')
  if (!log) throw new Error('.log 没渲染出来')
  Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 5000 })
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 500 })
  const tab = (name: string) => {
    const b = Array.from(div.querySelectorAll<HTMLButtonElement>('.branch-strip button')).find(
      (x) => (x.textContent ?? '').trim() === name,
    )
    if (!b) throw new Error(`没有「${name}」tab`)
    return b
  }
  return {
    log,
    send,
    // 用户滚动：改 scrollTop + 派 scroll 事件（浏览器里滚动事件下一帧到）
    scroll: (y: number) =>
      act(() => {
        log.scrollTop = y
        log.dispatchEvent(new Event('scroll'))
      }),
    // 点任务 tab，宿主随后回 task_hydrate（task_open 的真实时序）
    open: (name: string, items?: unknown[]) => {
      act(() => tab(name).click())
      if (items) send({ type: 'task_hydrate', folder: FOLDER, name, items })
    },
  }
}

describe('切任务滚动位置还原', () => {
  it('主任务 / 任务各自停在切走时的位置；没来过的任务跟到底', async () => {
    const app = await mount()
    app.scroll(1500)
    app.open('甲', conv('甲', 30))
    expect(app.log.scrollTop, '甲第一次打开：跟到底').toBe(5000)
    app.scroll(900)
    app.open('主任务')
    expect(app.log.scrollTop, '切回主任务：回到 1500').toBe(1500)
    app.open('甲', conv('甲', 30))
    expect(app.log.scrollTop, '切回甲（task_hydrate 替换后）：回到 900').toBe(900)
    app.open('乙', conv('乙', 5))
    app.open('甲', conv('甲', 30))
    expect(app.log.scrollTop, '经乙再回甲：仍是 900').toBe(900)
  })

  it('切走时在底部 → 切回跟到底（走后长了内容也到新底）', async () => {
    const app = await mount()
    app.scroll(4500)
    app.open('甲', conv('甲', 30))
    Object.defineProperty(app.log, 'scrollHeight', { configurable: true, get: () => 6000 })
    app.open('主任务')
    expect(app.log.scrollTop).toBe(6000)
  })
})
