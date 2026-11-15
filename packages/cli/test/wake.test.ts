/** $SIMPLE_CODE_WAKE bin 的时长解析（loop-interrupt.md 实现项 3） */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main, parseDuration } from '../src/wake.ts'

describe('parseDuration', () => {
  it('认 s/m/h 与组合；拒绝 0、纯数字、未知单位', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1h30m')).toBe(5_400_000)
    expect(parseDuration('90s')).toBe(90_000)
    expect(parseDuration('0m')).toBe(null)
    expect(parseDuration('30')).toBe(null)
    expect(parseDuration('30x')).toBe(null)
    expect(parseDuration('')).toBe(null)
  })
})

const cliRoots: string[] = []
afterEach(() => {
  for (const r of cliRoots.splice(0)) rmSync(r, { recursive: true, force: true })
  delete process.env.SIMPLE_CODE_ROOTS
  delete process.env.SIMPLE_CODE_OWNER
  delete process.env.TASK_PORT_ENV_KEY
  vi.restoreAllMocks()
})

describe('--list / --cancel（直读持久层，不经任务桥）', () => {
  it('--list：无桥也退出 0，列的是本任务的（owner 过滤）', async () => {
    mkdirSync('.simple-code/tmp/wake-cli', { recursive: true })
    const r = mkdtempSync(resolve('.simple-code/tmp/wake-cli/case-'))
    cliRoots.push(r)
    process.env.SIMPLE_CODE_ROOTS = JSON.stringify([r])
    process.env.SIMPLE_CODE_OWNER = ''
    // 主任务一条 + 别的任务一条：只该看到主的
    const { saveWakeAlarms, newWakeId } = await import(
      '@simple-code/core/src/session/wake-store.ts'
    )
    saveWakeAlarms(r, [
      { id: newWakeId(), owner: '', kind: 'after', dueAt: Date.now() + 60_000, note: '主的' },
      {
        id: newWakeId(),
        owner: 'task-a',
        kind: 'after',
        dueAt: Date.now() + 60_000,
        note: '任务的',
      },
    ])
    process.argv = ['node', 'wake.ts', '--list']
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const code = await main()
    expect(code).toBe(0)
    const out = spy.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('主的')
    expect(out).not.toContain('任务的')
  })

  it('--cancel：不存在/别人的任务返回 1 并报错；本任务的成功退出 0', async () => {
    mkdirSync('.simple-code/tmp/wake-cli', { recursive: true })
    const r = mkdtempSync(resolve('.simple-code/tmp/wake-cli/case-'))
    cliRoots.push(r)
    process.env.SIMPLE_CODE_ROOTS = JSON.stringify([r])
    process.env.SIMPLE_CODE_OWNER = 'task-a'
    const { saveWakeAlarms, newWakeId } = await import(
      '@simple-code/core/src/session/wake-store.ts'
    )
    const mine = newWakeId()
    const others = newWakeId()
    saveWakeAlarms(r, [
      { id: mine, owner: 'task-a', kind: 'after', dueAt: Date.now() + 60_000, note: '' },
      { id: others, owner: 'task-b', kind: 'after', dueAt: Date.now() + 60_000, note: '' },
    ])
    for (const [id, wantError] of [
      [others, '别的任务'],
      ['no-such-id', '没有这条闹钟'],
    ] as const) {
      process.argv = ['node', 'wake.ts', '--cancel', id]
      const writes: string[] = []
      vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
        writes.push(String(t))
        return true
      })
      const code = await main()
      expect(code).toBe(1)
      expect(writes.join('')).toContain(wantError)
    }
    process.argv = ['node', 'wake.ts', '--cancel', mine]
    const writes2: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
      writes2.push(String(t))
      return true
    })
    const code = await main()
    expect(code).toBe(0)
    expect(writes2.join('')).toContain('已取消')
  })
})
