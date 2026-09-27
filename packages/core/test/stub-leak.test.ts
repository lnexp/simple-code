import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession } from '../src/session/session.ts'
import { createBashTool } from '../src/tools/bash.ts'
import type { Tool, ToolContext, ToolOutput } from '../src/tools/types.ts'

/**
 * 卸载存根与工具命令的接缝（2026-08-27 事故的结案记录）。
 *
 * 现象：真实会话里，bash 收到的命令尾部多了一行
 * `[已卸载，完整内容见 .simple-code/memory/turns/turn-XXXX.jsonl]`——
 * bash: line N: [已卸载，完整内容见: command not found——行号随命令长度走，
 * 有一次直接落进 heredoc 正文里让 python 报 SyntaxError。
 *
 * 结案（两个嫌疑人排查看完）：
 * ① 管线无罪——「模型吐出 tool_input → 工具执行」之间输入逐字节不变
 *   （下面两条：假工具比对 + 真 bash 跑哨兵命令）；
 * ② 病根在存根形状：卸载把历史里的 command 截成「头 N 字 + notice」，
 *   `<<'EOF'` 开头留在头部、收尾终止符被截走、notice 顶在断口——历史里
 *   躺着一条「没写完的 heredoc」，模型照着自己上一条命令的形状续写，
 *   把 notice 当内容带了出来（notice 引用的正是它模仿的范本那个归档）。
 *
 * 修法在 unload.ts 的 clipShell：notice 加 `#` 前缀（被抄走也是注释）、
 * 断口对齐行边界。模仿挡不住——那是模型的天性——但抄了也无害。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-stub-leak'

// inputTokens 抬到接近窗口：卸载触发看的是 currentUsage = 上轮真实 usage +
// 之后新增的估算，usage=1 会让预算判断永远不超、一次卸载都不触发（第一版
// 夹具就是这么哑火的——请求里历史原封未动，测了个寂寞）
const usage = (): Usage => ({
  inputTokens: 2_800,
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

const calls = (id: string, input: unknown): StreamEvent[] => [
  { type: 'tool_input_start', id, name: 'bash' },
  { type: 'tool_input_delta', id, partial: JSON.stringify(input) },
  { type: 'tool_input_end', id, name: 'bash', input },
  { type: 'finish', reason: 'tool-calls', usage: usage() },
]

/** 和真实事故同款的 heredoc 命令：多行、远超 keepHeadChars、有终止符 */
const HEREDOC = (n: number) =>
  `python3 - <<'PYEOF'
p = 'packages/core/src/config/schema.ts'
s = open(p).read()
print('schema ok ${n}')
PYEOF`

// 预算 = 3000 - 500 - 2000 = 500：一轮大 tool_result 就能逼出卸载
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
  // 见 merge-e2e 里同一处的说明：夹具太短，用生产默认阈值裁不动
  memory: {
    unloadTargetRatio: 0.001,
    keepHeadChars: 40,
    summaryMinTokens: 0,
    clipThresholdChars: 0,
    // 保底区压到最小，理由和上面几个旋钮一样：生产默认 16,000 在 500 的预算
    // 下会被夹到 100（预算的 20%），而这里那条大 tool_result 自己就有 960
    // token——保底区落进它中间、往前扩到 step 起点，整个 heredoc 那一步都被
    // 护住，一条都卸不动。要测的是存根的形状，不是保底区的边界（那在
    // run.test.ts 里测）
    floorTokens: 1,
  },
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-stub-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  return { dir, globalPath }
}

function recordingStream(rounds: StreamEvent[][]) {
  const sent: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[sent.length] ?? []
    sent.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return { stream, sent }
}

const drain = async (source: AsyncIterable<AgentEvent>) => {
  for await (const _ of source) {
    // 跑完即可
  }
}

/** 记录执行时收到的输入——不是事件里的那份，是真正传进 execute 的 */
function recordingTool(output: string): { tool: Tool; inputs: unknown[] } {
  const inputs: unknown[] = []
  const tool: Tool = {
    name: 'bash',
    definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
    execute: async (input: unknown, _ctx: ToolContext): Promise<ToolOutput> => {
      inputs.push(structuredClone(input))
      return { output, exitCode: 0, isError: false }
    },
  }
  return { tool, inputs }
}

const stubArchive = (request: Request): string =>
  // notice 的格式是「# [已卸载，完整内容见 <路径>]」——从最后一条带 notice 的
  // part 里把归档路径抠出来，断言存根格式时用
  JSON.stringify(request.messages ?? []).match(/已卸载，完整内容见 ([^\]]+)\]/)?.[1] ?? ''

const commandOf = (request: Request, id: string): string | undefined =>
  (request.messages ?? [])
    .flatMap((m) => m.parts)
    .find((p) => p.type === 'tool_call' && p.id === id)?.type === 'tool_call'
    ? (
        (request.messages ?? [])
          .flatMap((m) => m.parts)
          .find((p) => p.type === 'tool_call' && p.id === id) as { input: { command?: string } }
      ).input.command
    : undefined

/** 把命令丢给真 bash 跑，拿到合并输出和退出码 */
const runBash = (command: string) =>
  new Promise<{ out: string; code: number }>((resolve) => {
    execFile('bash', ['-c', command], (error, stdout, stderr) =>
      resolve({
        out: `${stdout}${stderr}`,
        code: typeof error?.code === 'number' ? error.code : 0,
      }),
    )
  })

describe('卸载存根与工具命令的接缝', () => {
  it('即使模型把 notice 原样抄进命令，也只是注释——真 bash 跑一遍', async () => {
    // 新格式（clipShell 的产物形状）：# 开头的 notice 是 no-op
    const good = await runBash(
      `echo done\n# [已卸载，完整内容见 .simple-code/memory/turns/turn-000001.jsonl]`,
    )
    expect(good.code).toBe(0)
    expect(good.out).toContain('done')
    expect(good.out).not.toContain('command not found')

    // 对照：老格式裸 notice——这就是 2026-08-27 事故现场的指纹
    const bad = await runBash(
      `echo done\n[已卸载，完整内容见 .simple-code/memory/turns/turn-000001.jsonl]`,
    )
    expect(bad.out).toContain('command not found')
  })

  it('执行时收到的命令与模型吐出的逐字节一致——notice 没被拼进 args', async () => {
    // 单 turn 会话整个落在保底区里，什么都卸不掉——必须两个 turn
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([
      calls('t1', { command: HEREDOC(1) }),
      says('第一轮结束'),
      calls('t2', { command: HEREDOC(2) }),
      says('完事'),
    ])
    // 大 tool_result：第一轮结束后的请求组装就会撞预算、触发卸载
    const big = '这是会把上下文顶满的输出'.repeat(80)
    const rec1 = recordingTool(big)
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [rec1.tool],
      stream: rec.stream,
      skipLock: true,
    })

    await drain(session.send('看一下配置'))
    await drain(session.send('换个问题'))
    await session.close()

    // 嫌疑①：执行时收到的输入就是脚本里那份，一个字节都不能多
    expect(rec1.inputs).toEqual([{ command: HEREDOC(1) }, { command: HEREDOC(2) }])
  })

  it('模型看到的存根：heredoc 终止符被截掉，notice 顶在断口（现象②的原料）', async () => {
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([
      calls('t1', { command: HEREDOC(1) }),
      says('第一轮结束'),
      calls('t2', { command: HEREDOC(2) }),
      says('完事'),
    ])
    const big = '这是会把上下文顶满的输出'.repeat(80)
    const rec1 = recordingTool(big)
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [rec1.tool],
      stream: rec.stream,
      skipLock: true,
    })

    const events: AgentEvent[] = []
    await drain(
      (async function* () {
        for await (const ev of session.send('看一下配置')) {
          events.push(ev)
          yield ev
        }
      })(),
    )
    await drain(
      (async function* () {
        for await (const ev of session.send('换个问题')) {
          events.push(ev)
          yield ev
        }
      })(),
    )
    await session.close()
    console.log('unloaded 事件 =', JSON.stringify(events.filter((e) => e.type === 'unloaded')))

    // 前提：第二个 turn 的首个请求之前确实发生了卸载——否则下面测了个寂寞
    // （rec.sent[2]：0/1 是第一个 turn 的两次模型调用）
    const second = rec.sent[2]
    expect(second).toBeDefined()
    const stubbed = commandOf(second!, 't1')
    expect(stubbed).toBeDefined()
    expect(stubbed).toContain('已卸载') // 截断存根生效了
    console.log('模型看到的 t1 存根 command =', JSON.stringify(stubbed))
    // 断口对齐了行边界：头部是完整的第一行，不是半截
    expect(stubbed).toBe(`python3 - <<'PYEOF'\n# [已卸载，完整内容见 ${stubArchive(second!)}]`)
    // notice 带 # 前缀——这就是「被抄走也无害」的全部机制
    expect(stubbed!.split('\n').at(-1)).toMatch(/^# \[已卸载/)
  })

  it('真 bash 也一样：命令原样到达 spawn，输出里没有 command not found', async () => {
    const { dir, globalPath } = await workspace()
    const rec = recordingStream([
      calls('t1', { command: 'python3 -c "print(\'顶\' * 600)"' }),
      calls('t2', { command: 'python3 -c "print(\'再顶\' * 600)"' }),
      calls('t3', { command: 'echo sentinel-ok' }),
      says('完事'),
    ])
    const bash = createBashTool({
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 600_000,
      maxOutputChars: 30_000,
      killGraceMs: 3_000,
      envPassthrough: ['PATH', 'HOME'],
    })
    const events: AgentEvent[] = []
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [bash],
      stream: rec.stream,
      skipLock: true,
    })
    ;(async () => {
      for await (const ev of session.send('看')) events.push(ev)
    })().catch(() => {})
    await new Promise((r) => setTimeout(r, 4_000))
    await session.close()

    const outputs = events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as { output: string }).output)
    // 前提：三轮都真的执行了
    expect(outputs).toHaveLength(3)
    expect(outputs[2]).toContain('sentinel-ok') // echo 的结果就是它自己
    // 真事故的指纹：bash 把 notice 当命令执行了
    for (const out of outputs) {
      expect(out).not.toContain('command not found')
      expect(out).not.toContain('已卸载')
    }
  })
})
