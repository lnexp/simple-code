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
      expect(div.innerHTML).toContain('任务书')
    } catch (e) {
      error = e
    }
    expect(error).toBeNull()
    root.unmount()
  })
})
