import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/load.ts'
import type { AgentEvent } from '../src/events.ts'
import type { Message, Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { DAY_SWITCH_HEAD, daySwitchNotice, getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE } from '../src/session/store.ts'
import type { Tool } from '../src/tools/types.ts'

/**
 * 日期变更告知（2026-11-02 拍板）：跨天回来接续会话，send 入口比对
 * 「库内最后一轮的日期 ≠ 今天」→ 用户消息前插一条〔系统〕日期变更。
 * 与 model_switch 告知同模式（判据都从 turns 表读，不靠内存态——reload
 * 后依然成立）。这里用真实 state.db 把最后一轮的 started_at 改成昨天
 * 来模拟跨天。
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

const openPersisted = async (rounds: StreamEvent[][]) => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-day-'))
  dirs.push(dir)
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  await loadConfig(dir, { globalPath, env: ENV })
  const seen: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[seen.length] ?? []
    seen.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  const session = await getSession(dir, {
    globalPath,
    env: ENV,
    tools: [fakeTool()],
    stream,
    skipLock: true,
  })
  return { dir, session }
}

const texts = (session: { messages(): readonly Message[] }) =>
  session.messages().flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])))

/** 把库内所有轮的 started_at 改成昨天中午——模拟「上一轮发生在昨天」 */
const ageTurnsToYesterday = async (dir: string) => {
  const { openDb } = await import('../src/session/db.ts')
  const y = new Date()
  y.setDate(y.getDate() - 1)
  y.setHours(12, 0, 0, 0)
  const db = openDb(join(dir, MEMORY_RELATIVE, 'state.db'))
  db.run(`UPDATE turns SET started_at = ?`, y.toISOString())
  db.close()
}

describe('日期变更告知（2026-11-02 拍板）', () => {
  it('跨天 → 用户消息前插告知，只一次', async () => {
    const { dir, session } = await openPersisted([says('答一'), says('答二'), says('答三')])
    const collect = async (it: AsyncIterable<AgentEvent>) => {
      const out: AgentEvent[] = []
      for await (const ev of it) out.push(ev)
      return out
    }
    await collect(session.send('第一天的问题'))
    expect(texts(session).some((t) => t.startsWith(DAY_SWITCH_HEAD))).toBe(false)
    await ageTurnsToYesterday(dir)
    await collect(session.send('第二天的问题'))
    const all = texts(session)
    const at = all.findIndex((t) => t.startsWith(DAY_SWITCH_HEAD))
    expect(at).toBeGreaterThan(-1)
    // 位置：昨天的回复之后、今天这轮的用户消息之前
    expect(all[at - 1]).toBe('答一')
    expect(all[at + 1]).toBe('第二天的问题')
    // 今天这轮落库后：再次 send 不再告知
    await collect(session.send('同一天追问'))
    expect(all.filter((t) => t.startsWith(DAY_SWITCH_HEAD))).toHaveLength(1)
    await session.close()
  })

  it('同日续聊不告知；空库（首轮）不告知', async () => {
    const { session } = await openPersisted([says('答一'), says('答二')])
    const drain = async (it: AsyncIterable<AgentEvent>) => {
      for await (const _ of it) {
        /* 跑完即可 */
      }
    }
    await drain(session.send('第一轮'))
    await drain(session.send('第二轮'))
    expect(texts(session).some((t) => t.startsWith(DAY_SWITCH_HEAD))).toBe(false)
    expect(daySwitchNotice('2026-11-2 周一', '2026-11-3 周二')).toBe(
      '〔系统〕日期变更：上次活动 2026-11-2 周一，现在是 2026-11-3 周二，已跨天。',
    )
    await session.close()
  })
})
