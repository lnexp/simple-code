import { describe, expect, it } from 'vitest'
import { type SizedStep, takeSegment } from '../src/loop/turns.ts'

const steps = (...tokens: number[]): SizedStep[] => tokens.map((t, i) => ({ id: i + 1, tokens: t }))

const ids = (segment: SizedStep[]): number[] => segment.map((s) => s.id)

describe('按 token 预算切段', () => {
  it('装得下就整个 turn 一段', () => {
    expect(ids(takeSegment(steps(3_000, 4_000, 5_000), 16_000))).toEqual([1, 2, 3])
  })

  it('**装不下就切，且不许超预算**', () => {
    // 一个 15 万 token 的 turn 整个喂给摘要模型，出来的就是 §1.3 那种
    // 「无内容可提炼」。预算 16k 是 §1.1 那次真实调用验证过的点
    const segment = takeSegment(steps(6_000, 6_000, 6_000, 6_000), 16_000)
    expect(ids(segment)).toEqual([1, 2])
    expect(segment.reduce((sum, s) => sum + s.tokens, 0)).toBeLessThanOrEqual(16_000)
  })

  it('**取的是前缀，所以 covers 不会出洞**', () => {
    // 「跳过装不下的、继续往后收」那种实现也能凑满预算，但段里就有洞了
    // ——L1 合并靠连续前缀，中间断一个就再也接不上（§6.6）
    const segment = takeSegment(steps(6_000, 20_000, 1_000), 16_000)
    expect(ids(segment)).toEqual([1]) // 不是 [1, 3]
  })

  it('**第一个 step 就超预算时，它自己成一段**——返回空的话摘要线程会空转', () => {
    // 空数组让调用方拿不到候选，而这个 step 又永远排在队首：摘要从此不动，
    // 且**不报错**。宁可超预算摘一次
    const segment = takeSegment(steps(50_000, 1_000), 16_000)
    expect(ids(segment)).toEqual([1])
    expect(segment[0]?.tokens).toBeGreaterThan(16_000) // 前提：确实超了
  })

  it('对照：没有 step 就返回空', () => {
    expect(takeSegment([], 16_000)).toEqual([])
  })
})
