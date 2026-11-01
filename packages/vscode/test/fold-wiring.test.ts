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

describe('跑着时插话', () => {
  /** 在输入框里打字回车（跑着时 = 插话） */
  const enter = (text: string): void => {
    const ta = document.querySelector('textarea') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(ta, text)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
  }

  it('**插话不把前面的过程折走**：插话前的说明和命令照样在、排在插话前面，跑完再一起折', () => {
    const app = mount()
    app.send(state(false))
    enter('你来实现吧')
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '我先跑一下' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_end' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
    enter('顺便看下日志')
    // core 在 loop 顶投进历史（工具结果之后）——这之后它才进时间线、切开这一轮
    app.send({ type: 'agent', event: { type: 'input_delivered' }, at: 1 })

    expect(app.html()).toContain('顺便看下日志')
    expect(app.html()).not.toContain('process-head')
    expect(app.html()).toContain('我先跑一下')
    expect(app.html().indexOf('我先跑一下')).toBeLessThan(app.html().indexOf('顺便看下日志'))
    // 命令也得在（10-31 真机：说明在、命令没了——插话把轮切成两段，前一段
    // 不 live 也没折，renderBlock 把活动块画成 null）。收起的步骤留句尾计数
    expect(app.html()).toContain('1 个操作')
    expect(app.html().indexOf('1 个操作')).toBeLessThan(app.html().indexOf('顺便看下日志'))
    expect(document.querySelectorAll('.turn-progress').length, '进度头只在跑着的那段').toBe(1)
    // 插话前那段的步骤都收起（插话后还没新事件，全页没有「当前步」）
    expect(document.querySelectorAll('.tl-step[data-current="true"]').length).toBe(0)

    app.send(state(false)) // 跑完：照旧收起
    expect(app.html()).toContain('process-head')
  })

  it('**回答流式中插话，气泡排在这一步回答后面**：投递前留在最下面，与 reload 后的库顺序一致', () => {
    // 2026-10-31 真机：模型在出最后一段回答时插话，气泡当场进时间线，回答排到
    // 气泡后面、前面的命令被切走；core 实际在这步之后才投递，reload 后气泡在最下面
    const app = mount()
    app.send(state(false))
    enter('你来实现吧')
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'reasoning_start' }, at: 1 })
    enter('为什么会这样')
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '可以做：结论' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_end' }, at: 1 })
    expect(app.html().indexOf('可以做：结论')).toBeLessThan(app.html().indexOf('为什么会这样'))
    expect(document.querySelectorAll('.turn-progress').length, '还没投递，这一轮没被切开').toBe(1)
    app.send({ type: 'agent', event: { type: 'input_delivered' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '先修这个' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_end' }, at: 1 })
    // 跟一个工具：流式中的最后一条气泡是节流异步刷的，后面有块才同步出字
    app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't2', name: 'bash' }, at: 1 })
    const html = app.html()
    expect(html.indexOf('可以做：结论')).toBeLessThan(html.indexOf('为什么会这样'))
    expect(html.indexOf('为什么会这样')).toBeLessThan(html.indexOf('先修这个'))
    expect(html.indexOf('为什么会这样')).toBe(html.lastIndexOf('为什么会这样'))
  })

  it('hydrate 带 queued（轮内重开面板）：排队气泡画在最下面', () => {
    const app = mount()
    app.send(state(true))
    app.send({
      type: 'hydrate',
      items: [{ kind: 'user', text: '你来实现吧' }, { kind: 'assistant', text: '我先跑一下' }],
      queued: [{ kind: 'user', text: '顺便看下日志', interject: true }],
    })
    expect(app.html()).toContain('顺便看下日志')
    expect(app.html().indexOf('我先跑一下')).toBeLessThan(app.html().indexOf('顺便看下日志'))
  })

  it('**插话时前面挂着的审批卡不消失**：卡所在的步骤强制展开', () => {
    const app = mount()
    app.send(state(false))
    enter('你来实现吧')
    app.send(state(true))
    app.send({ type: 'agent', event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_delta', text: '要读个隐藏文件' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'text_end' }, at: 1 })
    app.send({ type: 'agent', event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
    app.send({
      type: 'approval_request',
      folder: '/tmp/x',
      expiresAt: Date.now() + 300_000,
      id: 1,
      toolCallId: 't1',
      command: 'cat .env',
      category: 'hidden_path',
      detail: '.env',
      reason: '要触碰隐藏路径：.env',
    })
    expect(document.querySelectorAll('.approval-card').length).toBe(1)
    enter('先别读')
    expect(document.querySelectorAll('.approval-card').length, '插话后卡还在').toBe(1)
    expect(app.html().indexOf('approval-card')).toBeLessThan(app.html().indexOf('先别读'))
  })

  it('**分支里插话同样不折**：选中跑着的分支，插话前的过程照样在、排在插话前面', () => {
    const app = mount()
    app.send(state(false))
    const name = '长活'
    app.send({
      type: 'tasks',
      folder: '/tmp/x',
      tasks: [
        {
          name,
          status: 'running',
          lastText: '',
          current: null,
          effort: null,
          effortOverridden: false,
          presets: [],
          imagesEnabled: false,
          contextWindow: 0,
          approvalOn: true,
        },
      ],
    })
    act(() => {
      // 任务 tab 是 span，能点的是里面的 .branch-open
      const tab = [...document.querySelectorAll<HTMLButtonElement>('.branch-open')].find(
        (b) => b.textContent === name,
      )
      if (!tab) throw new Error(`没有任务 tab：${name}`)
      tab.click()
    })
    app.send({ type: 'task_hydrate', folder: '/tmp/x', name, items: [{ kind: 'user', text: '分支任务书' }], contextTokens: 0 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'text_delta', text: '分支先跑一下' }, at: 1 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'text_end' }, at: 1 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'tool_input_start', id: 't1', name: 'bash' }, at: 1 })
    enter('插一句')
    // 投递前到的回答排在插话前面（插话在 queued，画在最下面）
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'text_start' }, at: 1 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'text_delta', text: '分支答完' }, at: 1 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'text_end' }, at: 1 })
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'tool_input_start', id: 't2', name: 'bash' }, at: 1 })
    expect(app.html().indexOf('分支答完')).toBeLessThan(app.html().indexOf('插一句'))
    app.send({ type: 'task_agent', folder: '/tmp/x', name, event: { type: 'input_delivered' }, at: 1 })

    // 先确认看的是分支（选中失败的话插话落进主任务，下面的断言会空过）
    expect(app.html()).toContain('分支任务书')
    expect(app.html()).toContain('分支先跑一下')
    expect(app.html()).toContain('插一句')
    expect(app.html()).not.toContain('process-head')
    expect(app.html().indexOf('分支先跑一下')).toBeLessThan(app.html().indexOf('插一句'))
    expect(app.html()).toContain('1 个操作')
    expect(app.html().indexOf('1 个操作')).toBeLessThan(app.html().indexOf('插一句'))
  })
})
