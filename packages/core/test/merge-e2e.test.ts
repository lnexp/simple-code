import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Message, Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession } from '../src/session/session.ts'
import { openStore } from '../src/session/store.ts'

/**
 * 3b-2 的端到端验收：**L0 攒够 → 空闲合并（只写库）→ 下次卸载时生效 →
 * 重启后还对**。单段在 merge.test.ts，这里测串起来之后模型实际看到的。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-merge-e2e'

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

/** 带 tool 往复的一轮：大 command（卸载时可裁成存根）+ isError result。
 * tools:[] 里的未知工具名会让 loop 自动补 isError 结果——正好免去真跑工具。
 * 三级递进（2026-09-12）后 L0 进场由存根段水位驱动，纯文本裁不动、
 * 没有存根，水位恒 0 摘要永不进场；生产里的大头就是工具输出（cq 实测），
 * 夹具跟着真实形态走 */
const saysWithTool = (text: string): StreamEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
  { type: 'tool_input_start', id: 'tc1', name: 'bash' },
  {
    type: 'tool_input_delta',
    id: 'tc1',
    partial: JSON.stringify({ command: `#侦查${'x'.repeat(400)}` }),
  },
  { type: 'tool_input_end', id: 'tc1', name: 'bash', input: { command: `#侦查${'x'.repeat(400)}` } },
  { type: 'finish', reason: 'tool-calls', usage: usage() },
  // loop 补完 isError result 后的第二发：收尾文本
  { type: 'text_start' },
  { type: 'text_delta', text: '收尾' },
  { type: 'text_end' },
  { type: 'finish', reason: 'stop', usage: usage() },
]

const CONFIG = {
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
  // mergeFactor=2：两条 L0 就合，用最小的攒组验证机制，不用真聊十轮。
  // idleSummarizeDelayMs=0 关掉 step 跑完的自动触发（§9.7 修正二）——本文件
  // 要精确控制「攒到第几条了」，自动多摘一条就把攒组的节奏打乱
  // clipThresholdChars=0 关掉第 0 层的阈值：本文件的夹具是几百字符的合成
  // 消息，用生产默认的 1000 一条都裁不动，测的就成了空集。阈值本身在
  // unload.test.ts 里测
  memory: {
    unloadTargetRatio: 0.001,
        stubTurns: 1,
    keepHeadChars: 40,
    mergeFactor: 2,
    idleSummarizeDelayMs: 0,
    clipThresholdChars: 0,
  },
}

async function workspace(over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-merge-e2e-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(globalPath, JSON.stringify({ ...CONFIG, ...over }), 'utf8')
  return { dir, globalPath }
}

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

/**
 * 按 system 区分回什么：L0 的指令和合并的指令不同。合并的文本带标记词，
 * 让断言能分清「模型看到的是 L0 还是 L1」
 */
const smartFetch = (l0Text: string, mergeText: string) =>
  (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { system?: unknown }
    // system 可能是字符串，也可能是 anthropic 的 text block 数组——都摊平成文本
    const system = Array.isArray(body.system)
      ? body.system
          .map((b) => (typeof b === 'object' && b && 'text' in b ? String(b.text) : ''))
          .join('')
      : typeof body.system === 'string'
        ? body.system
        : ''
    const text = system.includes('索引') ? mergeText : l0Text
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

function recordingStream(rounds: StreamEvent[][]) {
  const sent: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[sent.length] ?? rounds[rounds.length - 1] ?? []
    sent.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return { stream, sent }
}

const drain = async (source: AsyncIterable<AgentEvent>) => {
  for await (const _ of source) {
    // 只为跑完
  }
}

// 尺寸按估算器校准：CJK 按一字一 token 估（tokens.ts 的 estimateText），
// repeat(20) ≈ 345 token，与旧估算器下 repeat(80)（1365 字 ÷4 ≈ 341）等价——
// 改估算口径时同步核这行，否则「几轮撞阈值」的节奏会漂
const long = (label: string) => `${label}${'。这是为了把上下文撑大而重复的内容'.repeat(20)}`

/**
 * **assistant 回复也必须够长，否则合并根本凑不齐。**
 *
 * `pickOldest` 会跳过「卸了也省不到」的消息（run.ts 的 `saved <= 0`）——
 * 两三个字的「答一」加上归档提示反而更大，一辈子卸不掉。而卸不掉 = 它那个
 * step 的 L0 永远不 `in_context`，`pickMergeGroup` 要的是**连续**的生效
 * 前缀，中间夹一个就断在那里，mergeFactor 调到多小都没用。
 *
 * 这不是给测试开后门：真实会话里 assistant 回复本来就是几百上千 token，
 * 「答一」那种夹具才是不真实的那个。
 */
const reply = (label: string) => `${label}${'。这段回答也要够长才卸得动'.repeat(8)}`

const textOf = (messages: Message[] | undefined): string =>
  (messages ?? [])
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join(''))
    .join('\n')

const rowsOf = (dir: string) => {
  const store = openStore(dir)
  const rows = store.summaries()
  store.close()
  return rows
}

describe('合并端到端', () => {
  it('**L0 攒够 → 空闲合并只写库 → 下轮请求生效 → 重启后仍生效**', async () => {
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([
      says(reply('答一')),
      says(reply('答二')),
      says(reply('答三')),
      says(reply('答四')),
      says(reply('答五')),
    ])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: smartFetch('L0：读了文件', 'L1【索引】：这一段定下了架构'),
      skipLock: true,
    })

    // step 语义下的节奏：一轮 send 产生 user、assistant 各一个 step。
    // 卸载把最老的消息换成存根（step 已卸载），之后的空闲 tick 给这些 step
    // 补摘 L0——ready 时发现 step 已卸载，直接 in_context=1（翻转规则）。
    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await drain(session.send(long('第三个问题'))) // 撞阈值：卸最老的消息

    // 空闲期逐个补摘（一次 tick 一个 step）。前缀不变式（2026-09-23）：摘要
    // 只落 ready，进场要等下一个压缩点——再发一轮（超预算）把积压的放进来
    for (let i = 0; i < 6; i++) await session.summarizeIdle()
    await drain(session.send(long('第四个问题')))
    const active = rowsOf(dir).filter((r) => r.level === 0 && r.inContext)
    expect(active.length).toBeGreaterThanOrEqual(2) // 前提：合并的原料够了

    // 债还清后的空闲 tick：合并（mergeFactor=2）只写库。第四问那一轮也要
    // 先还 L0 债，所以 tick 到出现 L1 为止
    for (let i = 0; i < 8 && !rowsOf(dir).some((r) => r.level === 1); i++) await session.summarizeIdle()
    const rows = rowsOf(dir)
    const l1 = rows.find((r) => r.level === 1)
    expect(l1?.text).toContain('L1【索引】')
    expect(l1?.inContext).toBe(false) // 待生效
    const members = rows.filter((r) => r.level === 0 && r.supersededBy === l1?.id)
    expect(members.length).toBeGreaterThanOrEqual(2)
    for (const m of members) {
      expect(m.inContext).toBe(true) // 成员开关没动——这就是「只写库」
    }

    // **合并写入后、生效前** kill -9（不走 close）。重启后待生效的合并还在，
    // 下一个压缩点把它换进来（重启后第一问就超预算——压缩点）
    void session
    const rec2 = recordingStream([says(reply('答四'))])
    const session2 = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec2.stream,
      fetchImpl: smartFetch('L0：读了文件', 'L1【索引】：这一段定下了架构'),
      skipLock: true,
    })
    await drain(session2.send(long('重启后的问题')))
    await session2.close()

    const afterRestart = textOf(rec2.sent.at(-1)?.messages)
    expect(afterRestart).toContain('L1【索引】')
    expect(afterRestart).not.toContain('L0：读了文件')
    const after = rowsOf(dir)
    expect(after.find((r) => r.level === 1)?.inContext).toBe(true)
    const stillActive = after.filter((r) => r.level === 0 && r.inContext)
    for (const m of members) {
      expect(stillActive.map((r) => r.id)).not.toContain(m.id)
    }
  })

  it('**级联：分批生效的 L0 先合成 L1a，下一批合成 L1b 时级联出 L2**', async () => {
    const { dir, globalPath } = await workspace({
      memory: {
        unloadTargetRatio: 0.001,
        stubTurns: 1,
        keepHeadChars: 10,
        clipThresholdChars: 0,
        // 三级递进（2026-09-12）：L0 进场由存根段水位驱动。夹具消息小，
        // 默认 16k 的水位线永远不超 → 摘要永不进场 → 合并级联全部冻结。
        // 压到 1 让每次卸载后存根段都超线，进场/合并的链路照旧被测到
        stubTokens: 1,
        mergeFactor: 2,
        idleSummarizeDelayMs: 0,
      },
    })
    const stream: LoopDeps['stream'] = () =>
      (async function* () {
        for (const ev of saysWithTool(reply('这是一段回答'))) yield ev
      })()
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream,
      fetchImpl: smartFetch('L0：读了文件', 'L1【索引】'),
      skipLock: true,
    })
    const drain2 = async (source: AsyncIterable<AgentEvent>) => {
      for await (const _ of source) {
        // 跑完
      }
    }
    const long2 = (l: string) => `${l}${'。这是把上下文撑大而重复的内容'.repeat(15)}`
    /**
     * 已整体卸载的 **turn** id 列表。
     *
     * **数 turn 不数 step**：摘要单位是 turn（§4.5 ④），两个卸载的 step 常常
     * 同属一个 turn，那只出一条 L0——按 step 数的话夹具在「攒够 2 个」时其实
     * 只有 1 条 L0，mergeFactor=2 永远不触发，现象是「消息发够了合并却没做」，
     * 看起来像合并坏了
     */
    const coldTurns = (): number[] =>
      new DatabaseSync(join(dir, '.simple-code/memory/state.db'), { readOnly: true })
        .prepare('SELECT DISTINCT turn_id FROM steps WHERE unloaded = 1 ORDER BY turn_id')
        .all()
        .map((r) => (r as { turn_id: number }).turn_id)

    // 第一批：发消息攒出 ≥2 个整体卸载的 turn（期间不 idle——L0 不存在就
    // 没有可合并的，时序由测试自己掌控）
    let sent = 0
    while (coldTurns().length < 2 && sent < 12) {
      await drain2(session.send(long2(`第${++sent}个问题`)))
    }
    expect(coldTurns().length).toBeGreaterThanOrEqual(2) // 前提

    // idle 逐个还 L0 债；债清那次调用里 mergeWhileDue 把当时 active 的
    // 前缀 run 收成 L1a（待生效，in_context=0）
    // 前缀不变式：L0 只在压缩点进场，合并的原料（in_context 的 L0）要靠
    // 请求来放进来——空闲几次就插一问
    for (let i = 0; i < 40 && rowsOf(dir).filter((r) => r.level === 1).length === 0; i++) {
      await session.summarizeIdle()
      if (i % 4 === 3) await drain2(session.send(long2(`第${++sent}个问题`)))
    }
    const l1a = rowsOf(dir).find((r) => r.level === 1)
    expect(l1a).toBeDefined()
    expect(l1a?.inContext).toBe(false) // 只写库
    expect(l1a?.coversFrom).toBe(1)
    const firstBatch = coldTurns()

    // 第二批：再攒 ≥2 个新卸载的 turn；idle 债清后合并 L1b，
    // 同一个 mergeWhileDue 循环里 L1a+L1b 级联出 L2
    // 上界从 12 抬到 24：挑选会跳过卸不动的消息（短消息不再被无意义地卸载），
    // 一轮 send 卸掉的量因此变少，攒够要多发几轮。
    // **上界只是防死循环的保险，不是被测行为**——真正的终止条件是前面那个 filter
    while (coldTurns().filter((id) => !firstBatch.includes(id)).length < 2 && sent < 24) {
      await drain2(session.send(long2(`第${++sent}个问题`)))
    }
    for (let i = 0; i < 60 && rowsOf(dir).filter((r) => r.level === 2).length === 0; i++) {
      await session.summarizeIdle()
      if (i % 4 === 3) await drain2(session.send(long2(`第${++sent}个问题`)))
    }

    const rows = rowsOf(dir)
    const steps = new (require('node:sqlite').DatabaseSync)(join(dir, '.simple-code/memory/state.db'), { readOnly: true }).prepare('SELECT id, unloaded FROM steps ORDER BY id').all()
    console.log('PROBE', JSON.stringify({ rows: rows.map((r) => ({ l: r.level, f: r.coversFrom, ic: r.inContext })), steps }))
    const l2 = rows.find((r) => r.level === 2)
    expect(l2).toBeDefined()
    expect(l2?.coversFrom).toBe(1)
    const l1s = rows.filter((r) => r.level === 1)
    expect(l1s.length).toBeGreaterThanOrEqual(2)
    expect(l1s.every((r) => r.supersededBy === l2?.id)).toBe(true)
    // 被两级收编的 L0 全部 superseded，且各归各的 L1
    const l0s = rows.filter((r) => r.level === 0 && r.supersededBy !== null)
    expect(l0s.length).toBeGreaterThanOrEqual(4)
    expect(l0s.every((r) => l1s.some((l1) => l1.id === r.supersededBy))).toBe(true)
    await session.close()
  })

  it('**对照：mergeFactor 没攒够就不合**——合并是攒够才做，不是到点就做', async () => {
    const { dir, globalPath } = await workspace({
      memory: {
        unloadTargetRatio: 0.001,
        stubTurns: 1,
        keepHeadChars: 40,
        clipThresholdChars: 0,
        stubTokens: 1, // 同上：水位不超线摘要不进场，对照组测不到「没合」
        mergeFactor: 5,
        idleSummarizeDelayMs: 0,
      },
    })
    const rec = recordingStream([says(reply('答一')), says(reply('答二')), says(reply('答三'))])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: smartFetch('L0：读了文件', '不该出现的 L1'),
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await session.summarizeIdle()
    await session.summarizeIdle()
    await drain(session.send(long('第三个问题'))) // 卸载 + L0×2 生效
    await session.summarizeIdle() // 空闲，但 2 < 5 不合

    expect(rowsOf(dir).filter((s) => s.level === 1)).toEqual([])
    await session.close()
  })

  /**
   * 攒够条数**不再是**合并的触发条件，索引区超没超配额才是。
   *
   * 真库照出来的病：索引区上限 12,000 token、当时只用了 319（2.7%），25 条
   * 写得好好的 L0 叶子已经被折成一行关键词——「攒够 10 条」在第 7 个 turn
   * 就满足了，而按配额算要到第 87 个 turn 才轮得到第一次折叠。折叠是有损的
   * （叶子的 description 从 context 里消失，只剩路径），在还装得下的时候折纯亏。
   *
   * 两组只差 `indexRatio` 一个字段。差别放在别处（比如调 mergeFactor）的话，
   * 测的就还是老那条触发条件。
   */
  /**
   * **夹具是「问题短、回答长」**：`head` 取的是 user 消息的开头（`headOfStep`），
   * 跟 `keepHeadChars` 无关，也裁不到 40 字——问题写长了单条摘要连壳带头部就
   * 340 token，两条 680，在这个 500 的预算里怎么调比例都装不下，两组分不开。
   * 撑破预算的活交给 assistant 回复，那也更像真实会话。
   */
  const bigReply = (l: string) => `${l}${'。这段回答很长必须够长才卸得动'.repeat(40)}`

  const sixTurnsThen = async (indexRatio: number) => {
    const { dir, globalPath } = await workspace({
      memory: {
        unloadTargetRatio: 0.001,
        stubTurns: 1,
        keepHeadChars: 40,
        clipThresholdChars: 0,
        mergeFactor: 2, // **攒得够**：老条件下这里必合
        idleSummarizeDelayMs: 0,
        indexRatio,
      },
    })
    const rec = recordingStream(Array.from({ length: 7 }, (_, i) => says(bigReply(String(i)))))
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: smartFetch('L0：读了文件', 'L1：合并了'),
      skipLock: true,
    })
    for (let n = 1; n <= 6; n++) await drain(session.send(`q${n}问题很短`))
    // 一次 tick 补一个 step 的 L0，先把债还清，最后几 tick 才轮得到合并
    for (let i = 0; i < 14; i++) await session.summarizeIdle()
    // 前缀不变式：L0 只落 ready，再问一句（超预算 = 压缩点）放进场，之后
    // 的空闲 tick 才轮得到合并判断
    await drain(session.send('q7问题很短'))
    for (let i = 0; i < 4; i++) await session.summarizeIdle()
    const rows = rowsOf(dir)
    await session.close()
    return rows
  }

  it('**索引区没超配额就不合，哪怕条数攒够了**', async () => {
    // 预算 500（窗口 3,000 − maxTokens 500 − reserved 2,000），配额 = 500×0.5
    // = 250 token。实测索引区 4 条叶子共 155 token，装得下
    const rows = await sixTurnsThen(0.5)

    // 前提一：生效的叶子确实 ≥ mergeFactor，否则测的是「压根没攒够」
    const active = rows.filter((r) => r.level === 0 && r.inContext)
    expect(active.length).toBeGreaterThanOrEqual(2)

    expect(rows.filter((r) => r.level === 1)).toEqual([])
    // 一条都没被收编——叶子正文还在 context 里，这才是不合的收益
    expect(rows.every((r) => r.supersededBy === null)).toBe(true)
  })

  it('**对照：配额调到装不下，同一批叶子立刻就合**', async () => {
    // 配额 = 500×0.001 = 0.5 token，怎么都超。**只有 indexRatio 变了**
    const rows = await sixTurnsThen(0.001)

    expect(rows.filter((r) => r.level === 1).length).toBeGreaterThanOrEqual(1)
    expect(
      rows.filter((r) => r.level === 0 && r.supersededBy !== null).length,
    ).toBeGreaterThanOrEqual(2)
  })
})
