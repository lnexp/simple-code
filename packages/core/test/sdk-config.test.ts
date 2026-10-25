import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadConfig, selectModel } from '../src/config/load.ts'
import { stripDenied } from '../src/config/denylist.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
const config = () => ({
  provider: 'p',
  model: 'm',
  claudeAgentSdkPath: '/external/sdk',
  memory: { summaryModel: 'summary' },
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'sentinel',
      models: {
        m: {
          contextWindow: 10000,
          claudeAgentSdk: true,
          presets: { http: { claudeAgentSdk: false } },
        },
        summary: { contextWindow: 10000 },
      },
    },
  },
})
async function load(value: unknown) {
  await mkdir(resolve('.simple-code/tmp'), { recursive: true })
  const dir = await mkdtemp(resolve('.simple-code/tmp/sdk-config-'))
  dirs.push(dir)
  await mkdir(join(dir, 'ws'), { recursive: true })
  const globalPath = join(dir, 'global.json')
  await writeFile(globalPath, JSON.stringify(value))
  return loadConfig(join(dir, 'ws'), { globalPath, env: {} })
}
it('模型启用，preset可关闭，不改变摘要模型', async () => {
  const loaded = await load(config())
  expect(loaded.model.claudeAgentSdk).toBe(true)
  const next = selectModel(loaded, { provider: 'p', model: 'm', preset: 'http' }, {})
  expect(next.model.claudeAgentSdk).toBe(false)
  expect(next.summary.name).toBe('summary')
  expect(next.summary.model.claudeAgentSdk).not.toBe(true)
})
it('所有SDK配置只认用户级', () => {
  const value = config()
  const result = stripDenied(value)
  expect(result.stripped).toEqual(
    expect.arrayContaining([
      'claudeAgentSdkPath',
      'providers.p.models.m.claudeAgentSdk',
      'providers.p.models.m.presets.http.claudeAgentSdk',
    ]),
  )
})
it('启用但缺路径时报错', async () => {
  const { claudeAgentSdkPath: _, ...value } = config()
  await expect(load(value)).rejects.toThrow('claudeAgentSdkPath')
})
it('SDK主模型不能兼任默认摘要模型', async () => {
  const { memory: _, ...value } = config()
  await expect(load(value)).rejects.toThrow('memory.summaryModel')
})
it('副模型不能配置SDK', async () => {
  const value = config()
  value.memory.summaryModel = 'm'
  await expect(load(value)).rejects.toThrow('不支持')
})
it('SDK不接受其他协议', async () => {
  const value = config()
  value.providers.p.protocol = 'openai-chat'
  await expect(load(value)).rejects.toThrow('anthropic-messages')
})

it.skipIf(process.platform !== 'darwin')(
  '普通HTTP保持原fetch注入，SDK禁止remote且不会提前加载包',
  async () => {
    const { modelFetch } = await import('../src/session/model-fetch.ts')
    const loaded = await load(config())
    expect(() => modelFetch(loaded, { folder: dirs[0]!, remote: true })).toThrow('Remote')
    const http = selectModel(loaded, { provider: 'p', model: 'm', preset: 'http' }, {})
    const fetchImpl = (() => {
      throw Error('not called')
    }) as unknown as typeof fetch
    expect(modelFetch(http, { folder: dirs[0]!, fetchImpl, remote: true })).toBe(
      fetchImpl,
    )
    expect(typeof modelFetch(loaded, { folder: dirs[0]! })).toBe('function')
  },
)

it.skipIf(process.platform !== 'darwin')(
  '会话切换使用当前适配配置，拒绝remote且不改变旧选择',
  async () => {
    const { getSession } = await import('../src/session/session.ts')
    const value = config()
    value.model = 'summary'
    await load(value)
    const folder = dirs.at(-1)!
    const session = await getSession(join(folder, 'ws'), {
      globalPath: join(folder, 'global.json'),
      env: {},
      ephemeral: true,
      skipLock: true,
      remote: true,
    })
    try {
      expect(() => session.setModel({ provider: 'p', model: 'm' })).toThrow('Remote')
      expect(session.config.config.model).toBe('summary')
      session.setModel({ provider: 'p', model: 'm', preset: 'http' })
      expect(session.config.model.claudeAgentSdk).toBe(false)
    } finally {
      session.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin').each(['m', 'summary'])(
  '任务可以从 %s 建立会话并切换SDK模型/preset，不改变摘要模型',
  async (initialModel) => {
    const { getSession } = await import('../src/session/session.ts')
    const { forkTask, scopeOf } = await import('../src/session/task.ts')
    const value = config()
    value.model = initialModel
    await load(value)
    const folder = dirs.at(-1)!
    const ws = join(folder, 'ws')
    const task = scopeOf(forkTask(ws, 'SDK测试'))
    const session = await getSession(ws, {
      globalPath: join(folder, 'global.json'),
      env: {},
      ephemeral: true,
      skipLock: true,
      task,
    })
    try {
      expect(session.config.config.model).toBe(initialModel)
      session.setModel({ provider: 'p', model: 'm' })
      expect(session.config.model.claudeAgentSdk).toBe(true)
      expect(session.config.summary.name).toBe('summary')
      expect(session.config.summary.model.claudeAgentSdk).not.toBe(true)
      session.setModel({ provider: 'p', model: 'm', preset: 'http' })
      expect(session.config.model.claudeAgentSdk).toBe(false)
      session.setModel({ provider: 'p', model: 'm' })
      expect(session.config.model.claudeAgentSdk).toBe(true)
    } finally {
      session.close()
    }
  },
)

it('工作区新增preset不能间接启用SDK', async () => {
  const value = config()
  await load(value)
  const dir = dirs.at(-1)!
  await mkdir(join(dir, 'ws/.simple-code'), { recursive: true })
  await writeFile(
    join(dir, 'ws/.simple-code/settings.json'),
    JSON.stringify({
      claudeAgentSdkPath: '/malicious',
      providers: {
        p: {
          models: { m: { claudeAgentSdk: false, presets: { unsafe: { claudeAgentSdk: true } } } },
        },
      },
    }),
  )
  const loaded = await loadConfig(join(dir, 'ws'), {
    globalPath: join(dir, 'global.json'),
    env: {},
  })
  expect(loaded.config.claudeAgentSdkPath).toBe('/external/sdk')
  expect(loaded.model.claudeAgentSdk).toBe(true)
  expect(loaded.model.presets.unsafe?.claudeAgentSdk).toBeUndefined()
  expect(loaded.warnings).toHaveLength(3)
})
