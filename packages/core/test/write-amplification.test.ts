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
import type { Tool, ToolOutput } from '../src/tools/types.ts'

/**
 * 写放大：**存根被反复卸载，每轮把整个 live 集合又写一遍**。
 *
 * 真实库里的现场（2026-09-02 诊断）：66545 行里只有 13348 条不同内容，
 * 80% 是完全相同的重复行；turn 50 一个 turn 45773 行、去重后 2806 条，
 * 同一条内容存了 16.3 遍，row id 等距分布、间隔正好是一次 save 的规模。
 * 6 天写了 74 MB。
 *
 * 链条：
 *   1. `clip()` 对存根是恒等的（4cce410 加的 `isStubbed` 幂等保护）
 *   2. 但 `pickOldest` 照样把存根 `push` 进 picked，而它算出的
 *      「省下来的量」是 0 —— `estimated` 一点不降
 *   3. 于是循环不会 break，把 floor 以内的消息**全部**挑上
 *   4. `store.unload()` 把这些行全标 unloaded
 *   5. 下一次 `save()` 的 `replaceLive` 把它们作为**新的 live 行**重插
 *   6. 下一轮回到第 2 步
 *
 * 幂等修的是**内容不再增长**（§1.4 那个「短消息卸载后变大」），
 * 没修**行数不再增长**。两件事，一个病根：`pickOldest` 缺「省不到就跳过」。
 *
 * **§11.5 之后防线换了位置，性质没换。** 挑选不再看「省不省得到」（那条判断
 * 是造成「100 个 step 的 turn 卸不动」的因果链的一环，见 unload.test.ts），
 * 存根照样会被挑中；拦住第 4 步的改成了 `indices = picked.filter(savingOf > 0)`
 * ——挑中归挑中，**只有真卸得动的才交给 `store.unload`**。所以这条用例仍然
 * 是有效的回归，只是它盯的那道闸挪了个地方。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-write-amp'

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

// 预算 = 3000 - 500 - 2000 = 500，两三轮就撞上卸载
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
  // 摘要的自动触发关掉：本文件只看 messages 表的行数，
  // 摘要请求会走 fetch 打到 example.invalid 上添乱
  // 见 merge-e2e 里同一处的说明：夹具太短，用生产默认阈值裁不动
  memory: {
    unloadTargetRatio: 0.001,
    keepHeadChars: 40,
    idleSummarizeDelayMs: 0,
    clipThresholdChars: 0,
    // 保底区压到最小。默认 16,000 在 500 的预算下夹到 100，正好能盖住最近
    // 一整个 step——夹具就没有可卸的了。这里要的是「反复卸载」那个稳态
    floorTokens: 1,
  },
}

/** 每轮内容都不一样——所以库里任何**完全相同**的两行都必然是重复写入 */
const long = (n: number) => `第${n}个问题${`。这是为了把上下文撑大而重复的第${n}组内容`.repeat(20)}`

const calls = (id: string, input: unknown): StreamEvent[] => [
  { type: 'tool_input_start', id, name: 'bash' },
  { type: 'tool_input_delta', id, partial: JSON.stringify(input) },
  { type: 'tool_input_end', id, name: 'bash', input },
  { type: 'finish', reason: 'tool-calls', usage: usage() },
]

/**
 * **夹具必须带工具调用。** 原来是纯问答，靠 `clip` 把对话文本裁成存根来驱动
 * 写放大的循环。§11.4 之后卸载只碰工具的 input/output，纯文本夹具一个存根都
 * 产不出来，`warm.stubs > 0` 那条前提断言当场红——**测试自己报出了「它测的
 * 状态构造不出来了」**，这正是 §6.1 那两条前提断言存在的意义。
 *
 * 输出回声带上命令，保证每轮内容都不同（去重断言靠这个）
 */
const echoTool: Tool = {
  name: 'bash',
  definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
  execute: async (input: unknown): Promise<ToolOutput> => ({
    output: `${(input as { command: string }).command} 的输出${'。回声'.repeat(40)}`,
    exitCode: 0,
    isError: false,
  }),
}

const drain = async (source: AsyncIterable<AgentEvent>) => {
  for await (const _ of source) {
    // 只为跑完
  }
}

const stats = (dir: string) => {
  const db = new DatabaseSync(join(dir, '.simple-code/memory/state.db'), { readOnly: true })
  const one = <T>(sql: string): T => db.prepare(sql).get() as T
  const out = {
    rows: one<{ n: number }>('SELECT COUNT(*) AS n FROM messages').n,
    distinct: one<{ n: number }>('SELECT COUNT(DISTINCT content_json) AS n FROM messages').n,
    unloaded: one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE state='unloaded'").n,
    stubs: one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE state='live' AND content_json LIKE '%已卸载%'",
    ).n,
  }
  db.close()
  return out
}

describe('写放大', () => {
  it('**存根不会被反复卸载**——完全相同的行不随轮次累积', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-write-amp-'))
    dirs.push(dir)
    const globalPath = join(dir, 'settings.json')
    await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')

    // 每次 send 走两次模型调用：先要一个工具，再收尾。存根就出在这一步上
    let nth = 0
    const stream: LoopDeps['stream'] = () =>
      (async function* () {
        nth++
        const round =
          nth % 2 === 1
            ? calls(`t${nth}`, { command: `echo ${long(nth)}` })
            : says(`第${nth}个回答：${'内容'.repeat(30)}`)
        for (const ev of round) yield ev
      })()

    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: KEY },
      tools: [echoTool],
      stream,
      skipLock: true,
    })

    // 先跑到稳态：历史里已经有存根，卸载已经发生过
    for (let i = 1; i <= 4; i++) await drain(session.send(long(i)))
    const warm = stats(dir)
    // 前提一：卸载真的发生了。不断言的话，一个「从不卸载」的实现也能让
    // 下面的重复数为 0——绿得毫无意义
    expect(warm.unloaded).toBeGreaterThan(0)
    // 前提二：live 里确实躺着存根。写放大的循环靠存根被反复挑中驱动，
    // 没有存根就没进入出问题的状态
    expect(warm.stubs).toBeGreaterThan(0)

    // 再跑几轮。每轮内容都不同，所以行数应该只涨新增的那几条
    for (let i = 5; i <= 8; i++) await drain(session.send(long(i)))
    await session.close()

    const after = stats(dir)
    // 本体：库里不该有任何完全相同的两行
    expect(after.rows - after.distinct).toBe(0)
    // 增长必须是 O(每轮新增)，不是 O(live 集合)。4 轮最多几十行，
    // 写放大的话是 4 × live 条数
    expect(after.rows - warm.rows).toBeLessThan(40)
  })
})
