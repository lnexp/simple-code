import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getSession, type Request, type Session, type StreamEvent } from '@simple-code/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Bridge, createBridge, type SavedChoice } from '../src/bridge.ts'
import type { ToWebview } from '../src/protocol.ts'

const selected = { provider: 'q', model: 'selected-model', preset: 'route-b' }
const savedChoice: SavedChoice = { ...selected, effort: 'high' }
const roots: string[] = []
const bridges: Bridge[] = []
afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose()
  await new Promise<void>((done) => setImmediate(done))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const config = (available = true) => ({
  provider: 'p',
  model: 'default-model',
  providers: {
    p: {
      protocol: 'openai-responses',
      baseUrl: 'https://default.invalid',
      apiKey: 'test-only',
      models: { 'default-model': { contextWindow: 100_000, request: { effort: 'low' } } },
    },
    q: {
      protocol: 'openai-responses',
      baseUrl: 'https://selected.invalid',
      apiKey: 'test-only',
      models: available
        ? {
            'selected-model': {
              contextWindow: 200_000,
              presets: { 'route-b': { request: { effort: 'medium' } } },
            },
          }
        : {},
    },
  },
  memory: { idleSummarizeDelayMs: 0 },
})

async function* reply(request: Request, seen: Request[]): AsyncIterable<StreamEvent> {
  seen.push(structuredClone(request))
  yield { type: 'text_start' }
  yield { type: 'text_delta', text: 'ok' }
  yield { type: 'text_end' }
  yield {
    type: 'finish',
    reason: 'stop',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    },
  }
}

// 真实 core 负责模型/预设/档位；只替换网络，不落记忆库或读用户配置。
// 工厂、存档和界面共用闭包，保留完整装配以看清重建前提（测试工厂例外超过 50 行）。
async function harness() {
  const parent = resolve('.simple-code/tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'bridge-effort-'))
  roots.push(root)
  const globalPath = join(root, 'settings.json')
  await writeFile(globalPath, JSON.stringify(config()))
  let saved: SavedChoice | null = { ...savedChoice }
  const posted: ToWebview[] = []
  const made: Session[] = []
  const requests: Request[] = []
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('测试禁止访问网络'))
  const bridge = createBridge({
    post: (msg) => posted.push(msg),
    folder: root,
    session: async () => {
      const session = await getSession(root, {
        globalPath,
        ephemeral: true,
        skipLock: true,
        tools: [],
        fetchImpl,
        stream: (request) => reply(request, requests),
      })
      // 每次都是新建且仍为配置模型；不能复用已选模型的假 session 掩盖缺陷。
      expect(session.config.config.model).toBe('default-model')
      made.push(session)
      return session
    },
    taskSession: async () => {
      throw new Error('本用例不测试分支')
    },
    openExternal: async () => false,
    openFile: async () => {},
    savedChoice: () => saved,
    saveChoice: (choice) => {
      saved = choice
    },
    clearChoice: () => {
      saved = null
    },
  })
  bridges.push(bridge)
  const state = () =>
    posted
      .filter((msg): msg is Extract<ToWebview, { type: 'state' }> => msg.type === 'state')
      .at(-1)
  bridge.handle({ type: 'ready' })
  await vi.waitFor(() => expect(state()?.current).toEqual(selected))
  expect(made).toHaveLength(1)
  expect(state()?.effort).toBe('high')
  return { bridge, made, posted, requests, fetchImpl, globalPath, state, saved: () => saved }
}

describe('切推理档位保留已选模型与预设（真实 bridge + core）', () => {
  it('对照：未重建的 session 切 max 只改变档位', async () => {
    const h = await harness()
    h.bridge.handle({ type: 'setEffort', effort: 'max' })
    await vi.waitFor(() => expect(h.state()?.effort).toBe('max'))
    expect(h.made).toHaveLength(1)
    expect(h.state()?.current).toEqual(selected)
    expect(h.saved()).toEqual({ ...selected, effort: 'max' })
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })

  it.each(['max', 'low', null] as const)(
    '重建后首个动作切 %s：模型、预设、存档和下一请求一致',
    async (effort) => {
      const h = await harness()
      h.bridge.requestReload()
      // reload 后 UI 仍显示上次选择；切档前没有 send/ready 帮忙恢复。
      expect(h.state()?.current).toEqual(selected)
      h.bridge.handle({ type: 'setEffort', effort })
      await vi.waitFor(() => expect(h.state()?.effort).toBe(effort ?? 'medium'))
      expect(h.made).toHaveLength(2)
      expect(h.state()).toMatchObject({ current: selected, effortOverridden: effort !== null })
      expect(h.saved()).toEqual(effort === null ? selected : { ...selected, effort })
      expect(h.made[1]?.config.config).toMatchObject({ provider: 'q', model: 'selected-model' })
      expect(h.made[1]?.presetState().current).toBe('route-b')
      expect(h.made[1]?.effortState()).toEqual({
        effort: effort ?? 'medium',
        overridden: effort !== null,
      })

      h.bridge.handle({ type: 'send', text: '检查实际请求' })
      await vi.waitFor(() => {
        expect(h.requests).toHaveLength(1)
        expect(h.bridge.isRunning()).toBe(false)
      })
      expect(h.requests[0]).toMatchObject({ model: 'selected-model', effort: effort ?? 'medium' })
      expect(h.posted.filter((msg) => msg.type === 'fatal')).toEqual([])
      expect(h.fetchImpl).not.toHaveBeenCalled()
    },
  )

  it('重载后已选模型被删除：保留原有告警与清除失效选择的行为', async () => {
    const h = await harness()
    await writeFile(h.globalPath, JSON.stringify(config(false)))
    h.bridge.requestReload()
    h.bridge.handle({ type: 'setEffort', effort: 'max' })
    await vi.waitFor(() => expect(h.state()?.effort).toBe('max'))
    expect(h.made).toHaveLength(2)
    expect(h.posted.filter((msg) => msg.type === 'fatal')).toEqual([
      { type: 'fatal', message: expect.stringContaining('上次选的模型 q/selected-model 用不了') },
    ])
    expect(h.saved()).toEqual({ provider: 'p', model: 'default-model', effort: 'max' })
    h.bridge.handle({ type: 'setEffort', effort: 'low' })
    await vi.waitFor(() => expect(h.state()?.effort).toBe('low'))
    expect(h.posted.filter((msg) => msg.type === 'fatal')).toHaveLength(1)
    expect(h.fetchImpl).not.toHaveBeenCalled()
  })
})
