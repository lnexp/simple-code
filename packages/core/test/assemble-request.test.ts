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

/** 跑一轮，返回真正发出去的那份消息 */
async function sentMessages(options: {
  messages: Message[]
  turnOf: number[]
  summaries: Summary[]
  /** false = summaryInContext 关（压缩换召回，summary-on-demand.md） */
  summaryInContext?: () => boolean
  /** lean 身份判据：这些 step 的消息整块不进装配（2026-11-03） */
  unloadedSteps?: () => Set<number>
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
      stubSteps: 1e9,
      floorTokens: 1,
      safetyMargin: 0,
      clipThresholdChars: 1_000,
      keepHeadChars: 20,
      unload: () => [],
      leafBodies: () => new Map(),
      hotLeaves: 2,
      demoteBatch: 10,
      markCold: () => {},
      markStubs: () => {},
      activateSummary: () => false,
      summaries: () => options.summaries,
      applyMerges: () => new Set<number>(),
      recordRegions: () => {},
      pruneMessages: () => {},
      remap: () => {},
      cues: () => new Map(),
      ...(options.summaryInContext !== undefined
        ? { summaryInContext: options.summaryInContext }
        : {}),
      ...(options.unloadedSteps !== undefined ? { unloadedSteps: options.unloadedSteps } : {}),
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
  it('summaryInContext=false（精简模式）：摘要不进，存根行不进，库里 live 原样发', async () => {
    // 2026-11-03 拍板 + 163d010 复盘修正：精简 = 过滤库里存根行（被切的老
    // 消息以存根形态在库），不是每轮现算 floor——滑动窗口会打穿缓存
    // （prefix-guard 当场拦停）。库里 live 原样发（分辨率比摘要行高）
    const input = {
      messages: [
        says('user', '第一轮问题'),
        says('assistant', '第一轮回答'),
        says('user', '当前问题'),
      ],
      turnOf: [1, 1, 2],
      summaries: [summary({ coversFrom: 1, coversTo: 1, text: '第一轮：读了配置文件' })],
    }
    const sent = await sentMessages({ ...input, summaryInContext: () => false })
    const text = textOf(sent)
    expect(text).not.toContain('第一轮：读了配置文件') // 摘要不进
    expect(text).toContain('第一轮问题') // 库里 live 原样发
    expect(text).toContain('当前问题')
    expect(text).not.toContain('已硬切') // 没有存根行就没有切，不垫提示
    expect(text).toContain('当前问题')
    // 对照：不关（缺省）时还是老行为——被覆盖的换摘要行
    const control = await sentMessages(input)
    const controlText = textOf(control)
    expect(controlText).toContain('第一轮：读了配置文件')
    expect(controlText).not.toContain('第一轮问题')
  })

  it('summaryInContext 传函数：同一夹具返回值一变，下一次装配即时跟随（面板开关）', async () => {
    // deps 是构造时快照，开关切换后值传就死了——函数每次装配现读，
    // 这是上下文面板开关「下一轮生效」的机制（2026-11-03）
    let on = true
    const input = {
      messages: [says('user', '第一轮问题'), says('user', '当前问题')],
      turnOf: [1, 2],
      summaries: [summary({ coversFrom: 1, coversTo: 1, text: '第一轮：读了配置文件' })],
    }
    const sentOn = await sentMessages({ ...input, summaryInContext: () => on })
    expect(textOf(sentOn)).toContain('第一轮：读了配置文件')

    on = false
    const sentOff = await sentMessages({ ...input, summaryInContext: () => on })
    expect(textOf(sentOff)).not.toContain('第一轮：读了配置文件')
    // 精简语义：floor 之外硬切（上一条用例的对照已覆盖「关时在场才
    // 直出」的旧断言，这里只测函数跟随）
    expect(textOf(sentOff)).toContain('当前问题')
  })

  it('精简模式过滤存根行（2026-11-03 复盘修正）：被切的老消息不进装配，N=存根行数', async () => {
    // 老的 20 条已卸载成存根形态（正文 + 行尾〔已卸载〕标记），新的 2 条 live
    const messages: Message[] = []
    for (let i = 0; i < 20; i++)
      messages.push(
        says(
          'user',
          `旧消息${i}\n# [已卸载，完整内容见 .simple-code/memory/turns/000/turn-0000${i}.jsonl]`,
        ),
      )
    messages.push(says('assistant', '新1'), says('user', '新2'))
    const sent = await sentMessages({
      messages,
      turnOf: messages.map((_, i) => i),
      summaries: [],
      summaryInContext: () => false,
    })
    const text = textOf(sent)
    expect(text).not.toContain('旧消息') // 存根行全部不进装配
    expect(text).toContain('新1')
    expect(text).toContain('新2')
    // 顶部垫硬切提示，N = 被滤掉的 20 条存根行（库里不变它就不变——
    // 只在压缩点变，前缀改写在那里合法）
    expect(sent[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('已硬切 20 条'),
    })
    // 对照（缺省非精简）：存根行照发
    const control = await sentMessages({
      messages,
      turnOf: messages.map((_, i) => i),
      summaries: [],
    })
    expect(textOf(control)).toContain('旧消息0')
    expect(textOf(control)).not.toContain('已硬切')
  })

  it('精简模式过滤 tool_result 存根（2026-11-03 第二次修正）：通知在 output 尾部，不看 text part', async () => {
    // 第一次实现只查 text part——真机主任务 38k 条卸载消息几乎全是
    // tool_result（通知在 output 尾部），全部穿透照发。isStubPart 口径
    // （regions 记账同款）：tool_result.output / tool_call.command 行尾
    // 存根 tool_result 必须配对 tool_call（normalize 会删孤儿输出）
    const call: Message = {
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 'call_x', name: 'bash', input: { command: 'ls -la' } }],
    }
    const stubTool: Message = {
      role: 'tool',
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'call_x',
          output:
            'total 360\ndrwxr-xr-x …\n# [已卸载，完整内容见 .simple-code/memory/turns/000/turn-000001.jsonl]',
          isError: false,
        },
      ],
    }
    const messages = [call, stubTool, says('user', '下一步')]
    const sent = await sentMessages({
      messages,
      turnOf: [0, 0, 1],
      summaries: [],
      summaryInContext: () => false,
    })
    const text = textOf(sent)
    expect(text).not.toContain('total 360') // tool_result 存根不进
    // 配对 tool_call 的 command 没裁剪标记，是 live 照发（textOf 不渲染
    // tool_call 内容，按消息对象查）
    expect(sent.some((m) => m.parts.some((p) => p.type === 'tool_call'))).toBe(true)
    expect(text).toContain('下一步')
    expect(sent[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('已硬切 1 条'),
    })
    // 对照（非精简）：照发
    const control = await sentMessages({ messages, turnOf: [0, 0, 1], summaries: [] })
    expect(
      control.some((m) =>
        m.parts.some((p) => p.type === 'tool_result' && p.output.includes('total 360')),
      ),
    ).toBe(true)
  })

  it('精简模式按 stepId 身份过滤（2026-11-03 第三次修正）：已卸载 step 的对话文字也滤掉', async () => {
    // 卸载只裁 tool I/O，text/reasoning 原样穿过（unloadPart 的设计）——
    // 「已卸载 step 的对话」没有存根标记，靠 unloadedSteps 身份判据。
    // 短 tool I/O（裁了反而更长）同样只有身份判据能滤
    const messages: Message[] = [
      says('user', '老step的提问'), // step 1：已卸载，纯对话
      says('assistant', '老step的回答'), // step 1
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'ls' } }], // step 1：配对 call
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 'c1', output: '短', isError: false }], // step 1：短输出裁不动
      },
      says('user', '新step的提问'), // step 2：在场
    ]
    const sent = await sentMessages({
      messages,
      turnOf: [1, 1, 1, 1, 2],
      summaries: [],
      summaryInContext: () => false,
      unloadedSteps: () => new Set([1]),
    })
    const text = textOf(sent)
    expect(text).not.toContain('老step') // 已卸载 step 整块不在场
    expect(text).toContain('新step的提问')
    expect(sent[0]?.parts[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('已硬切 4 条'),
    })
  })

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
