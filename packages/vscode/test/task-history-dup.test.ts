// @vitest-environment jsdom
/// <reference types="vscode" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSession,
  type LoopDeps,
  type StreamEvent,
  scopeOf,
  type Tool,
  type Usage,
} from '@simple-code/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { createBridge } from '../src/bridge.ts'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { createRouter, type Router } from '../src/router.ts'
import { App } from '../webview/App.tsx'

/**
 * 真机复现回归（2026-11-12 真项目 task-4yjq6c）：
 * CLI 派单（via agent）跑超 100 个 DB step 后，打开任务或切目录恢复选中时，
 * task_open 重推 task_hydrate 把在途 task_fetchHistory 的 loading 清回 false，
 * 引爆双链乒乓锁步拉取，每页各 prepend 两遍——任务书气泡出现两次。
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const dirs: string[] = []
let cleanup: (() => void) | null = null
let forwardToHost: ((msg: ToHost) => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
  forwardToHost = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const usage = (): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

const fakeBash: Tool = {
  name: 'bash',
  definition: { name: 'bash', description: 'fake bash', parameters: { type: 'object' } },
  execute: async (input) => ({
    output: `ok:${String((input as { command?: string }).command ?? '')}`,
    exitCode: 0,
    isError: false,
  }),
}

const callStep = (ids: string[]): StreamEvent[] => [
  ...ids.flatMap((id): StreamEvent[] => [
    { type: 'tool_input_start', id, name: 'bash' },
    {
      type: 'tool_input_end',
      id,
      name: 'bash',
      input: { desc: `命令 ${id}`, command: `echo ${id}` },
    },
  ]),
  { type: 'finish', reason: 'tool-calls', usage: usage() },
]

const textStep = (text: string): StreamEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
  { type: 'finish', reason: 'stop', usage: usage() },
]

function makeWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'sc-task-dup-'))
  dirs.push(base)
  const [rootA, rootB, home] = ['proj-a', 'simple-code', 'home'].map((n) => join(base, n))
  for (const d of [rootA, rootB, home]) mkdirSync(d!, { recursive: true })
  const globalPath = join(home!, 'settings.json')
  writeFileSync(
    globalPath,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      memory: { idleSummarizeDelayMs: 0 },
      providers: {
        p: {
          protocol: 'openai-chat',
          baseUrl: 'https://example.invalid',
          apiKey: 'sk-test',
          models: { m: { contextWindow: 200_000 } },
        },
      },
    }),
  )
  return { rootA: rootA!, rootB: rootB!, globalPath }
}

function stubLogLayout(host: HTMLElement, scrollHeight: number, clientHeight: number) {
  const el = host.querySelector<HTMLDivElement>('.log')
  if (!el) throw new Error('.log 未挂载')
  let top = 0
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight))
    },
  })
}

function createTestBridge(
  folder: string,
  globalPath: string,
  taskStream: LoopDeps['stream'],
  post: (msg: ToWebview) => void,
  onTurnEnd: () => void,
) {
  const mainStream: LoopDeps['stream'] = () =>
    (async function* () {
      for (const ev of textStep('主干收到')) yield ev
    })()
  return createBridge({
    folder,
    post,
    onTurnEnd,
    session: (requestApproval) =>
      getSession(folder, {
        globalPath,
        skipLock: true,
        tools: [fakeBash],
        stream: mainStream,
        requestApproval,
      }),
    taskSession: (manifest, requestApproval) =>
      getSession(folder, {
        globalPath,
        task: scopeOf(manifest),
        skipLock: true,
        tools: [fakeBash],
        stream: taskStream,
        requestApproval,
      }),
    openExternal: async () => true,
    openFile: async () => {},
    savedChoice: () => null,
    saveChoice: () => {},
    setTimer: () => () => {},
  })
}

function mountFullStack(opts: {
  rootA: string
  rootB: string
  globalPath: string
  taskStream: LoopDeps['stream']
}) {
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => ({
      postMessage: (msg: unknown) => setTimeout(() => forwardToHost?.(msg as ToHost), 0),
    }),
    configurable: true,
  })
  const router: Router = createRouter({
    post: (msg: ToWebview) =>
      setTimeout(() =>
        act(() => void window.dispatchEvent(new MessageEvent('message', { data: msg }))),
      ),
    folders: () => [opts.rootA, opts.rootB],
    saveFolder: () => {},
    createBridge: (f, post, onTurnEnd) =>
      createTestBridge(f, opts.globalPath, opts.taskStream, post, onTurnEnd),
  })
  forwardToHost = (msg) => router.handle(msg)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(App)))
  stubLogLayout(host, 600, 600)

  cleanup = () => {
    router.dispose()
    act(() => root.unmount())
    host.remove()
  }
  return { host, router }
}

const waitUntil = async (pred: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * 与真项目 turn 9885 同构的 127 个 DB step（窗口外 53 行 = 1*50 + 3）：
 * step 1 = user 任务书，step 2 = 并行 2 个 bash（「1 步 2 个操作」），
 * step 3..126 = 124 个单命令 step，step 127 = 末条回复（总计 126 个操作）
 */
function makeLongTaskStream(hangSecondTurn: Promise<void>): LoopDeps['stream'] {
  let callIdx = 0
  return () =>
    (async function* () {
      const n = ++callIdx
      if (n === 1) {
        for (const ev of callStep(['t0a', 't0b'])) yield ev
        return
      }
      if (n <= 125) {
        for (const ev of callStep([`t${n}`])) yield ev
        return
      }
      if (n === 126) {
        for (const ev of textStep('全部实现并通过验证。')) yield ev
        return
      }
      yield { type: 'text_start' }
      yield { type: 'text_delta', text: '正在本地启动验证…' }
      await hangSecondTurn
      yield { type: 'text_end' }
      yield { type: 'finish', reason: 'stop', usage: usage() }
    })()
}

describe('任务视图长轮窗口化分页不重复（真项目真机复现）', () => {
  it('via agent 派单跑超 100 步 → 点开翻到底 + 多根切回 + 第二轮跑中：任务书只出一次', async () => {
    let releaseSecond!: () => void
    const hangSecond = new Promise<void>((r) => {
      releaseSecond = r
    })
    const { rootA, rootB, globalPath } = makeWorkspace()
    const { host, router } = mountFullStack({
      rootA,
      rootB,
      globalPath,
      taskStream: makeLongTaskStream(hangSecond),
    })

    await waitUntil(() => host.querySelector('.folder-head') !== null)
    const brief = '大知识库跳过摘要与glob工具·实现\n请按方案实现并跑通测试。'
    const dispatched = await router.dispatchFromAgent({ root: rootA, brief, owner: '' })
    expect(dispatched).toEqual({ ok: true, name: '大知识库跳过摘要与glob工具·实现' })
    await waitUntil(() => host.querySelector('.branch-strip .task-close') !== null)

    // 路径 1：点击任务 tab（触发 setBranch + task_open 与自动触顶分页并发）
    act(() => host.querySelector<HTMLButtonElement>('.branch-strip .branch-open')!.click())
    await waitUntil(() => host.textContent?.includes('没有更早的了') ?? false)
    await new Promise((r) => setTimeout(r, 60))

    const users = Array.from(host.querySelectorAll('.user')).map((e) => e.textContent ?? '')
    expect(users.some((t) => t.includes('你是一个独立任务'))).toBe(true)
    expect(users).toHaveLength(1)
    const heads = Array.from(host.querySelectorAll('.process-head')).map((e) => e.textContent ?? '')
    expect(heads).toHaveLength(1)
    expect(heads[0]).toContain('126 个操作')

    // 路径 2：多根切去 rootB 再切回 rootA（rehydrate + restoreBranch 的 task_open 双基线竞争）
    router.handle({ type: 'switchFolder', folder: rootB })
    await waitUntil(() => !host.textContent?.includes('你是一个独立任务'))
    router.handle({ type: 'switchFolder', folder: rootA })
    await waitUntil(() => host.textContent?.includes('没有更早的了') ?? false)
    await new Promise((r) => setTimeout(r, 60))
    expect(host.querySelectorAll('.user')).toHaveLength(1)

    // 路径 3：第二轮用户追问跑中（对齐真机 turn 9892 运行态截图）
    router.handle({
      type: 'task_send',
      task: '大知识库跳过摘要与glob工具·实现',
      text: 'DEV我已经执行了，你来本地启动验证下吧',
    })
    await waitUntil(() => host.textContent?.includes('正在本地启动验证') ?? false)
    const taskBriefs = Array.from(host.querySelectorAll('.user')).filter((e) =>
      e.textContent?.includes('你是一个独立任务'),
    )
    expect(taskBriefs).toHaveLength(1)

    releaseSecond()
    await waitUntil(() => host.querySelector('.branch-strip .task-close') !== null)
  })
})
