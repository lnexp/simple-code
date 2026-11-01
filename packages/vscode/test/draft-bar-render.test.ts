// @vitest-environment jsdom
// 复现：点 + 任务（setBranchDraft(true)）→ 草稿条渲染是否崩
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

vi.mock('./vscode.ts', () => ({ post: vi.fn(), onMessage: vi.fn(() => () => {}) }))

describe('开任务草稿条渲染', () => {
  it('branchDraft=true 不崩、按钮可点', async () => {
    const { App } = await import('../webview/App.tsx')
    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)
    let error: unknown = null
    try {
      await act(async () => {
        root.render(React.createElement(App))
      })
      // App 渲染后模拟点击 + 任务——webview 里该按钮 title 是「从最新回答 fork」
      const btn = Array.from(document.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').includes('+ 任务'),
      )
      expect(btn, '找到 + 任务按钮').toBeTruthy()
      await act(async () => {
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(div.innerHTML).toContain('作为任务名称') // 规则 13：+ 任务只输名称
    } catch (e) {
      error = e
    }
    expect(error).toBeNull()
    root.unmount()
  })

  it('草稿模式回车：输入当名称发 task_create（规则 13），不发 task_dispatch', async () => {
    // 截获发往宿主的消息：webview/vscode.ts 的 post 惰性取 acquireVsCodeApi
    const posted: { type: string }[] = []
    ;(globalThis as Record<string, unknown>).acquireVsCodeApi = () => ({
      postMessage: (m: { type: string }) => void posted.push(m),
    })
    const { App } = await import('../webview/App.tsx')
    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)
    await act(async () => {
      root.render(React.createElement(App))
    })
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('+ 任务'))
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const ta = div.querySelector('textarea') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setValue?.call(ta, '查群聊')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    posted.length = 0
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(posted).toContainEqual({ type: 'task_create', name: '查群聊' })
    expect(posted.some((m) => m.type === 'task_dispatch' || m.type === 'send')).toBe(false)
    root.unmount()
  })
})
