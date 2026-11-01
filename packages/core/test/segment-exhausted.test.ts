/**
 * 号段用尽（SegmentFullError）之后不用 reload 就能接着用（2026-10-31 用户：
 * 「虽然很少触发这种，但是我们要解决这种状况」）。
 *
 * 一轮只在一段里跑（task-trunk 规则 3），段宽 50000：一轮连续写满才会撞上。
 * 撞上后应当：这一轮报错结束 → 会话不卡在「运行中」→ 下一条消息开新轮、
 * 申请新段（不续进报错的那一轮——它的段已经没有号了）。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { openDb } from '../src/session/db.ts'
import { SEGMENT_FULL_STEPS } from '../src/session/segments.ts'
import { getSession } from '../src/session/session.ts'
import { openStore } from '../src/session/store.ts'

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
const collect = async (stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-seg-exhausted-'))
  dirs.push(dir)
  const root = join(dir, 'proj')
  const home = join(dir, 'home')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  const globalPath = join(home, 'settings.json')
  await writeFile(
    globalPath,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      memory: { idleSummarizeDelayMs: 0 },
      providers: {
        p: {
          protocol: 'anthropic-messages',
          baseUrl: 'https://example.invalid',
          apiKey: 'sk-test',
          models: { m: { contextWindow: 100_000 } },
        },
      },
    }),
    'utf8',
  )
  const stream: LoopDeps['stream'] = () =>
    (async function* () {
      for (const ev of says('好')) yield ev
    })()
  const open = () => getSession(root, { globalPath, tools: [], stream, skipLock: true })
  const db = () => openDb(join(root, '.simple-code/memory/state.db'))
  return { root, open, db }
}

describe('号段用尽', () => {
  it('这一轮报错结束；会话不卡；下一条开新轮、换新段；空闲时回调不丢', async () => {
    const p = await project()
    // 前置：主任务的段已用 999 步、只剩最后 1 个号（真机是一轮连续写满 5 万号；
    // 这里把段宽压成 1000，已用步数与真机一样 < 1000 时不换段、用尽时 ≥ 1000）
    openStore(p.root).close()
    const db = p.db()
    const now = new Date().toISOString()
    db.run(
      `INSERT INTO turns(id, started_at, meta, end_state) VALUES(1, ?, '{"model":"p/m"}', 'done')`,
      now,
    )
    db.run(
      `INSERT INTO segments(owner, step_floor, step_ceil, state, opened_at) VALUES('', 0, ?, 'open', ?)`,
      SEGMENT_FULL_STEPS,
      now,
    )
    for (let id = 1; id < SEGMENT_FULL_STEPS; id++)
      db.run(`INSERT INTO steps(id, turn_id, started_at) VALUES(?, 1, ?)`, id, now)
    db.close()

    // 同一个会话从头用到尾：「不用 reload」就是不重开会话
    const session = await p.open()
    // 用户消息占最后一个号，助手回复那一步用尽
    await expect(collect(session.send('二'))).rejects.toThrow('号段用尽')
    expect(session.isRunning()).toBe(false)

    // 空闲时宿主来取任务回调：段里没号了不能取（取了写不进去就丢了），留给下一轮
    const mail = p.db()
    mail.run(
      `INSERT INTO task_results(owner, text, created_at) VALUES('', '〔任务结果〕x', ?)`,
      now,
    )
    mail.close()
    expect(session.takeTaskResults()).toBe(0)

    const events = await collect(session.send('三'))
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    await session.close()

    const check = p.db()
    const turns = check.all<{ id: number }>(`SELECT id FROM turns ORDER BY id`)
    expect(turns).toHaveLength(3) // 「三」开了新轮，没续进用尽的那一轮
    const segs = check.all<{ state: string }>(
      `SELECT state FROM segments WHERE owner = '' ORDER BY id`,
    )
    expect(segs.map((s) => s.state)).toEqual(['full', 'open'])
    const taken = check.all<{ taken_at: string | null }>(`SELECT taken_at FROM task_results`)
    expect(taken[0]?.taken_at).not.toBeNull()
    const lastTurnUsers = check.all<{ content_json: string }>(
      `SELECT content_json FROM messages WHERE role = 'user' AND turn_id = 3 ORDER BY id`,
    )
    expect(lastTurnUsers.map((m) => m.content_json).join('')).toContain('〔任务结果〕x')
    check.close()
  })
})
