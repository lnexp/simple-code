import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../src/events.ts'
import type { LLMEvent } from '../src/llm/events.ts'
import { LLMStreamError } from '../src/llm/protocol.ts'
import type { Capabilities, Message, Request, Usage } from '../src/llm/types.ts'
import type { Summary } from '../src/loop/assemble.ts'
import type { RegionSizes } from '../src/loop/regions.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import { type LoopContext, type LoopDeps, run } from '../src/loop/run.ts'
import { relayHit, relaySave } from '../src/loop/relay-cache.ts'
import { estimateMessageTokens } from '../src/loop/tokens.ts'
import type { Tool, ToolContext, ToolOutput } from '../src/tools/types.ts'
import { makePng, mulberry32 } from './make-png'

const CAPS: Capabilities = { images: true }

const usage = (): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})
/** 说一句话就结束 */
const says = (text: string): StreamEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
  { type: 'finish', reason: 'stop', usage: usage() },
]

/** 调一次工具 */
const calls = (id: string, name = 'bash', input: unknown = { command: 'ls' }): StreamEvent[] => [
  { type: 'tool_input_start', id, name },
  { type: 'tool_input_delta', id, partial: JSON.stringify(input) },
  { type: 'tool_input_end', id, name, input },
  { type: 'finish', reason: 'tool-calls', usage: usage() },
]

const fakeTool = (name: string, run?: (ctx: ToolContext) => Promise<ToolOutput>): Tool => ({
  name,
  definition: { name, description: 'd', parameters: { type: 'object' } },
  execute: async (_input, ctx) => (run ? run(ctx) : { output: 'ok', exitCode: 0, isError: false }),
})

type Harness = {
  events: AgentEvent[]
  ctx: LoopContext
  requests: () => number
  /** 每轮实际发出去的 request，用来断言「发出去之前历史已经归一化」 */
  sent: Request[]
}

async function drive(options: {
  rounds?: StreamEvent[][]
  stream?: LoopDeps['stream']
  now?: () => number
  /** 工作区根。默认 '/tmp'；要验证落盘行为时传 mkdtempSync 的真目录 */
  root?: string
  messages?: Message[]
  tools?: Tool[]
  signal?: AbortSignal
  /** 插话软中断持有者（LoopContext.interject）——插话转后台用 */
  interject?: LoopContext['interject']
  maxIterations?: number
  lastFinish?: LoopContext['lastFinish']
  onEvent?: (ev: AgentEvent, ctx: LoopContext) => void
  memory?: LoopDeps['memory']
  /** 上一轮 API 返回的真实 usage。预算判断以它为基线 */
  lastUsage?: Usage
  /** 覆盖 request.maxTokens。预算要给输出留出这么多 */
  maxTokens?: number
  /** 注入 deps.reloadSystem，观测卸载触发点有没有调它 */
  reloadSystem?: LoopDeps['reloadSystem']
  /** 注入 deps.kickSummary，观测水位检查催没催摘要 */
  kickSummary?: LoopDeps['kickSummary']
  /** 注入 deps.taskOverflow（分支跑超）——观测 loop 顶的闸 */
  taskOverflow?: LoopDeps['taskOverflow']
}): Promise<Harness> {
  const scripted = scriptedStream(options.rounds ?? [])
  const tools = options.tools ?? [fakeTool('bash')]
  const deps: LoopDeps = {
    stream: options.stream ?? scripted.stream,
    now: options.now ?? (() => 0),
    tools: new Map(tools.map((t) => [t.name, t])),
    root: options.root ?? '/tmp',
    caps: CAPS,
    request: {
      model: 'm',
      maxTokens: options.maxTokens ?? 100,
      thinking: 'disabled',
      effort: 'high',
      reasoningDisplay: 'omitted',
      system: 'S',
      tools: [],
    },
    maxIterations: options.maxIterations ?? 10,
    ...(options.reloadSystem ? { reloadSystem: options.reloadSystem } : {}),
    ...(options.taskOverflow ? { taskOverflow: options.taskOverflow } : {}),
    ...(options.kickSummary ? { kickSummary: options.kickSummary } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  }
  const ctx: LoopContext = {
    messages: options.messages ?? [{ role: 'user', parts: [{ type: 'text', text: '跑一下' }] }],
    tasks: [],
    deps,
    signal: options.signal ?? new AbortController().signal,
    ...(options.interject ? { interject: options.interject } : {}),
    ...(options.lastFinish ? { lastFinish: options.lastFinish } : {}),
    ...(options.lastUsage ? { lastUsage: options.lastUsage } : {}),
  }

  const events: AgentEvent[] = []
  for await (const agentEv of run(ctx)) {
    events.push(agentEv)
    options.onEvent?.(agentEv, ctx)
  }
  return { events, ctx, requests: scripted.requests, sent: scripted.seen }
}

const kinds = (events: AgentEvent[]) => events.map((e) => e.type)

describe('基本回合', () => {
  it('模型只说话时跑一轮就停', async () => {
    const h = await drive({ rounds: [says('好的')] })

    expect(h.requests()).toBe(1)
    expect(kinds(h.events)).toEqual(['text_start', 'text_delta', 'text_end', 'request_timing', 'step_finish'])
    expect(h.ctx.messages.at(-1)).toEqual({
      role: 'assistant',
      parts: [{ type: 'text', text: '好的' }],
    })
  })

  it('request_timing：首块差值 + 整流耗时，时钟每调一次走 100ms', async () => {
    let t = 0
    const h = await drive({ rounds: [says('好的')], now: () => (t += 100) })
    // 调用序：startedAt(100) → 首块 firstAt(200) → 流结束(300)
    const timing = h.events.find((e) => e.type === 'request_timing')
    expect(timing).toEqual({ type: 'request_timing', ttftMs: 100, totalMs: 200 })
  })

  it('调工具后再跑一轮，结果进 role:tool 消息', async () => {
    const h = await drive({ rounds: [calls('t1'), says('跑完了')] })

    expect(h.requests()).toBe(2)
    expect(h.ctx.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(h.ctx.messages[2]?.parts[0]).toMatchObject({ toolCallId: 't1', isError: false })
  })

  it('一轮里的多个 tool_call 合成一条 tool 消息，且严格串行', async () => {
    const order: string[] = []
    const tool = fakeTool('bash', async () => {
      order.push('run')
      await new Promise((r) => setTimeout(r, 1))
      order.push('done')
      return { output: 'ok', exitCode: 0, isError: false }
    })
    const h = await drive({
      rounds: [
        [
          ...calls('t1').slice(0, 3),
          ...calls('t2').slice(0, 3),
          { type: 'finish', reason: 'tool-calls', usage: usage() },
        ],
        says('好'),
      ],
      tools: [tool],
    })

    // 串行的证据：不会出现 run run done done
    expect(order).toEqual(['run', 'done', 'run', 'done'])
    expect(h.ctx.messages.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(h.ctx.messages[2]?.parts).toHaveLength(2)
  })

  it('插话软中断：fire 命中正在执行的工具，同批后续工具拿到换新后的信号', async () => {
    // session 排队路径的语义（session.ts）：fire 当前这把 + 立刻换新。
    // 这里验证 loop 侧的关节——执行时取 .current.signal，且只有当时
    // 正在跑的那个工具收到已开火的信号
    const holder: NonNullable<LoopContext['interject']> = { current: new AbortController() }
    const seen: (AbortSignal | undefined)[] = []
    const tool = fakeTool('bash', async (tctx) => {
      seen.push(tctx.interjectSignal)
      await new Promise((r) => setTimeout(r, 250)) // 模拟长命令
      return { output: 'ok', exitCode: 0, isError: false }
    })
    setTimeout(() => {
      const fired = holder.current
      holder.current = new AbortController()
      fired.abort()
    }, 100) // 第一个工具执行中开火
    await drive({
      rounds: [
        [
          ...calls('t1').slice(0, 3),
          ...calls('t2').slice(0, 3),
          { type: 'finish', reason: 'tool-calls', usage: usage() },
        ],
        says('好'),
      ],
      tools: [tool],
      interject: holder,
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.aborted).toBe(true) // 正在执行的：收到开火
    expect(seen[1]?.aborted).toBe(false) // 换新后：干净信号
  })

  it('未知工具名变成 isError 结果，不打断 loop', async () => {
    const h = await drive({ rounds: [calls('t1', 'nosuch'), says('那我换个方式')] })

    expect(h.requests()).toBe(2) // loop 没被打断
    expect(h.ctx.messages[2]?.parts[0]).toMatchObject({ isError: true })
    expect(kinds(h.events)).toContain('tool_error')
  })

  /**
   * 大小写兜底。**不是为模型能力不足做防御，是外部输入不可靠**：
   * 2026-09-20 实测某渠道一段时间内把 `bash` 采样成 `Bash`（同一轮里
   * 两种写法混用），整轮工具调用全部 unknown tool，还撞上死循环熔断
   */
  it('**工具名大小写不匹配时回退命中**（渠道把 bash 写成 Bash）', async () => {
    let ran = 0
    const tool = fakeTool('bash', async () => {
      ran++
      return { output: 'ok', exitCode: 0, isError: false }
    })
    const h = await drive({
      rounds: [calls('t1', 'Bash'), says('好了')],
      tools: [tool],
    })

    expect(ran).toBe(1) // 真跑了，不是报「没有这个工具」
    expect(h.ctx.messages[2]?.parts[0]).toMatchObject({ isError: false })
    expect(kinds(h.events)).not.toContain('tool_error')
  })

  it('大小写兜底只在精确匹配失败后生效，不影响同名精确命中', async () => {
    const hits: string[] = []
    const lower = fakeTool('bash', async () => {
      hits.push('lower')
      return { output: 'lower', exitCode: 0, isError: false }
    })
    const upper = fakeTool('Bash', async () => {
      hits.push('upper')
      return { output: 'upper', exitCode: 0, isError: false }
    })
    await drive({
      rounds: [calls('t1', 'Bash'), says('好了')],
      tools: [lower, upper],
    })

    expect(hits).toEqual(['upper'])
  })

  /**
   * 网关前缀兜底，同一族的外部输入不可靠：2026-10-22 实测某网关渠道
   * 把工具定义全改成 mcp__client__<name>（Anthropic 的 MCP 命名三段式），
   * 响应回去不剥前缀，逐轮 tool_fail unknown tool
   */
  it('**工具名带 mcp__ 前缀时剥掉再命中**（网关把 bash 包成 mcp__client__bash）', async () => {
    let ran = 0
    const tool = fakeTool('bash', async () => {
      ran++
      return { output: 'ok', exitCode: 0, isError: false }
    })
    const h = await drive({
      rounds: [calls('t1', 'mcp__client__bash'), says('好了')],
      tools: [tool],
    })

    expect(ran).toBe(1)
    expect(h.ctx.messages[2]?.parts[0]).toMatchObject({ isError: false })
    expect(kinds(h.events)).not.toContain('tool_error')
  })

  it('前缀兜底只在精确匹配失败后生效：真有这个三段式工具时不误剥', async () => {
    const hits: string[] = []
    const wrapped = fakeTool('mcp__client__bash', async () => {
      hits.push('wrapped')
      return { output: 'wrapped', exitCode: 0, isError: false }
    })
    const plain = fakeTool('bash', async () => {
      hits.push('plain')
      return { output: 'plain', exitCode: 0, isError: false }
    })
    await drive({
      rounds: [calls('t1', 'mcp__client__bash'), says('好了')],
      tools: [wrapped, plain],
    })

    expect(hits).toEqual(['wrapped'])
  })

  /**
   * 名字归一要落进历史：剥前缀解析成功后，存进 ctx.messages 的
   * tool_call 名字也改成规范名——下一轮回给模型的消息、UI 工具行、
   * jsonl 落盘全是干净名字，前缀不在历史里繁殖（glm 会模仿历史写法）
   */
  it('**归一写回历史**：mcp__client__bash 执行后，历史里的调用名叫 bash', async () => {
    let ran = 0
    const tool = fakeTool('bash', async () => {
      ran++
      return { output: 'ok', exitCode: 0, isError: false }
    })
    const h = await drive({
      rounds: [calls('t1', 'mcp__client__bash'), says('好了')],
      tools: [tool],
    })

    expect(ran).toBe(1)
    const call = h.ctx.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_call')
    expect(call).toMatchObject({ name: 'bash' })
  })

  /**
   * 归一必须早于 step_finish：session 的 persist 挂在 step_finish 上（工具
   * 执行之前），那一刻存进库/归档的就得是规范名。原来归一放在
   * executeTools 里，step_finish 先落一份前缀版，归一后指纹变了归档又追加
   * 一份——2026-10-22 真库 turn-018255.jsonl 同一 call id 两行
   */
  it('归一早于 step_finish：persist 那一刻历史里已是 bash', async () => {
    const seen: string[] = []
    await drive({
      rounds: [calls('t1', 'mcp__client__bash'), says('好了')],
      tools: [fakeTool('bash')],
      onEvent: (ev, ctx) => {
        if (ev.type !== 'step_finish') return
        for (const p of ctx.messages.flatMap((m) => m.parts)) {
          if (p.type === 'tool_call') seen.push(p.name)
        }
      },
    })

    expect(seen[0]).toBe('bash')
  })

  it('归一写回不吞真名：注册表里真有 mcp__client__bash 时保持原样', async () => {
    const hits: string[] = []
    const wrapped = fakeTool('mcp__client__bash', async () => {
      hits.push('wrapped')
      return { output: 'wrapped', exitCode: 0, isError: false }
    })
    const h = await drive({
      rounds: [calls('t1', 'mcp__client__bash'), says('好了')],
      tools: [wrapped],
    })

    expect(hits).toEqual(['wrapped'])
    const call = h.ctx.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_call')
    expect(call).toMatchObject({ name: 'mcp__client__bash' })
  })
})

describe('退出条件', () => {
  it('provider 说 stop 但消息里带着 tool_call —— 照样要把工具跑完', async () => {
    // **这是实际会发生的事，不是假想**。
    //
    // 只信 finish 的话这个 tool_call 永远拿不到结果，下一轮请求缺配对
    // 直接 400，而且这条历史一直在，之后每轮都 400。
    const h = await drive({
      rounds: [
        [
          { type: 'tool_input_start', id: 't1', name: 'bash' },
          { type: 'tool_input_end', id: 't1', name: 'bash', input: { command: 'ls' } },
          // finish 撒谎说没事了
          { type: 'finish', reason: 'stop', usage: usage() },
        ],
        says('拿到结果了'),
      ],
    })

    expect(kinds(h.events)).toContain('tool_call')
    expect(h.requests()).toBe(2)
    expect(h.ctx.messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('孤儿 tool_call 藏在更早的消息里，也不能直接退出', async () => {
    // lastTurnCalledTools 只看最后一条 assistant 消息，看不见这种孤儿。
    // 第 1 步的历史由 loop 自己产生，出不了这种形状；第 2 步从 SQLite
    // 载入之后形状就不受我们控制了——hasPendingToolCalls 挡的是这个
    const h = await drive({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }],
        },
        { role: 'assistant', parts: [{ type: 'text', text: '说了句没头没尾的话' }] },
      ],
      lastFinish: 'stop',
      rounds: [says('补上了')],
    })

    // 直接退出的话请求数是 0，那条孤儿会永远留在历史里，之后每轮 400
    expect(h.requests()).toBe(1)
  })

  it('用户在 agent 跑的时候插话，那条消息不能丢', async () => {
    // 没有第四个合取项的话：模型说完话 finish=stop，loop 认为没事做了直接退出，
    // 排队的那句话再也没人处理。不报错，只是消息没了
    const h = await drive({
      rounds: [says('好的'), says('统计完了')],
      onEvent: (ev, ctx) => {
        if (ev.type === 'step_finish' && ctx.tasks.length === 0 && ctx.messages.length < 4) {
          ctx.tasks.push({ type: 'newInput', text: '顺便统计行数' })
        }
      },
    })

    expect(h.requests()).toBe(2)
    const texts = h.ctx.messages.filter((m) => m.role === 'user').flatMap((m) => m.parts)
    expect(texts).toContainEqual({ type: 'text', text: '顺便统计行数' })
  })

  it('连发两条消息按发送顺序处理', async () => {
    // 用栈的话第二条会先进历史，模型看到的因果顺序是反的。不报错，只是错了
    const h = await drive({
      rounds: [says('好的'), says('都办完了')],
      onEvent: (ev, ctx) => {
        if (ev.type === 'step_finish' && ctx.messages.length < 4) {
          ctx.tasks.push({ type: 'newInput', text: '先做 A' })
          ctx.tasks.push({ type: 'newInput', text: '再做 B' })
        }
      },
    })

    const userTexts = h.ctx.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts)
      .map((p) => (p as { text: string }).text)
    expect(userTexts).toEqual(['跑一下', '先做 A', '再做 B'])
  })

  it('finish=tool-calls 但没有待办时也要再跑一轮', async () => {
    // 模型说「我还要调工具」，实际一个 tool_call 都没发。这时不能退出，
    // 否则用户看到的是「模型说到一半就没了」
    const h = await drive({
      rounds: [[{ type: 'finish', reason: 'tool-calls', usage: usage() }], says('抱歉，说完了')],
    })

    expect(h.requests()).toBe(2)
  })

  it('载入的历史里有缺配对的 tool_call 时不能直接退出', async () => {
    // session 恢复的场景：历史和 lastFinish 都来自外部，没经过我们的 normalize。
    // 只看 lastFinish 的话会认定「上一轮 stop 了，没事做」直接退出，那条
    // tool_call 永远没有结果，下次再发就 400
    const h = await drive({
      rounds: [says('接着说')],
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'old', name: 'bash', input: {} }] },
      ],
      lastFinish: 'stop',
    })

    expect(h.requests()).toBe(1)
    // 补齐之后才发出去，请求里不能有缺配对的 tool_call
    const sent = h.sent[0]?.messages ?? []
    expect(sent.find((m) => m.role === 'tool')?.parts[0]).toMatchObject({
      toolCallId: 'old',
      interrupted: true,
    })
  })

  it('超过 maxIterations 发 error 而不是死循环', async () => {
    // 每轮参数递增：同参会先撞死循环熔断（那是 doom 用例的事），
    // 这里要测的是「轮数」兜底，得让 doom 判定一路不触发
    const h = await drive({
      rounds: Array.from({ length: 10 }, (_, i) => calls(`t${i}`, 'bash', { command: `cmd${i}` })),
      maxIterations: 3,
    })

    expect(h.requests()).toBe(3)
    expect(h.events.at(-1)).toMatchObject({ type: 'error' })
  })

  it('LLMStreamError 冒到顶层带 kind/retryable，不是抹平的字符串', async () => {
    const boom = new LLMStreamError({
      kind: 'server',
      message: '渠道 500：upstream panic',
      retryable: true,
    })
    const h = await drive({
      stream: async function* () {
        throw boom
      },
    })

    expect(h.events.at(-1)).toEqual({
      type: 'error',
      message: '渠道 500：upstream panic',
      retryable: true,
      kind: 'server',
    })
  })
})

describe('中断', () => {
  it('中断后不再发请求 —— loop 不空转', async () => {
    const controller = new AbortController()
    const h = await drive({
      rounds: [calls('t1'), says('不该跑到这')],
      signal: controller.signal,
      tools: [
        fakeTool('bash', async () => {
          controller.abort()
          return { output: '半截', exitCode: -1, isError: true }
        }),
      ],
    })

    expect(h.requests()).toBe(1)
  })

  it('中断时未执行的 tool_call 补上 interrupted 占位', async () => {
    const controller = new AbortController()
    // 两个 tool_call，第一个执行时中断，第二个必须补占位而不是没有结果
    const h = await drive({
      rounds: [
        [
          ...calls('t1').slice(0, 3),
          ...calls('t2').slice(0, 3),
          { type: 'finish', reason: 'tool-calls', usage: usage() },
        ],
      ],
      signal: controller.signal,
      tools: [
        fakeTool('bash', async () => {
          controller.abort()
          return { output: 'x', exitCode: 0, isError: false }
        }),
      ],
    })

    const toolMsg = h.ctx.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.parts).toHaveLength(2) // 前提：两个调用都有了结果
    expect(toolMsg?.parts[1]).toMatchObject({ toolCallId: 't2', interrupted: true })
  })

  it('中断发生在第一个工具之前时，历史里不留空 tool 消息', async () => {
    // 一个工具都没跑到，results 是空的。executeTools 照样 push 一条空的
    // tool 消息，靠 finally 那次 normalize 收拾——这里断言收拾干净了
    const controller = new AbortController()
    const h = await drive({
      signal: controller.signal,
      stream: () =>
        (async function* (): AsyncIterable<StreamEvent> {
          yield { type: 'tool_input_start', id: 't1', name: 'bash' }
          yield { type: 'tool_input_end', id: 't1', name: 'bash', input: {} }
          controller.abort() // 流结束前就中断，工具一个都跑不到
          yield { type: 'finish', reason: 'tool-calls', usage: usage() }
        })(),
    })

    const toolMsgs = h.ctx.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0]?.parts).toEqual([
      expect.objectContaining({ toolCallId: 't1', interrupted: true }),
    ])
  })

  it('工具违反「永不抛」契约时，历史不能留下缺配对的 tool_call', async () => {
    // finally 里那次 normalize 防的就是这个。工具抛异常 → 直接窜到 run 的
    // catch，executeTools 里补占位的代码根本没跑到，assistant 消息却已经
    // 带着 tool_call 进历史了。不补的话下一轮请求 400，而且每轮都 400
    const h = await drive({
      rounds: [calls('t1')],
      tools: [
        fakeTool('bash', async () => {
          throw new Error('工具没守规矩')
        }),
      ],
    })

    expect(h.events.at(-1)).toMatchObject({ type: 'error' }) // 前提：确实走了异常路径
    const toolMsg = h.ctx.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.parts[0]).toMatchObject({ toolCallId: 't1', interrupted: true })
  })

  it('一开始就是中断态时一个请求都不发', async () => {
    const h = await drive({ rounds: [says('不该跑')], signal: AbortSignal.abort() })

    expect(h.requests()).toBe(0)
  })
})

describe('健壮性', () => {
  it('同调用同结果连续 3 次触发死循环熔断：第 3 次不执行，熔断是 result 不是 error', async () => {
    // 与 maxIterations 互补：轮数没超但每轮做同一个无效调用。真死循环的
    // 指纹是「问了三遍、答案一模一样还在问」——判定要看 result，不看的话
    // 合法轮询（同参、结果每轮在变）会被误杀（2026-09-16 实测误杀过评测
    // 轮询）。熔断不再 throw：throw 后 tool_call 缺配对，normalize 补的
    // 占位是「用户中断」，模型会误以为被叫停——改成 isError 的 result
    let executed = 0
    const h = await drive({
      rounds: [calls('t1'), calls('t2'), calls('t3')],
      // output 固定不变：三问三答一模一样
      tools: [
        fakeTool('bash', async () => {
          executed++
          return { output: 'same', exitCode: 0, isError: false }
        }),
      ],
    })
    expect(executed).toBe(2) // 第 3 次没执行
    const results = h.ctx.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts)
    expect(results).toHaveLength(3) // 每个tool_call 都有配对 result——不再缺配对补「用户中断」占位
    expect(results[2]).toMatchObject({ type: 'tool_result', isError: true })
    expect((results[2] as { output?: string }).output).toContain('死循环')
    expect((results[2] as { output?: string }).output).toContain('轮询') // 合法轮询的出路
    // 熔断后 turn 不报废：模型还能看到 result 自行调整，后续正常收尾
    expect(h.events.some((e) => e.type === 'tool_error' && e.message.includes('死循环'))).toBe(true)
  })

  it('同调用但结果在变（合法轮询）：不熔断，三次都执行', async () => {
    // 误杀回归：sleep+grep 同参轮询，日志每轮都在长。原判定只看调用不看
    // 结果，第 3 轮就被拦死
    let executed = 0
    const h = await drive({
      rounds: [calls('t1'), calls('t2'), calls('t3'), calls('t4')],
      tools: [fakeTool('bash', async () => ({ output: `rows=${++executed}`, exitCode: 0, isError: false }))],
    })
    expect(executed).toBe(4)
    expect(h.events.some((e) => e.type === 'error' || e.type === 'tool_error')).toBe(false)
  })

  it('批内 3 连发完全相同的 call：result 还没出来也拦（同批连发同一条命令没有合法场景）', async () => {
    let executed = 0
    const h = await drive({
      rounds: [[...calls('t1'), ...calls('t2'), ...calls('t3')]],
      tools: [fakeTool('bash', async () => ({ output: `ran${++executed}`, exitCode: 0, isError: false }))],
    })
    expect(executed).toBe(0) // 第 1 个执行前就够数
    const results = h.ctx.messages.filter((m) => m.role === 'tool').flatMap((m) => m.parts)
    expect(results).toHaveLength(3)
    expect((results[0] as { output?: string }).output).toContain('死循环')
  })

  it('参数变了就不算死循环；换姿势后计数清零', async () => {
    // 同名但 input 不同 → 不拦。反过来也测：两次相同之后插一次不同，再两次
    // 相同——尾部连续段只有 2，不拦
    let executed = 0
    const tool = fakeTool('bash', async () => ({ output: `ran${++executed}`, exitCode: 0, isError: false }))
    const ok = await drive({
      rounds: [calls('t1', 'bash', { command: 'a' }), calls('t2', 'bash', { command: 'b' })],
      tools: [tool],
    })
    expect(ok.events.some((e) => e.type === 'error')).toBe(false)

    const h = await drive({
      rounds: [
        calls('a1', 'bash', { command: 'x' }),
        calls('a2', 'bash', { command: 'x' }),
        calls('b1', 'bash', { command: 'other' }),
        calls('a3', 'bash', { command: 'x' }),
        calls('a4', 'bash', { command: 'x' }),
      ],
      tools: [fakeTool('bash', async () => ({ output: 'ok', exitCode: 0, isError: false }))],
    })
    expect(h.events.some((e) => e.type === 'error')).toBe(false)
  })
  it('流抛异常时发 error 事件，不把异常扔给调用方', async () => {
    const h = await drive({
      stream: () =>
        (async function* (): AsyncIterable<StreamEvent> {
          throw new Error('连接断了')
          // biome-ignore lint/correctness/noUnreachable: 让 TS 认出这是 AsyncGenerator
          yield { type: 'text_start' }
        })(),
    })

    expect(h.events).toEqual([{ type: 'error', message: 'Error: 连接断了', retryable: false }])
  })

  it('restart 之后半截内容作废，历史里不留重复', async () => {
    const h = await drive({
      rounds: [
        [
          { type: 'text_start' },
          { type: 'text_delta', text: '半截' },
          { type: 'restart' },
          ...says('完整回答'),
        ],
      ],
    })

    expect(kinds(h.events)).toContain('restart')
    expect(h.ctx.messages.at(-1)?.parts).toEqual([{ type: 'text', text: '完整回答' }])
  })
})

/** 说一半被 max_tokens 砍断 */
const truncated = (text: string): StreamEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
  { type: 'finish', reason: 'length', usage: usage() },
]

/** 还没写正文就被 max_tokens 砍断——预算全烧在推理上（DeepSeek 实证形态） */
const starved = (thinking: string): StreamEvent[] => [
  { type: 'reasoning_start' },
  { type: 'reasoning_delta', text: thinking },
  { type: 'reasoning_end' },
  { type: 'finish', reason: 'length', usage: usage() },
]

describe('任务跑超（task-v3 配额闸）', () => {
  it('命中即收口：一个 error 事件、不发请求、排队输入不消费', async () => {
    const h = await drive({
      rounds: [says('做完了')],
      taskOverflow: () => '分支跑超预留编号段（turns 的 id 已到 10000，段上限 10000），已自动停止——只能合并或丢弃，不能继续',
    })
    expect(h.events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(h.requests()).toBe(0)
  })
})

describe('输出被 max_tokens 截断', () => {
  it('续写而不是当成正常结束', async () => {
    // 当成正常结束的话用户看到话说一半就没了；这里选择续写
    const h = await drive({ rounds: [truncated('第一段'), says('第二段')] })

    expect(kinds(h.events)).toContain('truncated')
    expect(h.requests()).toBe(2)
  })

  it('被截断的内容**保留**在历史里，不像 restart 那样作废', async () => {
    // 这两个事件语义相反，搞混了要么内容重复要么内容丢失，且都不报错
    const h = await drive({ rounds: [truncated('第一段'), says('第二段')] })

    const texts = h.ctx.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.parts)
      .map((p) => (p as { text?: string }).text)
    expect(texts).toEqual(['第一段', '第二段'])
  })

  it('续写请求里带着让模型接着写的指令', async () => {
    const h = await drive({ rounds: [truncated('第一段'), says('第二段')] })

    const second = JSON.stringify(h.sent[1]?.messages)
    expect(second).toContain('直接接着写')
    // 不许道歉和复述是有代价考量的：那会再烧掉一截输出
    expect(second).toContain('不要复述')
  })

  it('零正文被截断：保留原消息，不另存推理、不引导读取，提示分步推进', async () => {
    // 2026-10-23 140+SDK 六次实测：文件续读句 2/2 reasoning_extraction，
    // 删除该句或改成中性分步提示均 2/2 正常。只改恢复指令，不删除原始记录。
    mkdirSync('.simple-code/tmp', { recursive: true })
    const root = mkdtempSync('.simple-code/tmp/starved-')
    try {
      const h = await drive({ root, rounds: [starved('想了很多很多字'), says('答案')] })
      const prompt = h.sent[1]?.messages.findLast((m) => m.role === 'user')
      expect(prompt?.parts).toEqual([{
        type: 'text',
        text: '本次输出达到长度上限，尚未生成正文。请把任务拆成小步骤，先完成一个可验证的步骤，再根据结果继续。',
      }])
      expect(h.ctx.messages.some((m) => m.parts.some((p) => p.type === 'reasoning' && p.text === '想了很多很多字'))).toBe(true)
      expect(existsSync(join(root, '.simple-code', 'tmp', 'truncated-reasoning-0.md'))).toBe(false)
      expect(h.requests()).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('连续截断最多续 3 次，然后报错停下', async () => {
    // 不设上限的话，模型每次都被截断就会一直烧钱到 maxIterations
    const h = await drive({
      rounds: [
        truncated('一'),
        truncated('二'),
        truncated('三'),
        truncated('四'),
        says('不该到这'),
      ],
    })

    expect(kinds(h.events).filter((k) => k === 'truncated')).toHaveLength(3)
    expect(h.requests()).toBe(4) // 首轮 + 3 次续写
    expect(h.events.at(-1)).toMatchObject({ type: 'error', retryable: false })
    expect((h.events.at(-1) as { message: string }).message).toContain('maxTokens')
  })

  // 2026-10-24 Terminal-Bench 实测：resumeCount 整轮累计不归零，长任务里
  // 截断→干活→截断→干活→截断就被判「连续 3 次」停掉。CC query.ts:1720
  // 每进下一步都清零 maxOutputTokensRecoveryCount
  it('截断之间有一步正常干活（跑了工具），计数归零——上限是「连续」不是「累计」', async () => {
    const h = await drive({
      maxIterations: 20, // 8 次请求 + 4 次续写各占一轮，默认 10 不够
      rounds: [
        // 命令各不相同：同参同结果连做 3 次会被 doomLoopGuard 熔断
        starved('想'), calls('t1', 'bash', { command: 'echo 1' }),
        starved('想'), calls('t2', 'bash', { command: 'echo 2' }),
        starved('想'), calls('t3', 'bash', { command: 'echo 3' }),
        starved('想'),
        says('做完了'),
      ],
    })

    const truncs = h.events.filter((e) => e.type === 'truncated') as { attempt: number }[]
    expect(truncs.map((e) => e.attempt)).toEqual([1, 1, 1, 1])
    expect(h.events.some((e) => e.type === 'error')).toBe(false)
    expect(h.requests()).toBe(8)
  })

  it('对照组：finish 是 stop 时不续写', async () => {
    // 没有这条的话，「无条件续写」也能让上面几条通过
    const h = await drive({ rounds: [says('说完了'), says('不该到这')] })

    expect(kinds(h.events)).not.toContain('truncated')
    expect(h.requests()).toBe(1)
  })

  it('截断时还有没跑的工具，先跑工具而不是续写', async () => {
    // 流在工具参数拼到一半时断，硬续写不如把工具跑完、把结果给模型看
    const h = await drive({
      rounds: [
        [...calls('t1').slice(0, -1), { type: 'finish', reason: 'length', usage: usage() }],
        says('拿到结果了'),
      ],
    })

    expect(kinds(h.events)).not.toContain('truncated')
    expect(kinds(h.events)).toContain('tool_call')
  })
})

/**
 * 一条约 N token 的**可裁剪**消息。
 *
 * 字符数**反推自真实的估算函数**，不写死比值：写死的话改 CHARS_PER_TOKEN
 * 会让一批用例的量悄悄变化，而它们的断言（卸了几条、降到多少）都依赖那个量，
 * 表现是一堆看不出关联的红。
 *
 * ## 为什么体积放在 tool_call.command 里，不是 text
 *
 * 第 0 层只裁工具输入输出，**对话文本一律不动**（提案 §4.2）。原来这个夹具
 * 造的是纯文本消息，改完之后 `pickOldest` 一条也挑不动——十来个用例一起红，
 * 而它们要测的是预算和挑选，不是「文本裁不裁」。
 *
 * ## 为什么 call 和 result 挤在同一条消息里
 *
 * 这一条确实不像真实 wire 格式（两者本该分属 assistant 和 tool 两条消息），
 * 但**它是这里唯一能让消息条数稳定的形状**：
 *
 * - 只放 `tool_call` → `ensureCallOutputsPresent` 会插一条占位 result
 * - 只放 `tool_result` → `removeOrphanOutputs` 会把它删掉
 *
 * 两种都会改变条数，而这批用例的断言全是按下标写的（「卸的是 0 和 1」），
 * 条数一动就全错。放在一起时 normalize 的三个 pass 都判定「已配对」，
 * 原样穿过。被测性质（体积记账 + 挑选顺序）不受这个形状影响
 */
let bulkySeq = 0
const bulky = (role: Message['role'], tokens: number): Message => {
  const id = `bulky-${++bulkySeq}`
  const make = (chars: number): Message => ({
    role,
    parts: [
      { type: 'tool_call', id, name: 'bash', input: { command: 'x'.repeat(chars) } },
      { type: 'tool_result', toolCallId: id, output: '', isError: false },
    ],
  })
  // **固定开销要减掉。** 工具 part 的 JSON 骨架（id、name、input 的括号引号、
  // 配对的空 result）本身就值十几 token，直接按 tokens/perChar 算字符数会让
  // 每条都超一截——`bulky(role, 200)` 实测出来是 245，一批「卸到 400 以下」
  // 的断言集体差一点点红，而红的原因跟被测行为毫无关系
  const empty = estimateMessageTokens(make(0).parts)
  const perChar = (estimateMessageTokens(make(1000).parts) - empty) / 1000
  return make(Math.max(0, Math.round((tokens - empty) / perChar)))
}

/** 已卸载形态的消息：command 是存根（300 字符头部 + [已卸载] 尾巴）。
 * 三级递进第二级的夹具——水位检查的输入就是这种消息 */
const stubby = (seq: number): Message => ({
  role: 'assistant',
  parts: [
    {
      type: 'tool_call',
      id: `stub-${seq}`,
      name: 'bash',
      input: { command: `head-${seq}\n# [已卸载，完整内容见 .simple-code/memory/raw/turn-${seq}.txt]` },
    },
    { type: 'tool_result', toolCallId: `stub-${seq}`, output: '', isError: false },
  ],
})

/** 记下每次卸载请求和摘要启用请求，并返回假的归档路径 */
/**
 * 压缩点（缓存过期触发）。前缀不变式（2026-09-23）之后摘要进场、合并生效
 * 只在压缩点发生——测它们的用例要先让这一步成为压缩点
 */
const COMPACTION_POINT = { lastResponseAt: () => 0, now: () => 1e12 } as const


function spyMemory(over: Partial<NonNullable<LoopDeps['memory']>> = {}) {
  const calls: number[][] = []
  const activated: number[] = []
  const remaps: (number | null)[][] = []
  const cold: number[][] = []
  const stubs: Message[][] = []
  const regions: { sizes: RegionSizes; budget: number; real: number | null }[] = []
  const memory: LoopDeps['memory'] = {
    cues: () => new Map(),
    contextWindow: 1000,
    // compaction-v2：targetRatio 是保底区的比例下限（max(floorTokens, 预算×比例)
    // 再夹 20% 上限）。0.001 让 floor ≈ floorTokens=1（预算 900 下 0.9 取整到 1）
    // ——保持「只圈住最后一个 step」的旧口径，保底语义的用例自己覆盖
    targetRatio: 0.001,
    // 时间维度的默认值＝「不触发」：lastResponseAt 为 null 时 isCacheStale
    // 恒 false，既有用例（预算触发那些）不受影响。要测 stale 的自己覆盖
    cacheTtlMs: 3 * 60 * 60 * 1000,
    now: () => 0,
    lastResponseAt: () => null,
    markResponded: () => {},
    floorTokens: 1,
    // 默认大值=水位检查不触发；要测三级递进第二级的用例自己覆盖成小值
    stubTokens: 1e9,
    stubSteps: 1e9,
        // 测试里关掉余量，让预算就是 contextWindow - maxTokens，好算
    safetyMargin: 0,
    keepHeadChars: 20,
    // 阈值压到 0：这些用例造的夹具是几十到几百字符的合成消息，
    // 用生产默认的 1000 会一条都裁不动，测的就成了空集
    clipThresholdChars: 0,
    unload: (indices) => {
      calls.push(indices)
      // 默认一条消息一个 turn。要测「一个 turn 多条消息」的用例自己覆盖 unload
      return indices.map((i) => ({
        archivePath: `.simple-code/memory/turns/turn-${i}.jsonl`,
        turnId: i,
        stepId: i,
      }))
    },
    markCold: (stepIds) => cold.push(stepIds),
    activateSummary: (stepId) => {
      activated.push(stepId)
      return false // 默认没有 ready 摘要，走 3a 的截断存根
    },
    // 默认没有摘要 → 拼装原样返回，卸载相关的用例不受 3b 影响
    summaries: () => [],
    leafBodies: () => new Map(),
    hotLeaves: 2,
    demoteBatch: 10,
    withTurns: (messages) => messages.map((message, i) => ({ message, turnId: i, stepId: i })),
    applyMerges: () => new Set<number>(),
    recordRegions: (sizes, budget, real) => regions.push({ sizes, budget, real }),
    remap: (o) => remaps.push(o),
    pruneMessages: () => {},
    markStubs: (ms) => stubs.push(ms),
    ...over,
  }
  return {
    memory,
    calls,
    activated,
    remaps,
    cold,
    stubs,
    regions,
    unloadedCount: () => calls.flat().length,
  }
}

describe('上下文卸载', () => {
  it('超过阈值就卸最老的，一直卸到 target 以下', async () => {
    // 窗口 1000 → 触发阈值 700（budget），target 400。5 条各 300 共 1500。
    //
    // **断言的是「降到触发阈值以下」，不是「降到 target 以下」。** target 是
    // pickOldest 的停止条件，不是可达的下界——地板保留的那条原样留着（300），
    // 每个存根还有固定成本（光通知里那条归档路径就 ~50 字符）。四条存根加
    // 一条完整消息，物理上就到不了 400。
    //
    // 真正要证的性质是**这一轮卸完，下一轮不会立刻又触发**，那条线是 700。
    // 配上「至少卸掉 3 条」当第二个锚点，防止一个只卸一条的实现蒙混过关
    const m = spyMemory()
    const h = await drive({
      messages: [
        bulky('user', 300),
        bulky('assistant', 300),
        bulky('user', 300),
        bulky('assistant', 300),
        bulky('user', 300),
      ],
      memory: m.memory,
      rounds: [says('好的')],
    })

    expect(m.unloadedCount()).toBeGreaterThanOrEqual(3)
    const ev = h.events.find((e) => e.type === 'unloaded')
    expect(ev).toBeDefined()
    // 预算真超了才报 budget——stale 搭车、force 自救都不许冒用这个文案
    expect((ev as { reason: string }).reason).toBe('budget')
    const estimated = (ev as { estimated: number }).estimated
    expect(estimated).toBeLessThan(700) // 降到触发阈值以下：下一轮不会立刻再触发
    expect(estimated).toBeLessThan(1500 * 0.5) // 且确实是大幅下降，不是蹭过线
  })

  it('保底区 = min(floorTokens, 预算 × targetRatio)——两个都是上限（2026-09-28 由 max 改 min）', async () => {
    // 预算 600（窗口 1000 − maxTokens 400），四条 300 + 短 user。三组各钉一面：
    const msgs = (): Message[] => [
      bulky('user', 300),
      bulky('assistant', 300),
      bulky('user', 300),
      bulky('assistant', 300),
      { role: 'user', parts: [{ type: 'text', text: '短' }] },
    ]
    const run = async (floorTokens: number, targetRatio: number) => {
      const m = spyMemory({ floorTokens, targetRatio })
      await drive({ messages: msgs(), memory: m.memory, rounds: [says('好的')], maxTokens: 400 })
      return m.calls.flat()
    }
    // ① floorTokens 小、比例大：min(1, 600) = 1 → 只圈短消息，四条全卸。
    //    **这组区分 max 与 min**：max 时 = 600，下标 2、3 都会保住
    expect(await run(1, 1)).toContain(3)
    // ② floorTokens 比整个预算还大、比例小：min(100000, 60) = 60 → 圈住短
    //    消息 + 最后一条 bulky（对齐 step 起点整条保下）→ 卸 0..2，保 3。
    //    守的是「floorTokens 配大了保底区吞掉预算、一条都卸不动」（原
    //    FLOOR_MAX_RATIO 夹子的职责，summary-e2e 窗口 3000 当场红过）
    const wide = await run(100_000, 0.1)
    expect(wide).not.toContain(3)
    expect(wide).toContain(2)
    // ③ 两者都大：min(100000, 600) = 600 → 短 + 下标 3、2 → 只卸 0、1
    const both = await run(100_000, 1)
    expect(both).not.toContain(2)
    expect(both).toContain(1)
  })

  it('保底线按 usage 校准：同一组 min(100000, 600)，系数 2 → 估算尺子上只剩 300（2026-09-29）', async () => {
    // 与上一条 ③ 同一份数据同一组配置，**只多了 tokenRatio**：600 是真实
    // token，真实是估算的 2 倍 → 估算只能数到 300 → 短 + 下标 3，下标 2 出局
    const m = spyMemory({ floorTokens: 100_000, targetRatio: 1, tokenRatio: () => 2 })
    await drive({
      messages: [bulky('user', 300), bulky('assistant', 300), bulky('user', 300), bulky('assistant', 300), { role: 'user', parts: [{ type: 'text', text: '短' }] }],
      memory: m.memory,
      rounds: [says('好的')],
      maxTokens: 400,
    })
    const unloaded = m.calls.flat()
    expect(unloaded).toContain(2)
    expect(unloaded).not.toContain(3)
  })

  it('对照组：没到阈值时一条都不卸', async () => {
    // **量必须落在 target(400) 和 threshold(700) 之间。** 取个远低于 target
    // 的值（比如 100）看起来也能过，但那是假绿：pickOldest 自己第一轮就
    // break 了，阈值判断删掉与否结果都一样——变异检验实测确认过这一点。
    //
    // 500 这个量：高于 target 所以"有的可卸"，低于 threshold 所以"不该卸"。
    // 只有真的检查了阈值才会一条不卸
    const m = spyMemory()
    const h = await drive({
      messages: [bulky('user', 300), bulky('user', 200)], // 共 500
      memory: m.memory,
      rounds: [says('好的')],
    })

    expect(m.calls).toEqual([])
    expect(kinds(h.events)).not.toContain('unloaded')
  })

  it('对照组：没有 memory 依赖时不卸载也不报错', async () => {
    // ephemeral session 走这条路——没有 store 就没地方存原文
    const h = await drive({
      messages: [bulky('user', 5000)], // 远超任何阈值
      rounds: [says('好的')],
    })

    expect(kinds(h.events)).not.toContain('unloaded')
    expect(h.requests()).toBe(1) // 照常发请求，不是卡住
  })

  it('从最老的开始卸，不是随便挑', async () => {
    // §9.4：严格从最老开始，保证近期部分连续完整、不出空洞
    const m = spyMemory()
    await drive({
      messages: [
        bulky('user', 300),
        bulky('assistant', 300),
        bulky('user', 300),
        bulky('assistant', 100),
      ],
      memory: m.memory,
      rounds: [says('好的')],
    })

    const picked = m.calls.flat()
    expect(picked[0]).toBe(0) // 从头开始
    expect(picked).toEqual([...picked].sort((a, b) => a - b)) // 连续递增
  })

  it('卸载后的消息带着归档路径进请求', async () => {
    // 端到端：路径要从 store 一路传到模型看到的那份 messages 里
    const m = spyMemory()
    const h = await drive({
      // 共 1100 > 预算 900（窗口 1000 - maxTokens 100 - margin 0）
      messages: [bulky('user', 500), bulky('assistant', 500), bulky('user', 100)],
      memory: m.memory,
      rounds: [says('好的')],
    })

    expect(m.unloadedCount()).toBeGreaterThan(0)
    expect(JSON.stringify(h.sent[0]?.messages)).toContain('.simple-code/memory/turns/')
  })

  it('**卸载只判冷不激活摘要**——卸载和进场两个开关解绑', async () => {
    // 卸载只把原文降级成存根，摘要进场由位置制判定（activateByZone）。
    // 这里没有 ready 摘要、段也没出存根区，activated 必须是空
    const calls: number[][] = []
    const m = spyMemory({
      unload: (indices) => {
        calls.push(indices)
        return indices.map(() => ({
          archivePath: '.simple-code/memory/turns/turn-7.jsonl',
          turnId: 7,
          stepId: 7,
        }))
      },
      withTurns: (messages) =>
        messages.map((message, i) => ({ message, turnId: i < 2 ? 7 : 8, stepId: i < 2 ? 7 : 8 })),
    })
    await drive({
      messages: [
        bulky('user', 500),
        bulky('assistant', 500),
        bulky('user', 100),
        bulky('assistant', 100),
      ],
      memory: m.memory,
      rounds: [says('好的')],
    })
    expect(calls.flat().length).toBeGreaterThan(1) // 前提：确实卸了
    expect(m.cold.flat()).toContain(7) // 判冷照旧：摘要在场是顶替资格
    expect(m.activated).toEqual([]) // 但一二级解绑后不再当场激活
  })

  it('**存根区外的段摘要才进场，区内的不动**（compaction-v2 位置制）', async () => {
    // 三条存根消息各占一个 step（夹具里一轮一步，turn/step 同号 0/1/2）+ user（3，floor 只圈它）。
    // stubSteps=2：区里装 step 2、step 1，step 0 在区外——coversFrom 0 的
    // 摘要进场，1、2 的不进。跨界的（covers 1..2）也不进——半存根半摘要
    // 没有意义
    const summaries = [
      { id: 11, level: 0, coversFrom: 0, coversTo: 0, status: 'ready', inContext: false, supersededBy: null },
      { id: 12, level: 0, coversFrom: 1, coversTo: 1, status: 'ready', inContext: false, supersededBy: null },
      { id: 13, level: 0, coversFrom: 1, coversTo: 2, status: 'ready', inContext: false, supersededBy: null },
    ] as unknown as ReturnType<ReturnType<typeof spyMemory>['memory']['summaries']>
    const m = spyMemory({
      ...COMPACTION_POINT,
      stubTokens: 1e9, // token 界不设限，只让 step 数界起作用
      stubSteps: 2,
      summaries: () => summaries,
      activateSummary: (stepId) => {
        m.activated.push(stepId) // override 掉 spy 默认实现后得自己记
        return true
      },
      withTurns: (messages) =>
        messages.map((message, i) => ({
          message,
          turnId: i < 3 ? i : 3, // 存根各一轮，user 一轮
          stepId: i,
        })),
    })
    const kicks: number[] = []
    await drive({
      messages: [stubby(0), stubby(1), stubby(2), bulky('user', 10)],
      memory: m.memory,
      rounds: [says('好的')],
      kickSummary: () => kicks.push(1),
    })
    // 区外的（turn 0）进场；区内的（turn 1）和跨界的（covers 1..2）不动
    expect(m.activated).toEqual([0])
    expect(kicks).toEqual([]) // 区内段不需要自己的 L0，不催
  })

  it('**区外段没有摘要盖住时催摘要（kickSummary）**', async () => {
    // 存根区外的段在等自己的 L0——连续使用中 idle 摘要跟不上，
    // 主动催一次（不阻塞本轮）
    const m = spyMemory({
      ...COMPACTION_POINT,
      stubTokens: 1e9,
      // 区里只装得下 1 轮（默认 withTurns：一条消息一轮）：stubby(0) 在区外
      stubSteps: 1,
      summaries: () => [],
    })
    const kicks: number[] = []
    await drive({
      messages: [stubby(0), stubby(1), bulky('user', 10)],
      memory: m.memory,
      rounds: [says('好的')],
      kickSummary: () => kicks.push(1),
    })
    expect(kicks.length).toBeGreaterThan(0)
  })

  it('**token 界先到也收口**（两界先到先停的另一条腿）', async () => {
    // stubSteps 放开，只让 token 界起作用：界 = 一条存根的 1.5 倍——
    // 区里装得下一条、装不下两条。stubby(2) 在区里，stubby(0)/stubby(1) 在区外
    const oneStub = estimateMessageTokens(stubby(0).parts)
    const summaries = [
      { id: 11, level: 0, coversFrom: 0, coversTo: 0, status: 'ready', inContext: false, supersededBy: null },
      { id: 12, level: 0, coversFrom: 1, coversTo: 1, status: 'ready', inContext: false, supersededBy: null },
      { id: 13, level: 0, coversFrom: 2, coversTo: 2, status: 'ready', inContext: false, supersededBy: null },
    ] as unknown as ReturnType<ReturnType<typeof spyMemory>['memory']['summaries']>
    const m = spyMemory({
      ...COMPACTION_POINT,
      stubTokens: Math.ceil(oneStub * 1.5),
      stubSteps: 1e9,
      summaries: () => summaries,
      activateSummary: (stepId) => {
        m.activated.push(stepId)
        return true
      },
    })
    await drive({
      messages: [stubby(0), stubby(1), stubby(2), bulky('user', 10)],
      memory: m.memory,
      rounds: [says('好的')],
    })
    // 越界那条（stubby(1)）自己算区外——off-by-one 会把它留在区里
    expect(m.activated).toEqual([0, 1])
  })

  it('**存根区 token 界按 usage 校准**：界配 3 条存根，系数 2 → 估算尺子上 1.5 条（2026-09-29）', async () => {
    // 与上一条同一份数据。界 = 3 条存根：按估算三条全装得下，一条都不进场；
    // 真实是估算的 2 倍 → 界缩成 1.5 条 → 结果与上一条相同。系数没接进
    // activateByZone 的话这里是 []
    const oneStub = estimateMessageTokens(stubby(0).parts)
    const summaries = [
      { id: 11, level: 0, coversFrom: 0, coversTo: 0, status: 'ready', inContext: false, supersededBy: null },
      { id: 12, level: 0, coversFrom: 1, coversTo: 1, status: 'ready', inContext: false, supersededBy: null },
      { id: 13, level: 0, coversFrom: 2, coversTo: 2, status: 'ready', inContext: false, supersededBy: null },
    ] as unknown as ReturnType<ReturnType<typeof spyMemory>['memory']['summaries']>
    const m = spyMemory({
      ...COMPACTION_POINT,
      stubTokens: oneStub * 3,
      stubSteps: 1e9,
      tokenRatio: () => 2,
      summaries: () => summaries,
      activateSummary: (stepId) => {
        m.activated.push(stepId)
        return true
      },
    })
    await drive({
      messages: [stubby(0), stubby(1), stubby(2), bulky('user', 10)],
      memory: m.memory,
      rounds: [says('好的')],
    })
    expect(m.activated).toEqual([0, 1])
  })

  it('**前缀不变式：没触发压缩点，存根超线也不进场**（进场只搭压缩点的车）', async () => {
    const m = spyMemory({
      stubTokens: 1,
      stubSteps: 1e9,
      summaries: () => [
        { id: 31, level: 0, coversFrom: 0, coversTo: 0, status: 'ready', inContext: false, supersededBy: null },
      ] as unknown as ReturnType<ReturnType<typeof spyMemory>['memory']['summaries']>,
    })
    await drive({ messages: [stubby(0), bulky('user', 10)], memory: m.memory, rounds: [says('好的')] })
    expect(m.activated).toEqual([])
  })

  it('**前缀不变式：没触发压缩点，待生效的合并不应用**（2026-09-23 request1/2 实测的病）', async () => {
    let applied = 0
    const m = spyMemory({
      applyMerges: () => {
        applied += 1
        return new Set<number>()
      },
    })
    await drive({ messages: [bulky('user', 10)], memory: m.memory, rounds: [says('好的')] })
    expect(applied).toBe(0)
    // 对照：压缩点上照常应用
    const m2 = spyMemory({
      ...COMPACTION_POINT,
      applyMerges: () => {
        applied += 1
        return new Set<number>()
      },
    })
    await drive({ messages: [bulky('user', 10)], memory: m2.memory, rounds: [says('好的')] })
    expect(applied).toBe(1)
  })

  it('**纯文本段（裁不动、无存根）出存根区也进场**——否则原文一直全文在场', async () => {
    // 位置制判据只看「段在哪」，不看「有没有存根形态」：纯文本段裁不动，
    // 出了存根区照样该被摘要顶替——否则它的原文永远全文在场，token 一点
    // 不降。stubSteps=1 + 默认 withTurns（一条消息一轮一步）：text(0) 出区，
    // text(1) 是区里那一步
    const text = (i: number): Message => ({
      role: i % 2 ? 'assistant' : 'user',
      parts: [{ type: 'text', text: `第${i}段较长的纯文本内容。${'补'.repeat(200)}` }],
    })
    const m = spyMemory({
      ...COMPACTION_POINT,
      stubTokens: 1e9,
      stubSteps: 1,
      summaries: () => [
        { id: 21, level: 0, coversFrom: 0, coversTo: 0, status: 'ready', inContext: false, supersededBy: null },
      ] as unknown as ReturnType<ReturnType<typeof spyMemory>['memory']['summaries']>,
    })
    await drive({
      messages: [text(0), text(1), { role: 'user', parts: [{ type: 'text', text: '问' }] }],
      memory: m.memory,
      rounds: [says('好的')],
    })
    // text(0) 在存根区外，它 的 L0 该进场顶替
    expect(m.activated).toEqual([0])
  })

  it('**归一化增删消息后必须通知 store**——否则归属整体错一位', async () => {
    // run.ts 里 normalizeHistory 有三个调用点，原来各写一行、谁也不通知
    // store，而 turnOf/stepOf 是按下标对齐的（提案 §1.5 补记）。
    //
    // **这条守的是接线，不是 remap 的算法**——算法在 store.test.ts 里测。
    // 没有它的话，把 run.ts 那行 remap 删掉，全套 686 条测试一条都不红
    // （变异检验实测存活过）
    const m = spyMemory()
    await drive({
      // 带 tool_call 却没有 result → pass 1 会在它后面插一条占位
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 'orphan', name: 'bash', input: { command: 'ls' } }],
        },
      ],
      lastFinish: 'stop',
      memory: m.memory,
      rounds: [says('补上了')],
    })

    expect(m.remaps.length).toBeGreaterThan(0) // 前提：确实通知了
    // 第一次归一化就是补占位那次：第 2 条是新插的
    expect(m.remaps[0]).toEqual([0, 1, null])
  })

  it('最后一个 turn 不卸 —— 卸光了模型连当前问题都看不到', async () => {
    // 本项目自行推断，文档没写。全卸光的话模型只剩一堆
    // 「[已卸载]」，而它此时已经无法自救（连自己在干什么都不知道）
    const m = spyMemory({ targetRatio: 0.001 })
    const h = await drive({
      messages: [bulky('user', 500), bulky('assistant', 500), bulky('user', 500)],
      memory: m.memory,
      rounds: [says('好的')],
    })

    // 最后那条 user 是当前 turn，不能在卸载名单里
    expect(m.calls.flat()).not.toContain(2)
    // 它进请求时仍是原文，没有归档提示
    const sentLast = JSON.stringify(h.sent[0]?.messages?.at(-1))
    expect(sentLast).not.toContain('已卸载')
  })

  it('只卸了 tool_call 没卸它的 result 时，配对仍然完好', async () => {
    // 卸载**不会**拆散配对：id 和 toolCallId 都原样保留（只截断 command
    // 和 output 的值），所以一条被卸一条没被卸也是合法的。
    //
    // 这条是防御性的——将来若有人"优化"成把整个 input 换成字符串，
    // 或者顺手删掉 id，这里会红。构造让保底区边界恰好在 call 之后、result
    // 之前：result 够大（2000 字符 ≈ 500 token，加上 user 一起 ≥ floor），
    // 单独的 user 撑不满 floor——floorStartIndex 在 result 上收口，call 落在
    // 区外被卸。v2 的保底区从后往前**加到哪条哪条进来**，所以 crossing 必须由
    // result 自己完成，不能指望「下一条太大就停」——那会把 call 也保进来
    const m = spyMemory({ floorTokens: 300, targetRatio: 1 })
    const h = await drive({
      messages: [
        // **这条用纯文本撑体积，不用 bulky。** bulky 现在自带 tool_call /
        // tool_result 部件（见它的注释），它们的 id 会混进下面「历史里还有
        // 哪些 call」的断言里，测的就不是配对完整性了
        { role: 'user', parts: [{ type: 'text', text: 'x'.repeat(40_000) }] },
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'pair', name: 'bash', input: { command: 'x'.repeat(4_000) } },
          ],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', toolCallId: 'pair', output: 'y'.repeat(2_000), isError: false },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: '短' }] },
      ],
      memory: m.memory,
      rounds: [says('好的')],
    })

    // 前提：确实只卸了一半——不然测的是"两条都卸"那种平凡情况
    expect(m.calls.flat()).toContain(1) // call 被卸了
    expect(m.calls.flat()).not.toContain(2) // result 没被卸

    const sent = h.sent[0]?.messages ?? []
    const callIds = sent.flatMap((msg) =>
      msg.parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : [])),
    )
    const resultIds = sent.flatMap((msg) =>
      msg.parts.flatMap((p) => (p.type === 'tool_result' ? [p.toolCallId] : [])),
    )
    expect(callIds).toEqual(['pair']) // 被卸了但 id 还在
    expect(resultIds).toEqual(['pair'])
  })

  it('卸载后仍然保证 tool 配对', async () => {
    // §9.4 第 3 步的 normalizeHistory 兜底。配对断了是下一轮 400，
    // 而且这条历史一直在，之后每轮都 400
    const m = spyMemory({ targetRatio: 0.001 })
    const h = await drive({
      messages: [
        bulky('user', 300),
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'old', name: 'bash', input: { command: 'x'.repeat(2000) } },
          ],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', toolCallId: 'old', output: 'y'.repeat(2000), isError: false },
          ],
        },
        bulky('user', 100),
      ],
      memory: m.memory,
      rounds: [says('好的')],
    })

    const sent = h.sent[0]?.messages ?? []
    const callIds = sent.flatMap((msg) =>
      msg.parts.flatMap((p) => (p.type === 'tool_call' ? [p.id] : [])),
    )
    const resultIds = sent.flatMap((msg) =>
      msg.parts.flatMap((p) => (p.type === 'tool_result' ? [p.toolCallId] : [])),
    )
    expect(callIds.sort()).toEqual(resultIds.sort()) // 一一对应
  })
})

describe('缓存过期触发（提案 §12）', () => {
  // 夹具口径：窗口 1000、maxTokens 100 → 预算 900、target 360。
  // 三条 bulky 各 ~210 共 ~630：低于预算（预算路径不该动）、高于 target
  // （stale 路径有东西可卸）——正好落进「只有 stale 才会动」的区间
  const three = () => [bulky('assistant', 210), bulky('assistant', 210), bulky('assistant', 210)]

  it('距上次响应超过 cacheTtlMs，预算没超也压到 target', async () => {
    // now=0，上次响应在 -4h，超过 3h 的缺省 TTL → stale
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -4 * 60 * 60 * 1000 })
    const h = await drive({ messages: three(), memory: m.memory, rounds: [says('好的')] })

    // ~630 → 卸两条各省 ~190 → ~250 ≤ 360。挑中的是最老的两条，
    // 第三条既因为降到 target 停手、也在保底区里
    expect(m.calls).toEqual([[0, 1]])
    const stub = h.ctx.messages[0]?.parts[0]
    expect(stub).toMatchObject({ type: 'tool_call' })
    if (stub?.type === 'tool_call') {
      expect((stub.input as { command: string }).command).toContain('[已卸载')
    }
    // 判冷的 step 覆盖被挑中的全部（含裁不动的），摘要才有顶替的资格
    expect(m.cold.flat()).toEqual([0, 1])
    // 预算没超（~630 < 900），报的必须是 stale 而不是「接近上限」——
    // raw 14% 也喊「接近上限」就是当初要修的误导
    const ev = h.events.find((e) => e.type === 'unloaded')
    expect((ev as { reason: string } | undefined)?.reason).toBe('stale')
  })

  it('对照组：刚响应过，同样的夹具一条不卸', async () => {
    // 距上次响应 1 秒，远小于 3h。预算也没超 → 两个触发条件都不满足
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -1000 })
    await drive({ messages: three(), memory: m.memory, rounds: [says('好的')] })

    expect(m.calls).toEqual([])
  })

  it('生成的存根登记给 store（markStubs），归档才不会把它当新消息再写一遍（2026-09-30）', async () => {
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -4 * 60 * 60 * 1000 })
    const h = await drive({ messages: three(), memory: m.memory, rounds: [says('好的')] })
    // 登记的正是换进 ctx.messages 的那两个存根（内容一致即可——归档按指纹去重；
    // 引用不同：normalize 的 dropParts 每次都 {...msg} 复制，见 incremental-save.md §3.1 订正）
    expect(m.stubs).toEqual([[h.ctx.messages[0], h.ctx.messages[1]]])
  })

  it('unload_trigger 单记 mergePending：主因是 stale 时也看得出车票被这次吃掉（2026-09-30 补观测）', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      const m = spyMemory({ now: () => 0, lastResponseAt: () => -4 * 60 * 60 * 1000, consumeMergePending: () => true })
      await drive({ messages: three(), memory: m.memory, rounds: [says('好的')] })
      const ev = calls.find((c) => c.ev === 'unload_trigger')
      expect(ev).toMatchObject({ reason: 'stale', mergePending: true })
    } finally {
      spy.mockRestore()
    }
  })

  it('stale 触发时调用 reloadSystem（搭破缓存的车刷新 AGENTS.md/notes）', async () => {
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -4 * 60 * 60 * 1000 })
    const calls: string[] = []
    await drive({
      messages: three(),
      memory: m.memory,
      rounds: [says('好的')],
      reloadSystem: async () => {
        calls.push('reload')
      },
    })
    expect(calls).toEqual(['reload'])
  })

  it('对照组：没触发卸载就不调 reloadSystem——别的时机调用会废全史缓存', async () => {
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -1000 })
    const calls: string[] = []
    await drive({
      messages: three(),
      memory: m.memory,
      rounds: [says('好的')],
      reloadSystem: async () => {
        calls.push('reload')
      },
    })
    expect(calls).toEqual([])
  })

  it('reloadSystem 报 agentsOverLimit 时发 error 事件提示（AGENTS.md 保旧版）', async () => {
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -4 * 60 * 60 * 1000 })
    const h = await drive({
      messages: three(),
      memory: m.memory,
      rounds: [says('好的')],
      reloadSystem: async () => ({ agentsOverLimit: ['AGENTS.md'] }),
    })
    const ev = h.events.find((e) => e.type === 'error')
    expect(ev).toMatchObject({ type: 'error', retryable: false })
    expect((ev as { message: string }).message).toContain('AGENTS.md 超过')
  })

  it('对照组：本进程还没响应过（重启后第一条），不判 stale', async () => {
    // lastResponseAt 为 null → isCacheStale 恒 false，交给预算触发兜底。
    // 这是「宁可漏判不误判」的那一半：误判要白破一个还热的缓存
    const m = spyMemory({ now: () => 0 })
    await drive({ messages: three(), memory: m.memory, rounds: [says('好的')] })

    expect(m.calls).toEqual([])
  })

  it('对照组：stale 但用量已在 target 以下，不重复压', async () => {
    // 一条 ~210 ≤ target 360：stale 为真也没有可做的，不能空转标记
    const m = spyMemory({ now: () => 0, lastResponseAt: () => -4 * 60 * 60 * 1000 })
    await drive({
      messages: [bulky('assistant', 210)],
      memory: m.memory,
      rounds: [says('好的')],
    })

    expect(m.calls).toEqual([])
  })

  it('流结束时记录响应时刻', async () => {
    // markResponded 是计时的另一端：没有它，第二轮请求永远拿不到新的
    // 「上次响应」，stale 会一误到底。跑一轮（一次请求）记一次
    let marked = 0
    const m = spyMemory({ markResponded: () => marked++ })
    await drive({ memory: m.memory, rounds: [says('好的')] })

    expect(marked).toBe(1)
  })
})

/**
 * 判断"该卸载了"必须以 **API 返回的真实 usage** 为基线，只对"上次响应之后新增
 * 的消息"做估算——纯估算和纯真实值都不行：估算误差随历史长度累积，
 * 真实值滞后一轮。
 *
 * 纯估算的错法**不报错，只是不触发卸载**，然后请求撞窗口 400，而那之后每加一条
 * 消息都更超——session 从此废掉。
 */
describe('上下文预算：真实 usage + 新增估算', () => {
  /** 密集 JSON：`{`、`}`、`:`、`,`、`"` 全是单字符 token，真实比值接近 2 */
  const denseJson = (entries: number): string =>
    JSON.stringify(Array.from({ length: entries }, (_, i) => ({ file: `a${i}.ts`, line: i })))

  it('真实 usage 说已经很满时就卸载，哪怕估算说没到', async () => {
    // 这正是纯估算漏判的场景：模型上一轮回来的 usage 是权威的"到此为止用了
    // 多少"，本地估算对密集 JSON 会低估 70% 以上（实测：7781 字符按 3.5 估
    // 得 2223，按真实口径约 3891）。低估 → 不卸载 → 下一轮 400
    const m = spyMemory()
    const heavy = usage()
    heavy.inputTokens = 900 // 窗口 1000，真实已用 900

    const h = await drive({
      // 估算量刻意压低：这些消息按字符估不到 100 token，远不到任何阈值。
      // 唯一能说明"该卸了"的信息只有 usage
      //
      // **最老那条必须真的卸得动**：`pickOldest` 会跳过「卸了也省不到」的消息
      // （存根、以及短到加上归档提示反而更大的），全是三四个字的话一条都挑不
      // 中，这条测试就变成在测「卸载被跳过」而不是「usage 触发卸载」。
      // 用 denseJson 是因为它是纯 ASCII（4 字符/token）：209 字符只估 52 token，
      // 既够卸（存根约 25 token，省得到）又不撑破上面那个 <100 的前提
      messages: [
        { role: 'user', parts: [{ type: 'text', text: denseJson(8) }] },
        { role: 'assistant', parts: [{ type: 'text', text: '短回答' }] },
        { role: 'user', parts: [{ type: 'text', text: '再问一句' }] },
      ],
      memory: m.memory,
      lastUsage: heavy,
      rounds: [says('好的')],
    })

    // 前提断言：估算确实低到不足以自己触发卸载——否则这条测试测的是估算路径，
    // 把 usage 那段代码删掉照样绿（CLAUDE.md §6.1）
    const estimated = h.ctx.messages.reduce((n, m) => n + estimateMessageTokens(m.parts), 0)
    expect(estimated).toBeLessThan(100)
    // **观测的是「哪些 step 出局」，不是「裁短了几条」。**
    //
    // 原来断言 `unloadedCount() > 0`。§11.4 之后文本不再被裁，这个纯文本夹具
    // 卸载时一个字都不省，`indices` 为空、`store.unload` 根本不会被调——
    // 但出局判定确实跑了。新模型里「卸载发生了」的直接证据是 markCold：
    // 出局是位置决定的，裁不裁得动是另一回事（§11.5）
    expect(m.cold.flat().length).toBeGreaterThan(0)
  })

  it('对照组：真实 usage 很低时不卸载', async () => {
    // 没有这条的话，「无条件卸载」也能让上一条通过
    const m = spyMemory()
    const light = usage()
    light.inputTokens = 10

    await drive({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '短问题' }] },
        { role: 'user', parts: [{ type: 'text', text: '再问一句' }] },
      ],
      memory: m.memory,
      lastUsage: light,
      rounds: [says('好的')],
    })

    expect(m.calls).toEqual([])
  })

  it('新增消息算在基线之上——usage 之后堆进来的量不能不算', async () => {
    // 只看 usage 不看新增的错法：模型回了一个 900 token 的 usage，之后 bash
    // 吐回一个巨大的 tool_result，这一轮的真实输入是 900 + 那一大坨。不叠加
    // 的话会以为还是 900，照样撞窗口
    const m = spyMemory()
    const base = usage()
    base.inputTokens = 300 // 单看基线远不到阈值

    await drive({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '问' }] },
        // tool_call 必须配一条，**不能只放 tool_result**：normalizeHistory 在
        // 卸载之前跑，孤儿 result 会被它删掉，那一大坨量就凭空没了，
        // 测试变成"基线 300 不超预算"的平凡情况（第一版就是这么写的，红在这里）
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls' } }],
        },
        {
          role: 'tool',
          parts: [
            // 大块 JSON：基线 300 + 这一条，才越过预算
            { type: 'tool_result', toolCallId: 't', output: denseJson(120), isError: false },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: '再问' }] },
      ],
      memory: m.memory,
      lastUsage: base,
      rounds: [says('好的')],
    })

    expect(m.unloadedCount()).toBeGreaterThan(0)
  })

  it('预算要给输出留出 maxTokens ——窗口不等于能装的输入量', async () => {
    // 显式减法。不减的话：窗口 1000、maxTokens 400，输入用到 900 时看起来"还没满"，
    // 但 900 + 400 = 1300 已经超了，请求发出去必然 400
    const nearFull = usage()
    nearFull.inputTokens = 700 // 700 + maxTokens(400) = 1100 > 窗口 1000

    // 三条消息：最后一条落在保底区里（不卸），前两条可卸。
    // **只放一条的话这条测试是空的**——保底把它护住，预算逻辑对不对都卸不了。
    //
    // 老问题用 denseJson：`pickOldest` 跳过「卸了也省不到」的消息，三个字的
    // 消息加上归档提示反而更大，一条都挑不中。纯 ASCII 的 209 字符估 52 token，
    // 卸成存根（约 25）省得到，同时对照组那边 700 + 52 仍低于 900 的预算
    const history = (): Message[] => [
      { role: 'user', parts: [{ type: 'text', text: denseJson(8) }] },
      { role: 'assistant', parts: [{ type: 'text', text: '老回答' }] },
      { role: 'user', parts: [{ type: 'text', text: '当前问题' }] },
    ]

    const tight = spyMemory()
    await drive({
      messages: history(),
      memory: tight.memory,
      lastUsage: nearFull,
      maxTokens: 400,
      rounds: [says('好的')],
    })
    // 观测 markCold 而不是 unload：夹具是纯文本，§11.4 之后卸载对它一个字都
    // 不省，`indices` 恒为空。出局判定跑没跑要看 cold（同上一条的说明）
    expect(tight.cold.flat().length).toBeGreaterThan(0)

    // 对照组：同样的 700，maxTokens 小到不用预留那么多 → 700 < 1000-100，不卸。
    // 两条一起才证明"卸载与否真的随 maxTokens 变"，而不是恒卸
    const loose = spyMemory()
    await drive({
      messages: history(),
      memory: loose.memory,
      lastUsage: nearFull,
      maxTokens: 100,
      rounds: [says('好的')],
    })
    expect(loose.cold).toEqual([])
  })

  it('**一个 turn 自己就超预算时也不卸它**——至少保 1 个 turn 是硬约束', async () => {
    // 提案 §4.5 ④ 的后半句：「累计超过预算的 35% 就停，**但至少保 1 个 turn，
    // 哪怕它自己就超**」。不是兜底，是硬约束——正在跑的那个 turn 还没结束、
    // 没有摘要，把它挤出去等于「模型忘了自己这一轮在干什么」。超出的部分归
    // §4.8 的降级顺序管（先裁工具输出），不归卸载管。
    //
    // 这类故障**不抛异常**：卸完照样发请求，只是模型答非所问（§6.4）
    const history = (): Message[] => [
      { role: 'user', parts: [{ type: 'text', text: denseJson(60) }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 't', output: denseJson(60), isError: false }],
      },
      { role: 'user', parts: [{ type: 'text', text: '接着说' }] },
    ]
    const heavy = usage()
    heavy.inputTokens = 950 // 窗口 1000、maxTokens 100 → 预算 900，确实超了

    // 四条消息同属一个 turn（含最后那条：agent 跑着时插进来的用户消息并进
    // 当前 turn，run.ts:205）
    // 前提：这一个 turn 自己就压过了 target（窗口 1000 × targetRatio 0.4）。
    // 不成立的话根本走不到「超了但不卸」这个分支，测的是「没超所以没卸」。
    // **量的是夹具、不是跑完之后的 ctx.messages**——后者在卸载真的发生时会变成
    // 存根，于是这条断言先红，把失败指向「前提不成立」而不是「护栏没了」
    expect(history().reduce((n, m) => n + estimateMessageTokens(m.parts), 0)).toBeGreaterThan(
      1000 * 0.4,
    )

    // 四条消息**同属一个 turn**，四个不同的 step
    const oneTurn = (messages: Message[]) =>
      messages.map((message, i) => ({ message, turnId: 0, stepId: i }))

    const one = spyMemory({ withTurns: oneTurn })
    await drive({
      messages: history(),
      memory: one.memory,
      lastUsage: heavy,
      rounds: [says('好的')],
    })

    // 同一个 turn 内部，老 step 照样出局
    expect(one.cold.flat().length).toBeGreaterThan(0)
    // 但**最后一个 step 永远不出局**：保底区至少保它一个，哪怕 floorTokens=1。
    // 这一条守的是「模型不能忘了自己这一轮在干什么」——保底区的存在理由没变，
    // 变的只是边界从「turn 归属」换成了「token 数」
    expect(one.cold.flat()).not.toContain(3)

    // **对照：floorTokens 配得比整个预算还大，也照样卸得动。**
    //
    // 这条守的是「保底区与预算比例取小」。没有它，「floorTokens 比预算大」
    // 会让保底区吞掉全部历史——**又变回改动前那个「一条都卸不动」的病**，
    // 而且静默。本次实施时 summary-e2e / merge-e2e（窗口 3,000、floorTokens
    // 默认 16,000）当场全红，就是这个洞
    const wide = spyMemory({ floorTokens: 100_000, withTurns: oneTurn })
    await drive({
      messages: history(),
      memory: wide.memory,
      lastUsage: heavy,
      rounds: [says('好的')],
    })
    expect(wide.cold.flat().length).toBeGreaterThan(0)
  })

  it('**卸载同时裁 tool_call.input 和 tool_result.output，对话文本一个字不动**', async () => {
    // **这条原来叫「保底 turn 超预算时就地裁工具输出，一个字不写库」**，测的是
    // §4.8 第 1 级降级（`clipToolsInPlace`）。§11.4 之后那个函数没了：保底区的
    // 边界改成按 token 收口，「整个当前 turn 都动不了」这个前提不存在了，
    // 老 step 走的是正常卸载，会正常写库、正常判冷。所以「不写库」那两条断言
    // 反过来了。
    //
    // 事故记录保留：实测语料里工具 I/O 占 53%（§8.2），最大的 turn
    // 152,125 token（§8.1）——配个 128k 窗口的模型，这种 turn 一出现会话
    // 当场判死。**这个病现在由「按 step 卸」治，不是由「就地裁」治。**
    //
    // 剩下要钉的是两条跟 §11.4 直接相关的性质：工具的**输入和输出都要裁**，
    // 对话文本**一个字不动**
    const command = `echo ${'x'.repeat(400)}`
    const history = (): Message[] => [
      { role: 'user', parts: [{ type: 'text', text: denseJson(60) }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 't', name: 'bash', input: { command } }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 't', output: denseJson(60), isError: false }],
      },
      { role: 'user', parts: [{ type: 'text', text: '接着说' }] },
    ]
    const heavy = usage()
    heavy.inputTokens = 950

    const m = spyMemory({
      withTurns: (messages) => messages.map((message, i) => ({ message, turnId: 7, stepId: i })),
    })
    const h = await drive({
      messages: history(),
      memory: m.memory,
      lastUsage: heavy,
      rounds: [says('好的')],
    })

    // 归档路径由 store 按下标发回来（spyMemory 的 unload），下标即 step
    const output = h.ctx.messages[2]?.parts[0]
    const input = h.ctx.messages[1]?.parts[0]
    expect(output?.type === 'tool_result' && output.output).toContain('turn-2.jsonl')
    // 输入也要裁：`cat > x <<EOF ...500 行... EOF` 这种命令比多数输出都大（§9.4）
    expect(input?.type === 'tool_call' && (input.input as { command: string }).command).toContain(
      'turn-1.jsonl',
    )

    // **对话文本一个字不动**（§11.4）。原来这条注释写的是「把『裁工具』和
    // unloadMessage 的『全都裁』区分开」——那两个函数已经合成一个了，现在
    // 它钉的是合并后的 unloadMessage 确实不碰 text。denseJson 是用户刚说的
    // 话，是这一轮的题面
    const first = h.ctx.messages[0]?.parts[0]
    expect(first?.type === 'text' && first.text).toBe(denseJson(60))

    // **写库、判冷都要发生**（原来断言的是这两条都不发生）。走的是正常卸载
    // 路径，原文得先落库才能裁——不然 archivePath 指向的地方是空的
    // **判冷和写库的集合不一样，这是有意的。** step 0 是纯文本，卸载对它是
    // 恒等的——给它也存一份「原文」，库里就是内容完全相同的两行（写放大的
    // 另一种形态，`write-amplification` 盯着这个）。但它照样该判冷：出局是
    // 位置决定的，卸不卸得动是另一回事（§11.5）
    expect(m.calls.flat()).toEqual([1, 2])
    expect(m.cold.flat()).toEqual([0, 1, 2])
    expect(h.events.filter((e) => e.type === 'unloaded')).toHaveLength(1)
  })

  it('**对照：已经是存根的，count 必须是 0**——否则熔断器数着圈空转', async () => {
    // 卸完还是超预算是常态。第二遍如果照样报「卸了 N 条」，forceUnload 会认为
    // 有进展、再发一次同样大的请求，熔断器变成纯计数。
    //
    // **断言的对象换了。** 原来是「一个 unloaded 事件都不发」，那时候走的是
    // `clipToolsInPlace`，它自己判存根、判完直接不发事件。现在走正常卸载：
    // 存根被 `savingOf > 0` 过滤掉，`indices` 为空，事件照发但 **count 是 0**
    // ——forceUnload 累加的是 count，所以熔断这条性质原样成立。
    // 盯 count 而不是盯事件条数，才是盯在真正决定重不重发的那个量上
    const stub = `${'y'.repeat(30)}\n# [已卸载，完整内容见 .simple-code/memory/turns/turn-7.jsonl]`
    const heavy = usage()
    heavy.inputTokens = 950

    const m = spyMemory({
      withTurns: (messages) => messages.map((message, i) => ({ message, turnId: 7, stepId: i })),
    })
    const h = await drive({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: denseJson(60) }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls' } }],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', toolCallId: 't', output: stub, isError: false }],
        },
        { role: 'user', parts: [{ type: 'text', text: '接着说' }] },
      ],
      memory: m.memory,
      lastUsage: heavy,
      rounds: [says('好的')],
    })

    const counts = h.events.flatMap((e) => (e.type === 'unloaded' ? [e.count] : []))
    // 前提：判定确实跑了（不是「压根没触发卸载」把这条蒙过去的）
    expect(counts.length).toBeGreaterThan(0)
    expect(counts.every((n) => n === 0)).toBe(true)
  })

  /**
   * 基线下标的坐标系是 `ctx.messages`，**不是拼装后那份**。
   *
   * 一度记成 `request.messages.length`：两者曾经等价（卸载原地改写不改长度），
   * 摘要顶替把它打破了——被覆盖的 live 消息拼装时整条不出现。真实故障现场
   * （regions.jsonl + state.db）：内存历史 448 条，拼出去只剩 72 条，于是
   * `ctx.messages[72:]` 那 376 条——绝大多数根本没发出去——被当成「上次响应
   * 之后新增」又估了一遍，32,517 的真实上下文算成 251,135，超预算 238,000，
   * 从此每轮都触发卸载。UI 上就是「上下文明明没满却一直在归档」。
   *
   * 而且自我强化：每生效一条摘要，拼装就更短一截，下标更靠前，虚高更多。
   */
  describe('基线下标以 ctx.messages 为准', () => {
    const summary = (coversFrom: number, coversTo: number): Summary => ({
      id: 1,
      owner: null,
      level: 0,
      name: '',
      text: '早几轮的摘要',
      status: 'ready',
      inContext: true,
      supersededBy: null,
      head: null,
      archivePath: null,
      coversFrom,
      coversTo,
    })

    /** 8 条各 100 token 共 800，低于预算 900——这份历史本身不该触发卸载 */
    const history = (): Message[] =>
      Array.from({ length: 8 }, (_, i) => bulky(i % 2 === 0 ? 'user' : 'assistant', 100))

    /** 第一轮回一个指定 inputTokens 的 usage，它就是下一轮的基线 */
    const callsWith = (inputTokens: number): StreamEvent[] => [
      ...calls('t1').slice(0, -1),
      { type: 'finish', reason: 'tool-calls', usage: { ...usage(), inputTokens } },
    ]

    it('摘要顶替掉的消息不重复计入预算', async () => {
      // withTurns 默认 stepId = 下标，摘要盖住 0..6 → 拼装后只剩「摘要 + 第 8 条」
      const m = spyMemory({ summaries: () => [summary(0, 6)] })
      const h = await drive({
        messages: history(),
        memory: m.memory,
        // 真实基线 400：加上这一轮新增的两条（tool_call + 结果，几十 token）
        // 离预算 900 还很远。但把没发出去的那 6 条重算一遍就会越过去
        rounds: [callsWith(400), says('好的')],
      })

      // 前提一：拼装确实塌缩了。不塌缩的话两个下标恰好相等，这条测试是空的
      expect(h.sent[0]?.messages.length).toBeLessThan(8)
      // 前提二：第一轮本来就没触发卸载（那时还没有基线，纯估算 800 < 900）。
      // 否则「第二轮不卸」可能只是因为第一轮已经卸干净了
      expect(h.requests()).toBe(2)

      // 主断言：第二轮也不卸。观测 markCold 而不是 unload——出局是位置决定的，
      // 裁不裁得动是另一回事（§11.5）
      expect(m.cold).toEqual([])
    })

    it('对照组：真实 usage 确实超预算时照常卸载', async () => {
      // 没有这条的话，「卸载在这个夹具里根本跑不起来」也能让上一条绿
      const m = spyMemory({ summaries: () => [summary(0, 6)] })
      await drive({
        messages: history(),
        memory: m.memory,
        rounds: [callsWith(950), says('好的')], // 950 > 预算 900，这次是真超了
      })

      expect(m.cold.flat().length).toBeGreaterThan(0)
    })
  })
})

// ------------------------------------------------------------ §11 窗口分区

/**
 * §11.7 的验证清单。这一组盯的是**分区本身**：谁在可卸载区、谁在保底区、
 * 出局的判据是什么。上面那些用例盯的是卸载的产物（存根形状、写库次数）。
 */
describe('窗口分区（§11）', () => {
  const heavy = (): Usage => ({ ...usage(), inputTokens: 950 })
  /** 100 条消息同属一个 turn，每条自己一个 step */
  const oneTurn = (messages: Message[]) =>
    messages.map((message, i) => ({ message, turnId: 0, stepId: i }))

  it('**一个 turn 里有 100 个 step，照样卸得动**——§11 要治的就是这个病', async () => {
    // 改动前：`pickOldest` 按 turn 整组挑，第一组就是这个 turn、就撞上保底区
    // （保底区当年是「最后一个 user 消息及其之后」＝整个当前 turn），直接
    // break，一条都挑不出来。实测语料里最大的 turn 有 152,125 token（§8.1），
    // 这不是构造出来的极端情况
    const many = Array.from({ length: 100 }, () => bulky('user', 60))
    const m = spyMemory({ withTurns: oneTurn })
    const h = await drive({
      messages: many,
      memory: m.memory,
      lastUsage: heavy(),
      rounds: [says('好的')],
    })

    expect(m.cold.flat().length).toBeGreaterThan(50)
    // **但不是卸光。** 到 target 就停——卸光了模型什么都不记得，那是另一种坏
    expect(m.cold.flat().length).toBeLessThan(100)

    // **这里不断言「物理体积降到触发线以下」，因为做不到。** 每个存根有固定
    // 开销（光通知里那条归档路径就 ~50 字符），100 个 step 卸完还剩 5,106
    // token 全是存根本身——卸载的下界是「step 数 × 存根开销」。生产的 238,000
    // 预算下无所谓，但夹具这个尺度上它就是主导项。要看的是**出局这件事发生了**
    // （改动前是 0 条），体积不是这条用例的观测量
    const left = h.ctx.messages.reduce((n, msg) => n + estimateMessageTokens(msg.parts), 0)
    expect(left).toBeLessThan(many.reduce((n, msg) => n + estimateMessageTokens(msg.parts), 0))

    // **对照：同样这 100 个 step，窗口给够就一条都不出局。** 少了它，
    // 「无条件卸一半」也能让上面全绿。只动 contextWindow 一个旋钮
    const roomy = spyMemory({ contextWindow: 100_000, withTurns: oneTurn })
    await drive({
      messages: Array.from({ length: 100 }, () => bulky('user', 60)),
      memory: roomy.memory,
      lastUsage: heavy(),
      rounds: [says('好的')],
    })
    expect(roomy.cold).toEqual([])
  })

  it('**纯 reasoning 的 step 出局时 reasoning 整块丢弃**（compaction-v2 §0.3）', async () => {
    // **这条在 §11.5 之前必红。** 旧的 `pickOldest` 有一句 `if (saved <= 0)
    // continue`：卸载省不到量的 step 直接跳过，于是它永远不进 picked、永远
    // 不标 unloaded、它所在的段永远凑不齐「整段卸空」，**那个 turn 的摘要
    // 永远不生效**。纯问答和纯思考的 turn 就这么卡在 live 里出不去。
    //
    // 位置制让它照样出局、照样判冷；v2 再进一步：出局即丢 reasoning
    // （-76% 的那个大头），纯 reasoning 的消息丢完剩空壳，normalize 删掉。
    // 它的正文/推理原文都在 turns 归档里，cat 得回来
    const thinker = (n: number): Message => ({
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: `第${n}段推理`.repeat(60), encrypted: `sig-${n}` },
        { type: 'text', text: '嗯' },
      ],
    })
    const messages = [thinker(1), thinker(2), bulky('user', 300)]
    const m = spyMemory({ withTurns: oneTurn })
    const h = await drive({
      messages,
      memory: m.memory,
      lastUsage: heavy(),
      rounds: [says('好的')],
    })

    expect(m.cold.flat()).toContain(0) // 出局了
    expect(m.calls.flat()).toContain(0) // reasoning 丢了，真省得下——写库存原文
    // reasoning 整块没了，正文保留
    const after0 = h.ctx.messages[0]
    expect(after0?.parts.some((p) => p.type === 'reasoning')).toBe(false)
    expect(after0?.parts.some((p) => p.type === 'text')).toBe(true)
  })

  it('**保底区逐字不变**——最近那段是模型判断「我在干什么」的全部依据', async () => {
    // floorTokens 给 200：从后往前数够 200 token 就收口，再往前扩到 step 起点
    const messages = Array.from({ length: 8 }, () => bulky('user', 200))
    const before = structuredClone(messages)
    const m = spyMemory({ floorTokens: 200, withTurns: oneTurn })
    const h = await drive({
      messages,
      memory: m.memory,
      lastUsage: heavy(),
      rounds: [says('好的')],
    })

    // 前提：确实卸了东西，不然「保底区没变」是因为整个历史都没变
    expect(m.calls.flat().length).toBeGreaterThan(0)
    // 原历史的最后一条一定在保底区里（floorStartIndex 至少圈住最后一个 step）。
    // 按下标比，不是 at(-1)——跑完一轮之后末尾多了模型这次的回复
    const last = before.length - 1
    expect(h.ctx.messages[last]).toEqual(before[last])
    expect(m.cold.flat()).not.toContain(last)
  })

  it('**出局的 step 必须是连续前缀**——段的语义全靠这一条', async () => {
    // 「碰头即上岗」判的是段头那一条（segmentHeadUnloaded）。挑选一旦跳着来
    // （比如按「谁省得多」排序），会出现段尾卸了、段头没卸——判头退回不上岗
    // （存根滞留），判任一则把推进线还没扫到的历史顶掉。前缀性保证「段头卸了」
    // 等价于「推进线真的到过这段」
    const messages = [
      bulky('user', 300), // 卸得动
      { role: 'user', parts: [{ type: 'text', text: '短' }] } as Message, // 卸不动
      bulky('user', 300),
      bulky('user', 300),
    ]
    const m = spyMemory({ withTurns: oneTurn })
    await drive({
      messages,
      memory: m.memory,
      lastUsage: heavy(),
      rounds: [says('好的')],
    })

    const cold = m.cold.flat()
    expect(cold.length).toBeGreaterThan(1)
    // 前提：中间那条**确实卸不动**（否则「前缀」是碰巧成立的）
    expect(m.calls.flat()).not.toContain(1)
    // 本体：判冷的集合是 0..n 的连续前缀，中间那条没被跳过
    expect(cold).toEqual([...cold].sort((a, b) => a - b))
    expect(cold).toEqual(Array.from({ length: cold.length }, (_, i) => i))
  })
})

/**
 * 估算失效时的兜底。主动卸载靠预算判断，而预算里有估算成分，估算永远可能偏低；
 * 偏低的后果就是这里的 400。**这条路径以前完全没有**：`context_overflow` 被
 * 协议层认出来，然后跟"API key 错了"走同一条路——报错、结束，而下一轮历史更长，
 * 于是每轮都 400，session 从此废掉。
 */
describe('撞上下文窗口后的自救', () => {
  const overflow = () =>
    new LLMStreamError({
      kind: 'context_overflow',
      message: 'prompt is too long: 131500 tokens > 128000',
      retryable: false,
    })

  /** 前 n 次抛 overflow，之后正常回答 */
  function failingStream(n: number) {
    let calls = 0
    const stream = (): AsyncIterable<StreamEvent> =>
      (async function* () {
        calls++
        if (calls <= n) throw overflow()
        for (const ev of says('这次放得下了')) yield ev
      })()
    return { stream, calls: () => calls }
  }

  const history = (): Message[] => [bulky('user', 300), bulky('assistant', 300), bulky('user', 50)]

  it('超限后卸载历史再重发，而不是直接失败', async () => {
    const m = spyMemory()
    const s = failingStream(1)
    const h = await drive({ messages: history(), memory: m.memory, stream: s.stream })

    // 前提：第一次确实是因为超限失败的，不是流本身空了
    expect(s.calls()).toBe(2)
    expect(m.unloadedCount()).toBeGreaterThan(0) // 重发之前真的卸了东西
    expect(kinds(h.events)).not.toContain('error')
    expect(kinds(h.events)).toContain('step_finish') // 第二次成功了
  })

  it('重发之前一定真的卸掉东西——参数没变就重发是白烧钱', async () => {
    // 把截断当可重试错误、参数一字未改地重发，必然再次失败，
    // 白烧 max_retries 次。所以卸不动就不该再试
    const s = failingStream(99)
    const m = spyMemory({
      unload: () => [], // 卸不掉任何东西
    })
    const h = await drive({ messages: history(), memory: m.memory, stream: s.stream })

    expect(s.calls()).toBe(1) // 只发了一次，没有徒劳重试
    expect(kinds(h.events)).toContain('error')
  })

  it('连续卸载后仍然超限时熔断，不无限重试', async () => {
    // 熔断器有线上数据背书：1,279 个 session
    // 出现 50+ 次连续失败（最高 3,272 次），每天浪费约 250K 次调用。
    //
    // **每次都必须真的卸掉东西，熔断才是唯一的出口。** 用普通历史的话，第一次
    // 就把可卸的全卸完了，第二次 forceUnload 返回 false —— 挡住重试的是那个
    // 条件而不是熔断，删掉熔断照样绿（变异检验实测：M6 存活）。
    // 所以这里让 unload 永远"成功"，逼熔断出面
    const s = failingStream(99)
    const m = spyMemory({
      unload: (indices) =>
        indices.map((i) => ({
          archivePath: `.simple-code/memory/turns/turn-${i}.jsonl`,
          turnId: i,
          stepId: i,
        })),
    })
    // 消息足够多、且每轮都还有的卸：预算永远超，pickOldest 永远挑得出东西
    const many = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? bulky('user', 300) : bulky('assistant', 300),
    )
    const h = await drive({
      messages: [...many, bulky('user', 50)],
      memory: m.memory,
      stream: s.stream,
    })

    expect(s.calls()).toBeLessThanOrEqual(3)
    const err = h.events.find((e) => e.type === 'error')
    expect(err).toBeDefined()
    expect((err as { message: string }).message).toContain('窗口')
  })

  it('**保底区自己就撑爆窗口时，force 路径连它一起卸再重发**——以前这里是绝症', async () => {
    // 夹具只有一个 step，整个落在保底区里。§4.8 第 1 级降级之前，这条路只
    // 通向熔断：用户收到「开一个新会话，或者换一个窗口更大的模型」，而这个
    // step 一半以上是能卸的工具输出。
    //
    // **§11 实施时这个洞一度重新打开。** 当时 run.ts 里写的是「保底区有
    // floorTokens 夹着，撑不爆窗口，那个兜底要救的情况构造不出来了」——错的：
    // 夹的是**门限**，不是保底区的实际大小，`floorStartIndex` 无论如何要整个
    // 圈住最后一个 step。就是这条用例把它照出来的。
    //
    // 修法不是把「裁剪」请回来（§11.4 只留一个动作），是让 force 路径放弃
    // 保底区——同一个 unloadMessage，只是紧急时连保底区一起卸
    const s = failingStream(1)
    const m = spyMemory({
      withTurns: (messages) => messages.map((message, i) => ({ message, turnId: 0, stepId: i })),
    })
    const h = await drive({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: '跑一下' }] },
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 't', name: 'bash', input: { command: 'ls' } }],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', toolCallId: 't', output: 'X'.repeat(2000), isError: false },
          ],
        },
      ],
      memory: m.memory,
      stream: s.stream,
    })

    // 前提：卸的**就是保底区里那条**（只有一个 step，它自己就是保底区）。
    // 少了这条，「普通卸载碰巧够用」也能让下面全绿
    expect(m.calls.flat()).toContain(2)
    const stub = h.ctx.messages[2]?.parts[0]
    expect(stub?.type === 'tool_result' && stub.output.length).toBeLessThan(2000)

    expect(s.calls()).toBe(2) // 重发了，而且这次过了
    expect(kinds(h.events)).not.toContain('error')
    expect(kinds(h.events)).toContain('step_finish')
    // 连保底区都卸了，报 force——这个场景用户该警觉，混进「接近上限」会被淹掉
    const ev = h.events.find((e) => e.type === 'unloaded')
    expect((ev as { reason: string } | undefined)?.reason).toBe('force')
  })

  it('没有 memory 时不假装能自救，直接报错', async () => {
    // ephemeral session：没有 store 就没地方存原文，卸载等于丢数据
    const s = failingStream(99)
    const h = await drive({ messages: history(), stream: s.stream })

    expect(s.calls()).toBe(1)
    expect(kinds(h.events)).toContain('error')
  })

  it('对照组：非超限的错误不走这条路', async () => {
    // auth 错误重发一万次也没用，卸载更是南辕北辙
    let calls = 0
    const stream = (): AsyncIterable<StreamEvent> =>
      (async function* () {
        calls++
        throw new LLMStreamError({ kind: 'auth', message: 'bad key', retryable: false })
        // biome-ignore lint/correctness/noUnreachable: 让它成为合法的 AsyncIterable
        yield { type: 'text_start' } as StreamEvent
      })()
    const m = spyMemory()
    const h = await drive({ messages: history(), memory: m.memory, stream })

    expect(calls).toBe(1)
    expect(m.calls).toEqual([]) // 一条都没卸
    expect(kinds(h.events)).toContain('error')
  })
})

describe('loop 里没有协议分支', () => {
  it('LLMEvent 与 StreamEvent 之外的东西都不出现在 run.ts 里', async () => {
    // 形式化不了，用类型兜底：deps.stream 的产出就是 StreamEvent，
    // 换协议不需要改 loop。这条测试的价值在于它编译得过
    const ev: LLMEvent = { type: 'text_start' }
    const streamEv: StreamEvent = ev
    expect(streamEv.type).toBe('text_start')
  })
})

describe('四个区的记账（提案 §13）', () => {
  it('**每发一次请求记一行**，budget 记的是预算不是窗口', async () => {
    // 一轮工具调用 = 两次请求（发工具、拿结果再发一次），所以是两行。
    // budget：窗口 1000 − maxTokens 100 − margin 0 = 900
    const m = spyMemory()
    await drive({
      messages: [{ role: 'user', parts: [{ type: 'text', text: '跑一下' }] }],
      memory: m.memory,
      rounds: [calls('t1'), says('跑完了')],
    })

    expect(m.regions.length).toBe(2)
    expect(m.regions.every((r) => r.budget === 900)).toBe(true)
  })

  it('每行带**同一次请求**的真实输入 token（缓存读写都算）；渠道报 0 记 null', async () => {
    // 两次请求 usage 不同：第一次 3+50+7=60，第二次全 0（网关不报）。
    // 行和请求对不上号（比如错记成上一次的）这里就会红
    const m = spyMemory()
    const zero: Usage = { ...usage(), inputTokens: 0, outputTokens: 0 }
    const first: Usage = { ...usage(), inputTokens: 3, cacheReadInputTokens: 50, cacheCreationInputTokens: 7 }
    await drive({
      messages: [{ role: 'user', parts: [{ type: 'text', text: '跑一下' }] }],
      memory: m.memory,
      rounds: [
        calls('t1').map((e) => (e.type === 'finish' ? { ...e, usage: first } : e)),
        says('跑完了').map((e) => (e.type === 'finish' ? { ...e, usage: zero } : e)),
      ],
    })

    expect(m.regions.map((r) => r.real)).toEqual([60, null])
  })

  it('**卸载之后那一行的 ③ 才有数**——记的是真发出去的那份，不是内存历史', async () => {
    // 对照组在下一条。没有它的话，一个「stub 恒等于 0」的实现在这里也是绿的
    const m = spyMemory()
    await drive({
      messages: [
        bulky('user', 300),
        bulky('assistant', 300),
        bulky('user', 300),
        bulky('assistant', 300),
        bulky('user', 300),
      ],
      memory: m.memory,
      rounds: [says('好的')],
    })

    expect(m.unloadedCount()).toBeGreaterThan(0) // 前提：这一轮确实卸了东西
    expect(m.regions.at(-1)?.sizes.stub).toBeGreaterThan(0)
  })

  it('对照：没触发卸载时 ③ 是 0，全部记在 ④', async () => {
    const m = spyMemory()
    await drive({
      messages: [{ role: 'user', parts: [{ type: 'text', text: '短' }] }],
      memory: m.memory,
      rounds: [says('好的')],
    })

    expect(m.unloadedCount()).toBe(0) // 前提：这一轮确实没卸
    expect(m.regions.at(-1)?.sizes.stub).toBe(0)
    // 没卸的原文：保底 + 保底外 live。短对话全在保底区，live 可能是 0
    const sizes = m.regions.at(-1)?.sizes
    expect((sizes?.floor ?? 0) + (sizes?.live ?? 0)).toBeGreaterThan(0)
  })
})

describe('图片缩放（发送侧，web-tools §2）', () => {
  const bigPng = makePng(2100, 2100, mulberry32(42)).toString('base64')

  it('发出去的是压缩后的，内存里的历史保持原图', async () => {
    const h = await drive({
      messages: [{ role: 'user', parts: [{ type: 'image', data: bigPng, mimeType: 'image/png' }] }],
      rounds: [says('好的')],
    })

    const sent = h.sent[0]?.messages[0]?.parts[0]
    expect(sent?.type).toBe('image')
    if (sent?.type !== 'image') return
    expect(sent.mimeType).toBe('image/jpeg') // 重编码过
    expect(sent.data.length).toBeLessThan(bigPng.length)

    // **库（内存历史）不动**——变换只发生在出口
    const stored = h.ctx.messages[0]?.parts[0]
    expect(stored).toMatchObject({ type: 'image', data: bigPng, mimeType: 'image/png' })
  })

  it('第二轮发送输入仍是原图——从源头重新组装，幂等无缓存', async () => {
    const h = await drive({
      messages: [{ role: 'user', parts: [{ type: 'image', data: bigPng, mimeType: 'image/png' }] }],
      rounds: [calls('t1'), says('完')],
    })

    for (const request of h.sent) {
      const sent = request.messages[0]?.parts[0]
      expect(sent?.type).toBe('image')
      if (sent?.type !== 'image') return
      expect(sent.mimeType).toBe('image/jpeg')
      expect(sent.data.length).toBeLessThan(bigPng.length)
    }
    // 且两轮的压缩结果来自同一原图（字节级一致，无累积劣化）
    const first = h.sent[0]?.messages[0]?.parts[0]
    const second = h.sent[1]?.messages[0]?.parts[0]
    expect(first).toEqual(second)
    expect(h.ctx.messages[0]?.parts[0]).toMatchObject({ data: bigPng })
  })
})

describe('视觉转述中断', () => {
  it('停止能打断挂住的转述——孤儿 signal 回归（2026-09-24 gemini 挂 120s 实测）', async () => {
    // 转述模型挂住、不产 token：只有收到 abort 才 reject。修复前 relay
    // 拿的是没人能 abort 的孤儿 signal，这个 promise 永远不落——整个
    // run 挂在 relayPendingImages 上，「停止」打不到它（vitest 超时兜底）
    let started = false
    const relay = vi.fn(
      async (_img: { data: string; mimeType: string }, _focus: string, signal?: AbortSignal) => {
        started = true
        return await new Promise<string>((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    )
    const controller = new AbortController()
    const deps: LoopDeps = {
      stream: (request: Request): AsyncIterable<StreamEvent> =>
        (async function* () {
          yield* says('好的')
        })(),
      now: () => 0,
      tools: new Map([fakeTool('bash')].map((t) => [t.name, t])),
      root: '/tmp',
      caps: { images: false },
      request: {
        model: 'm',
        maxTokens: 100,
        thinking: 'disabled',
        effort: 'high',
        reasoningDisplay: 'omitted',
        system: 'S',
        tools: [],
      },
      maxIterations: 10,
      visionRelay: relay,
    }
    const ctx: LoopContext = {
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'text', text: '看图' },
            { type: 'image', data: 'aGk=', mimeType: 'image/png' },
          ],
        },
      ],
      tasks: [],
      deps,
      signal: controller.signal,
    }

    const events: AgentEvent[] = []
    const consuming = (async () => {
      for await (const ev of run(ctx)) events.push(ev)
    })()
    // 转述已发出再停——停早了循环顶的 aborted 检查会直接跳过转述
    await vi.waitFor(() => expect(started).toBe(true))
    controller.abort()
    await consuming
    // 中断的转述存 ''：一次了结，图降级成占位符而不是每轮重撞
    expect(ctx.relayCache?.get('aGk=')).toBe('')
  })
})

/**
 * 按脚本逐轮出流。**记录每轮收到的 request**——「中断后不空转」这类断言
 * 靠的就是请求次数，不是事件内容
 */
function scriptedStream(rounds: StreamEvent[][]) {
  const seen: Request[] = []
  const stream = (request: Request): AsyncIterable<StreamEvent> => {
    const round = rounds[seen.length] ?? []
    seen.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return { stream, seen, requests: () => seen.length }
}


describe('relay 转述缓存盘上层（relay-cache.ts，方案 B 2026-09-24）', () => {
  const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }

  /** 一轮就结束的最小 deps；relay 是可替换的转述副模型桩 */
  const makeDeps = (root: string, relay: (img: { data: string }) => Promise<string>): LoopDeps => ({
    stream: (request: Request): AsyncIterable<StreamEvent> =>
      (async function* () {
        yield* says('好的')
      })(),
    now: () => 0,
    tools: new Map(),
    root,
    caps: { images: false },
    request: {
      model: 'm',
      maxTokens: 100,
      thinking: 'disabled',
      effort: 'high',
      reasoningDisplay: 'omitted',
      system: 'S',
      tools: [],
    },
    maxIterations: 10,
    visionRelay: async (img) => relay(img),
  })

  const makeCtx = (deps: LoopDeps): LoopContext => ({
    messages: [{ role: 'user', parts: [{ type: 'text', text: '看图' }, image] }],
    tasks: [],
    deps,
    signal: new AbortController().signal,
  })

  const drive = async (ctx: LoopContext): Promise<void> => {
    for await (const _ev of run(ctx)) void _ev
  }

  it('save 后 hit、roundtrip；追加写不互吞', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-'))
    relaySave(root, 'aaa', '[视觉转述] 甲')
    relaySave(root, 'bbb', '[视觉转述] 乙')
    expect(relayHit(root, 'aaa')).toBe('[视觉转述] 甲')
    expect(relayHit(root, 'bbb')).toBe('[视觉转述] 乙')
    // 两个内容不同的图键不撞
    expect(relayHit(root, 'ccc')).toBeUndefined()
    // 同图重写取新值
    relaySave(root, 'aaa', '[视觉转述] 甲2')
    expect(relayHit(root, 'aaa')).toBe('[视觉转述] 甲2')
  })

  it('session 重建后旧图不再重述：新 ctx 命中盘缓存，副模型零调用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-'))
    const relay1 = vi.fn(async () => '这张图里有只猫')
    await drive(makeCtx(makeDeps(root, relay1)))
    expect(relay1).toHaveBeenCalledTimes(1)
    expect(ctxRelayText(root, image.data)).toContain('猫')

    // session 重建 = 全新 ctx（relayCache 清零），盘上还在
    const relay2 = vi.fn(async () => '不该被调用')
    const ctx2 = makeCtx(makeDeps(root, relay2))
    await drive(ctx2)
    expect(relay2).not.toHaveBeenCalled()
    // 命中的是盘上那份转述，出口拿到的是同一段成品文本
    expect(ctx2.relayCache?.get(image.data)).toBe(`[视觉转述] ${ctxRelayText(root, image.data)}`)
  })

  it("失败（''）不落盘：只留内存层，下个 session 重试再述", async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-'))
    const fail = async () => {
      throw new Error('gemini 挂了')
    }
    const ctx1 = makeCtx(makeDeps(root, fail))
    await drive(ctx1)
    // 内存层存 ''：本 session 内一次了结
    expect(ctx1.relayCache?.get(image.data)).toBe('')
    // 盘上没有这张图——失败不落盘（瞬时超时不能变永久占位符）
    expect(relayHit(root, image.data)).toBeUndefined()

    const ok = vi.fn(async () => '重试成功了')
    await drive(makeCtx(makeDeps(root, ok)))
    expect(ok).toHaveBeenCalledTimes(1)
    expect(relayHit(root, image.data)).toBe('[视觉转述] 重试成功了')
  })
})

/** 从盘缓存文件里读出这张图的转述原文（去掉 `[视觉转述] ` 前缀用的反查） */
function ctxRelayText(root: string, data: string): string {
  const text = relayHit(root, data)
  expect(text).toBeDefined()
  return text!.replace(/^\[视觉转述\] /, '')
}

describe('拒答透传（finish.refusal → error 事件，2026-09-27 欠账补测）', () => {
  it('content-filter 带详情：yield 不可重试 error，消息含 category/explanation', async () => {
    const h = await drive({
      rounds: [[
        { type: 'finish', reason: 'content-filter', usage: usage(), refusal: { category: 'harm_category', explanation: '涉及敏感内容' } },
      ]],
    })
    const err = h.events.find((e) => e.type === 'error') as { message: string; retryable: boolean } | undefined
    expect(err).toBeDefined()
    expect(err!.retryable).toBe(false)
    expect(err!.message).toContain('harm_category')
    expect(err!.message).toContain('涉及敏感内容')
    expect(err!.message).toContain('未自动重试或清理历史')
    expect(err!.message).not.toContain('通常可行')
    // 不算错误流：这轮正常结束（无 tool call），只补一条说明
    expect(kinds(h.events)).toContain('step_finish')
    expect(h.requests()).toBe(1)
  })

  it('普通 stop 无 refusal：不 yield error', async () => {
    const h = await drive({ rounds: [says('好的')] })
    expect(h.events.filter((e) => e.type === 'error')).toHaveLength(0)
  })
})
