import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { logRun } from '../src/runlog.ts'
import { openDb } from '../src/session/db.ts'
import { getSession } from '../src/session/session.ts'
import { MEMORY_RELATIVE, openStore, type Store } from '../src/session/store.ts'
import { createTask, scopeOf } from '../src/session/task.ts'

// 2026-10-26 某真实项目：轮开始距重启 22 分钟，最后响应却只隔 17.5 秒。
const START = Date.parse('2026-10-26T12:56:27.410Z')
const LAST = Date.parse('2026-10-26T13:18:19.784Z')
const TTL = 300_000
const dirs: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  vi.mocked(logRun).mockClear()
})
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = resolve('.simple-code/tmp')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'sc-cache-restart-'))
  dirs.push(dir)
  return dir
}

const message = (role: 'user' | 'assistant', text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})

function reply(store: Store, at: number): void {
  vi.setSystemTime(at)
  store.save([...store.load(), message('assistant', `回复 ${at}`)])
}

function unfinished(dir: string, resumed = false): number {
  const store = openStore(dir)
  const turn = store.beginTurn({ model: 'p/m', effort: null })
  store.save([message('user', '开始长轮')])
  reply(store, START + 1000)
  if (resumed) {
    store.finishTurn(turn, 1000, 'aborted')
    store.resumeTurn(turn)
  }
  reply(store, LAST)
  // 只关库，不 finishTurn：模拟进程在本轮收尾之前退出。
  store.close()
  return turn
}

describe('缓存时间的重启恢复', () => {
  it('空库、只有用户消息或空 step 都不能冒充模型响应', async () => {
    const store = openStore(await workspace())
    expect(store.lastRespondedAt()).toBeNull()
    store.beginTurn({ model: 'p/m', effort: null })
    store.save([message('user', '还未响应')])
    expect(store.lastRespondedAt()).toBeNull()
    store.beginStep()
    expect(store.lastRespondedAt()).toBeNull()
    store.close()
  })

  it.each([false, true])('长轮最近一次回复跨重启保留（续接=%s）', async (resumed) => {
    const dir = await workspace()
    const turn = unfinished(dir, resumed)
    vi.setSystemTime(LAST + 17_517)
    const store = openStore(dir)
    expect(store.turnsInfo([turn]).get(turn)?.finishedAt).toBe(resumed ? START + 1000 : null)
    expect(store.lastRespondedAt()).toBe(LAST)
    store.close()
  })

  it('新一轮只有用户消息，或后来又建了空 step，仍取前一轮的回复', async () => {
    const dir = await workspace()
    unfinished(dir)
    vi.setSystemTime(LAST + TTL + 1)
    const store = openStore(dir)
    store.beginTurn({ model: 'p/m', effort: null })
    store.save([...store.load(), message('user', '继续')])
    store.beginStep()
    store.close()
    const restarted = openStore(dir)
    expect(restarted.lastRespondedAt()).toBe(LAST)
    restarted.close()
  })

  it('等待工具不刷新响应时间，已卸载的 assistant 仍可恢复时间', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.beginTurn({ model: 'p/m', effort: null })
    store.save([message('user', '执行命令')])
    vi.setSystemTime(LAST)
    const call: Message = {
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 'call-1', name: 'bash', input: { command: 'pwd' } }],
    }
    store.save([...store.load(), call])
    vi.setSystemTime(LAST + TTL + 1)
    store.save([
      ...store.load(),
      {
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 'call-1', output: 'ok', isError: false }],
      },
    ])
    store.unload([1])
    expect(store.load().some((m) => m.role === 'assistant')).toBe(false)
    store.close()
    const restarted = openStore(dir)
    expect(restarted.lastRespondedAt()).toBe(LAST)
    restarted.close()
  })

  it('已完成轮沿用 ended_at，老记录仍兼容 started_at + elapsed_ms', async () => {
    const dir = await workspace()
    const turn = unfinished(dir)
    vi.setSystemTime(LAST + 1000)
    const store = openStore(dir)
    const elapsed = LAST + 1000 - START
    store.finishTurn(turn, elapsed, 'done')
    expect(store.lastRespondedAt()).toBe(LAST + 1000)
    store.close()
    const db = openDb(join(dir, MEMORY_RELATIVE, 'state.db'))
    db.run('UPDATE turns SET ended_at = NULL WHERE id = ?', turn)
    db.close()
    const legacy = openStore(dir)
    expect(legacy.lastRespondedAt()).toBe(START + elapsed)
    legacy.close()
  })

  it('主任务与任务互不更新时间；新任务不继承开它之前的响应（task-trunk 不 fork）', async () => {
    const dir = await workspace()
    unfinished(dir)
    const scope = scopeOf(createTask(dir, '隔离验证'))
    const main = openStore(dir)
    const task = openStore(dir, { task: scope })
    expect(main.lastRespondedAt()).toBe(LAST)
    expect(task.lastRespondedAt()).toBeNull() // 没有自己的轮
    task.beginTurn({ model: 'p/m', effort: null })
    reply(task, LAST + 1000)
    expect(main.lastRespondedAt()).toBe(LAST)
    vi.setSystemTime(LAST + 2000)
    main.beginTurn({ model: 'p/m', effort: null })
    reply(main, LAST + 2000)
    main.close()
    task.close()
    const restartedMain = openStore(dir)
    const restartedTask = openStore(dir, { task: scope })
    expect(restartedMain.lastRespondedAt()).toBe(LAST + 2000)
    expect(restartedTask.lastRespondedAt()).toBe(LAST + 1000)
    restartedMain.close()
    restartedTask.close()
  })
})

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
          models: { m: { contextWindow: 100_000, cacheTtlMs: TTL } },
        },
      },
    }),
  )
  return path
}

const respond: LoopDeps['stream'] = async function* () {
  yield { type: 'text_start' }
  yield { type: 'text_delta', text: '继续完成' }
  yield { type: 'text_end' }
  yield {
    type: 'finish',
    reason: 'stop',
    usage: {
      inputTokens: 10,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    },
  }
}

describe('重建 session 后首次请求的 stale 判定', () => {
  it.each([17_517, TTL, TTL + 1])('实际距最后响应 %d ms', async (gap) => {
    const dir = await workspace()
    unfinished(dir)
    vi.setSystemTime(LAST + gap)
    const stream = vi.fn(respond)
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
      const errors = []
      for await (const event of session.send('继续')) if (event.type === 'error') errors.push(event)
      expect(errors).toEqual([])
      expect(stream).toHaveBeenCalledTimes(1)
      const triggers = vi
        .mocked(logRun)
        .mock.calls.map(([event]) => event)
        .filter((e) => e.ev === 'unload_trigger')
      if (gap <= TTL) expect(triggers).toEqual([])
      else {
        expect(triggers).toHaveLength(1)
        expect(triggers[0]).toMatchObject({
          reason: 'stale',
          lastMs: LAST,
          sinceMs: gap,
          ttlMs: TTL,
        })
      }
    } finally {
      await session.close()
    }
  })
})
