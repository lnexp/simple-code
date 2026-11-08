// @vitest-environment jsdom
// 任务条上的待审批角标（2026-10-31）：目录 tab 有数字角标，进了目录却看不出
// 是主任务还是哪个分身在等——卡只画在发起它的那个视图里（toolCallId 对上
// 的命令行下），看着别的任务时哪儿都没有，5 分钟无人答复就自动 deny。
// 从最外层驱动：发真的 postMessage，读真的 DOM
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'

vi.mock('../webview/vscode.ts', () => ({ post: vi.fn() }))

const FOLDER = '/tmp/x'
const feed = (msg: ToWebview): void => {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }))
  })
}

const state: ToWebview = {
  type: 'state',
  running: true,
  folder: FOLDER,
  current: null,
  models: [],
  effort: null,
  effortOverridden: false,
  presets: [],
  imagesEnabled: true,
  attendance: 'attended',
  contextWindow: 256000,
}

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
  attendance: 'attended',
})

const card = (id: number, task?: string, folder = FOLDER): ToWebview => ({
  type: 'approval_request',
  folder,
  expiresAt: Date.now() + 300_000,
  id,
  toolCallId: `c${id}`,
  command: `cat .env.${id}`,
  category: 'external_dir',
  detail: '.env',
  reason: '要读项目外路径：/tmp/x/.env',
  ...(task === undefined ? {} : { task }),
})

/** 每个任务 tab 的角标数字；没有角标 = '' */
const badges = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll('.branch-strip .branch-tab')].map((tab) => {
      const label =
        tab.querySelector('.branch-open')?.textContent ??
        tab.textContent?.replace(/\d+$/, '').trim()
      return [label ?? '?', tab.querySelector('.tab-badge')?.textContent ?? '']
    }),
  )

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe('任务条上的待审批角标', () => {
  it('标在发卡的那个任务上，主任务的卡标在主任务上；答复/关卡后数字跟着减', async () => {
    const { App } = await import('../webview/App.tsx')
    const div = document.createElement('div')
    document.body.appendChild(div)
    const root = createRoot(div)
    act(() => root.render(React.createElement(App)))
    cleanup = () => {
      act(() => root.unmount())
      div.remove()
    }
    feed(state)
    feed({ type: 'tasks', folder: FOLDER, tasks: [taskState('长活'), taskState('短活')] })
    expect(badges()).toEqual({ 主任务: '', 长活: '', 短活: '' })

    // 看着主任务，分身弹卡：卡不在当前视图，角标是唯一信号
    feed(card(1, '长活'))
    feed(card(2, '长活'))
    expect(badges()).toEqual({ 主任务: '', 长活: '2', 短活: '' })

    feed(card(3))
    expect(badges()).toEqual({ 主任务: '1', 长活: '2', 短活: '' })

    feed({ type: 'approval_closed', id: 1, folder: FOLDER })
    expect(badges()).toEqual({ 主任务: '1', 长活: '1', 短活: '' })

    // 别的目录的卡不进本目录（彻底隔离），也不算进角标
    feed(card(4, '短活', '/tmp/other'))
    expect(badges()).toEqual({ 主任务: '1', 长活: '1', 短活: '' })
  })
})
