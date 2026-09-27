// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 第三层折叠的**接线**，不是分组算法（那个在 events.test.ts）。
 *
 * 跟 footer-wiring.test.ts 同一个理由：`splitTurns` 的单测可以一直全绿，
 * 而 App 里根本没调它——那种断线 tsc / biome / 全套单测都不红，只有盯着
 * 界面才看得见。所以这里从最外层驱动：发真的 postMessage，读真的 DOM。
 */

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mount() {
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
    click: (label: string) =>
      act(() => {
        // 纯图标按钮（发送/停止）没有 textContent，按 aria-label 认
        const btn = [...host.querySelectorAll('button')].find(
          (b) => b.textContent === label || b.getAttribute('aria-label') === label,
        )
        if (!btn) throw new Error(`没有这个按钮：${label}`)
        btn.click()
      }),
    html: () => host.innerHTML,
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

/** 截图里那个形状：说明 → 命令 → 说明 → 命令 → 最终回答 */
const messy = (app: ReturnType<typeof mount>): void => {
  const say = (text: string) => {
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_end' }, at: 1 })
  }
  app.send(state(false))
  app.send(state(true))
  say('中间说明甲')
  app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
  say('中间说明乙')
  app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't2', name: 'bash' }, at: 1 })
  say('这是最终回答')
}

describe('回答结束后，过程收成一行', () => {
  it('中间说明和操作组全部离开 DOM，只留最终回答', () => {
    const app = mount()
    messy(app)
    app.send(state(false)) // 跑完

    expect(app.html()).toContain('process-head')
    expect(app.html()).toContain('2 个操作')
    expect(app.html()).toContain('这是最终回答')
    // 折进去的一个字都不留——「收起 = 一条都不留」同活动组
    expect(app.html()).not.toContain('中间说明甲')
    expect(app.html()).not.toContain('中间说明乙')
  })

  it('**对照：还在跑的时候不折**，中间说明都在，也没有折叠头', () => {
    // 没有这条的话，「折了」和「无条件折」分不出来——而无条件折会把
    // 正在跑的那一轮整个藏起来，用户看着就是一片空白
    const app = mount()
    messy(app)

    expect(app.html()).not.toContain('process-head')
    expect(app.html()).toContain('中间说明甲')
    expect(app.html()).toContain('中间说明乙')
  })

  it('点停止 → 折叠头旁边留下「已中断」', () => {
    const app = mount()
    app.send(state(false))
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
    app.click('停止')
    app.send(state(false)) // 中断后 core 收尾，running 回落

    expect(app.html()).toContain('已中断')
    expect(app.html()).toContain('process-head')
  })

  it('**对照：正常跑完不写「已中断」**', () => {
    const app = mount()
    messy(app)
    app.send(state(false))
    expect(app.html()).not.toContain('已中断')
  })
})
