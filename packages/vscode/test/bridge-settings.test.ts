import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@simple-code/core'
import { logRun, MissingConfigError } from '@simple-code/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../src/bridge.ts'
import type { GatewayCheck, ToHost, ToWebview } from '../src/protocol.ts'

vi.mock('@simple-code/core', async (original) => ({
  ...(await original<typeof import('@simple-code/core')>()),
  logRun: vi.fn(),
}))

/**
 * 设置页在 bridge 上的接线：settings_get / settings_write / 首开分支
 * （缺配置时 attach 不再 fatal，推 settings_view.missing）。文件读写走
 * 真的临时目录——jsonc 写回在 core 有单测，这里只验桥接对了路径、回了
 * 对的消息、state.models 跟着新配置走。
 */

let dir = ''
let path = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'simple-code-bridge-settings-'))
  path = join(dir, 'settings.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const SAMPLE = {
  provider: 'p',
  model: 'm1',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.test',
      apiKey: '${MY_KEY}',
      models: {
        m1: { contextWindow: 200_000 },
        m2: { contextWindow: 128_000, capabilities: { images: true } },
      },
    },
  },
  memory: { idleSummarizeDelayMs: 0 },
}

/** 覆盖 attach（ready 握手）会碰到的 session 面——够推 hydrate/state 就行 */
const fakeSession = (): Session =>
  ({
    root: '/tmp/x',
    memoryRoot: dir,
    owner: null,
    config: {
      config: SAMPLE,
      model: { capabilities: { images: false }, contextWindow: 200_000 },
      vision: null,
    },
    defaultModel: { provider: 'p', model: 'm1' },
    setModel: vi.fn(),
    setEffort: vi.fn(),
    effortState: () => ({ effort: 'high' as const, overridden: false }),
    presetState: () => ({ current: undefined, available: [] }),
    interrupt: vi.fn(),
    close: vi.fn(async () => {}),
    messages: () => [],
    historyRowsWindowed: () => ({ rows: [], floor: null }),
    fold: () => {},
    bgSnapshot: () => [],
    summarizeIdle: vi.fn(async () => {}),
  }) as unknown as Session

function harness(
  sessionFactory?: () => Promise<Session>,
  gatewayPush?: { read: () => boolean | null; write: (on: boolean) => void },
  gatewayLark?: { path: () => string | null; check: () => Promise<GatewayCheck> },
  robot?: {
    mac: boolean
    installed: () => boolean
    read: () => boolean
    toggle: (on: boolean) => Promise<void>
    install: () => Promise<void>
  },
) {
  const posted: ToWebview[] = []
  const openedFiles: string[] = []
  const bridge = createBridge({
    post: (msg) => posted.push(msg),
    session: sessionFactory ?? (async () => fakeSession()),
    taskSession: async () => fakeSession(),
    folder: '/tmp/x',
    openExternal: async () => true,
    openFile: async (p) => {
      openedFiles.push(p)
    },
    savedChoice: () => null,
    saveChoice: () => {},
    clearChoice: () => {},
    settingsPath: async () => path,
    ...(gatewayPush ? { gatewayPush } : {}),
    ...(gatewayLark ? { gatewayLark } : {}),
    ...(robot ? { robot } : {}),
  })
  const handle = (msg: ToHost): void => bridge.handle(msg)
  const waitFor = async (pred: (msg: ToWebview) => boolean, ms = 1000): Promise<void> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (posted.some(pred)) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`等不到预期的消息（已到：${posted.map((m) => m.type).join(',')}）`)
  }
  return { bridge, posted, openedFiles, handle, waitFor }
}

describe('bridge / 设置页接线', () => {
  it('飞书推送：settings_get 随带 gateway_push；没接 = null；set 只认布尔、写完回读', async () => {
    await writeFile(path, JSON.stringify(SAMPLE))
    const bare = harness()
    bare.handle({ type: 'ready' })
    await bare.waitFor((m) => m.type === 'hydrate')
    bare.handle({ type: 'settings_get' })
    await bare.waitFor((m) => m.type === 'gateway_push')
    expect(bare.posted.find((m) => m.type === 'gateway_push')).toEqual({
      type: 'gateway_push',
      on: null,
      larkCli: null,
    })
    let stored = true
    const writes: boolean[] = []
    const t = harness(undefined, {
      read: () => stored,
      write: (on) => {
        writes.push(on)
        stored = on
      },
    })
    t.handle({ type: 'ready' })
    await t.waitFor((m) => m.type === 'hydrate')
    t.handle({ type: 'settings_get' })
    await t.waitFor((m) => m.type === 'gateway_push')
    expect(t.posted.filter((m) => m.type === 'gateway_push').at(-1)).toEqual({
      type: 'gateway_push',
      on: true,
      larkCli: null,
    })
    t.handle({ type: 'gateway_push_set', on: false })
    expect(writes).toEqual([false])
    expect(t.posted.at(-1)).toEqual({ type: 'gateway_push', on: false, larkCli: null })
    // 不可信面送来非布尔：不写，只回当前值
    t.handle({ type: 'gateway_push_set', on: 'off' } as unknown as ToHost)
    expect(writes).toEqual([false])
    expect(t.posted.at(-1)).toEqual({ type: 'gateway_push', on: false, larkCli: null })
  })

  it('桌面机器人：settings_get 随带 robot_state；toggle/install 转发后回读一次', async () => {
    await writeFile(path, JSON.stringify(SAMPLE))
    const bare = harness()
    bare.handle({ type: 'ready' })
    await bare.waitFor((m) => m.type === 'hydrate')
    bare.handle({ type: 'settings_get' })
    await bare.waitFor((m) => m.type === 'robot_state')
    // 没接 robot（测试、非 mac 宿主）：mac=false，界面据此不显示分区
    expect(bare.posted.find((m) => m.type === 'robot_state')).toEqual({
      type: 'robot_state',
      mac: false,
      installed: false,
      on: true,
    })
    let on = true
    const toggles: boolean[] = []
    let installs = 0
    const t = harness(undefined, undefined, undefined, {
      mac: true,
      installed: () => true,
      read: () => on,
      toggle: async (v) => {
        toggles.push(v)
        on = v
      },
      install: async () => {
        installs += 1
      },
    })
    t.handle({ type: 'ready' })
    await t.waitFor((m) => m.type === 'hydrate')
    t.handle({ type: 'settings_get' })
    await t.waitFor((m) => m.type === 'robot_state')
    expect(t.posted.filter((m) => m.type === 'robot_state').at(-1)).toEqual({
      type: 'robot_state',
      mac: true,
      installed: true,
      on: true,
    })
    // toggle：转发命令（静默参数由实现带），完成/失败都回读一次
    t.handle({ type: 'robot_toggle', on: false })
    await t.waitFor((m) => m.type === 'robot_state' && m.on === false)
    expect(toggles).toEqual([false])
    // install：完成后回读，installed 翻 true 由实现侧决定，这里只验证转发
    const before = t.posted.filter((m) => m.type === 'robot_state').length
    t.handle({ type: 'robot_install' })
    await t.waitFor(
      (m) =>
        m.type === 'robot_state' &&
        t.posted.filter((p) => p.type === 'robot_state').length > before,
    )
    expect(installs).toBe(1)
  })

  it('飞书推送：gateway_check 跑宿主 check 回 gateway_check_result；push 随带 larkCli', async () => {
    const t = harness(
      undefined,
      { read: () => true, write: () => {} },
      {
        path: () => '/nvm/bin/lark-cli',
        check: async () => ({
          larkCli: '/nvm/bin/lark-cli',
          installed: true,
          version: 'lark-cli version 1.0.97',
          auth: 'ready',
        }),
      },
    )
    t.handle({ type: 'ready' })
    await t.waitFor((m) => m.type === 'hydrate')
    t.handle({ type: 'settings_get' })
    await t.waitFor((m) => m.type === 'gateway_push')
    expect(t.posted.filter((m) => m.type === 'gateway_push').at(-1)).toEqual({
      type: 'gateway_push',
      on: true,
      larkCli: '/nvm/bin/lark-cli',
    })
    t.handle({ type: 'gateway_check' })
    await t.waitFor((m) => m.type === 'gateway_check_result')
    expect(t.posted.find((m) => m.type === 'gateway_check_result')).toEqual({
      type: 'gateway_check_result',
      result: {
        larkCli: '/nvm/bin/lark-cli',
        installed: true,
        version: 'lark-cli version 1.0.97',
        auth: 'ready',
      },
    })
    // check 抛异常：也回一条结果（按钮不能永远停在「检测中」）
    const bad = harness(
      undefined,
      { read: () => true, write: () => {} },
      {
        path: () => null,
        check: () => Promise.reject(new Error('spawn ENOENT')),
      },
    )
    bad.handle({ type: 'ready' })
    await bad.waitFor((m) => m.type === 'hydrate')
    bad.handle({ type: 'gateway_check' })
    await bad.waitFor((m) => m.type === 'gateway_check_result')
    expect(bad.posted.find((m) => m.type === 'gateway_check_result')).toMatchObject({
      type: 'gateway_check_result',
      result: { installed: false },
    })
  })

  it('settings_get 回 settings_view（临时路径 + 模型清单）', async () => {
    await writeFile(path, JSON.stringify(SAMPLE))
    const { posted, handle, waitFor } = harness()
    handle({ type: 'ready' })
    await waitFor((m) => m.type === 'hydrate')
    handle({ type: 'settings_get' })
    await waitFor((m) => m.type === 'settings_view')
    const view = posted.find((m) => m.type === 'settings_view')
    expect(view).toMatchObject({
      type: 'settings_view',
      view: {
        missing: false,
        path,
        defaultRef: { provider: 'p', model: 'm1' },
        providers: [
          {
            name: 'p',
            apiKey: { kind: 'env', name: 'MY_KEY' },
            models: [{ model: 'm1' }, { model: 'm2' }],
          },
        ],
      },
    })
    // env 形态只出现变量名；明文 key 的值不能出现——换一份带明文的样本验
    await writeFile(
      path,
      JSON.stringify({
        ...SAMPLE,
        providers: { p: { ...SAMPLE.providers.p, apiKey: 'sk-plain-secret' } },
      }),
    )
    posted.length = 0
    handle({ type: 'settings_get' })
    await waitFor((m) => m.type === 'settings_view')
    expect(JSON.stringify(posted)).not.toContain('sk-plain-secret')
  })

  it('settings_write firstSave：写文件、回 ok、state.models 带上新模型、权限 600', async () => {
    const { posted, handle, waitFor } = harness()
    handle({ type: 'ready' })
    await waitFor((m) => m.type === 'hydrate')
    handle({
      type: 'settings_write',
      edit: {
        op: 'firstSave',
        name: 'ds',
        protocol: 'openai-chat',
        baseUrl: 'https://api.ds.test',
        apiKey: '${DS_KEY}',
        model: 'ds-flash',
        contextWindow: 100_000,
        images: true,
      },
    })
    await waitFor((m) => m.type === 'settings_result' && m.ok)
    const text = JSON.parse(await readFile(path, 'utf8'))
    expect(text.provider).toBe('ds')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // state 推送里的 models 立刻带上新模型（不等下一次交互）
    const state = posted.filter((m) => m.type === 'state').at(-1)
    expect(state).toMatchObject({ type: 'state', models: [{ provider: 'ds', model: 'ds-flash' }] })
    expect(state).toMatchObject({ current: { provider: 'ds', model: 'ds-flash' } })
  })

  it('settings_write 校验失败：回 ok:false 带 error，不写文件', async () => {
    await writeFile(path, JSON.stringify(SAMPLE))
    const { posted, handle, waitFor } = harness()
    handle({ type: 'ready' })
    await waitFor((m) => m.type === 'hydrate')
    handle({
      type: 'settings_write',
      edit: {
        op: 'addModel',
        provider: 'nope',
        model: 'x',
        contextWindow: 1,
        images: false,
      },
    })
    await waitFor((m) => m.type === 'settings_result' && !m.ok)
    const r = posted.find((m) => m.type === 'settings_result')
    expect(r).toMatchObject({ type: 'settings_result', ok: false })
    if (r !== undefined && r.type === 'settings_result') expect(r.error).toContain('没有叫 nope')
    // 文件原样没动
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(SAMPLE))
  })

  it('settings_openFile 打开的是 settingsPath 指的文件', async () => {
    await writeFile(path, JSON.stringify(SAMPLE))
    const { openedFiles, handle } = harness()
    handle({ type: 'settings_openFile' })
    await new Promise((r) => setTimeout(r, 20))
    expect(openedFiles).toEqual([path])
  })
})

describe('bridge / 首开分支（缺配置）', () => {
  it('attach 时缺配置：不 fatal，推 missing 的 settings_view', async () => {
    const { posted, handle, waitFor } = harness(async () => {
      throw new MissingConfigError('还没有配置文件：…')
    })
    handle({ type: 'ready' })
    await waitFor((m) => m.type === 'settings_view')
    expect(posted.some((m) => m.type === 'fatal')).toBe(false)
    const view = posted.find((m) => m.type === 'settings_view')
    expect(view).toMatchObject({ type: 'settings_view', view: { missing: true } })
  })

  it('别的配置错误（schema 拒收）照旧 fatal', async () => {
    const { posted, handle, waitFor } = harness(async () => {
      throw new Error('配置校验失败：providers.p.baseUrl …')
    })
    handle({ type: 'ready' })
    await waitFor((m) => m.type === 'fatal')
    expect(posted.some((m) => m.type === 'settings_view')).toBe(false)
  })
})
