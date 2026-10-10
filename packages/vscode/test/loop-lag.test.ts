import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchLoopLag } from '../src/loop-lag.ts'

afterEach(() => vi.useRealTimers())

describe('watchLoopLag', () => {
  it('打点晚到 ≥ 阈值记一行 loop_lag（ms = 超出间隔的部分）；正常的不记', () => {
    vi.useFakeTimers()
    const lines: Record<string, unknown>[] = []
    const w = watchLoopLag((ev) => void lines.push(ev))
    vi.advanceTimersByTime(3000) // 正常走 3 拍
    expect(lines).toHaveLength(0)
    // 模拟事件循环被同步代码占住 3.6s：时钟跳了，定时器这一拍才到
    vi.setSystemTime(Date.now() + 3600)
    vi.advanceTimersByTime(1000)
    expect(lines).toEqual([{ ev: 'loop_lag', ms: 3600 }])
    w.dispose()
    vi.setSystemTime(Date.now() + 5000)
    vi.advanceTimersByTime(1000)
    expect(lines).toHaveLength(1) // dispose 后不再记
  })
})
