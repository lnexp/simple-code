import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { listBucketFiles } from '../src/session/buckets.ts'
import { getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE, openStore } from '../src/session/store.ts'
import type { Tool } from '../src/tools/types.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

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
}

/** 记下工具收到的 ToolContext，用来断言 loop 确实把落盘钩子和路径都传下去了 */
let lastToolCtx: { onRawOutput: unknown; rawPath: string | undefined } = {
  onRawOutput: undefined,
  rawPath: undefined,
}

const fakeTool = (): Tool => ({
  name: 'bash',
  definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
  execute: async (_input, ctx) => {
    lastToolCtx = { onRawOutput: ctx.onRawOutput, rawPath: ctx.rawPath }
    ctx.onRawOutput?.('完整的原始输出，没被截断')
    return { output: 'ok', exitCode: 0, isError: false }
  },
})

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-persist-'))
  dirs.push(dir)
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  return { dir, globalPath }
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

/** 同一个目录再开一次 session，模拟重启 */
const openAt = async (dir: string, globalPath: string, stream: LoopDeps['stream']) =>
  getSession(dir, {
    globalPath,
    env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
    tools: [fakeTool()],
    stream,
    skipLock: true,
  })

const drain = async (source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

describe('session 持久化', () => {
  it('重开 session 时接着上次的历史，不是从头开始', async () => {
    const { dir, globalPath } = await workspace()

    const first = await openAt(dir, globalPath, scripted([says('第一轮回答')]))
    await drain(first.send('第一个问题'))
    await first.close()

    const second = await openAt(dir, globalPath, scripted([says('第二轮回答')]))
    // 前提：新 session 的历史不是空的——否则下面在测空气
    expect(second.messages()).toHaveLength(2)
    expect(second.messages()[0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', text: '第一个问题' }],
    })

    await drain(second.send('第二个问题'))
    expect(second.messages()).toHaveLength(4)
    await second.close()
  })

  it('ephemeral 不落盘，也不建 memory 目录', async () => {
    // 对照组。没有它的话，「无论如何都落盘」也能让上面那条通过
    const { dir, globalPath } = await workspace()
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
      tools: [fakeTool()],
      stream: scripted([says('好的')]),
      skipLock: true,
      ephemeral: true,
    })
    await drain(session.send('问题'))
    await session.close()

    const again = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
      tools: [fakeTool()],
      stream: scripted([says('好的')]),
      skipLock: true,
      ephemeral: true,
    })
    expect(again.messages()).toEqual([])
    await again.close()
  })

  it('用户消息在请求发出去之前就落盘', async () => {
    // 反过来的话：请求发出去了但用户这条没记下来，崩溃重启后模型的回答
    // 在历史里成了一段没有来由的话
    const { dir, globalPath } = await workspace()
    let onDiskWhenAsked: number | null = null

    const peek: LoopDeps['stream'] = () => {
      // 流被调用 = 请求正在发。此刻另开一个 store 看磁盘上有什么
      onDiskWhenAsked = liveOnDisk(dir)
      return (async function* () {
        for (const ev of says('回答')) yield ev
      })()
    }

    const session = await openAt(dir, globalPath, peek)
    await drain(session.send('问题'))
    await session.close()

    expect(onDiskWhenAsked).toBe(1) // 用户那条已经在磁盘上了
  })

  it('说到一半崩溃时，半截 assistant 消息不在磁盘上', async () => {
    // session.ts 的 tap 挑 step_finish 落盘，就是为了这个：text_delta 期间
    // 消息还在 accumulator 里没进 ctx.messages。落盘点选错（比如每个事件
    // 都落）的话，磁盘上会留下一条说到一半的 assistant 消息，重启后模型
    // 接着一句残句往下说，且**不报错**
    const { dir, globalPath } = await workspace()
    let onDiskMidStream: number | null = null

    const halfway: LoopDeps['stream'] = () =>
      (async function* (): AsyncIterable<StreamEvent> {
        yield { type: 'text_start' }
        yield { type: 'text_delta', text: '我正在说一句话说到一' }
        // 此刻进程"崩溃"——看磁盘上有什么
        onDiskMidStream = liveOnDisk(dir)
        yield { type: 'text_end' }
        yield { type: 'finish', reason: 'stop', usage: usage() }
      })()

    const session = await openAt(dir, globalPath, halfway)
    await drain(session.send('问题'))

    // 只有用户那一条，没有半截的 assistant
    expect(onDiskMidStream).toBe(1)
    // 对照组：流跑完之后确实变成 2 条了——否则上面那个 1 可能只是因为
    // 压根没在落盘
    expect(liveOnDisk(dir)).toBe(2)
    await session.close()
  })

  it('工具的完整原始输出落到 raw/，跟截断后的 tool_result 分开', async () => {
    // design.md §9.3 第 ① 层。进 context 的是截断版，完整版留给模型 cat
    const { dir, globalPath } = await workspace()
    const rounds: StreamEvent[][] = [
      [
        { type: 'tool_input_start', id: 'toolu_x1', name: 'bash' },
        { type: 'tool_input_end', id: 'toolu_x1', name: 'bash', input: { command: 'ls' } },
        { type: 'finish', reason: 'tool-calls', usage: usage() },
      ],
      says('跑完了'),
    ]

    const session = await openAt(dir, globalPath, scripted(rounds))
    await drain(session.send('跑一下'))
    await session.close()

    await new Promise((r) => setTimeout(r, 30)) // 写流是异步的
    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'raw', '.log')
    expect(files.map((f) => basename(f))).toContain('toolu_x1.log')

    // 路径也得传到工具手里，否则截断提示写不出「完整输出见 X」，
    // 文件落了模型也不知道去哪 cat（design.md:512）。桶号取名字倒数
    // 第 6、5 字符（buckets.ts），toolu_x1.log → x1
    expect(lastToolCtx.rawPath).toBe(join(MEMORY_RELATIVE, 'raw', 'x1', 'toolu_x1.log'))
    // 相对路径：模型拿它直接拼 cat，而 bash 的 cwd 就是工作区根
    expect(lastToolCtx.rawPath?.startsWith('/')).toBe(false)
  })
})

/**
 * REPL 的核心路径：**同一个 session 上连续 send**，进程不退出。
 *
 * 原来一条覆盖都没有——已有的「重开 session 接着聊」测的是两个不同 session
 * （跨进程重启），中间隔了一次 close/open，内存状态全是重建的。这里测的是
 * 内存状态**连续演进**，第 4 步的交互式 CLI 全靠它。
 */
describe('同一个 session 连续对话', () => {
  it('第二轮能看见第一轮的历史', async () => {
    const { dir, globalPath } = await workspace()
    const session = await openAt(
      dir,
      globalPath,
      scripted([says('第一轮回答'), says('第二轮回答')]),
    )

    await drain(session.send('第一个问题'))
    expect(session.messages()).toHaveLength(2) // 前提：第一轮确实进了历史

    await drain(session.send('第二个问题'))

    const messages = session.messages()
    expect(messages).toHaveLength(4)
    expect(messages[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: '第一个问题' }] })
    expect(messages[2]).toEqual({ role: 'user', parts: [{ type: 'text', text: '第二个问题' }] })
    await session.close()
  })

  it('每一轮都落盘，不是攒到 close 才写', async () => {
    // 攒到 close 才写的话，中途 kill -9 会丢掉整段对话。而 REPL 是常驻进程，
    // 「中途」可能长达几小时
    const { dir, globalPath } = await workspace()
    const session = await openAt(dir, globalPath, scripted([says('一'), says('二')]))

    await drain(session.send('问题一'))
    expect(liveOnDisk(dir)).toBe(2) // 还没 close 就已经在磁盘上了

    await drain(session.send('问题二'))
    expect(liveOnDisk(dir)).toBe(4)
    await session.close()
  })

  it('连续三轮的 turn 边界是三个，不是一个', async () => {
    // §9.5 按 turn 对齐合并边界。REPL 下所有轮次在同一个进程里，如果
    // beginTurn 只在 open 时调一次，三轮会被算成一个 turn——3b 的分层合并
    // 会因此把「10 个 turn 合并成 1 条」算错
    const { dir, globalPath } = await workspace()
    const session = await openAt(dir, globalPath, scripted([says('一'), says('二'), says('三')]))

    await drain(session.send('问题一'))
    await drain(session.send('问题二'))
    await drain(session.send('问题三'))
    await session.close()

    const files = listBucketFiles(join(dir, MEMORY_RELATIVE), 'turns', '.jsonl')
    expect(files).toHaveLength(3)
  })
})

/** 直接读磁盘上有几条 live 消息。另开一个 store，不碰 session 的内存态 */
function liveOnDisk(dir: string): number {
  const store = openStore(dir)
  const length = store.load().length
  store.close()
  return length
}
