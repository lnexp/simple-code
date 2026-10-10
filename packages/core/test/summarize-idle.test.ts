import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE, openStore } from '../src/session/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-idle'

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
  // 本文件的夹具全是短消息（'回答' 这种），默认阈值 100 会把它们全送进
  // 本地 L0 路径、不调模型——这里测的是模型链路，关掉阈值；本地路径
  // 自己有专门的用例（见「短 step」describe）
  //
  // idleSummarizeDelayMs 关掉是为了**隔离触发点**：本文件绝大多数用例测的是
  // 手工入口 `summarizeIdle()`，自动的 step_finish 触发（§9.7 修正二）会在
  // send 之后凭空多摘几条，把「调了 N 次就该有 N 条」这类断言全冲掉。
  // 测自动触发的那几条自己把它打开
  memory: { summaryMinTokens: 0, idleSummarizeDelayMs: 0 },
}

/**
 * 同一个 provider 下两个模型，**路由参数和 maxTokens 都不一样**。
 *
 * 照着真实使用场景构造：网关靠 `extraBody.providerId` 分流，
 * 主模型和摘要模型的值不同。摘要请求若拿了主模型的 providerId，就是
 * 「model 换了、路由没换」——发给错的后端，而且不报错
 */
const TWO_MODELS = {
  p: {
    protocol: 'anthropic-messages',
    baseUrl: 'https://example.invalid',
    apiKey: '${TEST_KEY}',
    models: {
      m: { contextWindow: 100_000, request: { maxTokens: 16_000 }, extraBody: { providerId: 51 } },
      便宜模型: {
        contextWindow: 100_000,
        request: { maxTokens: 1_000 },
        extraBody: { providerId: 95 },
      },
    },
  },
}

async function workspace(over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-idle-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  // memory 段浅合并：单独覆盖 summaryModel 时不能把 CONFIG 里的
  // summaryMinTokens 冲掉（整对象替换的坑，第一版就是这么挂的）
  await writeFile(
    globalPath,
    JSON.stringify({
      ...CONFIG,
      ...over,
      memory: { ...CONFIG.memory, ...(over.memory as Record<string, unknown>) },
    }),
    'utf8',
  )
  return { dir, globalPath }
}

const SUMMARY_SSE = (text: string) =>
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
 * 摘要用的 fetch。`gate` 非空时请求会卡在那儿，好观察「正在跑」的状态。
 * 记下每次请求的 body，用来断言不带工具、用了哪个模型
 */
function summaryFetch(text = '摘要内容') {
  const bodies: Record<string, unknown>[] = []
  // 摘要落库后事件归类也会打这个 fetch（v3：单次判断）。分流记录：
  // 分类请求的 user 首行是 EVENT_CLASSIFY_MARK 标记（无 tools 了）——
  // 原有断言只看摘要，archiveBodies 可顺带断言「归类确实被触发」
  const archiveBodies: Record<string, unknown>[] = []
  let release: (() => void) | undefined
  let gated = false

  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const msgs = Array.isArray(body.messages) ? (body.messages as { content?: unknown }[]) : []
    const first = typeof msgs[0]?.content === 'string' ? msgs[0].content : JSON.stringify(msgs[0]?.content ?? '')
    const isArchive = first.includes('[event-classify]')
    ;(isArchive ? archiveBodies : bodies).push(body)
    if (gated) await new Promise<void>((r) => (release = r))
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(SUMMARY_SSE(text)))
          c.close()
        },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch

  return {
    impl,
    bodies,
    archiveBodies,
    calls: () => bodies.length,
    gate: () => {
      gated = true
    },
    release: () => release?.(),
  }
}

const drain = async (source: AsyncIterable<AgentEvent>) => {
  for await (const _ of source) {
    // 只为跑完
  }
}

/**
 * 等条件成立，返回它最终成没成立。给 step_finish 那个触发点用——它是
 * fire-and-forget，没有 promise 可 await。
 *
 * 返回布尔而不是直接抛：反向用例（断言「不该发生」）也用这一个，
 * 抛的话那边就得反过来包 try
 */
async function waitFor(cond: () => boolean, ms = 1000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  return cond()
}

/** 直接查库里的摘要行 */
const summariesOf = (dir: string) => {
  const store = openStore(dir)
  const rows = store.summaries()
  store.close()
  return rows
}

/** 绕开 openStore 读状态列——它开库时会重置 generating，掩盖掉中间态 */
function rawStatuses(dir: string): string[] {
  const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'), { readOnly: true })
  const rows = db.prepare('SELECT status FROM summaries ORDER BY id').all() as { status: string }[]
  db.close()
  return rows.map((row) => row.status)
}

/** 起一个 session 并聊两轮，好有一个「不是当前 turn」的 turn 可摘要 */
async function sessionWithHistory(
  fetchImpl: typeof fetch,
  over: Record<string, unknown> = {},
  answers = ['答一', '答二'],
) {
  const { dir, globalPath } = await workspace(over)
  const session = await getSession(dir, {
    globalPath,
    env: { TEST_KEY: KEY },
    tools: [],
    stream: scripted(answers.map(says)),
    fetchImpl,
    skipLock: true,
  })
  await drain(session.send('第一个问题'))
  await drain(session.send('第二个问题'))
  return { dir, session }
}

/**
 * 还有几个 turn 等着被摘要（不含当前 turn）。用来做前提断言——
 * 「闸挡住了」和「压根没东西可挑」在外部看起来一模一样，都是不发请求
 */
function pendingTurns(dir: string): number {
  const store = openStore(dir)
  const turns = new Set(store.liveWithTurns().map((entry) => entry.turnId))
  const covered = new Set(store.summaries().map((row) => row.coversFrom))
  store.close()
  const ids = [...turns].sort((a, b) => a - b).slice(0, -1) // 末尾是当前 turn
  return ids.filter((id) => !covered.has(id)).length
}

function scripted(rounds: StreamEvent[][]) {
  let calls = 0
  const stream: LoopDeps['stream'] = () => {
    const round = rounds[calls] ?? []
    calls += 1
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return stream
}

describe('空闲摘要', () => {
  it('生成一条 ready 的 L0 摘要', async () => {
    const f = summaryFetch('看了目录，有 3 个文件')
    const { dir, session } = await sessionWithHistory(f.impl)

    await session.summarizeIdle()
    await session.close()

    const rows = summariesOf(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ready')
    expect(rows[0]?.text).toBe('看了目录，有 3 个文件')
    expect(rows[0]?.level).toBe(0)
  })

  it('摘要请求不带工具', async () => {
    // 给了工具模型可能去跑命令「确认一下」，而摘要不进 agent loop，
    // 跑出来的工具调用没人执行
    const f = summaryFetch()
    const { session } = await sessionWithHistory(f.impl)

    await session.summarizeIdle()
    await session.close()

    expect(f.calls()).toBe(1) // 前提：确实发了摘要请求
    expect(f.bodies[0]?.tools).toEqual([])
  })

  it('summaryModel 为 null 时用主模型', async () => {
    const f = summaryFetch()
    const { session } = await sessionWithHistory(f.impl)

    await session.summarizeIdle()
    await session.close()

    expect(f.bodies[0]?.model).toBe('m')
  })

  it('配了 summaryModel 就用它', async () => {
    // 对照组：没有这条的话，「永远用主模型」也能让上面那条通过
    const f = summaryFetch()
    const { session } = await sessionWithHistory(f.impl, {
      providers: TWO_MODELS,
      memory: { summaryModel: '便宜模型' },
    })

    await session.summarizeIdle()
    await session.close()

    expect(f.bodies[0]?.model).toBe('便宜模型')
  })

  it('**同一时刻最多一个在跑**', async () => {
    // 并发闸。不封的话用户敲得快就会堆出一串并发请求，撞速率限制。
    //
    // **必须有两个待摘要的 turn**，否则测的是空集：第一个摘要一建行，
    // 那个 turn 就进了 covered，第二次调用即使没有闸也挑不到东西、不会发请求
    // ——变异检验里去掉闸仍然全绿，就是这么假绿的（CLAUDE.md §6.1）
    const f = summaryFetch()
    const { dir, session } = await sessionWithHistory(f.impl, {}, ['答一', '答二', '答三'])
    await drain(session.send('第三个问题'))
    // 前提：确实有两个 turn 可摘要（共 3 turn，末尾那个是当前 turn）
    expect(pendingTurns(dir)).toBe(2)

    f.gate()
    const first = session.summarizeIdle()
    await new Promise((r) => setTimeout(r, 20))
    expect(f.calls()).toBe(1) // 前提：第一个确实卡在请求里

    // 第二、三次：有 turn 可挑，但该被闸挡住。闸内拿到的是**在途那一次**
    // （2026-09-29 起，不再立即 resolve）——所以这里不 await，否则等的正是
    // 被 gate 卡住的第一次
    let settled = false
    const blocked = Promise.all([session.summarizeIdle(), session.summarizeIdle()]).then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(f.calls()).toBe(1) // 没有第二个请求
    expect(settled).toBe(false) // 等的是在途那次，没提前放行

    f.release()
    await first
    await blocked
    expect(f.calls()).toBe(1) // 在途那次跑完，挡住的两次随之返回，不补发
    await session.close()
  })

  it('跑完之后闸放开，能再摘要下一个 turn', async () => {
    // 对照组：闸如果只落不抬，第一条摘要之后就再也不生成了
    const f = summaryFetch()
    const { dir, session } = await sessionWithHistory(f.impl)

    await session.summarizeIdle()
    // 再聊一轮，制造第二个可摘要的 turn
    await drain(session.send('第三个问题'))
    await session.summarizeIdle()
    await session.close()

    expect(summariesOf(dir)).toHaveLength(2)
  })

  it('已经有摘要的 turn 不重复排队', async () => {
    const f = summaryFetch()
    const { dir, session } = await sessionWithHistory(f.impl)

    // **turn 语义**：一个 turn 一条 L0（超过 segmentTokens 才切段，这里远不到）。
    // 两轮对话切出 4 个 step，最后一个可能还在跑（保守跳过），归到 2 个 turn
    await session.summarizeIdle()
    await session.summarizeIdle()
    await session.summarizeIdle() // 没有新 turn 了
    await session.close()

    const rows = summariesOf(dir)
    expect(rows).toHaveLength(2)
    expect(f.calls()).toBe(2)
    // **对照：至少有一条盖住不止一个 step。** 没有这条的话，退回「一个 step
    // 一条」的实现在别的夹具上也能凑出 2 条，测的就不是 turn 粒度了
    expect(rows.some((row) => row.coversTo > row.coversFrom)).toBe(true)
  })

  it('loop 正在跑的时候照样开摘要', async () => {
    // §9.7 修正二：推翻第三条「用户活跃期间不开新的」。原来这里断言的是
    // `f.calls()` 为 0，理由是「摘要会跟主对话抢速率限额」——那个代价仍然
    // 存在，只是不再压过收益：空闲驱动追不上积压（真实库里攒了 6187 个 step）。
    //
    // **前面得先攒出可摘要的 turn**，否则测的是空集——变异检验里把闸加回去
    // 仍然全绿，因为第一轮时压根没有「非当前 turn」可挑
    const f = summaryFetch()
    const { dir, globalPath } = await workspace()
    let releaseLoop: (() => void) | undefined
    let slow = false
    const stream: LoopDeps['stream'] = () =>
      (async function* () {
        yield { type: 'text_start' } as StreamEvent
        if (slow) await new Promise<void>((r) => (releaseLoop = r))
        yield { type: 'text_delta', text: '答' } as StreamEvent
        yield { type: 'text_end' } as StreamEvent
        yield { type: 'finish', reason: 'stop', usage: usage() } as StreamEvent
      })()

    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream,
      fetchImpl: f.impl,
      skipLock: true,
    })
    await drain(session.send('第一个问题'))
    await drain(session.send('第二个问题'))

    slow = true
    const turn = drain(session.send('第三个问题'))
    await new Promise((r) => setTimeout(r, 20))
    // 两条前提缺一不可：loop 在跑，**而且**确实有 turn 等着被摘要
    expect(session.isRunning()).toBe(true)
    expect(pendingTurns(dir)).toBeGreaterThan(0)

    await session.summarizeIdle()
    expect(f.calls()).toBe(1) // loop 跑着也发了出去

    releaseLoop?.()
    await turn
    await session.close()
  })

  it('摘要请求带的是摘要模型自己的 extraBody 和 maxTokens', async () => {
    // 这个 bug 之所以能存在，就是因为上面两条只断言了 `model` 字段：id 换了、
    // 路由参数没换，看起来完全正常。providerContext 原来写死取 config.model，
    // 发出去的是「model=便宜模型 + providerId=51」，路由到主模型那个后端
    const f = summaryFetch()
    const { session } = await sessionWithHistory(f.impl, {
      providers: TWO_MODELS,
      memory: { summaryModel: '便宜模型' },
    })

    await session.summarizeIdle()
    await session.close()

    expect(f.calls()).toBe(1) // 前提：确实发了摘要请求
    expect(f.bodies[0]?.model).toBe('便宜模型')
    expect(f.bodies[0]?.providerId).toBe(95) // 不是主模型的 51
    expect(f.bodies[0]?.max_tokens).toBe(1_000) // 不是主模型的 16000
  })

  it('对照组：没配 summaryModel 时带的是主模型的', async () => {
    // 同一组字段两个反向断言才能证明是真接了线——只断言「等于 95」的话，
    // 写死成常量 95 也能过
    const f = summaryFetch()
    const { session } = await sessionWithHistory(f.impl, { providers: TWO_MODELS })

    await session.summarizeIdle()
    await session.close()

    expect(f.bodies[0]?.model).toBe('m')
    expect(f.bodies[0]?.providerId).toBe(51)
    expect(f.bodies[0]?.max_tokens).toBe(16_000)
  })

  it('step 跑完自动触发摘要，不用等空闲', async () => {
    // 新触发点本身。**全程不手工调 summarizeIdle**——调了的话测的还是老入口，
    // 触发点接没接上根本测不出来（变异检验：删掉 persist 里那行，这条必须红）
    const f = summaryFetch()
    const { dir, session } = await sessionWithHistory(f.impl, {
      memory: { idleSummarizeDelayMs: 3000 }, // 打开自动触发（本文件默认关着）
    })

    expect(await waitFor(() => f.calls() > 0)).toBe(true)
    // **等行真的落到 ready 再 close。** close() 明确不等在跑的摘要（用户按
    // /exit 不该干等），而没生成完的行会在下次 open 时被删掉——只等
    // `calls() > 0` 的话，请求发出去了但还没回来就关库，重开一看是空的。
    // 摘要单位从 step 改成 turn 之后这个窗口更窄了：整个当前 turn 都不当候选，
    // 唯一能出活的那一脚就在第二轮末尾。
    //
    // **轮询必须走 rawStatuses，不能走 summariesOf。** 后者要 openStore，
    // 而 open 会删掉没生成完的行——每轮一次，等于亲手把要等的东西删掉，
    // 永远等不到（跟下面「生成过程中库里是 generating」那条踩的是同一个坑）
    expect(await waitFor(() => rawStatuses(dir).includes('ready'))).toBe(true)
    await session.close()
    expect(summariesOf(dir).filter((row) => row.status === 'ready').length).toBeGreaterThan(0)
    // 「有东西可摘」这条前提由下面的对照组证明：同样两轮对话、只把开关关掉，
    // pendingTurns 就是正的。这里反而已经被摘空了，正是触发点生效的结果
  })

  it('对照组：总开关关掉时 step 跑完也不摘', async () => {
    // 没有这条的话，「摘要是别的什么路径发出去的」也能让上一条通过。
    // 顺带证明 idleSummarizeDelayMs=0 对新触发点仍然有效
    const f = summaryFetch()
    const { dir, session } = await sessionWithHistory(f.impl, {
      memory: { idleSummarizeDelayMs: 0 },
    })

    expect(pendingTurns(dir)).toBeGreaterThan(0) // 同样有东西可摘，只是关掉了
    expect(await waitFor(() => f.calls() > 0, 150)).toBe(false)
    await session.close()
  })

  it('生成过程中库里是 generating', async () => {
    // 状态机中间那一档。没有这条断言的话，「建行之后直接发请求、不标
    // generating」也全绿——而 resetStaleGenerating 的全部意义就是认出这个状态，
    // 不标的话崩溃残留的行会永远停在 pending，看不出是「排着队」还是「跑挂了」
    const f = summaryFetch()
    f.gate()
    const { dir, session } = await sessionWithHistory(f.impl)

    const task = session.summarizeIdle()
    await new Promise((r) => setTimeout(r, 20))

    // **直接读库，不走 openStore**——它一开就跑 resetStaleGenerating，
    // 会把正在跑的这行冲回 pending，测出来永远是 pending
    expect(rawStatuses(dir)).toEqual(['generating'])

    f.release()
    await task
    await session.close()
  })

  it('**用户在摘要跑的时候发消息，摘要照样跑完**', async () => {
    // §9.7 修正后的规则。原文写的是「立即停止」，但那样在用户连续问短问题时
    // 每条摘要都半路被杀，永远生成不出一条——而那恰好是最需要摘要的时候
    const f = summaryFetch('没被打断')
    f.gate()
    const { dir, session } = await sessionWithHistory(f.impl)

    const summary = session.summarizeIdle()
    await new Promise((r) => setTimeout(r, 20))

    // 用户这时候发消息
    await drain(session.send('插一句'))

    f.release()
    await summary
    await session.close()

    const rows = summariesOf(dir)
    expect(rows[0]?.status).toBe('ready') // 跑完了，不是卡在 generating
    expect(rows[0]?.text).toBe('没被打断')
  })

  it('摘要请求失败不影响任何东西', async () => {
    // 摘要是锦上添花。失败了 context 继续用占位文本，抛出去反而会让
    // 上层的空闲驱动崩掉——拿可选功能的失败换掉整个 REPL，不值
    const boom = (async () => {
      throw new Error('网络炸了')
    }) as unknown as typeof fetch
    const { dir, session } = await sessionWithHistory(boom, {
      loop: { retry: { maxAttempts: 1, initialDelayMs: 1 } },
    })

    await expect(session.summarizeIdle()).resolves.toBeUndefined()

    // **必须在 close 之前查，而且走 rawStatuses 不走 summariesOf。**
    // openStore 自己就会删掉没生成完的行，等关了再看的话「删干净了」的功劳
    // 全算在启动清理头上，进程内那条路径（summarizeSegment 的 finally）
    // 根本没被测到——变异检验实测：把那个 finally 拿掉，整套仍然全绿。
    //
    // 而进程内这条才是重要的那条：长驻的扩展跑几天不重启，全靠它
    expect(rawStatuses(dir)).toEqual([])

    await session.close()
    // 原来这里断言「行还在，占位文本可用」，理由是占位文本在 context 里顶着
    // ——那个前提不成立（activateSummary 的 SQL 写死 status='ready'）。留着
    // 的行会永久占住那一段 step：nextSegment 算「已覆盖」时不看 status
    expect(summariesOf(dir)).toEqual([])
  })

  it('**失败之后那一段还能被重新摘到**——不然「不影响」只是「没崩」', async () => {
    // 上一条只证明行没了。真正要的是这段历史仍然摘得成：先炸一次，再换成
    // 能用的 fetch 摘一次，这次必须落到 ready。少了这条，「失败就永久放弃
    // 这一段」也能让上一条全绿——那正是真库里发生过的事
    const boom = (async () => {
      throw new Error('网络炸了')
    }) as unknown as typeof fetch
    const { dir, session } = await sessionWithHistory(boom, {
      loop: { retry: { maxAttempts: 1, initialDelayMs: 1 } },
    })
    await session.summarizeIdle()
    await session.close()
    expect(summariesOf(dir)).toEqual([]) // 前提：确实失败了、也确实清干净了

    const f = summaryFetch()
    const again = await getSession(dir, {
      globalPath: join(dir, 'settings.json'),
      env: { TEST_KEY: KEY },
      tools: [],
      stream: scripted([says('答三')]),
      fetchImpl: f.impl,
      skipLock: true,
    })
    await again.summarizeIdle()
    await again.close()

    expect(summariesOf(dir).filter((row) => row.status === 'ready').length).toBeGreaterThan(0)
  })

  it('只有一个 turn 时，已完结的 step 照摘（那是历史 step，不是当前）', async () => {
    const f = summaryFetch()
    const { dir, globalPath } = await workspace()
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: scripted([says('答')]),
      fetchImpl: f.impl,
      skipLock: true,
    })
    await drain(session.send('唯一的问题'))

    await session.summarizeIdle()
    await session.close()

    // step 语义：最后一个 step（可能还在跑）跳过，其余照摘
    expect(f.calls()).toBe(1)
    expect(summariesOf(dir)).toHaveLength(1)
  })

  it('ephemeral session 不摘要', async () => {
    // 没有 store 就没地方写摘要
    const f = summaryFetch()
    const { dir, globalPath } = await workspace()
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: scripted([says('答一'), says('答二')]),
      fetchImpl: f.impl,
      skipLock: true,
      ephemeral: true,
    })
    await drain(session.send('一'))
    await drain(session.send('二'))

    await expect(session.summarizeIdle()).resolves.toBeUndefined()
    expect(f.calls()).toBe(0)
    await session.close()
  })

  it('摘要输入里命令和输出成对出现', async () => {
    // §9.6 的核心。前提断言很重要：要确认构造的 turn 确实两者都有，
    // 否则测的是空集（CLAUDE.md §6.1 的「丢弃空 thinking 块」那类无效测试）
    const f = summaryFetch()
    const { dir, globalPath } = await workspace()
    const toolStream: LoopDeps['stream'] = (() => {
      let n = 0
      return () => {
        n += 1
        if (n === 1)
          return (async function* () {
            yield { type: 'tool_input_start', id: 't1', name: 'bash' } as StreamEvent
            yield {
              type: 'tool_input_end',
              id: 't1',
              name: 'bash',
              input: { command: 'ls -la' },
            } as StreamEvent
            yield { type: 'finish', reason: 'tool-calls', usage: usage() } as StreamEvent
          })()
        return (async function* () {
          for (const ev of says('好了')) yield ev
        })()
      }
    })()

    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [
        {
          name: 'bash',
          definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
          execute: async () => ({ output: '总共 3 个文件', exitCode: 0, isError: false }),
        },
      ],
      stream: toolStream,
      fetchImpl: f.impl,
      skipLock: true,
    })
    await drain(session.send('看看目录'))
    await drain(session.send('第二轮'))

    // 前提：第一轮确实有 tool_call 和 tool_result
    const first = JSON.stringify(session.messages())
    expect(first).toContain('ls -la')
    expect(first).toContain('总共 3 个文件')

    // step 语义：把已完结的 step 都摘完（一次 tick 一个），命令对在其中一个
    // step 的输入里。用「所有摘要请求的并集」断言，不猜它在第几个
    for (let i = 0; i < 6; i++) await session.summarizeIdle()
    await session.close()

    const sent = JSON.stringify(f.bodies.flatMap((b) => b.messages ?? []))
    expect(sent).toContain('ls -la')
    expect(sent).toContain('总共 3 个文件')
    void dir
  })
})

describe('短 step 的本地 L0（summaryMinTokens）', () => {
  it('低于阈值：不调模型，落一条 ready 的头部 L0', async () => {
    const f = summaryFetch()
    const { dir, session } = await sessionWithHistory(f.impl, {
      memory: { summaryMinTokens: 100 }, // 默认值；CONFIG 里为测模型链路配了 0
    })

    await session.summarizeIdle() // 一个 tick 一条：第一条是短的
    await session.close()

    expect(f.calls()).toBe(0) // 对照：没花模型调用
    const rows = summariesOf(dir)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('ready') // 不是 pending/generating——本地生成没有中间态
    expect(rows[0]?.text).toBe('第一个问题') // 内容就是原文头，不是「摘要生成中」占位
  })

  it('超过阈值：同一个夹具，长消息走模型拿到摘要文本', async () => {
    const f = summaryFetch()
    const { dir, globalPath } = await workspace({ memory: { summaryMinTokens: 100 } })
    const long = '这是一段足够长的历史消息'.repeat(20) // ~240 token
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: scripted([says('短回答')]),
      fetchImpl: f.impl,
      skipLock: true,
    })
    await drain(session.send(long))
    await drain(session.send('第二个问题'))

    await session.summarizeIdle()
    await session.close()

    expect(f.calls()).toBe(1)
    const rows = summariesOf(dir)
    expect(rows[0]?.text).toBe('摘要内容') // summaryFetch 的固定返回
  })
})
