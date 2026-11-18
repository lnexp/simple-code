// @vitest-environment jsdom
/**
 * 任务改名的 webview 侧（2026-11-09）：双击任务名进入行内编辑，Enter 提交
 * （trim + 截 20 后发 task_rename）、Esc / 失焦取消；宿主确认（快照旧名消失
 * 新名出现）后选中态与任务视图键迁移，view_task 随 branch 自动重报。
 */

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

let cleanup: (() => void) | null = null
const sent: ToHost[] = []
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
    host,
  }
}

const A = '/w/a'
const state = (folder: string): ToWebview => ({
  type: 'state',
  running: false,
  folder,
  current: { provider: 'p', model: 'm1' },
  models: [{ provider: 'p', model: 'm1' }],
  effort: 'high',
  effortOverridden: false,
  presets: [],
  attendance: 'attended',
  imagesEnabled: false,
  contextWindow: 0,
  summaryInContext: true,
})

const tasksMsg = (folder: string, names: string[]): ToWebview => ({
  type: 'tasks',
  folder,
  tasks: names.map((name) => ({
    name,
    status: 'idle' as const,
    lastText: '',
    current: null,
    effort: null,
    effortOverridden: false,
    presets: [],
    imagesEnabled: false,
    contextWindow: 0,
    attendance: 'attended' as const,
    summaryInContext: true,
  })),
})

describe('任务改名（双击行内编辑）', () => {
  it('双击出编辑框，Enter 发 trim 后的 task_rename；快照迁移选中态并重报 view_task', () => {
    const app = mount()
    app.send(state(A))
    app.send(tasksMsg(A, ['旧名']))
    const btn = app.host.querySelector<HTMLButtonElement>('.branch-strip .branch-open')
    expect(btn).not.toBeNull()
    if (!btn) return
    // 先选中它（branch 指向旧名——迁移断言的前提）
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // 双击进入编辑
    act(() => {
      btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const input = app.host.querySelector<HTMLInputElement>('.branch-rename')
    expect(input).not.toBeNull()
    if (!input) return
    act(() => {
      input.value = '  新名  '
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(sent).toContainEqual({ type: 'task_rename', task: '旧名', name: '新名' })
    // 宿主确认：旧名消失、新名出现的快照 → 选中态迁移 + view_task 重报（useEffect 跟 branch）
    app.send(tasksMsg(A, ['新名']))
    expect(sent).toContainEqual({ type: 'view_task', task: '新名' })
    expect(app.host.querySelector('.branch-rename')).toBeNull()
  })

  it('Esc 取消；没改 / 清空提交不发', () => {
    const app = mount()
    app.send(state(A))
    app.send(tasksMsg(A, ['旧名']))
    // 双击后按钮会因编辑态切换被重建（卸载再挂载），每次都得现查——
    // 旧引用是脱离文档的节点，事件到不了 React 的委托层
    const open = (): HTMLInputElement => {
      const btn = app.host.querySelector<HTMLButtonElement>('.branch-strip .branch-open')
      act(() => {
        btn?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      })
      const input = app.host.querySelector<HTMLInputElement>('.branch-rename')
      expect(input).not.toBeNull()
      return input as HTMLInputElement
    }
    const type = (input: HTMLInputElement, value: string, key: string): void =>
      act(() => {
        input.value = value
        input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })

    // Esc：编辑框收起，什么都不发
    type(open(), '旧名', 'Escape')
    expect(app.host.querySelector('.branch-rename')).toBeNull()
    // Enter 原值：不发
    type(open(), '旧名', 'Enter')
    // Enter 空白：不发
    type(open(), '   ', 'Enter')
    expect(sent.filter((m) => m.type === 'task_rename')).toEqual([])
  })

  it('超长输入截到 20（与宿主 nameOf 同规格）', () => {
    const app = mount()
    app.send(state(A))
    app.send(tasksMsg(A, ['旧名']))
    const btn = app.host.querySelector<HTMLButtonElement>('.branch-strip .branch-open')
    act(() => {
      btn?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const input = app.host.querySelector<HTMLInputElement>('.branch-rename')
    expect(input).not.toBeNull()
    if (!input) return
    act(() => {
      input.value = '一二三四五六七八九十一二三四五六七八九十一二三'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(sent).toContainEqual({
      type: 'task_rename',
      task: '旧名',
      name: '一二三四五六七八九十一二三四五六七八九十',
    })
  })
})
