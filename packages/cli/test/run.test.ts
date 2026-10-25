import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Sink } from '../src/render.ts'
import { runOnce } from '../src/run.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-cli'

/** 借 core 那边录制的真实 SSE。手写的想不到分片切在 JSON 中间（CLAUDE.md §6.2） */
const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../../core/test/fixtures/${name}`, import.meta.url)))

const DONE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":466,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"当前目录有 3 个文件。"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

const bodyOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

/** 第一轮回放 fixture（一次工具调用），第二轮说一句话收尾 */
function replay(bytes: Uint8Array) {
  let calls = 0
  return (async () => {
    calls += 1
    const payload = calls === 1 ? bytes : new TextEncoder().encode(DONE)
    return new Response(bodyOf(payload), { status: 200 })
  }) as unknown as typeof fetch
}

function collector() {
  let out = ''
  let err = ''
  const sink: Sink = { out: (s) => (out += s), err: (s) => (err += s) }
  return { sink, stdout: () => out, stderr: () => err }
}

async function workspace(config: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-cli-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(globalPath, JSON.stringify(config), 'utf8')
  return { dir, globalPath }
}

const CONFIG = {
  provider: 'p',
  model: 'm',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      apiKey: '${TEST_KEY}',
      models: { m: { contextWindow: 100_000 } },
    },
  },
}

const run = async (over: { config?: unknown; fetchImpl?: typeof fetch } = {}) => {
  const { dir, globalPath } = await workspace(over.config ?? CONFIG)
  const c = collector()
  const code = await runOnce({
    prompt: '列出当前目录',
    cwd: dir,
    sink: c.sink,
    globalPath,
    env: { TEST_KEY: KEY },
    ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
  })
  return { code, dir, ...c }
}

describe('跑一轮', () => {
  it('模型的话进 stdout，页脚进 stderr', async () => {
    // 分流不是为了好看：`sc "..." > answer.txt` 要拿到干净的回答
    const { code, stdout, stderr } = await run({
      fetchImpl: replay(await fixture('anthropic-messages.tool-call.sse')),
    })

    expect(code).toBe(0)
    expect(stdout()).toContain('当前目录有 3 个文件。')
    expect(stdout()).not.toContain('首字') // 页脚绝不能混进答案
    expect(stderr()).toContain('首字 ') // 与插件底栏同款（App.tsx）
    expect(stderr()).toMatch(/↑\d[\d.]*[k]? ↓\d[\d.]*[k]? ｜ 上下文 \d[\d.]*[k]?/)
  })

  it('工具调用显示成命令本身，不是 JSON', async () => {
    const { stdout } = await run({
      fetchImpl: replay(await fixture('anthropic-messages.tool-call.sse')),
    })

    // 前提：这份 fixture 确实调了 bash 且命令是 ls，否则下面在测空气
    expect(stdout()).toContain('$ ls')
    expect(stdout()).not.toContain('{"command"')
  })

  it('工具跑在目标目录里，输出进 stdout', async () => {
    const { dir, stdout } = await run({
      fetchImpl: replay(await fixture('anthropic-messages.tool-call.sse')),
    })

    // 前提：settings.json 确实在这个目录里，而且**只在**这里——
    // 不断言这个的话，bash 万一跑在仓库根目录，输出里也可能有同名文件
    expect(await readdir(dir)).toContain('settings.json')
    expect(stdout()).toContain('settings.json')
  })
})

describe('token 用量怎么显示', () => {
  /**
   * 页脚格式与插件底栏（webview/App.tsx）一字不差：首字 · 总 · ↑↓ · 上下文。
   * ↑ 只报 usage.inputTokens（与插件同口径）——Anthropic 的 cache_read 是
   * 并列字段不含在内，缓存越有效数字越小；步数/合计行已按「和插件一致，
   * 其他的不要显示」退役
   */
  it('每步一行页脚，两步就是两行', async () => {
    const { stderr } = await run({
      fetchImpl: replay(await fixture('anthropic-messages.tool-call.sse')),
    })

    const feet = [...stderr().matchAll(/首字 [\d.]+m?s · 总 [\d.]+m?s · ↑/g)]
    expect(feet).toHaveLength(2)
  })

  it('上下文占用用最后一步报的量，不是各步累加', async () => {
    // 累计输入是各轮相加，跟"现在历史有多大"无关。拿累计算会一路虚高到
    // 100%，用户以为快爆窗口了
    const { stderr } = await run({
      fetchImpl: replay(await fixture('anthropic-messages.tool-call.sse')),
    })

    const feet = [...stderr().matchAll(/↑(\d+) ↓(\d+) ｜ 上下文 (\d+)/g)]
    // 前提：确实有两步，且两步的量不同——否则"取最后一步"和"取累计"看不出差别
    expect(feet).toHaveLength(2)
    const sums = feet.map((m) => Number(m[1]) + Number(m[2]))
    expect(sums[0]).not.toBe(sums[1])

    // **不等于最后一步的 ↑↓，也不该等于**：显示的是 core 报的 contextTokens
    // ——「下一轮要发多少」，即最后一步的真实 usage + 那条回复的本地估算。
    // 估算和真实有几个 token 的偏差是正常的，一致才说明又退回读 usage 了。
    // 这条用例真正要挡住的是「用累计值」，所以夹在 [last, all) 之间
    const last = sums[1]!
    const all = sums.reduce((n, x) => n + x, 0)
    const shown = Number(feet[1]?.[3])
    expect(shown).toBeGreaterThanOrEqual(last - 20)
    expect(shown).toBeLessThan(all)
  })

  it('只跑一步也有页脚——那跟步数无关', async () => {
    const oneShot = (async () =>
      new Response(bodyOf(new TextEncoder().encode(DONE)), {
        status: 200,
      })) as unknown as typeof fetch
    const { stderr } = await run({ fetchImpl: oneShot })

    expect(stderr()).toMatch(/首字 [\d.]+m?s · 总 [\d.]+m?s · ↑\d+ ↓\d+ ｜ 上下文 \d+/)
  })
})

describe('出错时的退出码', () => {
  it('loop 里出错：退出码 1，原因在 stderr', async () => {
    const boom = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error' } }), {
        status: 400,
      })) as unknown as typeof fetch
    const { code, stdout, stderr } = await run({ fetchImpl: boom })

    expect(code).toBe(1)
    expect(stderr()).toContain('错误')
    expect(stdout()).toBe('') // 没有半截答案
  })

  it('配置起不来：退出码 2，且说清楚是哪个字段', async () => {
    const { code, stderr } = await run({ config: { ...CONFIG, request: { maxToken: 1 } } })

    expect(code).toBe(2)
    expect(stderr()).toContain('启动失败')
    expect(stderr()).toContain('maxToken')
  })

  it('压根没有配置文件时，说清楚该建在哪、照着谁抄', async () => {
    // 「配置不存在」和「配置写错了」是两种处境。混成一条 zod 报错的话，
    // 第一次用的人看到的是"provider: expected string"，不知道该干嘛
    const dir = await mkdtemp(join(tmpdir(), 'sc-cli-'))
    dirs.push(dir)
    const c = collector()

    const code = await runOnce({
      prompt: 'hi',
      cwd: dir,
      sink: c.sink,
      globalPath: join(dir, '不存在.json'),
    })

    expect(code).toBe(2)
    expect(c.stderr()).toContain('还没有配置文件')
    expect(c.stderr()).toContain('settings.example.json')
    // 对照组：这条路径不该退化成 zod 那串字段错误
    expect(c.stderr()).not.toContain('expected string')
  })

  it('对照组：配置没问题时不会走启动失败那条路', async () => {
    // 没有这条的话，上面两条"退出码不是 0"可能只是因为压根没跑起来
    const { code, stderr } = await run({
      fetchImpl: replay(await fixture('anthropic-messages.tool-call.sse')),
    })

    expect(code).toBe(0)
    expect(stderr()).not.toContain('启动失败')
  })
})

describe('injectLocalTools（终端裸跑自补工具路径）', () => {
  it('变量缺失时指向 shim；已有注入不覆盖；缺文件跳过', async () => {
    const { injectLocalTools } = await import('../src/run.ts')
    const dir = await mkdtemp(join(tmpdir(), 'sc-inject-'))
    const binDir = await mkdtemp(join(tmpdir(), 'sc-shim-'))
    dirs.push(dir)
    await writeFile(join(dir, 'webfetch.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    await writeFile(join(dir, 'note.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    const savedNote = process.env.SIMPLE_CODE_NOTE
    const savedWebfetch = process.env.SIMPLE_CODE_WEBFETCH
    const savedLesson = process.env.SIMPLE_CODE_LESSON
    try {
      delete process.env.SIMPLE_CODE_WEBFETCH
      delete process.env.SIMPLE_CODE_LESSON // 本进程可能带扩展注入的值——清了才验「缺文件跳过」
      process.env.SIMPLE_CODE_NOTE = '/host/injected/note.js'
      await injectLocalTools(dir, binDir)
      // shim 而非脚本本体：PATH 无 node 的机器靠它用宿主 node 跑（shims.ts）
      expect(process.env.SIMPLE_CODE_WEBFETCH).toBe(join(binDir, 'sc-webfetch'))
      await expect(access(join(binDir, 'sc-webfetch'), fsConstants.X_OK)).resolves.toBeUndefined()
      expect(process.env.SIMPLE_CODE_NOTE).toBe('/host/injected/note.js') // 不覆盖
      expect(process.env.SIMPLE_CODE_LESSON).toBeUndefined() // 目录里没有 → 跳过
    } finally {
      if (savedWebfetch === undefined) delete process.env.SIMPLE_CODE_WEBFETCH
      else process.env.SIMPLE_CODE_WEBFETCH = savedWebfetch
      if (savedNote === undefined) delete process.env.SIMPLE_CODE_NOTE
      else process.env.SIMPLE_CODE_NOTE = savedNote
      if (savedLesson === undefined) delete process.env.SIMPLE_CODE_LESSON
      else process.env.SIMPLE_CODE_LESSON = savedLesson
    }
  })
})

describe('ensureCredentialProxy（终端 sc 自起凭据代理）', () => {
  const KEYS = ['SIMPLE_CODE_PROXY_PORT', 'SIMPLE_CODE_PROXY_TOKEN'] as const
  const save = () => KEYS.map((k) => process.env[k])
  const restore = (v: Array<string | undefined>) =>
    KEYS.forEach((k, i) => (v[i] === undefined ? delete process.env[k] : (process.env[k] = v[i])))

  it('无上层代理：起一个，写入端口与 token，错 token 401', async () => {
    const { ensureCredentialProxy } = await import('../src/run.ts')
    const saved = save()
    try {
      for (const k of KEYS) delete process.env[k]
      const server = await ensureCredentialProxy()
      expect(server).toBeDefined()
      const port = process.env.SIMPLE_CODE_PROXY_PORT
      expect(port).toMatch(/^\d+$/)
      expect(process.env.SIMPLE_CODE_PROXY_TOKEN).toMatch(/^[0-9a-f]{48}$/)
      const res = await fetch(`http://127.0.0.1:${port}/websearch`, { method: 'POST', headers: { 'x-sc-token': 'wrong' }, body: '{}' })
      expect(res.status).toBe(401)
      await new Promise((r) => server?.close(r))
    } finally {
      restore(saved)
    }
  })

  it('嵌套（VS Code bash 里跑 sc）：已有上层代理 → 复用，不起新的', async () => {
    const { ensureCredentialProxy } = await import('../src/run.ts')
    const saved = save()
    try {
      process.env.SIMPLE_CODE_PROXY_PORT = '12345'
      process.env.SIMPLE_CODE_PROXY_TOKEN = 'parent'
      expect(await ensureCredentialProxy()).toBeUndefined()
      expect(process.env.SIMPLE_CODE_PROXY_PORT).toBe('12345')
      expect(process.env.SIMPLE_CODE_PROXY_TOKEN).toBe('parent')
    } finally {
      restore(saved)
    }
  })
})
