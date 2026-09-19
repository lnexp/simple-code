import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Message, Request, Usage } from '../src/llm/types.ts'
import type { LiveMessage, Summary } from '../src/loop/assemble.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import { type LoopContext, type LoopDeps, run } from '../src/loop/run.ts'

/**
 * 发请求前的拼装（提案 §4.1 定案）。**这是整个 3b-1 唯一对外可见的效果**
 * ——摘要生成、状态机、并发闸都只改库，模型看得见的变化全在这里。
 *
 * 断言的对象是真正发出去的 `request.messages`，不是 `ctx.messages`：
 * 内存历史故意保持 live 原样（摘要不回流，见 store.ts:load 的注释），
 * 断言 ctx 的话测的是「没变」，正好把拼装漏了也测不出来。
 */

const usage = (): Usage => ({
  inputTokens: 1,
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

/** 跑一轮，返回真正发出去的那份消息 */
async function sentMessages(options: {
  messages: Message[]
  turnOf: number[]
  summaries: Summary[]
}): Promise<Message[]> {
  const seen: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    seen.push(structuredClone(request))
    return (async function* () {
      yield { type: 'finish', reason: 'stop', usage: usage() } as StreamEvent
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
      maxTokens: 100,
      thinking: 'disabled',
      effort: 'high',
      reasoningDisplay: 'omitted',
      system: 'S',
      tools: [],
    },
    maxIterations: 5,
    memory: {
      // 窗口给足：这些用例只测拼装，不该顺带触发卸载
      contextWindow: 1_000_000,
      targetRatio: 0.5,
      // 时间维度的注入给「不触发」的默认值：这些用例只测拼装
      cacheTtlMs: Number.MAX_SAFE_INTEGER,
      now: () => 0,
      lastResponseAt: () => null,
      markResponded: () => {},
      stubTokens: 1e9,
    unloadedSteps: () => new Set<number>(),
    floorTokens: 1,
      safetyMargin: 0,
      clipThresholdChars: 1_000,
      keepHeadChars: 20,
      unload: () => [],
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
      withTurns: (msgs: Message[]): LiveMessage[] =>
        msgs.map((message, index) => ({
          message,
          turnId: options.turnOf[index] ?? 0,
          stepId: options.turnOf[index] ?? 0,
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
  return seen[0]?.messages ?? []
}

const textOf = (messages: Message[]): string =>
  messages.map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join('')).join('\n')

describe('发请求前的拼装', () => {
  it('被覆盖的 turn 换成摘要，其余原样', async () => {
    const sent = await sentMessages({
      messages: [
        says('user', '第一轮问题'),
        says('assistant', '第一轮回答'),
        says('user', '当前问题'),
      ],
      turnOf: [1, 1, 2],
      summaries: [summary({ coversFrom: 1, coversTo: 1, text: '第一轮：读了配置文件' })],
    })

    const text = textOf(sent)
    expect(text).toContain('第一轮：读了配置文件')
    expect(text).not.toContain('第一轮问题') // 被顶替
    expect(text).not.toContain('第一轮回答')
    expect(text).toContain('当前问题') // 没被覆盖的一字不动
  })

  it('**顺序不乱**：摘要占原 turn 的位置', async () => {
    // 追加在末尾的话，模型会以为"先发生了第二轮，然后有人总结了第一轮"，
    // 因果顺序反了。不报错，只是回答会莫名其妙
    const sent = await sentMessages({
      messages: [says('user', '一'), says('user', '二'), says('user', '三')],
      turnOf: [1, 2, 3],
      summaries: [summary({ coversFrom: 2, coversTo: 2, text: '中间那轮' })],
    })

    // 按**消息**验，不按行——摘要自己就是多行的，split('\n') 会把它切成三段
    // （第一版这么写，红了才发现测的是换行位置不是消息顺序）
    expect(sent).toHaveLength(3)
    expect(textOf([sent[0] as Message])).toBe('一')
    expect(textOf([sent[1] as Message])).toContain('中间那轮')
    expect(textOf([sent[2] as Message])).toBe('三')
  })

  it('**对照：inContext=false 的摘要一个字节都不进**', async () => {
    // §9.1 的核心不变量。摘要生成好但那个 turn 还没被卸载时就是这个状态——
    // 没有这条的话，「有摘要就用」也能让上面两条全绿
    const sent = await sentMessages({
      messages: [says('user', '第一轮问题'), says('user', '当前问题')],
      turnOf: [1, 2],
      summaries: [summary({ coversFrom: 1, coversTo: 1, inContext: false })],
    })

    expect(textOf(sent)).toContain('第一轮问题')
    expect(textOf(sent)).not.toContain('摘要')
  })

  it('**内存历史不受影响**', async () => {
    // 拼装只作用于「要发出去的那份」。改了 ctx.messages 的话摘要会随 save
    // 回流进 live 行，重启一次多一份（store.test.ts 那条往返测试的同一个 bug）
    const messages = [says('user', '第一轮问题'), says('user', '当前问题')]
    await sentMessages({
      messages,
      turnOf: [1, 2],
      summaries: [summary({ coversFrom: 1, coversTo: 1 })],
    })

    expect(messages[0]).toEqual(says('user', '第一轮问题'))
  })

  it('头部和归档路径都在摘要里', async () => {
    // 三样缺一不可（提案 §4.1 评审修正二）：头部是原始锚点，摘要是判断依据，
    // 路径是取回原文的唯一线索——缺了路径模型知道该展开却不知道去哪 cat
    const sent = await sentMessages({
      messages: [says('user', '一'), says('user', '当前')],
      turnOf: [1, 2],
      summaries: [
        summary({
          coversFrom: 1,
          coversTo: 1,
          text: '写入 src/auth.ts 约 500 行',
          head: '把 auth 中间件补上 JWT 校验',
          archivePath: '.simple-code/memory/turns/turn-000001.jsonl',
        }),
      ],
    })

    const text = textOf(sent)
    expect(text).toContain('把 auth 中间件补上 JWT 校验')
    expect(text).toContain('写入 src/auth.ts 约 500 行')
    expect(text).toContain('turn-000001.jsonl')
  })

  it('没有摘要时原样发', async () => {
    const messages = [says('user', '一'), says('assistant', '二')]
    const sent = await sentMessages({ messages, turnOf: [1, 1], summaries: [] })

    expect(sent).toEqual(messages)
  })

  it('一条摘要覆盖多个 turn 时只出现一次', async () => {
    // 3b-2 的分层合并会产出这种行。现在还不会有，但拼装已经要处理——
    // 每个被覆盖的 turn 各发一遍的话，同一段摘要在 context 里重复 N 次
    const sent = await sentMessages({
      messages: [says('user', '一'), says('user', '二'), says('user', '当前')],
      turnOf: [1, 2, 3],
      summaries: [summary({ coversFrom: 1, coversTo: 2, text: '前两轮的合并摘要' })],
    })

    expect(textOf(sent).match(/前两轮的合并摘要/g)).toHaveLength(1)
    expect(sent).toHaveLength(2) // 摘要 + 当前轮
  })

  it('**turn 被卸载到一条 live 都不剩时，摘要照样发出去**', async () => {
    // 整个 turn 卸光的情况。「遍历 live 消息、遇到被覆盖的就替换」那种写法
    // 在这里会整条摘要漏发——一段历史凭空消失，不报错
    const sent = await sentMessages({
      messages: [says('user', '当前问题')],
      turnOf: [5],
      summaries: [summary({ coversFrom: 1, coversTo: 1, text: '早就卸掉的那轮' })],
    })

    expect(textOf(sent)).toContain('早就卸掉的那轮')
    expect(textOf(sent)).toContain('当前问题')
  })

  it('摘要是 user 消息，不是 assistant', async () => {
    // assistant 的话模型会当成"我自己说过的话"，第一人称对不上
    const sent = await sentMessages({
      messages: [says('user', '一'), says('user', '当前')],
      turnOf: [1, 2],
      summaries: [summary({ coversFrom: 1, coversTo: 1 })],
    })

    expect(sent[0]?.role).toBe('user')
  })
})
