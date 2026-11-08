/** $SIMPLE_CODE_WAKE bin 的时长解析（loop-interrupt.md 实现项 3） */
import { describe, expect, it } from 'vitest'
import { parseDuration } from '../src/wake.ts'

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
