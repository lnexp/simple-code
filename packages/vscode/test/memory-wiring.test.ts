// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryStats } from '@simple-code/core'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 记忆面板的**接线**（同 ctx-wiring 纪律：从最外层驱动）。
 * 链路：冷启动按钮常驻 → 点击发 reflect_panel → memory_data 渲染四元组 →
 * 反思三态（无任务/反思中/双选项）→ reflect_result 受理关面板、失败留理由。
 */

const sent: ToHost[] = []
let cleanup: (() => void) | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
  sent.length = 0
  host = null
})

function mount() {
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => ({ postMessage: (msg: unknown) => sent.push(msg as ToHost) }),
    configurable: true,
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    host?.remove()
  }
  return {
    send: (msg: ToWebview) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      }),
    clickMem: () =>
      act(() => {
        const btn = host!.querySelector<HTMLButtonElement>('[title="记忆面板"]')
        if (!btn) throw new Error('「记忆」按钮没渲染出来')
        btn.click()
      }),
    /** 面板内按文字找按钮（去查看 / 关闭并重开 / 反思） */
    clickPanelBtn: (text: string) =>
      act(() => {
        const btn = [...host!.querySelectorAll<HTMLButtonElement>('.ctx-compact')].find((b) =>
          b.textContent?.includes(text),
        )
        if (!btn) throw new Error(`面板里没有「${text}」按钮`)
        btn.click()
      }),
    esc: () =>
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      }),
    html: () => host!.innerHTML,
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

const tasks = (status: 'running' | 'idle'): ToWebview => ({
  type: 'tasks',
  folder: '/tmp/x',
  tasks: [
    {
      name: '反思',
      status,
      lastText: '',
      current: { provider: 'p', model: 'm' },
      effort: 'high',
      effortOverridden: false,
      presets: [],
      imagesEnabled: false,
      contextWindow: 0,
      approvalOn: true,
    },
  ],
  limit: 3,
})

const stats: MemoryStats = {
  notes: { total: 69, visible: 20, hidden: 44, superseded: 5 },
  lessons: { total: 43, visible: 30, hidden: 13, superseded: 0 },
  events: { total: 125, visible: 30, hidden: 95, superseded: 0 },
  skills: 2,
  summaries: 628,
  lastReflect: { date: '2026-10-22', theme: 'recall-review' },
}

describe('记忆面板接线', () => {
  it('冷启动：按钮无条件渲染 → 点击发 reflect_panel → 条形图与上次反思渲染；Esc 关', () => {
    const app = mount()
    // 一个消息都不发——按钮必须在（这是它能进 .bar 的全部理由）
    app.clickMem()
    expect(sent.some((m) => m.type === 'reflect_panel')).toBe(true)

    app.send({ type: 'memory_data', stats })
    const html = app.html()
    // 同上下文面板：一根整条按四库分段，每库一行只给总数与占比
    expect(html).toContain('共 239 条') // 69+43+125+2
    expect(html).toContain('ctx-stack')
    expect(html).toContain('29%') // note 69/239
    expect(html).not.toContain('收起')
    expect(html).toContain('另有 summary 628 份')
    expect(html).toContain('2026-10-22 · recall-review')

    app.esc()
    expect(app.html()).not.toContain('另有 summary')
  })

  it('无反思任务：点「反思」发 reflect_start；受理 ok 面板自动关', () => {
    const app = mount()
    app.send(state(false))
    app.clickMem()
    app.send({ type: 'memory_data', stats })
    app.clickPanelBtn('反思')
    expect(sent.some((m) => m.type === 'reflect_start')).toBe(true)

    app.send({ type: 'reflect_result', ok: true })
    expect(app.html()).not.toContain('另有 summary') // 面板关了
  })

  it('受理失败：reason 留在面板里', () => {
    const app = mount()
    app.send(state(false))
    app.clickMem()
    app.send({ type: 'memory_data', stats })
    app.clickPanelBtn('反思')
    app.send({ type: 'reflect_result', ok: false, reason: '已有同名任务「反思」在跑' })
    const html = app.html()
    expect(html).toContain('已有同名任务「反思」在跑')
    expect(html).toContain('另有 summary') // 面板还开着
  })

  it('反思任务 running：按钮变「反思中…」，无双选项', () => {
    const app = mount()
    app.send(state(false))
    app.send(tasks('running'))
    app.clickMem()
    app.send({ type: 'memory_data', stats })
    const html = app.html()
    expect(html).toContain('反思中…')
    expect(html).not.toContain('关闭并重开')
  })

  it('反思任务 idle：双选项——去查看发 task_open 并关面板；关闭并重开发 reflect_reopen', () => {
    const app = mount()
    app.send(state(false))
    app.send(tasks('idle'))
    app.clickMem()
    app.send({ type: 'memory_data', stats })
    expect(app.html()).toContain('去查看') // 状态由按钮表达，不另设状态行

    app.clickPanelBtn('去查看')
    const open = sent.find((m) => m.type === 'task_open')
    expect(open).toEqual({ type: 'task_open', task: '反思' })
    expect(app.html()).not.toContain('另有 summary') // 面板关了

    app.clickMem()
    app.clickPanelBtn('关闭并重开')
    expect(sent.some((m) => m.type === 'reflect_reopen')).toBe(true)
  })

  it('主任务 running：按钮置灰显示「主任务运行中」', () => {
    const app = mount()
    app.send(state(true))
    app.clickMem()
    app.send({ type: 'memory_data', stats })
    const html = app.html()
    expect(html).toContain('主任务运行中')
    expect(html).not.toContain('关闭并重开')
  })
})
