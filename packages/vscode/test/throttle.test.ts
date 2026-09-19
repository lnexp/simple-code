import { describe, expect, it } from 'vitest'
import { STREAM_THROTTLE_MS, throttleDelay } from '../webview/throttle.ts'

describe('throttleDelay（流式节流的决策，D1a）', () => {
  it('间隔未到 → 剩余毫秒', () => {
    expect(throttleDelay(1000, 1050, STREAM_THROTTLE_MS)).toBe(50)
  })

  it('间隔已到 → 0（立刻放行）', () => {
    expect(throttleDelay(1000, 1100, STREAM_THROTTLE_MS)).toBe(0)
    expect(throttleDelay(1000, 5000, STREAM_THROTTLE_MS)).toBe(0)
  })

  it('同时/回拨 → 不放行（等同刚发过）；任何输入不出负数', () => {
    // elapsed = 0 或负都算「没等够」，delay 为正——绝不排负延时定时器
    expect(throttleDelay(1000, 1000, STREAM_THROTTLE_MS)).toBe(STREAM_THROTTLE_MS)
    expect(throttleDelay(1000, 900, STREAM_THROTTLE_MS)).toBe(200)
  })
})
