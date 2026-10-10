/**
 * turn 续接（docs/proposals/turn-resume.md，2026-09-29 拍板）：上一轮被中断或
 * 报错结束，下一次 send 续进那一轮，不开新轮。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import { LLMStreamError } from '../src/llm/protocol.ts'
import type { Message, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { openDb, openDbReadOnly } from '../src/session/db.ts'
import { getSession, type Session } from '../src/session/session.ts'
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

/** 一次请求怎么回：事件序列，或 'fail'（不可重试的错）/ 'abort'（用户中断） */
type Round = StreamEvent[] | 'fail' | 'abort'

async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-turn-resume-'))
  dirs.push(dir)
  const root = join(dir, 'proj')
  const home = join(dir, 'home')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  const globalPath = join(home, 'settings.json')
  const settings = (model: string) => ({
    provider: 'p',
    model,
    // 空闲摘要关掉：本文件只看轮归属，摘要请求会吃掉脚本里的轮次
    memory: { idleSummarizeDelayMs: 0 },
    providers: {
      p: {
        protocol: 'anthropic-messages',
        baseUrl: 'https://example.invalid',
        apiKey: 'sk-test',
        models: { m: { contextWindow: 100_000 }, n: { contextWindow: 100_000 } },
      },
    },
  })
  await writeFile(globalPath, JSON.stringify(settings('m')), 'utf8')
  const setModel = (model: string) => writeFile(globalPath, JSON.stringify(settings(model)), 'utf8')

  /** 开会话、发一条、关会话（真机每轮结束也会重建会话） */
  const send = async (text: string, round: Round) => {
    let session: Session | null = null
    const stream: LoopDeps['stream'] = () =>
      (async function* () {
        if (round === 'fail') throw new LLMStreamError({ kind: 'invalid_request', message: 'bad', retryable: false })
        if (round === 'abort') {
          yield { type: 'text_start' } as StreamEvent
          // 中断那段故意跑 40ms：续接后耗时 ≥ 40 才说明是累加的，不是被覆盖
          await new Promise((r) => setTimeout(r, 40))
          session?.interrupt()
          throw new DOMException('This operation was aborted', 'AbortError')
        }
        for (const ev of round) yield ev
      })()
    session = await getSession(root, { globalPath, tools: [], stream, skipLock: true })
    await collect(session.send(text))
    await session.close()
  }

  const turns = () => {
    const db = openDbReadOnly(join(root, '.simple-code/memory/state.db'))
    const rows = db.all<{ id: number; end_state: string | null; elapsed_ms: number | null; ended_at: string | null }>(
      `SELECT id, end_state, elapsed_ms, ended_at FROM turns ORDER BY id`,
    )
    db.close()
    return rows
  }
  /** 每条 live 用户消息的文字与所在轮 */
  const users = () => {
    const db = openDbReadOnly(join(root, '.simple-code/memory/state.db'))
    const rows = db.all<{ turn_id: number; content_json: string }>(
      `SELECT turn_id, content_json FROM messages WHERE role = 'user' ORDER BY id`,
    )
    db.close()
    return rows.map((r) => {
      const m = JSON.parse(r.content_json) as Message
      const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
      return { turn: r.turn_id, text }
    })
  }
  return { root, send, turns, users, setModel }
}

describe('turn 续接：session.send', () => {
  it('中断后再发：续进同一轮，不新增 turns 行，两条用户消息同属一轮', async () => {
    const p = await project()
    await p.send('查一下日志', 'abort')
    expect(p.turns().map((t) => t.end_state)).toEqual(['aborted'])
    await p.send('继续', says('好的'))
    const t = p.turns()
    expect(t).toHaveLength(1)
    expect(t[0]?.end_state).toBe('done')
    expect(p.users()).toEqual([
      { turn: t[0]?.id, text: '查一下日志' },
      { turn: t[0]?.id, text: '继续' },
    ])
  })

  it('报错后再发：续进同一轮', async () => {
    const p = await project()
    await p.send('查一下日志', 'fail')
    expect(p.turns().map((t) => t.end_state)).toEqual(['error'])
    await p.send('继续', says('好的'))
    expect(p.turns()).toHaveLength(1)
    expect(new Set(p.users().map((u) => u.turn)).size).toBe(1)
  })

  it('正常结束后再发：开新轮（对照组）', async () => {
    const p = await project()
    await p.send('一', says('好'))
    await p.send('二', says('好'))
    expect(p.turns().map((t) => t.end_state)).toEqual(['done', 'done'])
    expect(new Set(p.users().map((u) => u.turn)).size).toBe(2)
  })

  it('报错后原话重发：不追加第二遍；换了说法才追加', async () => {
    const p = await project()
    await p.send('删掉备份', 'fail')
    await p.send('删掉备份', 'fail')
    expect(p.users().map((u) => u.text)).toEqual(['删掉备份'])
    await p.send('删掉 bak 文件', says('好'))
    expect(p.users().map((u) => u.text)).toEqual(['删掉备份', '删掉 bak 文件'])
    expect(p.turns()).toHaveLength(1)
  })

  it('换了模型：不续，开新轮（按轮 meta 判签名归属，一轮两个模型会误剥）', async () => {
    const p = await project()
    await p.send('一', 'abort')
    await p.setModel('n')
    await p.send('二', says('好'))
    expect(p.turns()).toHaveLength(2)
  })

  it('耗时累加、ended_at 更新为最后一次结束', async () => {
    const p = await project()
    await p.send('一', 'abort')
    const first = p.turns()[0]
    await new Promise((r) => setTimeout(r, 15))
    await p.send('二', says('好'))
    const second = p.turns()[0]
    expect(first?.elapsed_ms).toBeGreaterThanOrEqual(40)
    expect(second?.elapsed_ms).toBeGreaterThanOrEqual(first?.elapsed_ms ?? 0)
    expect(Date.parse(second?.ended_at ?? '')).toBeGreaterThan(Date.parse(first?.ended_at ?? ''))
  })
})

describe('turn 续接：store 判据', () => {
  const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })
  const reply = (text: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text }] })

  async function aborted() {
    const dir = await mkdtemp(join(tmpdir(), 'sc-turn-resume-store-'))
    dirs.push(dir)
    const store = openStore(dir)
    const turn = store.beginTurn({ model: 'p/m', effort: null })
    store.save([user('一'), reply('半截')])
    store.finishTurn(turn, 10, 'aborted')
    return { dir, store, turn }
  }

  it('没定稿的轮（end_state NULL：老库或进行中）不续', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-turn-resume-store-'))
    dirs.push(dir)
    const store = openStore(dir)
    store.beginTurn({ model: 'p/m', effort: null })
    store.save([user('一')])
    expect(store.resumableTurn('p/m')).toBeNull()
    store.close()
  })

  it('aborted 可续；之后分出过任务（更晚的 turns 行）就不续', async () => {
    const { dir, store, turn } = await aborted()
    expect(store.resumableTurn('p/m')).toBe(turn)
    const db = openDb(join(dir, '.simple-code/memory/state.db'))
    db.run(
      `INSERT INTO turns(id, started_at, state, owner) VALUES(?, ?, 'reserved', NULL)`,
      turn + 1000,
      new Date(Date.now() + 1000).toISOString(),
    )
    db.close()
    expect(store.resumableTurn('p/m')).toBeNull()
    store.close()
  })

  it('末条 live 消息的 step 已被摘要覆盖：不续（挂上去模型看不见）', async () => {
    const { store } = await aborted()
    const live = store.liveWithTurns().at(-1)
    expect(live).toBeDefined()
    store.addSummary({
      level: 0,
      coversFrom: live?.stepId ?? 0,
      coversTo: live?.stepId ?? 0,
      name: '',
      text: '摘要',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    expect(store.resumableTurn('p/m')).toBeNull()
    store.close()
  })

  it('摘要候选：aborted 的末轮空闲时也不摘；开了下一轮它才成候选', async () => {
    const { store } = await aborted()
    expect(store.nextSegmentToSummarize(16_000, null)).toBeNull()
    store.finishTurn(store.beginTurn({ model: 'p/m', effort: null }), 1, 'done')
    expect(store.nextSegmentToSummarize(16_000, null)).not.toBeNull()
    store.close()
  })

  it('末条 live 消息的 step 已卸载（只剩存根）：不续', async () => {
    const { dir, store, turn } = await aborted()
    expect(store.resumableTurn('p/m')).toBe(turn)
    const step = store.liveWithTurns().at(-1)?.stepId
    const db = openDb(join(dir, '.simple-code/memory/state.db'))
    db.run(`UPDATE steps SET unloaded = 1 WHERE id = ?`, step ?? 0)
    db.close()
    expect(store.resumableTurn('p/m')).toBeNull()
    store.close()
  })
})
