/**
 * 前缀不变式（2026-09-23 用户定死的规则）：除了触发上下文压缩，请求前缀
 * 绝对不能变。守卫在 loop/prefix-guard.ts，接线在 run.ts（发请求前 check、
 * 压缩点 allowRewrite）与 session.ts（基线落库、现场落盘）。
 *
 * 三层：纯函数判定 / 守卫状态机 / 真 session 端到端——最后一层是规则本身：
 * 多轮对话 + 空闲摘要 + 卸载 + 合并全程，守卫一次都不许响；后台偷改前缀
 * 必须当场响。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import {
  createPrefixGuard,
  findBreak,
  fingerprint,
  PrefixBrokenError,
  type PrefixFingerprint,
} from '../src/loop/prefix-guard.ts'
import { getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE } from '../src/session/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const req = (messages: string[], over: Partial<Request> = {}): Request => ({
  model: 'm',
  maxTokens: 100,
  thinking: 'disabled',
  effort: 'high',
  reasoningDisplay: 'omitted',
  system: 'S',
  tools: [],
  messages: messages.map((text, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text }],
  })),
  ...over,
})

describe('findBreak', () => {
  it('末尾追加 = 完好', () => {
    expect(findBreak(fingerprint(req(['a', 'b'])), fingerprint(req(['a', 'b', 'c', 'd'])))).toBeNull()
  })
  it('中段改一条 → 报出第一处下标', () => {
    const b = findBreak(fingerprint(req(['a', 'b', 'c'])), fingerprint(req(['a', 'X', 'c', 'd'])))
    expect(b).toMatchObject({ part: 'messages', index: 1, prevLength: 3, nextLength: 4 })
  })
  it('变短也是改写（末尾被删）', () => {
    const b = findBreak(fingerprint(req(['a', 'b', 'c'])), fingerprint(req(['a', 'b'])))
    expect(b).toMatchObject({ part: 'messages', index: 2 })
  })
  it('system / tools 变了', () => {
    expect(findBreak(fingerprint(req(['a'])), fingerprint(req(['a'], { system: 'S2' })))?.part).toBe('system')
    expect(
      findBreak(
        fingerprint(req(['a'])),
        fingerprint(req(['a'], { tools: [{ name: 't', description: '', inputSchema: {} }] as never })),
      )?.part,
    ).toBe('tools')
  })
})

describe('守卫状态机', () => {
  const harness = () => {
    let saved: PrefixFingerprint | null = null
    const dumps: unknown[] = []
    const guard = createPrefixGuard({
      baseline: { read: () => saved, write: (fp) => (saved = fp) },
      dump: (info) => {
        dumps.push(info)
        return '/tmp/x.json'
      },
    })
    return { guard, dumps }
  }

  it('违规抛 PrefixBrokenError、落现场；之后以违规那次为新基线（再发能继续）', () => {
    const { guard, dumps } = harness()
    guard.check(req(['a', 'b']))
    expect(() => guard.check(req(['a', 'X', 'c']))).toThrow(PrefixBrokenError)
    expect(dumps).toHaveLength(1)
    expect(() => guard.check(req(['a', 'X', 'c', 'd']))).not.toThrow()
  })

  it('压缩点放行且只放行一次', () => {
    const { guard } = harness()
    guard.check(req(['a', 'b']))
    guard.allowRewrite()
    expect(() => guard.check(req(['摘要', 'b']))).not.toThrow()
    expect(() => guard.check(req(['又改', 'b']))).toThrow(PrefixBrokenError)
  })

  it('配置键变了（只改 settings 的窗口，system 随之变）= 用户的选择，不报', () => {
    const { guard } = harness()
    guard.check(req(['a', 'b']), 'win=3000')
    expect(() => guard.check(req(['a', 'b'], { system: '窗口 200000' }), 'win=200000')).not.toThrow()
    // 配置键不变时同样的 system 变化照报
    expect(() => guard.check(req(['a', 'b'], { system: '偷改' }), 'win=200000')).toThrow(PrefixBrokenError)
  })

  it('会话重建后（新守卫实例）违规：现场里 prev 仍有上一条请求原文', async () => {
    // 2026-09-23 真机教训：守卫实例随会话重建而弃，内存 prev 没了，现场文件
    // 里 prev 只剩 null，两条请求没法 diff。原文必须平时就落盘（last-requests/）
    const dir = await mkdtemp(join(tmpdir(), 'sc-pg-prev-'))
    dirs.push(dir)
    const file = join(dir, 'prev.json')
    const prevStore = {
      read: () => {
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as Request
        } catch {
          return null
        }
      },
      write: (r: Request) => writeFileSync(file, JSON.stringify(r)),
    }
    let saved: PrefixFingerprint | null = null
    const dumps: { prev: Request | null; next: Request }[] = []
    const mk = () =>
      createPrefixGuard({
        baseline: { read: () => saved, write: (fp) => (saved = fp) },
        prev: prevStore,
        dump: (info) => {
          dumps.push(info)
          return '/tmp/x.json'
        },
      })
    mk().check(req(['a', 'b']))
    // 会话重建：新实例，内存里的 prev 没了——现场只能靠落盘原文
    expect(() => mk().check(req(['a', 'X', 'c']))).toThrow(PrefixBrokenError)
    expect(dumps[0]?.prev?.messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['a', 'b'])
  })

  it('请求参数变了（换模型/档位）= 用户的选择，基线静默重置', () => {
    const { guard } = harness()
    guard.check(req(['a', 'b']))
    expect(() => guard.check(req(['完全不同'], { model: 'm2' }))).not.toThrow()
  })
})

// ── 端到端 ─────────────────────────────────────────────────────

const KEY = 'sk-SENTINEL-prefix'
const usage = (): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})
const says = (text: string): StreamEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
  { type: 'finish', reason: 'stop', usage: usage() },
]
const SSE = (text: string) =>
  [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')
/** 摘要/合并模型：L0 与合并的 system 不同（合并的含「索引」），各回各的 */
const summaryFetch = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { system?: unknown }
  const system = JSON.stringify(body.system ?? '')
  const text = system.includes('索引') ? 'L1：合并了' : 'L0：读了文件'
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(SSE(text)))
        c.close()
      },
    }),
    { status: 200 },
  )
}) as unknown as typeof fetch

const long = (label: string) => `${label}${'。这是为了把上下文撑大而重复的内容'.repeat(20)}`

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-prefix-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(
    globalPath,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      providers: {
        p: {
          protocol: 'anthropic-messages',
          baseUrl: 'https://example.invalid',
          apiKey: '${TEST_KEY}',
          models: { m: { contextWindow: 3_000 } },
        },
      },
      request: { maxTokens: 500 },
      memory: {
        unloadTargetRatio: 0.001,
        keepHeadChars: 40,
        clipThresholdChars: 0,
        mergeFactor: 2,
        indexRatio: 0.001, // 配额极小：一有 2 条在场的 L0 就合——逼出合并路径
        stubTokens: 1,
        idleSummarizeDelayMs: 0,
      },
    }),
    'utf8',
  )
  return { dir, globalPath }
}

const open = (dir: string, globalPath: string) =>
  getSession(dir, {
    globalPath,
    env: { TEST_KEY: KEY },
    tools: [],
    stream: (() =>
      (async function* () {
        for (const ev of says('答。这段回答也要够长才卸得动'.repeat(8))) yield ev
      })()) as LoopDeps['stream'],
    fetchImpl: summaryFetch,
    skipLock: true,
  })

const collect = async (source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}
const prefixErrors = (evs: AgentEvent[]) =>
  evs.filter((e) => e.type === 'error' && e.message.includes('前缀'))

describe('前缀不变式（真 session 端到端）', () => {
  it('多轮 + 空闲摘要 + 卸载 + 合并全程：守卫一次都不响，且摘要与合并确实发生过', async () => {
    const { dir, globalPath } = await workspace()
    const s = await open(dir, globalPath)
    const all: AgentEvent[] = []
    for (let i = 1; i <= 10; i++) {
      all.push(...(await collect(s.send(long(`第${i}个问题`)))))
      // 每轮之间让摘要器跑（旧代码里这里生成的摘要会当场进场、改前缀）
      for (let k = 0; k < 3; k++) await s.summarizeIdle()
    }
    await s.close()
    expect(prefixErrors(all)).toEqual([])
    // 前提：被测路径真的走过——卸载发生了、摘要进过场、合并出过 L1
    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
    const sums = db.prepare('SELECT level, in_context FROM summaries').all() as {
      level: number
      in_context: number
    }[]
    db.close()
    expect(all.some((e) => e.type === 'unloaded')).toBe(true)
    expect(sums.some((r) => r.level === 0 && r.in_context === 1) || sums.some((r) => r.level >= 1)).toBe(true)
    expect(sums.some((r) => r.level >= 1)).toBe(true)
    // 上一请求原文落盘（违规现场里 prev 的来源，2026-09-23 起每请求覆盖写）
    expect(existsSync(join(dir, MEMORY_RELATIVE, 'last-requests', 'main.json'))).toBe(true)
  })

  it('重启（reload）后缓存还热：第一次请求照样接得上上一次的前缀', async () => {
    const { dir, globalPath } = await workspace()
    const s1 = await open(dir, globalPath)
    await collect(s1.send('短问一'))
    await collect(s1.send('短问二'))
    await s1.close()
    const s2 = await open(dir, globalPath)
    const evs = await collect(s2.send('重启后短问'))
    await s2.close()
    expect(prefixErrors(evs)).toEqual([])
  })

  it('大窗口下（请求都不是压缩点）空闲摘要照写，但不进场、前缀不动——旧 bug 的正面回归', async () => {
    // 2026-09-23 request1/request2：摘要在非压缩点进场/合并生效，113 条消息
    // 只命中前 18 条。这里造「有 ready 摘要、却没到压缩点」的现场
    const { dir, globalPath } = await workspace()
    const s1 = await open(dir, globalPath)
    for (let i = 1; i <= 4; i++) await collect(s1.send(long(`第${i}个问题`)))
    await s1.close()
    const cfg = JSON.parse(readFileSync(globalPath, 'utf8'))
    cfg.providers.p.models.m.contextWindow = 200_000
    await writeFile(globalPath, JSON.stringify(cfg), 'utf8')

    const s = await open(dir, globalPath)
    const inCtx = () => {
      const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
      const r = db.prepare('SELECT COUNT(*) AS n FROM summaries WHERE in_context = 1').get() as { n: number }
      const all = db.prepare('SELECT COUNT(*) AS n FROM summaries').get() as { n: number }
      db.close()
      return { inCtx: r.n, all: all.n }
    }
    const evs: AgentEvent[] = []
    evs.push(...(await collect(s.send('短问一'))))
    const before = inCtx()
    for (let k = 0; k < 6; k++) await s.summarizeIdle()
    const mid = inCtx()
    expect(mid.all).toBeGreaterThan(before.all) // 前提：空闲期确实写出了新摘要
    for (let i = 0; i < 3; i++) evs.push(...(await collect(s.send(`短问${i + 2}`))))
    await s.close()
    expect(prefixErrors(evs)).toEqual([])
    expect(inCtx().inCtx).toBe(before.inCtx) // 新摘要只落 ready，没进场
  })

  it('后台偷改前缀（在场摘要被翻掉）→ 下一次请求当场报错、不发出去、现场落盘', async () => {
    const { dir, globalPath } = await workspace()
    // 小窗口下每问都超预算 = 每问都是压缩点，改写被放行。所以先用小窗口
    // 攒出在场摘要，再换大窗口重开——之后的请求都不是压缩点
    const s1 = await open(dir, globalPath)
    for (let i = 1; i <= 6; i++) {
      await collect(s1.send(long(`第${i}个问题`)))
      await s1.summarizeIdle()
    }
    await s1.close()
    const cfg = JSON.parse(readFileSync(globalPath, 'utf8'))
    cfg.providers.p.models.m.contextWindow = 200_000
    await writeFile(globalPath, JSON.stringify(cfg), 'utf8')

    const sent: number[] = []
    const s = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: (() => {
        sent.push(1)
        return (async function* () {
          for (const ev of says('短答')) yield ev
        })()
      }) as LoopDeps['stream'],
      fetchImpl: summaryFetch,
      skipLock: true,
    })
    expect(prefixErrors(await collect(s.send('短问一')))).toEqual([]) // 对照：不篡改就不响

    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
    const inCtx = db.prepare('SELECT id FROM summaries WHERE in_context = 1 LIMIT 1').get() as
      | { id: number }
      | undefined
    expect(inCtx).toBeDefined() // 前提
    // 模拟一个违规的改写者：不经过压缩点，直接把在场摘要撤下
    db.prepare('UPDATE summaries SET in_context = 0 WHERE id = ?').run(inCtx!.id)
    db.close()

    const before = sent.length
    const evs = await collect(s.send('短问二'))
    await s.close()
    const errs = prefixErrors(evs)
    expect(errs).toHaveLength(1)
    expect(sent.length).toBe(before) // 没发出去——发了就是一次全价请求
    const path = /现场：([^）]+)）/.exec((errs[0] as { message: string }).message)?.[1]
    expect(path).toBeDefined()
    expect(existsSync(path!)).toBe(true)
    const dump = JSON.parse(readFileSync(path!, 'utf8')) as { break: { part: string } }
    expect(dump.break.part).toBe('messages')
  })
})

describe('发出去的必须先在库里（checkpoint）', () => {
  it('工具结果在下一次请求发出前已落库——此时 reload，重启后前缀接得上', async () => {
    // 2026-09-23 某项目真机：工具结果只在下一个 step_finish 落盘，
    // 请求在途时 reload，重启后工具调用被补成「中断」占位，前缀对不上
    const { dir, globalPath } = await workspace()
    let call = 0
    let toolRowsAtSecondRequest = -1
    const stream = (() => {
      call++
      if (call === 2) {
        const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
        toolRowsAtSecondRequest = (
          db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'tool' AND state = 'live'`).get() as { n: number }
        ).n
        db.close()
      }
      const events: StreamEvent[] =
        call === 1
          ? [
              { type: 'tool_input_start', id: 'c1', name: 'echo' },
              { type: 'tool_input_delta', id: 'c1', partial: '{}' },
              { type: 'tool_input_end', id: 'c1', name: 'echo', input: {} },
              { type: 'finish', reason: 'tool-calls', usage: usage() },
            ]
          : says('好了')
      return (async function* () {
        for (const ev of events) yield ev
      })()
    }) as LoopDeps['stream']
    const s = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [
        {
          name: 'echo',
          definition: { name: 'echo', description: 'd', parameters: { type: 'object' } },
          execute: async () => ({ output: '工具的真实输出', exitCode: 0, isError: false }),
        } as never,
      ],
      stream,
      fetchImpl: summaryFetch,
      skipLock: true,
    })
    const evs = await collect(s.send('调个工具'))
    await s.close()
    expect(call).toBe(2) // 前提：确实走了「工具 → 第二次请求」
    expect(evs.filter((e) => e.type === 'error')).toEqual([])
    expect(toolRowsAtSecondRequest).toBe(1)
  })
})
