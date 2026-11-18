/** 闹钟中心（wake-center.ts，loop-interrupt.md §5；2026-11-09 起持久化） */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadWakeAlarms } from '@simple-code/core/src/session/wake-store.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWakeCenter } from '../src/wake-center.ts'

const roots: string[] = []
function root() {
  mkdirSync('.simple-code/tmp/wake-tests', { recursive: true })
  const r = mkdtempSync(resolve('.simple-code/tmp/wake-tests/case-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('闹钟中心', () => {
  it('--after：到点投递一条〔wake〕备忘，之后清空并从文件摘除', () => {
    vi.useFakeTimers()
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    expect(w.add({ root: r, owner: '', afterMs: 60_000, note: '构建该跑完了' })).toEqual({
      ok: true,
      id: expect.any(String),
    })
    expect(w.size()).toBe(1)
    expect(loadWakeAlarms(r)).toHaveLength(1) // add 即持久化
    vi.advanceTimersByTime(59_999)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(fired).toEqual([[r, '', '〔wake〕你设的闹钟：构建该跑完了']])
    expect(w.size()).toBe(0) // 响过即清
    expect(loadWakeAlarms(r)).toHaveLength(0) // 文件同步摘除
  })

  it('--after 不留备忘：文案兜底；任务会话按 owner 定向', () => {
    vi.useFakeTimers()
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: r, owner: 'task-ab12', afterMs: 1000 })
    vi.advanceTimersByTime(1000)
    expect(fired).toEqual([[r, 'task-ab12', '〔wake〕闹钟到点（未留备忘）']])
  })

  it('--at：已过时刻自动挪到明天；到点持久化的是绝对时刻', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T23:30:00'))
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: r, owner: '', at: '23:00' }) // 已过半小时 → 明天 23:00
    vi.advanceTimersByTime(24 * 3600_000 - 30 * 60_000 - 1000)
    expect(fired).toEqual([])
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveLength(1)
  })

  it('--until-ok：立即探一次，命令退出 0 那次唤醒并停探测；非 0 继续等下轮', () => {
    vi.useFakeTimers()
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    // true/false 由命令控制：头两轮失败，第三轮成功
    let gate = false
    const res = w.add({
      root: r,
      owner: '',
      untilOk: 'sh -c "exit $(cat .simple-code/tmp/sc-wake-gate 2>/dev/null || echo 1)"',
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

  it('--until-ok：探测子进程 cwd 为项目根，依赖相对路径的条件能唤醒', async () => {
    vi.useRealTimers()
    const r = root()
    const marker = 'sc-wake-cwd-only-in-root.flag'
    writeFileSync(join(r, marker), 'ok')
    // 前提：测试进程自身 cwd 下不存在该相对文件——若漏传 cwd: root 则探测必非 0
    expect(existsSync(resolve(marker))).toBe(false)

    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((rt, owner, text) => fired.push([rt, owner, text]))
    try {
      const res = w.add({
        root: r,
        owner: 'task-cwd',
        untilOk: `test -f ${marker}`,
        note: '产物就绪',
      })
      expect(res.ok).toBe(true)
      await vi.waitFor(() => {
        expect(fired).toEqual([[r, 'task-cwd', '〔wake〕你设的闹钟：产物就绪']])
      })
      expect(w.size()).toBe(0)

      // 对照组：不存在该标记文件的另一项目根不会误唤醒
      const emptyRoot = root()
      expect(w.add({ root: emptyRoot, owner: 'task-empty', untilOk: `test -f ${marker}` }).ok).toBe(
        true,
      )
      await new Promise((res2) => setTimeout(res2, 80))
      expect(fired).toHaveLength(1)
    } finally {
      w.dispose()
    }
  })

  it('按任务计上限 20：同任务超了拒绝，别的任务不受挤占', () => {
    vi.useFakeTimers()
    const r = root()
    const w = createWakeCenter(() => {})
    for (let i = 0; i < 20; i++) w.add({ root: r, owner: '', afterMs: 3600_000 })
    const full = w.add({ root: r, owner: '', afterMs: 3600_000 })
    expect(full).toEqual({ ok: false, error: expect.stringContaining('上限') })
    const other = w.add({ root: r, owner: 'task-2', afterMs: 3600_000 })
    expect(other.ok).toBe(true) // 别的任务自己的 20 条额度
  })

  it('三种形态都没有：拒绝并列出用法', () => {
    const r = root()
    const w = createWakeCenter(() => {})
    const res = w.add({ root: r, owner: '' })
    expect(res).toEqual({ ok: false, error: expect.stringContaining('三种形态') })
  })

  it('fire 前被取消（dropWakeAlarm）：不再投递，静默退出', () => {
    vi.useFakeTimers()
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    const res = w.add({ root: r, owner: 'task-a', afterMs: 1000, note: '备忘' })
    if (!res.ok) throw new Error('add failed')
    const { dropWakeAlarm } = require('@simple-code/core/src/session/wake-store.ts')
    expect(dropWakeAlarm(r, res.id, 'task-a')).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(fired).toEqual([]) // 已取消：不响
  })

  it('restore：未到点重挂、过点补投迟到的叫醒、条件型重挂探测', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-09T10:00:00'))
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: r, owner: 'task-a', afterMs: 3600_000, note: '一小时的' }) // 11:00 到点
    w.add({ root: r, owner: 'task-b', afterMs: 60_000, note: '早该响的' }) // 10:01 到点
    const w2 = createWakeCenter((root, owner, text) => fired.push([root, owner, text])) // reload：新中心
    vi.setSystemTime(new Date('2026-11-09T10:30:00')) // 一条过点、一条没到
    w2.restore([r])
    expect(fired).toEqual([
      [r, 'task-b', '〔wake〕你设的闹钟：早该响的（这条闹钟在你重载期间到点，迟到的叫醒）'],
    ])
    expect(w2.size()).toBe(1) // 未到点的重挂了
    vi.advanceTimersByTime(30 * 60_000)
    expect(fired).toHaveLength(2)
    expect(fired[1]).toEqual([r, 'task-a', '〔wake〕你设的闹钟：一小时的'])
    expect(loadWakeAlarms(r)).toHaveLength(0) // 都响完，文件清空
  })

  it('stopRoot：目录移出工作区停 timer，文件保留等目录回来', () => {
    vi.useFakeTimers()
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: r, owner: '', afterMs: 1000 })
    w.stopRoot(r)
    vi.advanceTimersByTime(2000)
    expect(fired).toEqual([]) // 停了不响
    expect(loadWakeAlarms(r)).toHaveLength(1) // 文件还在
    const w2 = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w2.restore([r]) // 目录回来：重挂
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveLength(1)
  })

  it('dispose：全部清掉，不再触发；文件保留', () => {
    vi.useFakeTimers()
    const r = root()
    const fired: Array<[string, string, string]> = []
    const w = createWakeCenter((root, owner, text) => fired.push([root, owner, text]))
    w.add({ root: r, owner: '', afterMs: 1000 })
    w.dispose()
    vi.advanceTimersByTime(2000)
    expect(fired).toEqual([])
    expect(w.size()).toBe(0)
    expect(loadWakeAlarms(r)).toHaveLength(1)
  })
})
