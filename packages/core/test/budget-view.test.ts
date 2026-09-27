import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Message, Request, Usage } from '../src/llm/types.ts'
import type { LiveMessage, Summary } from '../src/loop/assemble.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import { type LoopContext, type LoopDeps, run } from '../src/loop/run.ts'

/**
 * 预算判断的口径：**必须和真正发出去的那份一致**。
 *
 * 摘要顶替（§4.1）让 `ctx.messages` 和 `request.messages` 分了家——被覆盖的
 * live 消息整条不出现在请求里，但一直留在内存历史里。预算判断若照着内存历史
 * 算，就把「根本没发出去的那些」也算进用量，虚高到触发误归档。
 *
 * 5b63f04 修过同一个坑的另外半边（基线下标记成了拼装后数组的长度）。那次修的是
 * 基线，这次修的是被基线之后那段遍历到的范围——两处都错才凑出完整的虚高。
 */

const usage = (inputTokens: number): Usage => ({
  inputTokens,
  outputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

const says = (role: Message['role'], text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})

const summary = (over: Partial<Summary> & Pick<Summary, 'coversFrom' | 'coversTo'>): Summary => ({
  owner: null,
  id: over.coversFrom,
  level: 0,
  name: '',
  text: `第 ${over.coversFrom} 轮的摘要`,
  status: 'ready',
  inContext: true,
  supersededBy: null,
  head: null,
  archivePath: null,
  ...over,
})

type RunResult = {
  events: AgentEvent[]
  sent: Request[]
  unloadCalls: number
}

/**
 * 跑一轮。`contextWindow` 由用例给，因为这些用例测的正是「该不该触发卸载」。
 *
 * 第一轮没有 `lastUsage` 基线，全靠估算——所以用例里的消息内容长度就是
 * 唯一的用量来源，好钉死。
 */
async function runOnce(options: {
  messages: Message[]
  turnOf: number[]
  summaries: Summary[]
  contextWindow: number
}): Promise<RunResult> {
  const sent: Request[] = []
  let unloadCalls = 0

  const stream: LoopDeps['stream'] = (request) => {
    sent.push(structuredClone(request))
    return (async function* () {
      yield { type: 'finish', reason: 'stop', usage: usage(1) } as StreamEvent
    })()
  }

  const deps: LoopDeps = {
    now: () => 0,
    stream,
    tools: new Map(),
    root: '/tmp',
    caps: { images: true },
    request: {
      model: 'm',
      maxTokens: 0,
      thinking: 'disabled',
      effort: 'high',
      reasoningDisplay: 'omitted',
      system: '',
      tools: [],
    },
    maxIterations: 5,
    memory: {
      cues: () => new Map(),
      contextWindow: options.contextWindow,
      targetRatio: 0.5,
      // 时间维度给「不触发」的值：这些用例只测预算这一条触发路径
      cacheTtlMs: Number.MAX_SAFE_INTEGER,
      now: () => 0,
      lastResponseAt: () => null,
      markResponded: () => {},
      stubTokens: 1e9,
      stubTurns: 1e9,
        floorTokens: 1,
      // 0 是为了让预算就是窗口本身，用例里的数字直接可推算
      safetyMargin: 0,
      clipThresholdChars: 1_000,
      keepHeadChars: 20,
      // 必须返回和 indices 等长的 ref：run.ts 靠 `refs[nth]` 才会真的改写
      // 消息并计入 count，返回空数组的话「卸载发生了」这件事测不出来
      unload: (indices) => {
        unloadCalls += indices.length
        return indices.map(() => ({ archivePath: 'turns/t.jsonl', turnId: 1, stepId: 1 }))
      },
      leafBodies: () => new Map(),
      hotLeaves: 2,
      demoteBatch: 10,
      markCold: () => {},
      activateSummary: () => false,
      summaries: () => options.summaries,
      applyMerges: () => new Set<number>(),
      recordRegions: () => {},
      pruneMessages: () => {},
      remap: () => {},
      // **stepId 一条一个**，不跟着 turnId 走：保底区会把最后一个 step 整个
      // 圈回来（floorStartIndex），十条挤在一个 step 里的话保底区吞掉全部，
      // 卸载一条都挑不出来——那样对照组测不到东西
      withTurns: (msgs: Message[]): LiveMessage[] =>
        msgs.map((message, index) => ({
          message,
          turnId: options.turnOf[index] ?? 0,
          stepId: index,
        })),
    },
  }

  const ctx: LoopContext = {
    messages: options.messages,
    tasks: [],
    deps,
    signal: new AbortController().signal,
  }
  const events: AgentEvent[] = []
  for await (const agentEv of run(ctx)) events.push(agentEv)
  return { events, sent, unloadCalls }
}

/** 一条约 1000 token 的消息（4 字符/token 的纯 ASCII） */
const bulk = (tag: string): string => `${tag}:${'x'.repeat(4000)}`

/**
 * 一次工具往返（assistant 的 call + tool 的 result）。
 *
 * 两条**必须成对**：`normalizeHistory` 的 `removeOrphanOutputs` 会丢掉没有
 * 配对 tool_call 的 tool_result，单发 result 的话消息在进 loop 第一步就没了。
 *
 * 用工具 I/O 而不是纯文本，是因为 `unloadMessage` **只裁工具 I/O**
 * （§11.4「对话文本免裁」）：纯文本的 `savingOf` 恒为 0，会被调用方的
 * `filter(saved > 0)` 全部滤掉——对照组就永远看不到卸载发生
 */
const toolRoundTrip = (tag: string): Message[] => [
  {
    role: 'assistant',
    parts: [{ type: 'tool_call', id: tag, name: 'bash', input: { command: `echo ${tag}` } }],
  },
  {
    role: 'tool',
    parts: [{ type: 'tool_result', toolCallId: tag, output: bulk(tag), isError: false }],
  },
]

describe('预算判断的口径跟随真正发出去的那份', () => {
  it('被摘要顶替的消息不该算进用量', async () => {
    // 10 组工具往返（各约 1000 token），全部被一条摘要覆盖；末尾一条当前消息。
    // 内存历史 ≈ 10,000 token，但真正发出去的只有「摘要 + 当前消息」≈ 几十。
    const old = Array.from({ length: 10 }, (_, i) => toolRoundTrip(`旧${i}`)).flat()
    const messages = [...old, says('user', '当前问题')]
    const turnOf = [...old.map(() => 1), 2]

    const result = await runOnce({
      messages,
      turnOf,
      // covers 是 **step 区间**，而 withTurns 给的是一条消息一个 step，
      // 所以要盖住 0..old.length-1 才是「这些老消息全被顶替」
      summaries: [summary({ coversFrom: 0, coversTo: old.length - 1, text: '前十轮：都是旧的' })],
      // 预算 = 窗口 - maxTokens(0) - safetyMargin(0) = 5,000。
      // 内存历史 10,000 远超它；发出去的那份远低于它。口径决定了触发与否
      contextWindow: 5_000,
    })

    // —— 前提断言：不加这些的话，下面那条「没触发」可能是因为压根没顶替 ——
    const sentText = JSON.stringify(result.sent[0]?.messages ?? [])
    expect(sentText).toContain('前十轮：都是旧的') // 摘要确实生效了
    expect(sentText).not.toContain('旧0') // 那 10 组确实没发出去
    expect(messages).toHaveLength(old.length + 1) // 内存历史确实还留着

    // —— 结论 ——
    expect(result.events.filter((e) => e.type === 'unloaded')).toHaveLength(0)
    expect(result.unloadCalls).toBe(0)
  })

  it('对照组：没有摘要顶替时，同样的历史照常触发', async () => {
    // 和上一个用例**只差摘要**。两个都通过才说明上面那条测的是口径，
    // 而不是「预算判断整个没在工作」（CLAUDE.md §6.1 的对照组要求）
    const old = Array.from({ length: 10 }, (_, i) => toolRoundTrip(`旧${i}`)).flat()
    const messages = [...old, says('user', '当前问题')]
    const turnOf = [...old.map(() => 1), 2]

    const result = await runOnce({
      messages,
      turnOf,
      summaries: [],
      contextWindow: 5_000,
    })

    expect(result.events.filter((e) => e.type === 'unloaded').length).toBeGreaterThan(0)
    expect(result.unloadCalls).toBeGreaterThan(0)
  })
})
