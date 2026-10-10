// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

const posted: ToHost[] = []
vi.mock('../webview/vscode.ts', () => ({
  post: (msg: ToHost) => posted.push(msg),
}))

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  posted.length = 0
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
    host,
    open: (cls: string): HTMLElement[] => {
      act(() => {
        host.querySelector<HTMLButtonElement>(`button.${cls}`)?.click()
      })
      return [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    },
    heads: () => [...host.querySelectorAll('.menu-head')].map((h) => h.textContent),
  }
}

const MODELS = [
  { provider: 'p', model: 'only-here' },
  { provider: 'p', model: 'both-sides' },
  { provider: 'q', model: 'both-sides' },
]

const state = (over: Partial<Extract<ToWebview, { type: 'state' }>> = {}): ToWebview => ({
  approvalOn: true,
  type: 'state',
  running: false,
  folder: '/tmp/x',
  current: { provider: 'p', model: 'only-here' },
  models: MODELS,
  effort: 'high',
  effortOverridden: false,
      presets: [],
  imagesEnabled: false,
  contextWindow: 0,
  ...over,
})

describe('模型选择器', () => {
  it('**配置没加载完时整个不渲染**', () => {
    const app = mount()
    app.send(state({ current: null, models: [] }))
    expect(app.host.querySelector('button.model-picker')).toBeNull()
  })

  it('列出所有模型，按 provider 分节', () => {
    const app = mount()
    app.send(state())
    const items = app.open('model-picker')
    expect(items.map((el) => el.textContent)).toEqual(['only-here', 'both-sides', 'both-sides'])
    expect(app.heads()).toEqual(['p', 'q'])
  })

  it('**同名模型时触发器带 provider 前缀**（消歧）', () => {
    const app = mount()
    app.send(state({ current: { provider: 'p', model: 'both-sides' } }))
    expect(app.host.querySelector('button.model-picker')?.textContent).toContain('p/both-sides')

    cleanup?.()
    const solo = mount()
    solo.send(
      state({
        current: { provider: 'p', model: 'solo' },
        models: [{ provider: 'p', model: 'solo' }],
      }),
    )
    expect(solo.host.querySelector('button.model-picker')?.textContent).toContain('solo')
  })

  it('**跑的时候禁用**', () => {
    const app = mount()
    app.send(state({ running: true }))
    expect(app.host.querySelector<HTMLButtonElement>('button.model-picker')?.disabled).toBe(true)
  })

  it('**不跑的时候可用**——对照组', () => {
    const app = mount()
    app.send(state({ running: false }))
    expect(app.host.querySelector<HTMLButtonElement>('button.model-picker')?.disabled).toBe(false)
  })

  it('选一个就把 setModel 发给宿主，带上 provider', () => {
    const app = mount()
    app.send(state())
    const items = app.open('model-picker')
    act(() => {
      items[2]?.click()
    })
    expect(posted).toContainEqual({
      type: 'setModel',
      choice: { provider: 'q', model: 'both-sides' },
    })
  })
})

describe('底栏布局', () => {
  const rightOrder = (host: HTMLElement): string[] =>
    [...(host.querySelector('.bar-right')?.querySelectorAll('button') ?? [])].map((el) =>
      el.classList.contains('model-picker')
        ? 'model-picker'
        : el.classList.contains('effort-picker')
          ? 'effort-picker'
          : // 发送/停止是纯图标钮（textContent 为空），认 aria-label；
            // 审批是图标+状态字，textContent 就是「开」/「关」
            `button:${el.getAttribute('aria-label') ?? el.textContent}`,
    )

  it('发送按钮在右侧组的最后，两个选择器在它左边', () => {
    const app = mount()
    app.send(state())
    // 审批开关排最前（安全语义，approval.md §4.2），其次两个选择器
    expect(rightOrder(app.host)).toEqual(['button:开', 'effort-picker', 'model-picker', 'button:发送'])
  })

  it('用量在右侧组外面（也就是左边）', () => {
    const app = mount()
    app.send(state())
    app.send({
      type: 'agent',
      event: {
        type: 'step_finish',
        usage: {
          inputTokens: 1,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          reasoningTokens: 0,
        },
        // 页脚显示的是这个（core 报的「下一轮要发多少」），不是 usage
        contextTokens: 1234,
      },
      at: 1,
    })
    // 底栏左侧是**两个并列的子项**（2026-09-20 拆分）：耗时统计 .usage
    // 与上下文按钮 .usage-ctx。挤在一个 span 里时窄侧栏会把按钮推到第二
    // 行，所以拆开——耗时可收缩、按钮 flex:none。1234 → 1.2k（fmtTok）
    expect(app.host.querySelector('.usage')?.textContent).toContain('首字')
    expect(app.host.querySelector('.usage-ctx')?.textContent).toContain('1.2k')
    expect(app.host.querySelector('.usage-ctx')?.textContent).toContain('上下文')
    // 都在 .bar 里但不在 .bar-right 里——right 靠 margin-left:auto 推到右边
    expect(app.host.querySelector('.bar-right .usage')).toBeNull()
    expect(app.host.querySelector('.bar-right .usage-ctx')).toBeNull()
  })

  it('跑的时候发送变停止，仍然在最后', () => {
    const app = mount()
    app.send(state({ running: true }))
    expect(rightOrder(app.host).at(-1)).toBe('button:停止')
  })
})

describe('推理深度选择器', () => {
  it('session 还没建起来时不渲染（effort 是 null）', () => {
    const app = mount()
    app.send(state({ effort: null }))
    expect(app.host.querySelector('button.effort-picker')).toBeNull()
  })

  it('所有档位都列出，「默认」带配置值副文案', () => {
    const app = mount()
    app.send(state())
    const items = app.open('effort-picker')
    expect(items.map((el) => el.textContent)).toEqual([
      '默认跟随配置（high）',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('**没盖过时选中「默认」**，不是选中当前那一档；触发器带出配置值', () => {
    const app = mount()
    app.send(state({ effort: 'high', effortOverridden: false }))
    const items = app.open('effort-picker')
    expect(items[0]?.getAttribute('aria-checked')).toBe('true')
    expect(items[3]?.getAttribute('aria-checked')).toBe('false')
    // 原生 select 时代这个信息塞不下（触发器就是选中项，只显示「默认」）
    expect(app.host.querySelector('button.effort-picker')?.textContent).toContain('默认 · high')
  })

  it('盖过时选中那一档，并且点亮', () => {
    const app = mount()
    app.send(state({ effort: 'max', effortOverridden: true }))
    const items = app.open('effort-picker')
    expect(items.at(-1)?.getAttribute('aria-checked')).toBe('true')
    expect(app.host.querySelector('.ctl-group[data-on="true"]')).not.toBeNull()
  })

  it('**没盖过时不点亮**——对照组', () => {
    const app = mount()
    app.send(state({ effort: 'high', effortOverridden: false }))
    expect(app.host.querySelector('.ctl-group[data-on="true"]')).toBeNull()
  })

  it('选一档就发给宿主', () => {
    const app = mount()
    app.send(state())
    const items = app.open('effort-picker')
    act(() => {
      items[4]?.click() // xhigh
    })
    expect(posted).toContainEqual({ type: 'setEffort', effort: 'xhigh' })
  })

  it('**选「默认」发的是 null**，不是空字符串', () => {
    // 发空串的话 core 会把它当档位塞进请求体，服务端 400
    const app = mount()
    app.send(state({ effort: 'max', effortOverridden: true }))
    const items = app.open('effort-picker')
    act(() => {
      items[0]?.click()
    })
    expect(posted).toContainEqual({ type: 'setEffort', effort: null })
  })

  it('跑的时候禁用', () => {
    const app = mount()
    app.send(state({ running: true }))
    expect(app.host.querySelector<HTMLButtonElement>('button.effort-picker')?.disabled).toBe(true)
  })
})

describe('自绘菜单交互', () => {
  const keydown = (app: ReturnType<typeof mount>, key: string) =>
    act(() => {
      app.host
        .querySelector('[role="menu"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })

  it('选中后菜单收起', () => {
    const app = mount()
    app.send(state())
    const items = app.open('effort-picker')
    act(() => {
      items[1]?.click()
    })
    expect(app.host.querySelector('[role="menu"]')).toBeNull()
  })

  it('Escape 收起', () => {
    const app = mount()
    app.send(state())
    app.open('effort-picker')
    keydown(app, 'Escape')
    expect(app.host.querySelector('[role="menu"]')).toBeNull()
  })

  it('方向键移动高亮，Enter 选中', () => {
    const app = mount()
    app.send(state())
    app.open('effort-picker')
    keydown(app, 'ArrowDown')
    keydown(app, 'ArrowDown')
    keydown(app, 'Enter')
    expect(app.host.querySelector('[role="menu"]')).toBeNull()
    expect(posted).toContainEqual({ type: 'setEffort', effort: 'medium' })
  })

  it('点击菜单外关闭', () => {
    const app = mount()
    app.send(state())
    app.open('effort-picker')
    act(() => {
      document.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(app.host.querySelector('[role="menu"]')).toBeNull()
  })
})

// t885 预设：同一模型多组请求参数（典型是网关多线路），在模型右侧独立下拉切
describe('预设选择器', () => {
  it('没配 presets 的模型整个不渲染——那时这一排跟以前一样', () => {
    const ui = mount()
    ui.send(state({ presets: [] }))
    expect(ui.host.querySelector('button.preset-picker')).toBeNull()
  })

  it('有 presets 时显示，默认态显示「默认」，选中后显示预设名', () => {
    const ui = mount()
    ui.send(state({ presets: ['备用线路', '长输出'] }))
    const btn = ui.host.querySelector<HTMLButtonElement>('button.preset-picker')
    expect(btn?.textContent).toContain('默认')
    // 「预设」二字不进 label——与模型/档位一致，字段名靠图标和 title 表达
    expect(btn?.textContent).not.toContain('预设')
    // title 挂在 Menu 的外层 .picker 上，不在 button 上
    expect(ui.host.querySelector('.preset-picker')?.closest('.picker')?.getAttribute('title')).toBe(
      '预设：默认（模型本体参数）',
    )

    ui.send(state({ presets: ['备用线路', '长输出'], preset: '备用线路' }))
    const on = ui.host.querySelector<HTMLButtonElement>('button.preset-picker')
    expect(on?.textContent).toContain('备用线路')
    expect(
      ui.host.querySelector('.preset-picker')?.closest('.picker')?.getAttribute('title'),
    ).toBe('预设：备用线路')
  })

  it('选一项发 setModel 带 preset；选「默认」发的 choice 不带 preset 键', () => {
    const ui = mount()
    ui.send(state({ presets: ['备用线路'], preset: '备用线路' }))
    const items = ui.open('preset-picker')
    expect(items.map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '默认模型本体参数',
      '备用线路',
    ])

    act(() => items[1]?.click())
    expect(posted.at(-1)).toEqual({
      type: 'setModel',
      choice: { provider: 'p', model: 'only-here', preset: '备用线路' },
    })

    const again = ui.open('preset-picker')
    act(() => again[0]?.click())
    // 切回默认：choice 里不能残留 preset，否则 core 会去找一个叫「默认」的预设
    expect(posted.at(-1)).toEqual({
      type: 'setModel',
      choice: { provider: 'p', model: 'only-here' },
    })
  })

  it('任务标签用任务模型自己的 presets 与 preset（2026-10-08：主任务 glm 没配、任务 opus 配了，任务里控件消失）', () => {
    const ui = mount()
    // 主任务：有选中的预设，但下面断言任务标签不许借它
    ui.send(state({ presets: [], preset: '主任务的线路' }))
    ui.send({
      type: 'tasks',
      folder: '/tmp/x',
      limit: 3,
      tasks: [
        {
          name: '分支',
          status: 'idle',
          lastText: '',
          current: { provider: 'p', model: 'both-sides' },
          effort: 'high',
          effortOverridden: false,
          presets: ['line-a', 'line-b'],
          imagesEnabled: false,
          contextWindow: 0,
          approvalOn: true,
        },
      ],
    })
    act(() => ui.host.querySelector<HTMLButtonElement>('.branch-strip .branch-open')?.click())
    const btn = ui.host.querySelector<HTMLButtonElement>('button.preset-picker')
    expect(btn).not.toBeNull()
    // 任务没选预设 = 默认，不回退成主任务的
    expect(btn?.textContent).toContain('默认')
    expect(ui.open('preset-picker').map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '默认模型本体参数',
      'line-a',
      'line-b',
    ])
  })

  it('任务标签的贴图门控用任务模型自己的 imagesEnabled（主干能收图、分支不能 → 分支里贴图要提示）', () => {
    const ui = mount()
    ui.send(state({ imagesEnabled: true }))
    ui.send({
      type: 'tasks',
      folder: '/tmp/x',
      limit: 3,
      tasks: [
        {
          name: '分支',
          status: 'idle',
          lastText: '',
          current: { provider: 'p', model: 'both-sides' },
          effort: 'high',
          effortOverridden: false,
          presets: [],
          imagesEnabled: false,
          contextWindow: 0,
          approvalOn: true,
        },
      ],
    })
    act(() => ui.host.querySelector<HTMLButtonElement>('.branch-strip .branch-open')?.click())
    const ta = ui.host.querySelector('textarea')
    expect(ta).not.toBeNull()
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', {
      value: { items: [{ type: 'image/png', kind: 'file', getAsFile: () => null }] },
    })
    act(() => {
      ta?.dispatchEvent(ev)
    })
    expect(ui.host.textContent).toContain('当前模型不支持图片')
  })
})
