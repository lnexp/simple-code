import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { logRun } from '../src/runlog.ts'
import { getSession } from '../src/session/session.ts'
import { openStore } from '../src/session/store.ts'

// 2026-10-30 真机：每个工具步「llm 结束 → tool_run」主线程被占 0.5–1.1s，
// 观测版要能把这段拆开（note loop-lag-is-macos-sleep）
const dirs: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-10-30T08:00:00Z'))
  vi.mocked(logRun).mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = resolve('.simple-code/tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'sc-persist-timing-'))
  dirs.push(dir)
  return dir
}

async function settings(dir: string): Promise<string> {
  const path = join(dir, 'settings.json')
  await writeFile(
    path,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      memory: { idleSummarizeDelayMs: 0 },
      providers: {
        p: {
          protocol: 'anthropic-messages',
          baseUrl: 'https://example.invalid',
          apiKey: 'test',
          models: { m: { contextWindow: 100_000 } },
        },
      },
    }),
  )
  return path
}

const logged = (ev: string) =>
  vi
    .mocked(logRun)
    .mock.calls.map(([event]) => event)
    .filter((e) => e.ev === ev)

const message = (role: 'user' | 'assistant', text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})

const usage = {
  inputTokens: 10,
  outputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
}

describe('每步落盘的分段计时', () => {
  it('store.save 记 store_save：条数、字符数，四段之和就是总耗时', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    try {
      store.beginTurn({ model: 'p/m', effort: null })
      const messages = [message('user', '问'), message('assistant', '答')]
      store.save(messages)
      const rows = logged('store_save')
      expect(rows).toHaveLength(1)
      const row = rows[0] as Record<'attr' | 'live' | 'archive' | 'index' | 'ms', number>
      expect(row).toMatchObject({
        folder: dir,
        msgs: 2,
        chars: messages.reduce((n, m) => n + JSON.stringify(m).length, 0),
      })
      expect(row).not.toHaveProperty('owner')
      expect(row.ms).toBe(row.attr + row.live + row.archive + row.index)
    } finally {
      store.close()
    }
  })

  it('每个 step_finish 记一行 step_persist，consumerMs 量的是下游处理这个事件的时间', async () => {
    const dir = await workspace()
    let call = 0
    const stream: LoopDeps['stream'] = async function* () {
      call += 1
      const events: StreamEvent[] =
        call === 1
          ? [
              { type: 'tool_input_start', id: 't1', name: 'nope' },
              { type: 'tool_input_end', id: 't1', name: 'nope', input: {} },
              { type: 'finish', reason: 'tool-calls', usage },
            ]
          : [
              { type: 'text_start' },
              { type: 'text_delta', text: '完成' },
              { type: 'text_end' },
              { type: 'finish', reason: 'stop', usage },
            ]
      yield* events
    }
    const session = await getSession(dir, {
      globalPath: await settings(dir),
      tools: [],
      stream,
      skipLock: true,
      fetchImpl: () => {
        throw new Error('本测试禁止联网')
      },
    })
    try {
      let finishes = 0
      for await (const event of session.send('跑一步工具')) {
        // 模拟下游（bridge）同步处理 step_finish 用掉 300ms
        if (event.type === 'step_finish') {
          finishes += 1
          vi.setSystemTime(Date.now() + 300)
        }
      }
      expect(finishes).toBe(2)
      const rows = logged('step_persist')
      expect(rows).toHaveLength(2)
      for (const row of rows)
        expect(row).toEqual({
          ev: 'step_persist',
          folder: dir,
          consumerMs: 300,
          kickMs: 0,
          kickCpuMs: expect.any(Number),
          kickGcMs: expect.any(Number),
          kickGcN: expect.any(Number),
        })
      // 每个 step_finish 一次 + 轮末 finally 一次，save 都带 store_save
      expect(logged('store_save').length).toBeGreaterThanOrEqual(3)
    } finally {
      await session.close()
    }
  })
})
