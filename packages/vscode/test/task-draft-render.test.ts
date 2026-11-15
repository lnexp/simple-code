// @vitest-environment jsdom
// 「+ 任务」新任务状态（task-trunk.md 规则 13，2026-11-14 改为第一条消息即开）：
// 任务还没建，控件显示待开任务的选择、选了不发宿主，随第一条 task_create 带走
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

const MODELS = [
  { provider: 'p', model: 'alpha' },
  { provider: 'p', model: 'beta' },
]

/** 主任务切到了 beta、手动 low、值守「询问」、正在跑——新任务都不该跟它 */
const state: ToWebview = {
  type: 'state',
  running: true,
  folder: '/tmp/x',
  current: { provider: 'p', model: 'beta' },
  models: MODELS,
  effort: 'low',
  effortOverridden: true,
  presets: ['线路2'],
  attendance: 'attended',
  summaryInContext: true,
  imagesEnabled: false,
  contextWindow: 200,
  taskDraft: {
    model: { provider: 'p', model: 'alpha' },
    perModel: [
      { effort: 'high', presets: [], imagesEnabled: true, contextWindow: 100 },
      { effort: 'medium', presets: ['线路2'], imagesEnabled: false, contextWindow: 200 },
    ],
  },
}

function mount() {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: state }))
  })
  const button = (cls: string) => host.querySelector<HTMLButtonElement>(`button.${cls}`)
  const clickText = (text: string): void => {
    const b = [...host.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes(text))
    expect(b, `按钮「${text}」`).toBeTruthy()
    act(() => b?.click())
  }
  /** 开菜单点第 i 项 */
  const pick = (cls: string, i: number): void => {
    act(() => button(cls)?.click())
    const items = [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    act(() => items[i]?.click())
  }
  const ta = (): HTMLTextAreaElement => host.querySelector('textarea') as HTMLTextAreaElement
  const type = (text: string): void => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(ta(), text)
      ta().dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const enter = (init: KeyboardEventInit = {}): void => {
    act(() => {
      ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }))
    })
  }
  const text = (cls: string): string => button(cls)?.textContent ?? ''
  return { host, button, clickText, pick, type, enter, text }
}

describe('新任务状态的控件', () => {
  it('显示任务的默认（配置默认模型、它的配置档位、审批拒绝），不跟主任务；主任务在跑也能选、出发送键', () => {
    const app = mount()
    expect(app.text('model-picker')).toContain('beta') // 前提：主任务显示 beta
    app.clickText('+ 任务')
    expect(app.text('model-picker')).toContain('alpha')
    expect(app.text('effort-picker')).toContain('默认 · high')
    expect(app.text('approval-toggle')).toContain('拒绝')
    expect(app.button('preset-picker')).toBeNull() // alpha 没配预设
    expect(app.button('model-picker')?.disabled).toBe(false)
    expect(app.button('send-btn')?.classList.contains('is-stop')).toBe(false)
  })

  it('选模型/档位/预设/审批不发宿主；换模型撤掉档位覆盖、同模型换预设保留；随第一条带走', () => {
    const app = mount()
    app.clickText('+ 任务')
    app.pick('effort-picker', 4) // 默认 low medium high [xhigh] max
    expect(app.text('effort-picker')).toContain('xhigh')
    app.pick('model-picker', 1) // beta
    expect(app.text('effort-picker')).toContain('默认 · medium') // 换模型：覆盖撤掉，跟 beta 的配置
    app.pick('effort-picker', 5) // max
    app.pick('preset-picker', 1) // 线路2（同模型换预设）
    expect(app.text('effort-picker')).toContain('max')
    app.pick('approval-toggle', 2) // 放行
    expect(app.text('approval-toggle')).toContain('放行')
    expect(posted.filter((m) => /^set(Model|Effort|Attendance)$/.test(m.type))).toEqual([])
    app.type('查群聊\n细节')
    app.enter()
    expect(posted).toContainEqual({
      type: 'task_create',
      name: '查群聊\n细节',
      text: '查群聊\n细节',
      choice: { provider: 'p', model: 'beta', preset: '线路2', effort: 'max' },
      attendance: 'off',
    })
    // 发出即退出新任务状态，控件回到主任务
    expect(app.host.innerHTML).not.toContain('第一行作任务名称')
    expect(app.text('model-picker')).toContain('beta')
    expect(app.text('effort-picker')).toContain('low')
  })

  it('没动过选择：不带 choice（宿主走配置默认），审批带默认拒绝；取消后再进从默认起', () => {
    const app = mount()
    app.clickText('+ 任务')
    app.pick('model-picker', 1)
    app.clickText('取消（Esc）')
    app.clickText('+ 任务')
    expect(app.text('model-picker')).toContain('alpha')
    app.type('只说一句')
    app.enter()
    expect(posted.filter((m) => m.type === 'task_create')).toEqual([
      { type: 'task_create', name: '只说一句', text: '只说一句', attendance: 'unattended' },
    ])
  })

  it('带附件：附件拼在第一条消息前面，名字只取用户打的字', () => {
    const app = mount()
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'active_editor', editor: { path: '/tmp/x/a.ts' } },
        }),
      )
    })
    app.clickText('+ 任务')
    act(() => app.host.querySelector<HTMLButtonElement>('.cur-file')?.click())
    app.type('查群聊')
    app.enter()
    const create = posted.find((m) => m.type === 'task_create')
    expect(create).toMatchObject({ name: '查群聊' })
    expect(create && 'text' in create ? create.text : '').toMatch(/a\.ts[\s\S]*\n\n查群聊$/)
  })
})
