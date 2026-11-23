import { describe, expect, it } from 'vitest'
import { findRepeatedSuffix } from '../src/loop/repetition.ts'

describe('正文重复检测', () => {
  it('连续四次且重复区达到 320 字符时命中', () => {
    const unit = 'abcdefghijklmnop 0123456789 -- 这是一个足够长的重复片段。'.repeat(3) + 'END.'
    const match = findRepeatedSuffix(`前缀${unit.repeat(4)}`)

    expect(match?.repeats).toBe(4)
    expect(match?.unit).toBe(unit)
    expect(match?.start).toBe(2)
  })

  it('只有三次重复时不命中', () => {
    const unit = 'abcdefghijklmnop 0123456789 -- 这是一个足够长的重复片段。'.repeat(3) + 'END.'

    expect(findRepeatedSuffix(unit.repeat(3))).toBeNull()
  })

  it('短片段即使重复四次也不命中', () => {
    expect(findRepeatedSuffix('0123456789abcdef'.repeat(4))).toBeNull()
  })

  it('同一正文追加更多重复时仍返回完整重复区', () => {
    const unit = Array.from({ length: 24 }, (_, i) => `第${i}段：不同的内容 ${i * 17 + 3}。`).join(
      '',
    )
    const match = findRepeatedSuffix(`正常开头${unit.repeat(10)}`)

    expect(match?.repeats).toBe(10)
    expect(match?.start).toBe(4)
  })
})
