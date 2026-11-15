// @vitest-environment jsdom
// 排队发送的 webview 侧（docs/proposals/queued-sends.md）：按键分流、列表渲染、
// 按 id 取消。从最外层驱动：发真的 postMessage、按真的键，读真的 DOM 与发往
// 宿主的消息
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'

vi.mock('../webview/vscode.ts', () => ({ post: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FOLDER = '/tmp/x'
const feed = (msg: ToWebview): void => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }))
  })
}

const state = (running: boolean): ToWebview => ({
  type: 'state',
  running,
  folder: FOLDER,
  current: null,
  models: [],
  effort: null,
  effortOverridden: false,
  presets: [],
  imagesEnabled: true,
  attendance: 'attended',
  contextWindow: 256000,
  summaryInContext: true,
})

const taskState = (name: string) => ({
  name,
  status: 'running' as const,
  lastText: '',
  current: null,
  effort: null,
  effortOverridden: false,
  presets: [],
  imagesEnabled: false,
  contextWindow: 0,
  attendance: 'attended' as const,
  summaryInContext: true,
})

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

async function mount() {
  const { post } = await import('../webview/vscode.ts')
  const posted = post as unknown as ReturnType<typeof vi.fn>
  const { App } = await import('../webview/App.tsx')
  const div = document.createElement('div')
  document.body.appendChild(div)
  const root = createRoot(div)
  act(() => root.render(React.createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    div.remove()
  }
  feed(state(true))
  const ta = (): HTMLTextAreaElement => div.querySelector('textarea') as HTMLTextAreaElement
  const type = (text: string): void => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(ta(), text)
      ta().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = (init: KeyboardEventInit): void => {
    act(() => {
      ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }))
    })
  }
  /** 从上次清空以来发往宿主的消息（只看发送相关的三种） */
  const sent = (): ToHost[] =>
    posted.mock.calls
      .map((c) => c[0] as ToHost)
      .filter((m) => m.type === 'send' || m.type === 'turnQueueAdd' || m.type === 'task_send')
  const clear = (): void => {
    posted.mockClear()
  }
  return { div, ta, type, key, sent, clear, posted }
}

describe('排队发送：按键分流', () => {
  it('Ctrl+Enter、Cmd+Enter 排队；Enter 发送；输入法组合中都不发', async () => {
    const m = await mount()
    m.clear()
    m.type('排一下')
    m.key({ ctrlKey: true })
    expect(m.sent()).toEqual([{ type: 'turnQueueAdd', text: '排一下' }])
    expect(m.ta().value).toBe('') // 发出即清空，同 Enter
    m.clear()
    m.type('插一句')
    m.key({})
    expect(m.sent()).toEqual([{ type: 'send', text: '插一句' }])
    m.clear()
    m.type('命令键')
    m.key({ metaKey: true })
    expect(m.sent()).toEqual([{ type: 'turnQueueAdd', text: '命令键' }])
    m.clear()
    m.type('还在选词')
    m.key({ ctrlKey: true, isComposing: true })
    m.key({ metaKey: true, isComposing: true })
    m.key({ isComposing: true })
    expect(m.sent()).toEqual([])
    expect(m.ta().value).toBe('还在选词')
  })

  it('发送按钮是发送，不是排队（onClick 不能把点击事件当 queue 参数）', async () => {
    const m = await mount()
    feed(state(false))
    m.clear()
    m.type('点按钮')
    const btn = m.div.querySelector('.send-btn') as HTMLButtonElement
    expect(btn).toBeTruthy()
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(m.sent()).toEqual([{ type: 'send', text: '点按钮' }])
  })

  it('选中任务时 Ctrl+Enter 带上任务名', async () => {
    const m = await mount()
    feed({ type: 'tasks', folder: FOLDER, tasks: [taskState('甲')] })
    feed({ type: 'select_task', task: '甲' })
    m.clear()
    m.type('任务排队')
    m.key({ ctrlKey: true })
    expect(m.sent()).toEqual([{ type: 'turnQueueAdd', text: '任务排队', task: '甲' }])
  })

  it('新任务状态（+ 任务）Ctrl+Enter 同 Enter：开任务，不排队', async () => {
    const m = await mount()
    const add = [...m.div.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('+ 任务'),
    )
    expect(add).toBeTruthy()
    act(() => {
      add?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(m.div.innerHTML).toContain('第一行作任务名称') // 前提：真在新任务状态
    m.clear()
    m.type('新任务')
    m.key({ ctrlKey: true })
    expect(m.posted.mock.calls.map((c) => (c[0] as ToHost).type)).toContain('task_create')
    expect(m.sent()).toEqual([]) // 没有 turnQueueAdd / send
    expect(m.ta().value).toBe('')
  })
})

describe('排队发送：列表', () => {
  it('只显示当前目标的队列；暂停有提示；× 按 id 取消', async () => {
    const m = await mount()
    feed({ type: 'tasks', folder: FOLDER, tasks: [taskState('甲')] })
    feed({
      type: 'turnQueue',
      main: { paused: true, items: [{ id: 7, text: '主任务那条', imageCount: 1 }] },
      tasks: { 甲: { paused: false, items: [{ id: 8, text: '任务那条', imageCount: 0 }] } },
    })
    const items = (): string[] =>
      [...m.div.querySelectorAll('.turn-queue-item')].map((x) => x.textContent ?? '')
    expect(items()).toHaveLength(1)
    expect(items()[0]).toContain('主任务那条')
    expect(items()[0]).toContain('1 张图')
    expect(m.div.querySelector('.turn-queue-paused')?.textContent).toContain('已暂停')
    m.posted.mockClear()
    const x = m.div.querySelector('.turn-queue-item button') as HTMLButtonElement
    act(() => {
      x.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(m.posted.mock.calls.map((c) => c[0])).toEqual([{ type: 'turnQueueCancel', id: 7 }])
    feed({ type: 'select_task', task: '甲' })
    expect(items()).toHaveLength(1)
    expect(items()[0]).toContain('任务那条')
    expect(m.div.querySelector('.turn-queue-paused')).toBeNull()
  })

  it('队列空不渲染', async () => {
    const m = await mount()
    feed({ type: 'turnQueue', main: { paused: false, items: [] }, tasks: {} })
    expect(m.div.querySelector('.turn-queue')).toBeNull()
  })
})
