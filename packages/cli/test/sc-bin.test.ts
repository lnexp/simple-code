import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { assertRootAllowed, parseScArgs, scMain, SC_USAGE } from '../src/sc-bin.ts'

// scMain 校验 fallback 到 process.env.SIMPLE_CODE_ROOTS——而「被 agent
// 跑的 vitest」本身就是这个变量的真实携带者（bash.ts 注入，实测全量
// 跑时把 /tmp 的 fixture 拦下退 2）。测试环境摘掉宿主痕迹，校验用例
// 自己显式喂 io.env
const savedRoots = process.env.SIMPLE_CODE_ROOTS
beforeEach(() => { delete process.env.SIMPLE_CODE_ROOTS })
const dirs: string[] = []
afterEach(async () => {
  if (savedRoots !== undefined) process.env.SIMPLE_CODE_ROOTS = savedRoots
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../../core/test/fixtures/${name}`, import.meta.url)))

const CONFIG = {
  provider: 'p',
  model: 'm',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      apiKey: '${TEST_KEY}',
      models: {
        m: { contextWindow: 100_000 },
        v: { contextWindow: 256_000, capabilities: { images: true } },
      },
    },
  },
}

const DONE = ['event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":466,"output_tokens":0}}}',
  '', 'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '', 'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"结论一行"}}',
  '', 'event: content_block_stop', 'data: {"type":"content_block_stop","index":0}', '', 'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}',
  '', 'event: message_stop', 'data: {"type":"message_stop"}', '', ''].join('\n')

const bodyOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })

function io(over: {
  argv?: string[]
  stdin?: string
  globalPath?: string
  cwd?: string
  env?: Record<string, string>
  fetchImpl?: typeof fetch
}) {
  let out = ''
  let err = ''
  const stdin = new Readable({ read() {} }) as NodeJS.ReadableStream & { isTTY?: boolean }
  stdin.isTTY = over.stdin === undefined // 没喂内容=模拟 tty，不读
  const stdout = (s: string) => (out += s)
  const stderr = (s: string) => (err += s)
  return {
    io: {
      stdin,
      stdout,
      stderr,
      cwd: over.cwd ?? '/tmp',
      ...(over.globalPath ? { globalPath: over.globalPath } : {}),
      env: { TEST_KEY: 'sk-x', ...over.env },
      ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}),
      signal: new AbortController().signal,
    },
    argv: over.argv ?? [],
    stdout: () => out,
    stderr: () => err,
    feed: (text: string) => {
      // push(null) 是可读流的标准 EOF；emit('end') 在监听器挂上前发会丢
      const r = stdin as unknown as { push: (s: string | null) => boolean }
      r.push(text)
      r.push(null)
    },
  }
}

describe('parseScArgs', () => {
  it('位置参数拼成 prompt；旗标各自落位', () => {
    const r = parseScArgs(['-q', '-t', '600', '调研', '一下'])
    expect(r).toEqual({
      ok: true,
      value: { quiet: true, timeoutSec: 600, prompt: '调研 一下', listModelsFlag: false, help: false },
    })
  })
  it('-m 从第一个 / 断——模型名可含 /（网关命名）', () => {
    const r = parseScArgs(['-m', 'anthropic/claude-opus-4-8'])
    expect(r.ok && r.value.model).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' })
  })
  it('-m 断不开/缺值：用法错文案', () => {
    expect(!parseScArgs(['-m', 'noforward']).ok).toBe(true)
    expect(!parseScArgs(['-m']).ok).toBe(true)
  })
  it('-e 只认 core 的 Effort 值集', () => {
    expect(parseScArgs(['-e', 'high']).ok).toBe(true)
    expect(!parseScArgs(['-e', 'minimal']).ok).toBe(true)
    expect(!parseScArgs(['-e']).ok).toBe(true)
  })
  it('-t 拒绝非正整数', () => {
    expect(parseScArgs(['-t', '600']).ok).toBe(true)
    expect(!parseScArgs(['-t', '1.5']).ok).toBe(true)
    expect(!parseScArgs(['-t', '0']).ok).toBe(true)
    expect(!parseScArgs(['-t']).ok).toBe(true)
  })
  it('不认识的参数报错并指路 -h', () => {
    const r = parseScArgs(['--bogus'])
    expect(!r.ok && r.message.includes('--bogus')).toBe(true)
  })
})

describe('子 agent 权限上限（SIMPLE_CODE_ROOTS，逐级只减不增）', () => {
  it('纯函数：无变量=人直接用，放行', () => {
    expect(assertRootAllowed('/any/where', undefined)).toBeNull()
  })
  it('纯函数：范围内/前缀之下放行，条目尾斜杠不碍事', () => {
    expect(assertRootAllowed('/a/b', JSON.stringify(['/a']))).toBeNull()
    expect(assertRootAllowed('/a/b', JSON.stringify(['/a/']))).toBeNull()
    expect(assertRootAllowed('/a', JSON.stringify(['/a/b/c', '/a']))).toBeNull()
  })
  it('纯函数：越界/邻接伪造前缀/坏 JSON 都拒', () => {
    expect(assertRootAllowed('/tmp', JSON.stringify(['/a']))).toContain('逐级只减不增')
    expect(assertRootAllowed('/ab', JSON.stringify(['/a']))).toContain('超出') // /ab 不沾 /a 的光
    expect(assertRootAllowed('/a', 'not-json')).toContain('不是合法 JSON')
    expect(assertRootAllowed('/a', '["x",5]')).toContain('字符串数组')
  })
  it('scMain：越界拒绝启动（exit 2），范围内放行到干活那步', async () => {
    // HOME 换临时目录：放行后会走到 injectLocalTools——shim 要写
    // ~/.simple-code/bin，不换就污染真实 HOME（2026-09-19 实测发生过）
    const home = await mkdtemp(join(tmpdir(), 'sc-home-'))
    dirs.push(home)
    const savedHome = process.env.HOME
    process.env.HOME = home
    const bad = io({
      argv: ['--root', '/etc', '任务'],
      env: { SIMPLE_CODE_ROOTS: JSON.stringify(['/Users/dev/Code/proj']) },
    })
    expect(await scMain(bad.argv, bad.io)).toBe(2)
    expect(bad.stderr()).toContain('父 agent 审批范围')
    // 范围内：不因校验拦（后续因缺 API key 配置退 2 是别的出口——exit 2
    // 不止校验一种来源，断言看 stderr 里没有校验文案）
    const ok = io({
      argv: ['--root', '/Users/dev/Code/proj/sub', '任务'],
      env: { SIMPLE_CODE_ROOTS: JSON.stringify(['/Users/dev/Code/proj']) },
    })
    const code = await scMain(ok.argv, ok.io)
    try {
      expect(ok.stderr()).not.toContain('审批范围')
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome
      else delete process.env.HOME
    }
  })
  it('scMain：--root 相对路径按 cwd 解析后再校验（绕道相对路径不豁免）', async () => {
    const h = io({
      // ../../escape 从 sub 出两层 = /Users/dev/Code/escape，出了 proj
      argv: ['--root', '../../escape', '任务'],
      cwd: '/Users/dev/Code/proj/sub',
      env: { SIMPLE_CODE_ROOTS: JSON.stringify(['/Users/dev/Code/proj']) },
    })
    expect(await scMain(h.argv, h.io)).toBe(2)
    expect(h.stderr()).toContain('/Users/dev/Code/escape')
  })
})

describe('scMain', () => {
  it('-h：用法进 stdout，退出码 0', async () => {
    const h = io({ argv: ['-h'] })
    expect(await scMain(h.argv, h.io)).toBe(0)
    expect(h.stdout()).toContain('用法：sc')
  })
  it('用法错：退出码 2，文案进 stderr', async () => {
    const h = io({ argv: ['--bogus'] })
    expect(await scMain(h.argv, h.io)).toBe(2)
    expect(h.stderr()).toContain('不认识的参数')
    expect(h.stderr()).toContain(SC_USAGE.slice(0, 8))
  })
  it('--models：TSV 清单（含窗口与视觉位），不吐 apiKey/baseUrl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-sc-'))
    dirs.push(dir)
    const globalPath = join(dir, 'settings.json')
    await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
    const h = io({ argv: ['--models'], globalPath, cwd: dir })
    expect(await scMain(h.argv, h.io)).toBe(0)
    expect(h.stdout()).toContain('p/m\t100000\tno')
    expect(h.stdout()).toContain('p/v\t256000\tyes')
    expect(h.stdout()).not.toContain('TEST_KEY')
    expect(h.stdout()).not.toContain('example.invalid')
  })
  it('没任务（无参数、stdin 非 tty 且为空）：退出码 2', async () => {
    const h = io({ argv: [], stdin: '' })
    h.feed('')
    expect(await scMain(h.argv, h.io)).toBe(2)
    expect(h.stderr()).toContain('没给任务')
  })
  it('无参数 + stdin 是终端 → 进 REPL（人用），对话后 /exit 退出码 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-sc-'))
    dirs.push(dir)
    const globalPath = join(dir, 'settings.json')
    await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
    const h = io({
      argv: [], globalPath, cwd: dir,
      fetchImpl: (async () => new Response(bodyOf(new TextEncoder().encode(DONE)), { status: 200 })) as typeof fetch,
    })
    // tty 假流：REPL 接管 stdin，喂一行问题再 /exit
    ;(h.io.stdin as unknown as { isTTY: boolean }).isTTY = true
    h.feed('你好\n/exit\n')
    expect(await scMain(h.argv, h.io)).toBe(0)
    expect(h.stderr()).toContain('sc · ') // banner（元信息走 err）
    expect(h.stdout()).toContain('结论一行')
  })
  it('-q + stdin 任务书：stdout 只有最终文本，退出码 0（回放 SSE）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-sc-'))
    dirs.push(dir)
    const globalPath = join(dir, 'settings.json')
    await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
    const { runOnce } = await import('../src/run.ts')
    const realRunOnce = runOnce
    const h = io({
      argv: ['-q'], stdin: 'heredoc 任务书', globalPath, cwd: dir,
      fetchImpl: (async () => new Response(bodyOf(new TextEncoder().encode(DONE)), { status: 200 })) as typeof fetch,
    })
    h.feed('heredoc 任务书')
    expect(await scMain(h.argv, h.io)).toBe(0)
    expect(realRunOnce).toBeTypeOf('function')
    expect(h.stdout()).toContain('结论一行')
    expect(h.stdout()).not.toContain('[思考]') // 过程信息不得漏进 stdout
  })
})
