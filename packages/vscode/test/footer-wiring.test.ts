// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 页脚的**接线**，不是页脚的内容。
 *
 * 这个文件是为一次真实的翻车加的：`finishTurn` 的单测一直全绿，坏的是
 * 「谁来调它」——原来接在一个 core 根本不产生的 AgentEvent 上，分支永远
 * 不跑、页脚永远不出现，tsc / biome / 565 条单测全绿，只有用户盯着界面
 * 才发现。那个幽灵成员已经从类型里删掉了（core/src/events.ts 有原委），
 * 但**「单测全绿而接线是断的」这个失败模式还在**——所以留这个文件。
 *
 * 所以这里从**最外层**驱动：往 window 发真的 postMessage，断言页脚出现。
 * 中间换任何实现都不影响这条测试的有效性。
 */

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

/** 挂一个真的 App，返回「发消息」和「读 DOM」两个把手 */
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
    html: () => host.innerHTML,
  }
}

const state = (
  running: boolean,
  footer?: { model: string | null; finishedAt: number; elapsedMs: number },
): ToWebview => ({
  type: 'state',
  running,
  ...(footer ? { footer } : {}),
  folder: '/tmp/x',
  current: { provider: 'p', model: 'test-model-9' },
  models: [{ provider: 'p', model: 'test-model-9' }],
  effort: 'high',
  effortOverridden: false,
      presets: [],
  approvalOn: true,
  imagesEnabled: false,
  contextWindow: 0,
})

/** 一轮完整对话；`end` 决定跑不跑完 */
const runTurn = (app: ReturnType<typeof mount>, end: boolean): void => {
  app.send(state(false)) // 面板刚连上
  app.send(state(true)) // 开跑
  app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
  app.send({ type: 'agent', event: { type: 'text_delta', text: '答案' }, at: 1 })
  if (end) app.send(state(false))
}

/** 面板中途重开的形态：running=true 的 state 到达时 webview 是新建的，
 * 内存里没有 turnStartedAt（它是 user append 时记的，hydrate 不带）。
 * 模拟：跳过「开跑前」那条 state(false)，直接从 running=true 开始 */
const runTurnAfterReopen = (app: ReturnType<typeof mount>): void => {
  app.send(state(true)) // 重开时已经在跑——turnStartedAt 无从记起
  app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
  app.send({ type: 'agent', event: { type: 'text_delta', text: '答案' }, at: 1 })
  app.send(
    state(false, { model: 'p/host-model', finishedAt: 1_700_000_000_000, elapsedMs: 654_321 }),
  )
}

/**
 * 「页脚在不在」的哨兵是 `class="footer"`，**不是模型名**。
 *
 * 一度用的是模型名，后来输入框旁边加了模型选择器——同一个名字在页脚之外
 * 也出现了，三条「不该有页脚」的断言当场变成永远失败。反过来（先有选择器
 * 再写这些测试）就是永远通过，而那不会有人发现
 */
const hasFooter = (html: string): boolean => html.includes('class="footer"')

describe('一轮跑完，页脚要出现', () => {
  it('running true→false 之后页脚带上模型名和复制按钮', () => {
    const app = mount()
    runTurn(app, true)
    // 前提断言：回答确实渲出来了。不然「页脚出现了」也可能是在空壳上
    // （流式中途不断言文本——那时 useThrottledText 还压着，见 throttle.ts）
    expect(app.html()).toContain('答案')
    expect(hasFooter(app.html())).toBe(true)
    expect(app.html()).toContain('footer-model')
    expect(app.html()).toContain('test-model-9') // 页脚里显示的是当前模型名
    expect(app.html()).toContain('codicon-copy')
  })

  it('**还在跑的时候没有页脚**', () => {
    // 对照上面那条：页脚要是无条件渲染，上面那条照样绿
    const app = mount()
    runTurn(app, false)
    expect(hasFooter(app.html())).toBe(false)
  })

  it('**step_finish 不算收尾**——一轮里每步都有一个', () => {
    // 拿它当收尾信号的话，第一次调工具之后页脚就冒出来了，后面还在跑。
    // 收尾只认 running 回落（这条和第一条只差这一点）
    const app = mount()
    runTurn(app, false)
    app.send({
      type: 'agent',
      event: {
        type: 'step_finish',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          reasoningTokens: 0,
        },
        contextTokens: 1,
      },
      at: 1,
    })
    expect(hasFooter(app.html())).toBe(false)
  })

  it('中断（没有 assistant 消息）不崩，也不硬塞页脚', () => {
    const app = mount()
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
    app.send(state(false))

    expect(hasFooter(app.html())).toBe(false)
  })
})

describe('页脚模型按轮记录（切换不漂移）', () => {
  const stateAs = (running: boolean, model: string): ToWebview => ({
    type: 'state',
    running,
    folder: '/tmp/x',
    current: { provider: 'p', model },
    models: [{ provider: 'p', model }],
    effort: 'high',
    effortOverridden: false,
      presets: [],
    approvalOn: true,
    imagesEnabled: false,
    contextWindow: 0,
  })

  // 用 DOM 查询而不是 html 字符串：模型名在下拉选择器里也出现（哨兵教训）
  const footers = (): string[] =>
    Array.from(document.querySelectorAll('.footer')).map((el) => el.textContent ?? '')

  it('两轮各用不同模型 → 各自页脚各标各的', () => {
    const app = mount()
    app.send(stateAs(false, 'alpha'))
    app.send(stateAs(true, 'alpha'))
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '第一轮答' }, at: 1 })
    app.send(stateAs(false, 'alpha'))
    expect(footers()).toHaveLength(1)
    expect(footers()[0]).toContain('alpha')

    // 中途切到 beta 再跑一轮。**第一轮页脚是原 DOM 节点的原样文本**——
    // 若渲染仍吃全局 controls，它会被静默改写成 beta（翻车原状）
    app.send(stateAs(true, 'beta'))
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '第二轮答' }, at: 1 })
    app.send(stateAs(false, 'beta'))

    // 第二轮结束后第一轮被折进「处理过程」组（实测发现的：折叠时组内
    // DOM 不渲染）。点开再验——用户看历史也是这个路径
    act(() => {
      document.querySelector<HTMLButtonElement>('.process-head')?.click()
    })
    const f = footers()
    expect(f).toHaveLength(2)
    expect(f[0]).toContain('alpha')
    expect(f[0]).not.toContain('beta')
    expect(f[1]).toContain('beta')
  })
})

describe('宿主权威页脚（面板中途重开丢 turnStartedAt 的补法）', () => {
  const footers = (): string[] =>
    Array.from(document.querySelectorAll('.footer')).map((el) => el.textContent ?? '')

  it('重开后收口：footer 覆盖出耗时，模型用宿主给的', () => {
    const app = mount()
    runTurnAfterReopen(app)
    // finishTurn 本地无 turnStartedAt → 本地无耗时；footer 补 elapsedMs
    // 654321ms = 10m 54s。哨兵是格式化后的耗时文本而不是裸数字：
    // finishedAt 时刻戳也在页脚里，裸数字会误命中
    expect(footers()).toHaveLength(1)
    expect(footers()[0]).toContain('10m 54s')
    expect(footers()[0]).toContain('host-model')
  })

  it('footer 不带时维持旧行为：无耗时不编造', () => {
    const app = mount()
    app.send(state(true)) // 重开形态
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '答' }, at: 1 })
    app.send(state(false)) // 收口 state 没有 footer（旧宿主/未升级）
    expect(footers()).toHaveLength(1)
    // 没有耗时段（watch 图标不出现），但页脚本身还在（模型+时刻）
    expect(footers()[0]).toContain('test-model-9')
  })
})
