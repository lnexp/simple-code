// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 上下文分析面板的**接线**（同 footer-wiring 的纪律：从最外层驱动，
 * 单测全绿而接线是断的这种失败模式在这里被抓）。
 *
 * 链路：step_finish 带出 contextTokens → 底栏出现「上下文 X」可点 →
 * 点击发 get_regions → 宿主回 regions → 面板渲染分区表 → Esc 关。
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
  return {
    send: (msg: ToWebview) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      }),
    clickCtx: () =>
      act(() => {
        const btn = host.querySelector<HTMLButtonElement>('.usage-ctx')
        if (!btn) throw new Error('「上下文 X」按钮没渲染出来')
        btn.click()
      }),
    esc: () =>
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      }),
    html: () => host.innerHTML,
  }
}

const state: ToWebview = {
  type: 'state',
  running: false,
  folder: '/tmp/x',
  current: { provider: 'p', model: 'm' },
  models: [{ provider: 'p', model: 'm' }],
  effort: 'high',
  effortOverridden: false,
      presets: [],
  approvalOn: true,
  imagesEnabled: false,
  contextWindow: 0,
}

const finish: ToWebview = {
  type: 'agent',
  at: 1,
  event: {
    type: 'step_finish',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    },
    contextTokens: 67_300,
  },
}

const info: Extract<ToWebview, { type: 'regions' }>['info'] = {
  at: '2026-09-11T20:00:00.000Z',
  contextWindow: 256_000,
  maxTokens: 16_000,
  budget: 238_000,
  overhead: 3_283,
  cold: 6_974,
  warm: 0,
  hot: 2_273,
  stub: 0,
  floor: 2_625,
  live: 44_007,
  ranges: null,
}

const infoWithRanges: typeof info = { ...info, ranges: {
  cold: { from: 1, to: 811 }, warm: null, hot: { from: 871, to: 871 },
  stub: null, floor: { from: 2306, to: 2311 }, live: { from: 872, to: 2311 },
} }

describe('上下文分析面板接线', () => {
  it('step_finish 出数 → 按钮出现；点击发 get_regions；regions 回来渲染；Esc 关', () => {
    const app = mount()
    app.send(state)
    expect(app.html()).not.toContain('usage-ctx') // 没数据不渲染

    app.send(finish)
    app.clickCtx()
    expect(sent.some((m) => m.type === 'get_regions')).toBe(true)
    // 取数中的空态（还没有 regions 消息回来）
    expect(app.html()).toContain('取数中')

    app.send({ type: 'regions', info })
    const html = app.html()
    expect(html).toContain('上下文分析')
    expect(html).toContain('冷区')
    expect(html).toContain('不可卸')
    expect(html).toContain('空闲')
    expect(html).toContain('67.3k') // contextTokens 的徽标（fmtTok）

    app.esc()
    expect(app.html()).not.toContain('上下文分析')
  })

  it('宿主回 null（从未跑过）：显示空态而不是崩', () => {
    const app = mount()
    app.send(state)
    app.send(finish)
    app.clickCtx()
    app.send({ type: 'regions', info: null })
    expect(app.html()).toContain('还没有记录')
  })

  it('范围列：带 ranges 渲染纯数字区间，老记录没有 ranges 列为空不炸', () => {
    const app = mount()
    app.send(state)
    app.send(finish)
    app.clickCtx()
    app.send({ type: 'regions', info: infoWithRanges })
    const html = app.html()
    expect(html).toContain('1–811')
    expect(html).toContain('871') // 单值不显示区间符
    expect(html).toContain('2306–2311')
    expect(html).toContain('>0<') // system+tools 恒为消息 0

    const old = mount()
    old.send(state)
    old.send(finish)
    old.clickCtx()
    old.send({ type: 'regions', info })
    expect(old.html()).toContain('上下文分析') // 老记录（无 ranges）照常出表
  })
})

/**
 * V2 版式（2026-09-20 拍板）的**结构**断言，不是内容。
 *
 * 旧版每行一根 `min(pct,8)*4` 的短条：70% 的空闲和 8.5% 的未卸载画出来
 * 一样长，看图得到的结论是反的。改成顶部一条按真实比例的堆叠总览条，
 * 空闲不进堆叠（露出的轨道底色就是它）。这条测试盯住那个「真实比例」——
 * 退回截断实现的话 width 就不再等于占比，断言会挂
 */
describe('上下文面板 V2 版式', () => {
  it('堆叠条按真实比例、空闲不进段；每行有色点', () => {
    const app = mount()
    app.send(state)
    app.send(finish)
    app.clickCtx()
    app.send({ type: 'regions', info })
    const html = app.html()

    // 堆叠条存在，且段数 = 行数 − 1（空闲那行不进堆叠）
    expect(html).toContain('ctx-stack')
    const segs = html.split('ctx-stack')[1]?.split('</div>')[0] ?? ''
    expect(segs.match(/<span/g)?.length).toBe(8)

    // 真实比例：live 44,007 / 256,000 = 17.19%，不被截断到 8%
    expect(segs).toContain('width: 17.19')
    // 旧版的表格结构已经不在
    expect(html).not.toContain('ctx-table')
    // 每行一个色点
    expect(html.match(/ctx-dot/g)?.length).toBe(9)
  })
})
