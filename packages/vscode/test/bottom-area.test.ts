// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'
import { STYLE } from '../src/style.ts'
import { App } from '../webview/App.tsx'

/**
 * 底部区域（进程条 / 任务条 / 输入框 / 底栏）2026-10-29 改版：
 * 进程条行内不出原命令（悬停 title 看）；任务条只有当前 tab 选中、
 * 关闭键是 ×；「上下文」「记忆」两个字可在窄侧栏让掉；输入框把底栏包进框里。
 * 像素与窄宽表现靠真构建夹具截图验，这里守 DOM 结构与关键选择器。
 */

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mount() {
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => ({ postMessage: () => {} }),
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

const F = '/w/a'
const state: ToWebview = {
  type: 'state',
  running: false,
  folder: F,
  current: { provider: 'p', model: 'm1' },
  models: [{ provider: 'p', model: 'm1' }],
  effort: 'high',
  effortOverridden: false,
  presets: [],
  approvalOn: true,
  imagesEnabled: false,
  contextWindow: 0,
}

describe('进程条：原命令不在行内，悬停看', () => {
  it('行内只有 desc 与进程数，命令在整行的 title 里', () => {
    const app = mount()
    app.send(state)
    app.send({
      type: 'bg_processes',
      folder: F,
      items: [
        {
          pgid: 42,
          pids: [42, 43],
          label: '起服务',
          command: 'python3 -m http.server 8123',
          startedAt: 1,
        },
      ],
    })
    const row = app.host.querySelector('.bg-item')
    expect(row?.textContent).toContain('起服务')
    expect(row?.textContent).toContain('2 个进程')
    expect(row?.textContent).not.toContain('http.server')
    expect(row?.querySelector('.bg-cmd')).toBeNull()
    expect(row?.getAttribute('title')).toContain('python3 -m http.server 8123')
    expect(row?.getAttribute('title')).toContain('pid 42 43')
  })
})

describe('任务条', () => {
  it('只有当前 tab 是 data-active="true"；样式只认 =true（false 也是属性，判存在会全选中）', () => {
    const app = mount()
    app.send(state)
    app.send({
      type: 'tasks',
      folder: F,
      tasks: [
        {
          name: '调研',
          status: 'idle',
          lastText: '',
          current: null,
          effort: null,
          effortOverridden: false,
          contextWindow: 0,
          approvalOn: true,
          presets: [],
          imagesEnabled: false,
        },
      ],
    })
    const tabs = [...app.host.querySelectorAll('.branch-strip .branch-tab')]
    expect(tabs.map((t) => t.getAttribute('data-active'))).toEqual(['true', 'false'])
    expect(STYLE).toMatch(/\.branch-tab\[data-active='true'\]\s*\{/)
    expect(STYLE).not.toMatch(/\.branch-tab\[data-active\]\s*\{/)
    // 关闭键与进程条的结束键同为 ×，文字说明在 aria-label/title
    const close = app.host.querySelector('.task-close')
    expect(close?.textContent).toBe('×')
    expect(close?.getAttribute('aria-label')).toBe('关闭任务')
  })
})

describe('底栏与输入框', () => {
  it('「上下文」「记忆」两个字单独包在 .bar-word 里，数字和图标不在里面', () => {
    const app = mount()
    app.send(state)
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
        contextTokens: 1234,
      },
      at: 1,
    })
    const words = [...app.host.querySelectorAll('.bar .bar-word')].map((e) => e.textContent?.trim())
    expect(words).toEqual(['上下文', '记忆'])
    const ctx = app.host.querySelector('.usage-ctx[title="上下文分区分析"]')
    expect(ctx?.textContent).toContain('1.2k')
    expect(ctx?.querySelector('.bar-word')?.textContent).not.toContain('1.2k')
  })

  it('样式：框画在 .composer 上，textarea 无框；窄宽依次让掉耗时统计与两个字', () => {
    const rule = (sel: string): string => {
      const i = STYLE.indexOf(`\n${sel} {`)
      expect(i, sel).toBeGreaterThan(-1)
      return STYLE.slice(i, STYLE.indexOf('}', i))
    }
    expect(rule('.composer')).toContain('border: 1px solid var(--vscode-input-border')
    expect(rule('.composer textarea')).toContain('border: none')
    expect(STYLE).toContain(
      '.composer:has(textarea:focus) { border-color: var(--vscode-focusBorder); }',
    )
    expect(STYLE).toContain('@media (max-width: 634px) { .usage { display: none; } }')
    expect(STYLE).toContain('@media (min-width: 635px) { .bar-right { flex-shrink: 0; } }')
    expect(STYLE).toContain('@media (max-width: 520px) { .bar-word { display: none; } }')
  })
})
