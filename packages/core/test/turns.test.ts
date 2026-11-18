import { describe, expect, it } from 'vitest'
import {
  type SizedStep,
  takeOpenTurnSegment,
  takeSegment,
  uncoveredRuns,
} from '../src/loop/turns.ts'

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

describe('一个 turn 里的连续未覆盖段', () => {
  it('**被已覆盖的 step 隔开，不接起来**——接起来 covers 就跨过一个洞', () => {
    const covered = new Set([3, 4, 7])
    expect(uncoveredRuns([1, 2, 3, 4, 5, 6, 7, 8], (id) => covered.has(id))).toEqual([
      [1, 2],
      [5, 6],
      [8],
    ])
  })

  it('对照：全覆盖就没有段', () => {
    expect(uncoveredRuns([1, 2], () => true)).toEqual([])
  })
})

describe('没结束的 turn：只摘中间攒满的段', () => {
  // 每个 step 1 token、预算 2：开头那段 = [1, 2]
  const open = (runs: number[][], last: number, size = (_id: number) => 1) =>
    ids(takeOpenTurnSegment({ runs, first: 1, last, size, budget: 2 }))

  it('**开头那段（含提问）跳过，取它后面攒满的一段**', () => {
    expect(open([[1, 2, 3, 4, 5]], 5)).toEqual([3, 4])
  })

  it('**含最后一个 step 的那截还在长，不摘**——摘了后面跑出来的只能另起一段', () => {
    expect(open([[1, 2, 3, 4]], 4)).toEqual([])
    expect(open([[1, 2, 3]], 3)).toEqual([])
  })

  it('开头那段被已覆盖的段截住后，从后面的段接着取', () => {
    // [3, 4] 已摘：开头那段定死为 [1, 2]
    expect(
      open(
        [
          [1, 2],
          [5, 6, 7],
        ],
        7,
      ),
    ).toEqual([5, 6])
  })

  it('**提问那个 step 自己就超预算时，它自己是开头那段**，后面照常摘', () => {
    const size = (id: number) => (id === 1 ? 50 : 1)
    expect(open([[1, 2, 3, 4]], 4, size)).toEqual([2, 3])
  })

  it('对照：第一段不从提问开始（提问已覆盖）时不跳', () => {
    expect(open([[3, 4, 5]], 5)).toEqual([3, 4])
  })
})
