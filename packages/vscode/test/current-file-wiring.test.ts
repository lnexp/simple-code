// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActiveEditor, ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 底栏「当前文件」按钮的**接线**（同 memory-wiring：从最外层驱动）。
 * 链路：宿主推 active_editor → 按钮显示文件名/行号 → 默认不带 → 点一下进附件行
 * → 发送时附件在前、正文在后 → 编辑器不是文件时按钮消失。
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
  const btn = () => host.querySelector<HTMLButtonElement>('.cur-file')
  return {
    send: (msg: ToWebview) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      }),
    editor: (editor: ActiveEditor | null) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: 'active_editor', editor } }),
        )
      }),
    btn,
    click: () =>
      act(() => {
        const b = btn()
        if (!b) throw new Error('当前文件按钮没渲染出来')
        b.click()
      }),
    chips: () => [...host.querySelectorAll('.file-chip-name')].map((e) => e.textContent),
    /** 打字回车 */
    enter: (text: string) => {
      const ta = host.querySelector('textarea') as HTMLTextAreaElement
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      act(() => {
        setValue?.call(ta, text)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
    },
    sentTexts: () => sent.flatMap((m) => (m.type === 'send' ? [m.text] : [])),
  }
}

const state: ToWebview = {
  type: 'state',
  running: false,
  folder: '/proj',
  current: { provider: 'p', model: 'm' },
  models: [{ provider: 'p', model: 'm' }],
  effort: 'high',
  effortOverridden: false,
  presets: [],
  attendance: 'attended',
  summaryInContext: true,
  imagesEnabled: false,
  contextWindow: 0,
}

const SEL: ActiveEditor = {
  path: '/proj/src/store.ts',
  start: 5,
  end: 7,
  text: 'a\nb\nc',
}

describe('底栏当前文件按钮', () => {
  it('宿主没推（或推 null）：按钮不渲染', () => {
    const app = mount()
    app.send(state)
    expect(app.btn()).toBeNull()
    app.editor(SEL)
    expect(app.btn()).not.toBeNull()
    app.editor(null)
    expect(app.btn()).toBeNull()
  })

  it('显示文件名和行号；**默认不带**：不点直接发，消息里没有文件', () => {
    const app = mount()
    app.send(state)
    app.editor(SEL)
    expect(app.btn()?.textContent).toBe('store.ts:5-7')
    app.enter('随便问问')
    expect(app.sentTexts()).toEqual(['随便问问'])
  })

  it('点一下进附件行（相对路径:行号），按钮变 ✓、再点不重复；发出去是标签+代码块+正文', () => {
    const app = mount()
    app.send(state)
    app.editor(SEL)
    app.click()
    expect(app.chips()).toEqual(['src/store.ts:5-7'])
    expect(app.btn()?.className).toContain('is-added')
    expect(app.btn()?.querySelector('.codicon-check')).not.toBeNull()
    app.click()
    expect(app.chips()).toHaveLength(1)
    app.enter('这段为什么慢')
    expect(app.sentTexts()).toEqual(['src/store.ts:5-7\n```ts\na\nb\nc\n```\n\n这段为什么慢'])
    // 发完附件行清空，按钮回到文件图标
    expect(app.chips()).toEqual([])
    expect(app.btn()?.querySelector('.codicon-file')).not.toBeNull()
  })

  it('没选区只带路径；超限（宿主不给 text）只带路径和行号', () => {
    const app = mount()
    app.send(state)
    app.editor({ path: '/proj/src/store.ts' })
    expect(app.btn()?.textContent).toBe('store.ts')
    app.click()
    app.editor({ path: '/proj/src/big.ts', start: 1, end: 300 })
    app.click()
    expect(app.chips()).toEqual(['src/store.ts', 'src/big.ts:1-300'])
    app.enter('')
    expect(app.sentTexts()).toEqual(['src/store.ts\nsrc/big.ts:1-300'])
  })

  it('原文里有 ``` 时围栏加长，不提前闭合；单行显示 :12', () => {
    const app = mount()
    app.send(state)
    app.editor({ path: '/proj/README.md', start: 12, end: 12, text: '```sh' })
    expect(app.btn()?.textContent).toBe('README.md:12')
    app.click()
    app.enter('')
    expect(app.sentTexts()).toEqual(['README.md:12\n````md\n```sh\n````'])
  })
})
