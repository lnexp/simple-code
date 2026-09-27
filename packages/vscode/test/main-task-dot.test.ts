// @vitest-environment jsdom
// 主任务 tab 的 running 绿点：以前任务 tab 有、主任务没有——看着任务的
// 时候主任务跑没跑无从看起。复现：state(running=true) 喂进 App，断言
// 「主任务」tab 里出现 task-dot[running]
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../webview/vscode.ts', () => ({ post: vi.fn() }))

// App 直接挂 window 的 message 监听（不走 vscode.ts 的 onMessage）
const feed = (msg: unknown): void => {
  window.dispatchEvent(new MessageEvent('message', { data: msg }))
}

const state = (running: boolean) => ({
  type: 'state',
  running,
  folder: '/tmp/x',
  current: null,
  models: [],
  effort: null,
  effortOverridden: false,
  presets: [],
  imagesEnabled: true,
  approvalOn: true,
  contextWindow: 256000,
})

describe('主任务 tab 的 running 绿点', () => {
  it('running=true 时主任务 tab 里出现 task-dot[data-status=running]', async () => {
    const { App } = await import('../webview/App.tsx')
    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)
    await act(async () => {
      root.render(React.createElement(App))
    })
    const main = (): HTMLButtonElement | undefined =>
      Array.from(document.querySelectorAll('.branch-strip .branch-tab')).find(
        (el) => (el.textContent ?? '').includes('主任务'),
      ) as HTMLButtonElement | undefined
    expect(main(), '主任务 tab 存在').toBeTruthy()
    expect(main()?.querySelector('.task-dot'), 'running=false 时没有点').toBeNull()
    await act(async () => {
      feed(state(true))
    })
    expect(
      main()?.querySelector('.task-dot[data-status="running"]'),
      'running=true 时有绿点',
    ).toBeTruthy()
    await act(async () => {
      feed(state(false))
    })
    expect(main()?.querySelector('.task-dot'), '回落 false 点消失').toBeNull()
    root.unmount()
  })
})
