import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listModels, loadConfig, selectModel } from '../src/config/load.ts'
import { anthropicMessages } from '../src/llm/protocols/anthropic-messages.ts'
import type { Message, Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession } from '../src/session/session.ts'
import type { Tool } from '../src/tools/types.ts'

/**
 * 运行时换模型。
 *
 * **这一整个文件对应的失败模式都是「不报错，只是行为不对」**：切了没生效、
 * 切在了正在跑的那一轮头上、或者切完之后每个请求都 400——最后那个虽然会报
 * 错，但报的是服务端的 400，从错误信息里看不出跟换模型有关。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/**
 * 两个 provider，**每一项都刻意不同**：协议、地址、key 的环境变量、
 * 上下文窗口、maxTokens。selectModel 只换对了一部分的话下面能指出是哪部分
 */
const CONFIG = {
  provider: 'alpha',
  model: 'a-small',
  providers: {
    alpha: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://alpha.invalid',
      apiKey: '${ALPHA_KEY}',
      models: {
        'a-small': { contextWindow: 100_000 },
        'a-big': { contextWindow: 400_000, request: { maxTokens: 8_000 } },
      },
    },
    beta: {
      protocol: 'openai-chat',
      baseUrl: 'https://beta.invalid',
      apiKey: '${BETA_KEY}',
      // effort 刻意配一个非默认值：换模型时能区分「覆盖被清掉了」和
      // 「覆盖还在」——两边都是 'high' 的话这两种情况长得一模一样
      models: {
        'b-one': { contextWindow: 32_000, request: { maxTokens: 4_000, effort: 'low' } },
      },
    },
  },
}

const ENV = { ALPHA_KEY: 'sk-ALPHA-1', BETA_KEY: 'sk-BETA-2' }

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-switch-'))
  dirs.push(dir)
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  return { dir, globalPath }
}

const loaded = async () => {
  const { dir, globalPath } = await workspace()
  return loadConfig(dir, { globalPath, env: ENV })
}

describe('selectModel', () => {
  it('**跨 provider 时协议、地址、key、窗口、请求偏好全跟着换**', async () => {
    const before = await loaded()
    // 前提：起点确实是 alpha，不是碰巧已经等于目标值
    expect(before.config.provider).toBe('alpha')
    expect(before.baseUrl).toBe('https://alpha.invalid')

    const after = selectModel(before, { provider: 'beta', model: 'b-one' }, ENV)

    expect(after.config.provider).toBe('beta')
    expect(after.config.model).toBe('b-one')
    expect(after.baseUrl).toBe('https://beta.invalid')
    expect(after.apiKey).toBe('sk-BETA-2') // ${BETA_KEY} 展开了，不是原样带过去
    expect(after.model.contextWindow).toBe(32_000)
    expect(after.request.maxTokens).toBe(4_000) // 模型级 request 覆盖生效
    // 协议对象整个换了。只换名字不换协议的话，请求体还是按旧协议拼的
    expect(after.protocol).not.toBe(before.protocol)
    expect(after.protocol.name).toBe('openai-chat')
  })

  it('同 provider 内换模型，只有模型相关的变', async () => {
    const before = await loaded()
    const after = selectModel(before, { provider: 'alpha', model: 'a-big' }, ENV)

    expect(after.model.contextWindow).toBe(400_000)
    expect(after.request.maxTokens).toBe(8_000)
    // 对照：provider 级的没动
    expect(after.baseUrl).toBe(before.baseUrl)
    expect(after.apiKey).toBe(before.apiKey)
    expect(after.protocol).toBe(before.protocol)
  })

  it('**不存在的模型抛异常，不回退到默认**（CLAUDE.md §1.2）', async () => {
    const before = await loaded()
    expect(() => selectModel(before, { provider: 'alpha', model: '打错了' }, ENV)).toThrow(
      /不在 provider "alpha" 的 models 里/,
    )
    // 报错要能指路。只说「找不到」的话用户不知道有哪些能选
    expect(() => selectModel(before, { provider: 'alpha', model: '打错了' }, ENV)).toThrow(
      /a-small/,
    )
  })

  it('provider 不存在也抛', async () => {
    const before = await loaded()
    expect(() => selectModel(before, { provider: 'gamma', model: 'b-one' }, ENV)).toThrow(
      /provider "gamma" 不在 providers 里/,
    )
  })

  it('原来那份 LoadedConfig 不被改动', async () => {
    // 纯函数。改到原对象上的话，调用方手里的引用会莫名其妙变了
    const before = await loaded()
    selectModel(before, { provider: 'beta', model: 'b-one' }, ENV)
    expect(before.config.model).toBe('a-small')
    expect(before.baseUrl).toBe('https://alpha.invalid')
  })
})

describe('listModels', () => {
  it('拍平所有 provider 下的模型', async () => {
    const config = (await loaded()).config
    expect(listModels(config)).toEqual([
      { provider: 'alpha', model: 'a-small' },
      { provider: 'alpha', model: 'a-big' },
      { provider: 'beta', model: 'b-one' },
    ])
  })
})

// ------------------------------------------------------------ session.setModel

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

const fakeTool = (): Tool => ({
  name: 'bash',
  definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
  execute: async () => ({ output: 'ok', exitCode: 0, isError: false }),
})

/** 每轮回放一段脚本，同时把收到的 Request 存下来 */
function scripted(rounds: StreamEvent[][]) {
  const seen: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[seen.length] ?? []
    seen.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return { stream, seen }
}

const open = async (rounds: StreamEvent[][] = []) => {
  const { dir, globalPath } = await workspace()
  const s = scripted(rounds)
  const session = await getSession(dir, {
    globalPath,
    env: ENV,
    tools: [fakeTool()],
    stream: s.stream,
    skipLock: true,
    ephemeral: true,
  })
  return { session, ...s }
}

const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream) {
    // 只要跑完，事件内容这里不关心
  }
}

describe('session.setModel', () => {
  it('下一次 send 用新模型', async () => {
    const { session, seen } = await open([says('一'), says('二')])
    await drain(session.send('第一句'))
    expect(seen[0]?.model).toBe('a-small') // 对照：切之前是旧的

    session.setModel({ provider: 'beta', model: 'b-one' })
    await drain(session.send('第二句'))

    expect(seen[1]?.model).toBe('b-one')
    expect(session.config.baseUrl).toBe('https://beta.invalid')
    await session.close()
  })

  it('**config 是 getter**——切完之后旧的读法要读到新值', async () => {
    // 写成固定属性的话，`session.config` 永远是建会话时那份，
    // 上下文占用还按旧窗口算，页脚显示旧模型名，全都不报错
    const { session } = await open()
    expect(session.config.model.contextWindow).toBe(100_000)
    session.setModel({ provider: 'beta', model: 'b-one' })
    expect(session.config.model.contextWindow).toBe(32_000)
    await session.close()
  })

  it('模型名写错时抛异常，且会话保持原样可用', async () => {
    const { session, seen } = await open([says('还能跑')])
    expect(() => session.setModel({ provider: 'alpha', model: '不存在' })).toThrow()
    // 抛完之后不能变成半死状态
    await drain(session.send('还能发吗'))
    expect(seen[0]?.model).toBe('a-small')
    await session.close()
  })
})

/**
 * 推理深度覆盖。**错了不抛异常，只是模型想得深浅不对**——而深浅本来就看不出
 * 来，只有账单和延迟能反映，那是最难发现的一类。
 */
describe('session.setEffort', () => {
  it('覆盖压在配置算出来的值上面', async () => {
    const { session, seen } = await open([says('一'), says('二')])
    await drain(session.send('第一句'))
    expect(seen[0]?.effort).toBe('high') // 前提：配置里 a-small 算出来是 high

    session.setEffort('max')
    await drain(session.send('第二句'))
    expect(seen[1]?.effort).toBe('max')
    await session.close()
  })

  it('**null = 撤掉覆盖，回到配置值**，不是回到某个硬编码默认', async () => {
    const { session, seen } = await open([says('一'), says('二')])
    session.setEffort('low')
    await drain(session.send('第一句'))
    expect(seen[0]?.effort).toBe('low')

    session.setEffort(null)
    await drain(session.send('第二句'))
    expect(seen[1]?.effort).toBe('high') // a-small 的配置值，不是 'low' 也不是别的
    await session.close()
  })

  it('只动 effort，request 的其他字段不受影响', async () => {
    const { session, seen } = await open([says('一')])
    session.setEffort('max')
    await drain(session.send('句'))
    expect(seen[0]).toMatchObject({ model: 'a-small', maxTokens: 32_000, thinking: 'adaptive' })
    await session.close()
  })

  it('**换模型清掉覆盖**，退回新模型自己的配置值', async () => {
    // 不清的话，在 A 上选的 max 会跟着到 B——档位含义按模型而定，B 可能
    // 根本不认这一档。而且请求照发，只是深浅不是用户以为的那个
    const { session, seen } = await open([says('一'), says('二')])
    session.setEffort('max')
    await drain(session.send('第一句'))
    expect(seen[0]?.effort).toBe('max') // 前提：覆盖确实生效过

    session.setModel({ provider: 'beta', model: 'b-one' })
    await drain(session.send('第二句'))
    expect(seen[1]?.effort).toBe('low') // b-one 配的是 low，不是跟过来的 max
    await session.close()
  })

  it('**切成同一个模型不清覆盖**——对照组', async () => {
    // setModel 开头那个「一样就直接 return」如果漏了，UI 每次重发一遍相同
    // 选择都会把用户调好的深度悄悄打回默认
    const { session, seen } = await open([says('一'), says('二')])
    session.setEffort('max')
    session.setModel({ provider: 'alpha', model: 'a-small' })
    await drain(session.send('句'))
    expect(seen[0]?.effort).toBe('max')
    await session.close()
  })

  it('跑着的时候调，当前这轮不受影响', async () => {
    const toolRound: StreamEvent[] = [
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_input_end', id: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'finish', reason: 'tool-calls', usage: usage() },
    ]
    const { session, seen } = await open([toolRound, says('续写'), says('下一轮')])

    const iterator = session.send('干活')[Symbol.asyncIterator]()
    let step = await iterator.next()
    while (!step.done && seen.length < 2) step = await iterator.next()
    expect(seen.length).toBe(2) // 前提：这一轮确实发了第二个请求

    session.setEffort('max')
    while (!step.done) step = await iterator.next()
    expect(seen.map((r) => r.effort)).toEqual(['high', 'high'])

    await drain(session.send('下一轮'))
    expect(seen[2]?.effort).toBe('max')
    await session.close()
  })
})

/**
 * **正在跑的那一轮不受影响。**
 *
 * 切换只影响下一轮。搞错了不报错——请求照发，只是这一轮的续写换了个模型，
 * 而 Anthropic 的 thinking 签名会当场 400、OpenAI 那边则是悄悄换了脑子。
 */
describe('切换时机', () => {
  it('agent 跑着的时候切，当前这轮仍用旧模型，下一轮才换', async () => {
    // 第一轮调工具（所以会发两次请求：调用 + 带结果续写），切换发生在两次之间
    const toolRound: StreamEvent[] = [
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_input_end', id: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'finish', reason: 'tool-calls', usage: usage() },
    ]
    const { session, seen } = await open([toolRound, says('续写'), says('第二轮')])

    const first = session.send('干活')
    const iterator = first[Symbol.asyncIterator]()
    // 推到工具已经调完、正准备发第二个请求之前
    let step = await iterator.next()
    while (!step.done && seen.length < 2) step = await iterator.next()

    expect(seen.length).toBe(2) // 前提：这一轮确实发了第二个请求
    session.setModel({ provider: 'beta', model: 'b-one' })
    while (!step.done) step = await iterator.next()

    // 这一轮的两个请求都还是旧模型
    expect(seen.map((r) => r.model)).toEqual(['a-small', 'a-small'])

    await drain(session.send('下一轮'))
    expect(seen[2]?.model).toBe('b-one') // 下一轮才换
    await session.close()
  })
})

/**
 * 跨模型的 reasoning 签名。**留着错签名是 400，剥掉只是少发一块思考**——
 * 不对称，往剥掉那边倒。见 session.ts 的 dropForeignSignatures 注释。
 */
describe('换模型剥掉 reasoning 签名', () => {
  const withThinking: StreamEvent[] = [
    { type: 'reasoning_start' },
    { type: 'reasoning_delta', text: '让我想想' },
    { type: 'reasoning_end', encrypted: 'sig-ALPHA-xyz' },
    { type: 'text_start' },
    { type: 'text_delta', text: '想好了' },
    { type: 'text_end' },
    { type: 'finish', reason: 'stop', usage: usage() },
  ]

  const signatures = (messages: readonly Message[]): (string | undefined)[] =>
    messages.flatMap((m) => m.parts.filter((p) => p.type === 'reasoning').map((p) => p.encrypted))

  /** 某次请求里 assistant 消息带的签名 */
  const sentSignatures = (request: Request | undefined): (string | undefined)[] =>
    (request?.messages ?? []).flatMap((m) =>
      m.parts.filter((p) => p.type === 'reasoning').map((p) => p.encrypted),
    )

  it('切到别的模型后发消息：发出去的请求里没有旧模型的签名（思考文本还在）', async () => {
    const { session, seen } = await open([withThinking, says('b 答')])
    await drain(session.send('想一下'))
    // 前提断言（§6.1）：确实存下了签名，否则「剥掉了」是在剥空集合
    expect(signatures(session.messages())).toEqual(['sig-ALPHA-xyz'])

    session.setModel({ provider: 'beta', model: 'b-one' })
    await drain(session.send('换了'))

    expect(seen[1]?.model).toBe('b-one')
    expect(sentSignatures(seen[1])).toEqual([undefined])
    expect(signatures(session.messages())).toEqual([undefined])
    // 文本没被连坐删掉——界面上那块思考还要显示
    expect(JSON.stringify(session.messages())).toContain('让我想想')
    await session.close()
  })

  it('setModel 本身不改历史——剥签名推迟到真发给别的模型时', async () => {
    // 在 setModel 里剥的话，重建会话时「恢复上次选择」也算换模型，每次
    // reload 剥一遍、改写请求前缀（2026-09-23 前缀守卫抓到）
    const { session } = await open([withThinking])
    await drain(session.send('想一下'))
    session.setModel({ provider: 'beta', model: 'b-one' })
    expect(signatures(session.messages())).toEqual(['sig-ALPHA-xyz'])
    await session.close()
  })

  it('A→B→A 中间没发消息：签名留着，回到 A 照常发出去', async () => {
    const { session, seen } = await open([withThinking, says('又是 a')])
    await drain(session.send('想一下'))
    session.setModel({ provider: 'beta', model: 'b-one' })
    session.setModel({ provider: 'alpha', model: 'a-small' })
    await drain(session.send('回来了'))
    expect(sentSignatures(seen[1])).toEqual(['sig-ALPHA-xyz'])
    await session.close()
  })

  it('**对照组：切成当前正在用的那个，签名必须留着**', async () => {
    // 没有这条的话，「无条件剥掉」也能让上面那条通过。而无条件剥掉的代价是
    // 每次 UI 重发一遍相同选择就把签名清一次，thinking 白思考
    const { session, seen } = await open([withThinking, says('还是 a')])
    await drain(session.send('想一下'))
    session.setModel({ provider: 'alpha', model: 'a-small' })
    await drain(session.send('再来'))
    expect(sentSignatures(seen[1])).toEqual(['sig-ALPHA-xyz'])
    await session.close()
  })

  it('重建会话恢复上次选择（配置默认 → 上次模型）：签名不剥、前缀守卫不响', async () => {
    // 真机 2026-09-23：面板重建会话 → onSessionReady 从配置默认 setModel 回
    // 上次的模型 → 旧代码当成换模型剥光签名 → 下一次请求 messages 第 91 条
    // 起与上次不同，PrefixBrokenError
    const { dir, globalPath } = await workspace()
    const big = { provider: 'alpha', model: 'a-big' }
    const first = scripted([withThinking])
    const s1 = await getSession(dir, { globalPath, env: ENV, tools: [fakeTool()], stream: first.stream, skipLock: true })
    s1.setModel(big)
    await drain(s1.send('想一下'))
    await s1.close()

    const second = scripted([says('接着')])
    const s2 = await getSession(dir, { globalPath, env: ENV, tools: [fakeTool()], stream: second.stream, skipLock: true })
    s2.setModel(big) // 恢复上次选择
    const events: { type: string; message?: string }[] = []
    for await (const ev of s2.send('重启后')) events.push(ev as { type: string; message?: string })
    await s2.close()

    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(sentSignatures(second.seen[0])).toEqual(['sig-ALPHA-xyz'])
  })

  it('前提：协议层确实会把没签名的 reasoning 整块丢掉', async () => {
    // dropForeignSignatures 的全部依据。协议层哪天改成「没签名就伪造一个」或者
    // 「原样发空 signature」，剥签名就从「少发一块」变成「照样 400」，
    // 而这个文件里其他测试全都还是绿的
    const reasoning = (encrypted?: string): Message => ({
      role: 'assistant',
      parts: [{ type: 'reasoning', text: '想', ...(encrypted ? { encrypted } : {}) }],
    })
    // 断言只看 messages。整个 body 里还有个顶层的 `thinking: {type:'disabled'}`
    // 参数，拿 body 全文找 'thinking' 会永远命中
    const wireMessages = (message: Message) =>
      JSON.stringify(
        (
          anthropicMessages.buildRequest(
            {
              model: 'm',
              messages: [message],
              system: '',
              tools: [],
              maxTokens: 1,
              thinking: 'disabled',
              effort: 'low',
              reasoningDisplay: 'omitted',
            },
            { baseUrl: 'https://x.invalid', apiKey: 'k' },
          ).body as { messages: unknown }
        ).messages,
      )

    expect(wireMessages(reasoning('sig-1'))).toContain('sig-1') // 对照：有签名就发
    expect(wireMessages(reasoning())).toBe('[{"role":"assistant","content":[]}]') // 没签名整块不见
  })
})
