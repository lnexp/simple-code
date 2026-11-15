import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REFLECT_TASK_BOOK } from '../src/reflect.ts'
import { createAutoReflect, lastReflectStart, REFLECT_MIN_TURNS } from '../src/reflect-auto.ts'
import type { TaskCenter } from '../src/tasks.ts'

/**
 * 自动反思（reflect-auto.ts，2026-11-12）：任何任务开轮时查门槛——距上次反思
 * ≥24h 且之后所有任务合计 ≥30 轮。上次反思 = 收尾 event 的 created 与上次
 * 派出时间取晚的；派出时间兜住「反思失败、没写 event」，否则每轮重派。
 */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const HOUR = 3600_000
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/** 与 event 头部 created 同格式（本地时间，精确到秒） */
const stamp = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** reflectedAt = 有一条 memory-reflect 收尾 event、created 是这个时刻 */
const folderWith = (reflectedAt?: number): string => {
  const folder = mkdtempSync(join(tmpdir(), 'sc-autoreflect-'))
  dirs.push(folder)
  if (reflectedAt !== undefined) {
    const events = join(folder, '.simple-code', 'events')
    mkdirSync(events, { recursive: true })
    writeFileSync(
      join(events, 'memory-reflect-x.md'),
      `---\nname: memory-reflect-x\ndescription: d\ncreated: ${stamp(reflectedAt)}\n---\n`,
    )
  }
  return folder
}

type Overview = ReturnType<TaskCenter['listOverview']>[number]
const fakeTasks = (list: Overview[] = []) => {
  const calls: string[] = []
  return {
    calls,
    listOverview: () => list,
    close: vi.fn(async (name: string): Promise<{ ok: boolean; error?: string }> => {
      calls.push(`close:${name}`)
      return { ok: true }
    }),
    dispatch: vi.fn(async (brief: string): Promise<string | null> => {
      calls.push(`dispatch:${brief.split('\n', 1)[0]}`)
      return null
    }),
  }
}

describe('自动反思门槛', () => {
  it('从没反思过、库里够 30 轮 → 派按钮同一份任务书，记下派出时间；轮数从头数', async () => {
    const folder = folderWith()
    const tasks = fakeTasks()
    const asked: number[] = []
    createAutoReflect({ folder, tasks })((at) => {
      asked.push(at)
      return REFLECT_MIN_TURNS
    })
    await settle()
    expect(asked).toEqual([0])
    expect(tasks.dispatch).toHaveBeenCalledWith(REFLECT_TASK_BOOK)
    expect(lastReflectStart(folder)).not.toBeNull()
  })

  it('距上次反思不足 24h → 不派，也不查库', async () => {
    const now = Date.now()
    const tasks = fakeTasks()
    const turnsSince = vi.fn(() => 999)
    createAutoReflect({ folder: folderWith(now - 23 * HOUR), tasks, now: () => now })(turnsSince)
    await settle()
    expect(turnsSince).not.toHaveBeenCalled()
    expect(tasks.dispatch).not.toHaveBeenCalled()
  })

  it('满 24h：29 轮不派、30 轮派；轮数从上次反思的时刻数起', async () => {
    const now = Date.now()
    const reflected = now - 25 * HOUR
    const few = fakeTasks()
    createAutoReflect({ folder: folderWith(reflected), tasks: few, now: () => now })(
      () => REFLECT_MIN_TURNS - 1,
    )
    await settle()
    expect(few.dispatch).not.toHaveBeenCalled()
    const enough = fakeTasks()
    const asked: number[] = []
    createAutoReflect({ folder: folderWith(reflected), tasks: enough, now: () => now })((at) => {
      asked.push(at)
      return REFLECT_MIN_TURNS
    })
    await settle()
    expect(enough.dispatch).toHaveBeenCalledTimes(1)
    expect(asked).toEqual([Math.floor(reflected / 1000) * 1000]) // created 精确到秒
  })

  it('反思任务在跑 → 跳过，不记派出时间', async () => {
    const folder = folderWith()
    const tasks = fakeTasks([{ name: '反思', status: 'running', lastLine: '' }])
    createAutoReflect({ folder, tasks })(() => 100)
    await settle()
    expect(tasks.calls).toEqual([])
    expect(lastReflectStart(folder)).toBeNull()
  })

  it('旧反思任务停着 → 先关再派', async () => {
    const tasks = fakeTasks([{ name: '反思', status: 'idle', lastLine: '' }])
    createAutoReflect({ folder: folderWith(), tasks })(() => 100)
    await settle()
    expect(tasks.calls).toEqual(['close:反思', 'dispatch:反思'])
  })

  it('关旧任务失败 → 不派；派出时间已记，24h 内不再试', async () => {
    const folder = folderWith()
    const tasks = fakeTasks([{ name: '反思', status: 'idle', lastLine: '' }])
    tasks.close.mockResolvedValueOnce({ ok: false, error: '摘要失败' })
    const auto = createAutoReflect({ folder, tasks })
    auto(() => 100)
    await settle()
    expect(tasks.dispatch).not.toHaveBeenCalled()
    expect(lastReflectStart(folder)).not.toBeNull()
    auto(() => 100)
    await settle()
    expect(tasks.close).toHaveBeenCalledTimes(1)
  })

  it('派出的反思没写收尾 event（失败）：24h 内不重派；满 24h 从派出时刻数轮、够了再派', async () => {
    const folder = folderWith()
    const tasks = fakeTasks()
    let now = Date.now()
    const auto = createAutoReflect({ folder, tasks, now: () => now })
    auto(() => 100)
    await settle()
    expect(tasks.dispatch).toHaveBeenCalledTimes(1)
    const firstStart = lastReflectStart(folder)
    expect(firstStart).not.toBeNull()
    now += 23 * HOUR
    auto(() => 100)
    await settle()
    expect(tasks.dispatch).toHaveBeenCalledTimes(1)
    now += 2 * HOUR
    const asked: number[] = []
    auto((at) => {
      asked.push(at)
      return 100
    })
    await settle()
    expect(tasks.dispatch).toHaveBeenCalledTimes(2)
    expect(asked).toEqual([firstStart]) // 从上次派出数起，不是从头（0）
  })

  it('派出还没回来时又开一轮（主任务和任务前后脚）→ 只派一个', async () => {
    const folder = folderWith()
    const tasks = fakeTasks()
    let release = (): void => {}
    tasks.dispatch.mockImplementationOnce(
      () =>
        new Promise<string | null>((r) => {
          release = () => r(null)
        }),
    )
    const auto = createAutoReflect({ folder, tasks })
    auto(() => 100)
    auto(() => 100)
    release()
    await settle()
    expect(tasks.dispatch).toHaveBeenCalledTimes(1)
  })
})
