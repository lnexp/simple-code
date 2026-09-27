// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 多根切换 = 清空重取（用户拍板，桶方案已删）：
 * webview 是无状态投影，宿主 bridge.attach 推 hydrate + bg 清单 +
 * 待处理审批卡。这里的用例从最外层驱动（真 postMessage），模拟宿主
 * attach 时该推的消息，断言三条：切走清空、切回重推后恢复、别的
 * 目录的 bg/审批快照不进当前界面（彻底隔离）。
 */

let cleanup: (() => void) | null = null
/** 外发消息的捕获桩（切回恢复要断言 task_open 补基线） */
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
    html: () => host.innerHTML,
  }
}

const A = '/w/a'
const B = '/w/b'

const state = (folder: string, running = false): ToWebview => ({
  type: 'state',
  running,
  folder,
  current: { provider: 'p', model: 'm1' },
  models: [{ provider: 'p', model: 'm1' }],
  effort: 'high',
  effortOverridden: false,
      presets: [],
  approvalOn: true,
  imagesEnabled: false,
  contextWindow: 0,
})

const folders = (active: string): ToWebview => ({
  type: 'folders',
  active,
  folders: [
    { path: A, running: false, pendingApprovals: 0 },
    { path: B, running: false, pendingApprovals: 0 },
  ],
})

/** 宿主 attach 的标准三连：hydrate（镜像带真钟）+ bg 清单 + state */
const attach = (
  app: ReturnType<typeof mount>,
  folder: string,
  items: unknown[],
  running = false,
): void => {
  // 顺序对齐真实宿主：attach 同步先 pushState，warmUp 异步再 hydrate/bg。
  // 反过来的话 state 的 swapFolder 会把 hydrate 的内容当旧目录清掉
  app.send(state(folder, running))
  app.send({ type: 'hydrate', items: items as never })
  app.send(state(folder, running))
  app.send({ type: 'bg_processes', folder, items: [] })
}

describe('切换瞬间视图换血（清空重取）', () => {
  it('切到 B，A 的消息立即消失；切回 A 由 hydrate 重推恢复', () => {
    const app = mount()
    app.send(state(A))
    attach(app, A, [{ kind: 'user', text: 'A 目录的独白' }])
    expect(app.html()).toContain('A 目录的独白')

    app.send(folders(B))
    expect(app.html()).not.toContain('A 目录的独白')

    // 宿主重推（切回 A 的 attach）——内容回来
    attach(app, A, [{ kind: 'user', text: 'A 目录的独白' }])
    expect(app.html()).toContain('A 目录的独白')
  })
})

describe('秒表起点随事件走（④：镜像重放带真钟，不靠 webview 继承）', () => {
  it('hydrate 里进行中的 bash 行带真实 startedAt，切回后秒表起点不归零', () => {
    const app = mount()
    app.send(state(A))
    // 镜像重放产的行：startedAt = 事件到达宿主的钟（这里给 1，判据是
    // 「有值且被保留」，不是具体数字）
    attach(
      app,
      A,
      [
      { kind: 'user', text: '跑个 sleep' },
      { kind: 'tool', id: 't1', name: 'bash', command: 'sleep 30', output: '', failed: false, startedAt: Date.now() - 5000 },
      ],
      true,
    )
    expect(app.html()).toContain('sleep 30')
    expect(app.html()).toContain('tool-row')

    app.send(folders(B))
    expect(app.html()).not.toContain('sleep 30')
    attach(
      app,
      A,
      [
      { kind: 'user', text: '跑个 sleep' },
      { kind: 'tool', id: 't1', name: 'bash', command: 'sleep 30', output: '', failed: false, startedAt: Date.now() - 5000 },
      ],
      true,
    )
    // 秒表行的 startedAt 原样保留（hydrate 全量替换，钟是宿主给的）
    expect(app.html()).toContain('sleep 30')
  })
})

describe('上下文水位随镜像回来（③：水位是 ChatView 字段，不在 items 里）', () => {
  it('切走再切回，底栏水位还在——hydrate 带 contextTokens', () => {
    const app = mount()
    app.send(state(A))
    // attach 带 52k 水位（镜像 step_finish 记的）
    app.send({ type: 'hydrate', items: [], contextTokens: 52000 })
    app.send(state(A))
    expect(app.html()).toContain('52k')

    app.send(folders(B))
    expect(app.html()).not.toContain('52k')

    app.send(folders(A))
    app.send({ type: 'hydrate', items: [], contextTokens: 52000 })
    app.send(state(A))
    expect(app.html()).toContain('52k')
  })
})

describe('页脚随镜像回来（切回后「用了什么模型·多长时间」还在）', () => {
  it('hydrate 的最后一条 assistant 带 model/elapsedMs，切走切回不丢', () => {
    const app = mount()
    app.send(state(A))
    app.send({
      type: 'hydrate',
      items: [
        { kind: 'user', text: '问' },
        { kind: 'assistant', text: '答', model: 'm1', finishedAt: 100, elapsedMs: 2500 },
      ],
    })
    app.send(state(A))
    expect(app.html()).toContain('m1')
    expect(app.html()).toContain('2.5s') // formatElapsed(2500)

    app.send(folders(B))
    // 注意不能用 m1 做否定断言——模型选择器的 trigger-label 也显示它
    expect(app.html()).not.toContain('2.5s')

    app.send(folders(A))
    app.send({
      type: 'hydrate',
      items: [
        { kind: 'user', text: '问' },
        { kind: 'assistant', text: '答', model: 'm1', finishedAt: 100, elapsedMs: 2500 },
      ],
    })
    app.send(state(A))
    expect(app.html()).toContain('m1')
  })
})

describe('后台进程条按目录隔离（用户拍板：互不干扰）', () => {
  it('A 的进程只在 A 显示；B 的快照不进 A 的界面；切回 A 由 attach 重推', () => {
    const app = mount()
    app.send(state(A))
    app.send({ type: 'bg_processes', folder: A, items: [{ pid: 42, command: 'python http.server 8123', startedAt: 1 }] })
    expect(app.html()).toContain('http.server')

    // 切到 B：A 的进程条不跟来（切走即清）
    app.send(folders(B))
    expect(app.html()).not.toContain('http.server')

    // B 的快照进 B 界面；A 的不顶账（现在没有桶，只有当前清单）
    app.send({ type: 'bg_processes', folder: B, items: [{ pid: 7, command: 'vitest watch', startedAt: 2 }] })
    expect(app.html()).toContain('vitest watch')
    expect(app.html()).not.toContain('http.server')

    // 切回 A：attach 重推 A 的清单（不是桶恢复）
    app.send(folders(A))
    expect(app.html()).not.toContain('http.server') // 清了，等 attach
    app.send({ type: 'bg_processes', folder: A, items: [{ pid: 42, command: 'python http.server 8123', startedAt: 1 }] })
    expect(app.html()).toContain('http.server')
    expect(app.html()).not.toContain('vitest watch')
  })

  it('后台目录的审批卡不进当前界面（彻底隔离），切回时由 attach 重推', () => {
    const app = mount()
    app.send(state(A))
    // 审批卡渲染在 ActivityGroup（tool 组块）里，先铺一条 tool 行做挂载点
    attach(
      app,
      A,
      [
        { kind: 'user', text: '问' },
        { kind: 'tool', id: 't1', name: 'bash', command: 'echo hi', output: 'hi', failed: false, startedAt: 1, endedAt: 2 },
      ],
      true,
    )
    // B 目录弹的卡（router 注入 folder=B）：A 界面不显示
    app.send({
      type: 'approval_request',
      expiresAt: 1,
      folder: B,
      id: 1,
      command: 'rm /tmp/x',
      toolCallId: 't1',
      category: 'external_dir',
      detail: '/tmp/x',
      reason: '项目外',
    })
    expect(app.html()).not.toContain('rm /tmp/x')

    // A 自己的卡正常显示
    app.send({
      type: 'approval_request',
      expiresAt: 1,
      folder: A,
      id: 1,
      command: 'rm /w/a/y',
      toolCallId: 't1',
      category: 'external_dir',
      detail: '/w/a/y',
      reason: '项目外',
    })
    expect(app.html()).toContain('rm /w/a/y')
  })
})

describe('切目录同批消息的守卫（2026-09-23 真机：分支条偶发消失）', () => {
  it('folders+state+tasks 同一批到达（无渲染间隔）：tasks 用新目录，分支条不丢', () => {
    const app = mount()
    app.send(state(A))
    // 切到 B：宿主 switchTo 的真实时序是 postFolders → attach 的 state →
    // tasks.rehydrate，三条消息背靠背到达——中间没有 React flush 的机会
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: folders(B) }))
      window.dispatchEvent(new MessageEvent('message', { data: state(B) }))
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'tasks',
            folder: B,
            limit: 3,
            tasks: [
              {
                name: '调研分支',
                status: 'idle',
                lastText: '做完了',
                current: null,
                effort: null,
                effortOverridden: false,
                contextWindow: 0,
                approvalOn: true,
              },
            ],
          },
        }),
      )
    })
    // 修复前：tasks 守卫读旧目录 A，快照被丢，分支条只剩「主干」
    expect(app.html()).toContain('调研分支')
  })
})

describe('切目录恢复任务选中（B 方案：lastBranch 按目录记选中）', () => {
  const taskState = (name: string) => ({
    name,
    status: 'idle' as const,
    lastText: '',
    current: null,
    effort: null,
    effortOverridden: false,
    contextWindow: 0,
    approvalOn: true,
  })
  const tasksMsg = (folder: string, names: string[]): ToWebview =>
    ({ type: 'tasks', folder, limit: 3, tasks: names.map(taskState) })

  /** 点分支条选中任务——同真实交互（click → setBranch + task_open 补基线） */
  const select = (name: string): void => {
    const btn = document.querySelector('.branch-strip .branch-open')
    expect(btn).not.toBeNull()
    act(() => btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('A 里选中的任务，切到 B 落主任务，切回 A 恢复选中并补 task_open 基线', () => {
    const app = mount()
    app.send(state(A))
    app.send(tasksMsg(A, ['调研分支']))
    app.send(state(A))
    select('调研分支')
    expect(app.html()).toContain('调研分支')
    // 点击本身就该发一次 task_open（选中即补基线）
    expect(sent.filter((m) => m.type === 'task_open')).toEqual([{ type: 'task_open', task: '调研分支' }])

    // 切到 B：落主任务（B 没记过选中）
    app.send(folders(B))
    const tabsB = document.querySelectorAll('.branch-strip .branch-tab')
    expect(tabsB[0]?.getAttribute('data-active')).toBe('true')

    // 切回 A：选中立即恢复（不等快照），快照到了再补一次基线（幂等）
    app.send(folders(A))
    const tabsA = document.querySelectorAll('.branch-strip .branch-tab')
    expect(tabsA[0]?.getAttribute('data-active')).toBe('false')
    app.send(state(A))
    sent.length = 0
    app.send(tasksMsg(A, ['调研分支']))
    expect(sent).toContainEqual({ type: 'task_open', task: '调研分支' })
  })

  it('离开期间任务被关闭——切回不选中、不发 task_open，落主任务', () => {
    const app = mount()
    app.send(state(A))
    app.send(tasksMsg(A, ['调研分支']))
    app.send(state(A))
    select('调研分支')
    expect(app.html()).toContain('调研分支')

    app.send(folders(B))
    app.send(state(B))
    // 离开期间「调研分支」被关掉：切回时的快照里没有它
    app.send(folders(A))
    app.send(state(A))
    sent.length = 0
    app.send(tasksMsg(A, []))
    expect(sent.filter((m) => m.type === 'task_open')).toEqual([])
    // 主任务 tab 激活（任务已被关闭，选中作废）
    const tabs = document.querySelectorAll('.branch-strip .branch-tab')
    expect(tabs[0]?.getAttribute('data-active')).toBe('true')
  })
})
