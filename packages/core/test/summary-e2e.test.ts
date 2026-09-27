import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Message, Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { resolveBucketFile } from '../src/session/buckets.ts'
import { listLeaves } from '../src/session/leaf.ts'
import { getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE, openStore } from '../src/session/store.ts'
import type { Tool, ToolOutput } from '../src/tools/types.ts'

/**
 * 3b-1 的端到端验收：**摘要生成 → 卸载时生效 → 重启后还对**。
 *
 * 前面各文件测的是单段（summarize.ts 挑 turn、store 读写、assemble 拼装、
 * repl 定时器）。这里测的是把它们串起来之后，模型实际看到的历史长什么样
 * ——那才是这一步唯一对用户可见的东西。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-e2e'

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

/**
 * 窗口调小，好让几轮对话就撞上卸载阈值。
 *
 * **窗口要明显大于 maxTokens + SAFETY_MARGIN（2000）**，否则预算落到下限
 * （contextWindow × 0.1），卸载行为由那个下限决定而不是由真实预算决定——
 * 测试仍然会绿，但测的不是要测的东西。所以 maxTokens 也一起调小。
 */
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
  // 预算 = 3000 - 500 - 2000 = 500，约两条 long() 消息（一条约 341）
  request: { maxTokens: 500 },
  // idleSummarizeDelayMs 关掉是为了**隔离触发点**：本文件靠手工调
  // summarizeIdle() 精确控制「此刻有几条摘要」，而 step 跑完的自动触发
  // （§9.7 修正二）会在 send 之后凭空多摘几条，把「前提：一条摘要都没有」
  // 这类断言直接冲垮。自动触发本身在 summarize-idle.test.ts 里测
  // 见 merge-e2e 里同一处的说明：夹具太短，用生产默认阈值裁不动
  memory: {
    unloadTargetRatio: 0.001,
        stubTurns: 1,
    keepHeadChars: 40,
    idleSummarizeDelayMs: 0,
    clipThresholdChars: 0,
  },
}

async function workspace(over: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-e2e-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(globalPath, JSON.stringify({ ...CONFIG, ...over }), 'utf8')
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
    // **走 JSON.stringify，不是裸插值。** 摘要现在是多行的结构化输出
    // （名称/描述/四段正文），裸插的换行会把这行 JSON 撑断——解析失败后
    // text 是空的，症状是「摘要一直 pending」，看不出是夹具的错
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`,
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

const summaryFetch = (text: string) =>
  (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(SUMMARY_SSE(text)))
          c.close()
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch

/** 记下每轮真正发出去的 request，那是模型看到的东西 */
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

/** 长到能把窗口顶满的一句话 */
// 尺寸按估算器校准：CJK 按一字一 token 估（tokens.ts 的 estimateText），
// repeat(20) ≈ 345 token，与旧估算器下 repeat(80)（1365 字 ÷4 ≈ 341）等价——
// 改估算口径时同步核这行，否则「几轮撞阈值」的节奏会漂
const long = (label: string) => `${label}${'。这是为了把上下文撑大而重复的内容'.repeat(20)}`

const calls = (id: string, input: unknown): StreamEvent[] => [
  { type: 'tool_input_start', id, name: 'bash' },
  { type: 'tool_input_delta', id, partial: JSON.stringify(input) },
  { type: 'tool_input_end', id, name: 'bash', input },
  { type: 'finish', reason: 'tool-calls', usage: usage() },
]

/**
 * 会吐一大坨输出的假工具。**下面两条「有没有产生存根」的用例必须有它。**
 *
 * §11.4 之后卸载只碰工具的 input/output，纯问答夹具卸载时一个字都不省，
 * 断言「模型看到存根」永远红。这不是断言写错了——是那个夹具**构造不出存根**，
 * 得让第一个 turn 真的调一次工具
 */
const bigTool: Tool = {
  name: 'bash',
  definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
  execute: async (): Promise<ToolOutput> => ({
    output: `工具输出的开头${'。这是会把上下文顶满的输出'.repeat(40)}`,
    exitCode: 0,
    isError: false,
  }),
}

/**
 * 连工具的 input/output 一起看。`textOf` 把非文本部分折成类型名（'tool_call'），
 * 而 §11.4 之后存根**只出现在工具那两个字段里**——用 textOf 去断言存根，
 * 看到的永远是 'tool_call' 四个字母
 */
const wireOf = (messages: Message[] | undefined): string => JSON.stringify(messages ?? [])

const textOf = (messages: Message[] | undefined): string =>
  (messages ?? [])
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join(''))
    .join('\n')

describe('摘要端到端', () => {
  it('**跨 provider 摘要：请求打到目标 provider 的 URL，主模型不动**', async () => {
    // summaryModel 的 ref 形态。连接解析错了的话摘要会打到主 provider 的
    // URL——config 层已断言解析结果，这里锁「真发出去的那一发」的 URL
    const { dir, globalPath } = await workspace({
      providers: {
        ...CONFIG.providers,
        cheap: {
          protocol: 'anthropic-messages',
          baseUrl: 'https://cheap.test',
          apiKey: '${TEST_KEY}',
          models: { small: { contextWindow: 60_000 } },
        },
      },
      memory: { ...CONFIG.memory, summaryModel: { provider: 'cheap', model: 'small' } },
    })
    const urls: string[] = []
    const crossFetch = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return (summaryFetch('读了 config.ts，跨网关摘要') as unknown as () => Promise<Response>)()
    }) as unknown as typeof fetch
    const rec = recordingStream([says('答一'), says('答二')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: crossFetch,
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await session.summarizeIdle()
    await session.close()

    // 摘要真生成了（不是静默失败——那是被 summarizeOnce 吞掉的典型症状）
    expect(openStoreSummaries(dir)[0]?.status).toBe('ready')
    // 主模型走 mock stream 不发 HTTP，urls 里**只应有**摘要那一发——
    // 全部命中目标网关，等于「没有一发打错到主 provider」
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith('https://cheap.test'))).toBe(true)
  })

  it('**摘要生成 → 卸载 → 模型看到「头部+摘要+路径」**', async () => {
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([says('答一'), says('答二'), says('答三')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: summaryFetch('读了 config.ts，发现三个配置项'),
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await session.summarizeIdle() // 空闲，摘掉第一轮

    // 前提：摘要确实生成好了，否则下面测的是降级路径
    expect(openStoreSummaries(dir)[0]?.status).toBe('ready')

    await drain(session.send(long('第三个问题'))) // 这一轮会撞上卸载阈值
    await session.close()

    const last = textOf(rec.sent.at(-1)?.messages)
    expect(last).toContain('读了 config.ts，发现三个配置项') // 摘要
    expect(last).toContain('第一个问题') // 头部（原话开头）
    expect(last).toContain('turn-') // 归档路径
    // 原文的后半段没了——那才叫卸载
    expect(last).not.toContain(long('第一个问题'))
  })

  it('**对照：没有摘要时降级成「头部+路径」，不是空洞**', async () => {
    // §9.7 的降级路径。没有这条的话，「卸载后必须有摘要」这种实现也能让
    // 上面那条通过——而它会在摘要还没生成时让整个 turn 从 context 里消失。
    //
    // **夹具加了一次工具调用**（原来是纯问答）：§11.4 之后「头部+路径」这个
    // 形状只在工具的 input/output 上出现，纯文本卸载时逐字不变，这条用例的
    // 被测形状压根构造不出来
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([
      calls('t1', { command: '看一下' }),
      says('答一'),
      says('答二'),
      says('答三'),
    ])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [bigTool],
      stream: rec.stream,
      fetchImpl: summaryFetch('用不到'),
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    // 故意**不**调 summarizeIdle
    expect(openStoreSummaries(dir)).toEqual([]) // 前提：一条摘要都没有

    await drain(session.send(long('第三个问题')))
    await session.close()

    const last = rec.sent.at(-1)?.messages
    expect(textOf(last)).toContain('第一个问题') // 头部还在
    expect(wireOf(last)).toContain('已卸载') // 3a 的截断存根
    expect(wireOf(last)).toContain('turn-') // 归档路径
    // **对话文本一个字没少**（§11.4）。原来这条 turn 的提问会被裁成头部，
    // 现在只有工具那两个字段变。「不是空洞」因此比原来更强
    expect(textOf(last)).toContain(long('第一个问题'))
  })

  it('**reservedTokens 真的挪动触发点**——配大了提前卸，配小了推后卸', async () => {
    // 这个值是"预算 = 窗口 - maxTokens - 它"里唯一没有实测依据的一项
    // （默认 2000 没有实测依据，按窗口比例推的），所以必须能配。
    //
    // **测两个方向，不只测"配了不报错"**：只测一个方向的话，把
    // `safetyMargin: config.config.memory.reservedTokens` 改回写死的常量，
    // 测试照样绿
    const run = async (reservedTokens: number) => {
      const { dir, globalPath } = await workspace({
        memory: { ...CONFIG.memory, reservedTokens },
      })
      // 同上一条：第一个 turn 得真调一次工具，否则卸载了也产不出存根，
      // 「卸没卸」这个观测量在纯问答夹具上恒为「没卸」
      const rec = recordingStream([calls('t1', { command: '看一下' }), says('答一'), says('答二')])
      const session = await getSession(dir, {
        globalPath,
        env: { TEST_KEY: KEY },
        tools: [bigTool],
        stream: rec.stream,
        fetchImpl: summaryFetch('用不到'),
        skipLock: true,
      })
      await drain(session.send(long('第一个问题')))
      await drain(session.send(long('第二个问题')))
      await session.close()
      return wireOf(rec.sent.at(-1)?.messages)
    }

    // 预算 = max(窗口×0.1, 3000 - 500 - reservedTokens)。
    //
    // **量以 lastUsage 为准，不是历史的字符数**：这些用例的假流回的
    // usage 是 inputTokens=1，那才是第二轮的基线（§9.4.1 的口径），
    // 所以第二轮的量约等于「1 + 新增的那条」而不是整个历史
    expect(await run(2_400)).toContain('已卸载') // 预算 300，放不下
    expect(await run(0)).not.toContain('已卸载') // 预算 2500，放得下
  })

  it('**重启之后模型看到的历史不变**', async () => {
    // turn 归属在内存和库里各有一份，对不上的话摘要会盖错 turn——
    // 现象是「重开之后它就不记得刚才说的了」，不报错
    const { dir, globalPath } = await workspace()
    const first = recordingStream([says('答一'), says('答二'), says('答三')])
    const s1 = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: first.stream,
      fetchImpl: summaryFetch('第一轮：看了目录'),
      skipLock: true,
    })
    await drain(s1.send(long('第一个问题')))
    await drain(s1.send(long('第二个问题')))
    await s1.summarizeIdle()
    await drain(s1.send(long('第三个问题'))) // 触发卸载 + 摘要生效
    await s1.close()
    const before = textOf(first.sent.at(-1)?.messages)
    // 前提：重启**之前**摘要就已经生效了。不断言的话，「摘要从来没生效过」
    // 也能让下面的 before/after 一致——一致地都不对
    expect(openStoreSummaries(dir)[0]?.inContext).toBe(true)

    // 重启，什么都不做，只是再问一句
    const second = recordingStream([says('答四')])
    const s2 = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: second.stream,
      fetchImpl: summaryFetch('用不到'),
      skipLock: true,
    })
    await drain(s2.send('新问题'))
    await s2.close()
    const after = textOf(second.sent[0]?.messages)

    // 摘要那段一字不差地还在，且**只有一条**（不是每次重启多一份）
    expect(after).toContain('第一轮：看了目录')
    expect(after.match(/第一轮：看了目录/g)).toHaveLength(1)
    // 重启前已经在 context 里的那些，重启后还在
    for (const marker of ['第一轮：看了目录', '第二个问题', '第三个问题']) {
      expect(before).toContain(marker)
      expect(after).toContain(marker)
    }
  })

  it('**热区的摘要在窗口里展开成叶子正文**', async () => {
    // C 把正文写进了文件，D 把它接回 context。不接的话正文写了没人读，
    // 「摘要一次产出键和正文」白花了那些 token
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([says('答一'), says('答二'), says('答三')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: summaryFetch(
        '名称: 配置项摸底\n描述: 读了 config.ts，发现三个配置项\n\n## 未完成/失败\n第三个配置项没查清楚',
      ),
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await session.summarizeIdle()
    await drain(session.send(long('第三个问题'))) // 撞卸载阈值，摘要生效
    await session.close()

    const last = textOf(rec.sent.at(-1)?.messages)
    expect(last).toContain('读了 config.ts，发现三个配置项') // 键
    expect(last).toContain('第三个配置项没查清楚') // **正文**——D 加的就是这一行
  })

  it('**结构化输出 → 正文落叶子文件，库里只留描述**', async () => {
    // §4.4 的分辨率梯度：正文（叶子文件）→ 键（name+描述）→ 内部节点一行。
    // 正文也塞进 summaries.text 的话，进 context 的就不是一行而是四段，
    // ④ 热区的预算立刻被几个 turn 吃光
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([says('答一'), says('答二')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: summaryFetch(
        '名称: 配置项摸底\n描述: 读了 config.ts，发现三个配置项\n\n## 用户要求\n看看配置\n## 涉及文件\nconfig.ts',
      ),
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await session.summarizeIdle()
    await session.close()

    expect(openStoreSummaries(dir)[0]?.status).toBe('ready') // 前提：真摘出来了
    // 库里那一列是描述，**不含正文**
    expect(openStoreSummaries(dir)[0]?.text).toBe('读了 config.ts，发现三个配置项')

    const leaves = listLeaves(join(dir, MEMORY_RELATIVE))
    expect(leaves).toHaveLength(1)
    expect(leaves[0]?.name).toBe('配置项摸底')
    expect(leaves[0]?.body).toContain('## 涉及文件')
    expect(leaves[0]?.coversTo).toBeGreaterThanOrEqual(leaves[0]?.coversFrom ?? 0)
  })

  it('**模型没按格式输出时也写叶子**，正文为空但文件必须在', async () => {
    // **这条是反转过来的。** 原来断言「不写叶子」，理由是「只有 frontmatter
    // 的空叶子比没有叶子更糟——索引树会把它当成『这一轮什么都没干』」。
    //
    // 那条理由在当时成立：内部节点是读 frontmatter 拼出来的，空的会污染路由
    // 行。现在内部节点改成调模型生成（§10 ②），frontmatter 只被 leafBodies
    // 用来取正文，空正文渲染出来就是温区那一档，不会假装成别的。
    //
    // 而不写的代价变实了：**摘要里那行「详情：」指的就是这个文件**，缺文件
    // 就是模型 cat 过去一个「No such file」。真库 34 条叶子里 18 条没文件
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([says('答一'), says('答二')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: summaryFetch('读了 config.ts，发现三个配置项'), // 没有名称/描述行
      skipLock: true,
    })

    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await session.summarizeIdle()
    await session.close()

    expect(openStoreSummaries(dir)[0]?.text).toBe('读了 config.ts，发现三个配置项')
    const leaves = listLeaves(join(dir, MEMORY_RELATIVE))
    expect(leaves).toHaveLength(1)
    // 正文如实为空——不编，也不拿描述凑数
    expect(leaves[0]?.body.trim()).toBe('')
    // 但描述在，温区那一档照样有东西可显示
    expect(leaves[0]?.description).toBe('读了 config.ts，发现三个配置项')
  })

  it('顺着摘要里那行路径，一路能 cat 回逐字原文', async () => {
    // 摘要是索引，原文得真的取得到，否则整套设计的前提不成立（§9.3）。
    //
    // **这条测的路径变长了一跳。** 原来 context 里直接给 `turns/*.jsonl`，
    // 断言 cat 它就有原文。现在给的是叶子（`summaries/*.md`）——几 KB 的
    // 结构化摘要，而不是几百 KB 的逐字对话，展开一次不再等于把刚卸载的
    // 全读回来。逐字原文没丢，在叶子 frontmatter 的 `turn:` 后面。
    //
    // 所以断言改成**把这条链走完**：context → 叶子 → 归档 → 原话。
    // 只断言叶子存在的话，就测不出「最后那一跳是不是真的到得了」
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([says('答一'), says('答二'), says('答三')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [],
      stream: rec.stream,
      fetchImpl: summaryFetch('第一轮的摘要'),
      skipLock: true,
    })
    await drain(session.send(long('第一个问题')))
    await drain(session.send(long('第二个问题')))
    await session.summarizeIdle()
    await drain(session.send(long('第三个问题')))
    await session.close()

    // ① context 里给的是叶子
    // 桶化后路径多一层（summaries/000/turn-…），正则放宽成可选桶段
    const leafRel = /(\.simple-code\/memory\/summaries\/(?:\d{3}\/)?turn-\d+-s\d+\.md)/.exec(
      textOf(rec.sent.at(-1)?.messages),
    )?.[1]
    expect(leafRel).toBeDefined() // 前提：请求里确实带了路径
    // ② 那个文件真的在，不是一条指向空气的路径
    const leaf = await readFile(join(dir, leafRel ?? ''), 'utf8')
    // ③ frontmatter 的 turn 指得到归档
    const turn = /^turn: (\d+)$/m.exec(leaf)?.[1]
    expect(turn).toBeDefined()
    const archive = await readFile(
      resolveBucketFile(
        join(dir, '.simple-code/memory'),
        'turns',
        `turn-${String(turn).padStart(6, '0')}.jsonl`,
      ),
      'utf8',
    )
    // ④ 逐字原文，一字不少
    expect(archive).toContain(long('第一个问题'))
  })
})

function openStoreSummaries(dir: string) {
  const store = openStore(dir)
  const rows = store.summaries()
  store.close()
  return rows
}
