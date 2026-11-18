import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/load.ts'
import type { AgentEvent } from '../src/events.ts'
import type { Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE } from '../src/session/store.ts'
import type { Tool } from '../src/tools/types.ts'

/**
 * 开轮回调（SessionOptions.onTurnStart，自动反思的挂点——vscode reflect-auto.ts）：
 * 每开始一轮调一次，给宿主一个本库的轮数计数。计数不分 owner——主任务与
 * 其他任务平权（note task-parity）；fork 插的 reserved 锚不是真的一轮。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const CONFIG = {
  provider: 'alpha',
  model: 'a-small',
  providers: {
    alpha: {
      protocol: 'openai-chat',
      baseUrl: 'https://alpha.invalid',
      apiKey: '${ALPHA_KEY}',
      models: { 'a-small': { contextWindow: 100_000 } },
    },
  },
}
const ENV = { ALPHA_KEY: 'sk-A' }

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
const drain = async (it: AsyncIterable<AgentEvent>) => {
  for await (const _ of it) {
    /* 跑完即可 */
  }
}

const open = async (onTurnStart: (turnsSince: (at: number) => number) => void) => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-turnhook-'))
  dirs.push(dir)
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  await loadConfig(dir, { globalPath, env: ENV })
  const rounds = [says('答一'), says('答二')]
  let n = 0
  const stream: LoopDeps['stream'] = () =>
    (async function* () {
      for (const ev of rounds[n++] ?? []) yield ev
    })()
  const session = await getSession(dir, {
    globalPath,
    env: ENV,
    tools: [fakeTool()],
    stream,
    skipLock: true,
    onTurnStart,
  })
  return { dir, session }
}

describe('开轮回调 onTurnStart', () => {
  it('每开一轮调一次，计数含本轮', async () => {
    const seen: number[] = []
    const { session } = await open((turnsSince) => seen.push(turnsSince(0)))
    await drain(session.send('第一轮'))
    await drain(session.send('第二轮'))
    expect(seen).toEqual([1, 2])
    await session.close()
  })

  it('计数不分 owner、不算 reserved 锚、只数 at 之后开始的', async () => {
    const hook: { turnsSince?: (at: number) => number } = {}
    const { dir, session } = await open((turnsSince) => {
      hook.turnsSince = turnsSince
    })
    await drain(session.send('主任务一轮'))
    const { openDb } = await import('../src/session/db.ts')
    const db = openDb(join(dir, MEMORY_RELATIVE, 'state.db'))
    const now = new Date().toISOString()
    // 数量故意不对称（其他任务 2、reserved 1）：只数主任务 = 2、连 reserved
    // 一起数 = 4，都和正确值 3 区分得开（对称的 1/1 会让「只数主任务」蒙对）
    db.run(`INSERT INTO turns(started_at, owner) VALUES(?, ?)`, now, 'task-abc')
    db.run(`INSERT INTO turns(started_at, owner) VALUES(?, ?)`, now, 'task-def')
    db.run(`INSERT INTO turns(started_at, state) VALUES(?, 'reserved')`, now)
    // 前提：库里确有其他任务的轮与 reserved 锚，否则「不分 owner」测了个空
    const rows = db.all<{ owner: string | null; state: string }>(`SELECT owner, state FROM turns`)
    db.close()
    expect(rows.some((r) => r.owner === 'task-abc')).toBe(true)
    expect(rows.some((r) => r.state === 'reserved')).toBe(true)
    expect(hook.turnsSince?.(0)).toBe(3) // 主任务 1 + 其他任务 2，reserved 不算
    expect(hook.turnsSince?.(Date.now() + 60_000)).toBe(0)
    await session.close()
  })
})
