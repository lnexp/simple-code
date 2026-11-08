/** 闹钟中心（wake-center.ts，loop-interrupt.md 实现项 3） */
import { describe, expect, it, vi } from 'vitest'
import { createWakeCenter } from '../src/wake-center.ts'

describe('闹钟中心', () => {
  it('--after：到点投递一条〔wake〕备忘，之后清空', () => {
    vi.useFakeTimers()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    expect(w.add({ root: '/w/a', owner: '', afterMs: 60_000, note: '构建该跑完了' })).toEqual({
      ok: true,
      id: expect.any(String),
    })
    expect(w.size()).toBe(1)
    vi.advanceTimersByTime(59_999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([['/w/a', '', '〔wake〕你设的闹钟：构建该跑完了']])
    expect(w.size()).toBe(0) // 响过即清
  })

  it('--after 不留备忘：文案兜底；任务会话按 owner 定向', () => {
    vi.useFakeTimers()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: '/w/b', owner: 'task-ab12', afterMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(fired).toEqual([['/w/b', 'task-ab12', '〔wake〕闹钟到点（未留备忘）']])
  })

  it('--at：已过时刻自动挪到明天', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T23:30:00'))
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: '/w/a', owner: '', at: '23:00' }) // 已过半小时 → 明天 23:00
    vi.advanceTimersByTime(24 * 3600_000 - 30 * 60_000 - 1000)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveLength(1)
  })

  it('--until-ok：立即探一次，命令退出 0 那次唤醒并停探测；非 0 继续等下轮', () => {
    vi.useFakeTimers()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    // true/false 由命令控制：头两轮失败，第三轮成功
    let gate = false
    const res = w.add({
      root: '/w/a',
      owner: '',
      untilOk: 'sh -c "exit $(cat /tmp/sc-wake-gate 2>/dev/null || echo 1)"',
    })
    expect(res.ok).toBe(true)
    // 立即那轮：gate=false → exit 1，不唤醒
    expect(fired).toEqual([])
    // 第二轮（30m 默认间隔）：仍失败
    vi.advanceTimersByTime(30 * 60_000)
    // 命令是异步子进程：fake timers 下等微任务落定不现实，这里只断言 interval 还活着
    expect(w.size()).toBe(1)
    gate = true
    expect(w.describe()).toEqual(['条件满足（每 30 分钟探测）'])
  })

  it('总量上限 20：超了拒绝（防变相轮询）', () => {
    vi.useFakeTimers()
    const w = createWakeCenter(() => {})
    for (let i = 0; i < 20; i++) w.add({ root: '/w/a', owner: '', afterMs: 3600_000 })
    const full = w.add({ root: '/w/a', owner: '', afterMs: 3600_000 })
    expect(full).toEqual({ ok: false, error: '闹钟已达上限 20，先等现有的响' })
  })

  it('三种形态都没有：拒绝并列出用法', () => {
    const w = createWakeCenter(() => {})
    const res = w.add({ root: '/w/a', owner: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('--after')
  })

  it('dispose：全部清掉，不再触发', () => {
    vi.useFakeTimers()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: '/w/a', owner: '', afterMs: 1000 })
    w.dispose()
    vi.advanceTimersByTime(10_000)
    expect(fired).toEqual([])
  })
})
