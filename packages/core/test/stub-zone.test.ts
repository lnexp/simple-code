import { describe, expect, it } from 'vitest'
import type { LiveMessage, Summary } from '../src/loop/assemble.ts'
import { activateBeyondStubZone } from '../src/loop/summarize.ts'

/**
 * 存根区按 **step** 数，不按 turn（2026-09-28 纠偏）。9-24 用户原话「保底区往上
 * 再数 30 个组 tool call」并否决 turn 粒度；定稿文档误写「30 轮」，实现数了
 * turnId——一个 turn 常有 20~50 次工具调用，30 turn 永远到不了。
 *
 * 夹具：一个大 turn（turn 1，step 1..6，像一次连跑六条命令）+ 当前 turn 的
 * 最后一条在保底区。stubSteps=3：区里装 step 6、5、4，step 1..3 在区外。
 * 按 turn 数的话 turn 1 只算「1 轮」，整个 turn 都在区里，一条都不进场。
 */
const msg = (turnId: number, stepId: number): LiveMessage => ({
  message: { role: 'assistant', parts: [{ type: 'text', text: `s${stepId}` }] },
  turnId,
  stepId,
})
const summary = (id: number, coversFrom: number, coversTo: number): Summary => ({
  id,
  level: 0,
  coversFrom,
  coversTo,
  name: '',
  text: 'x',
  status: 'ready',
  inContext: false,
  supersededBy: null,
  head: null,
  archivePath: null,
  owner: null,
})

describe('存根区按 step 计数', () => {
  const live = [1, 2, 3, 4, 5, 6].map((s) => msg(1, s)).concat([msg(2, 7)])
  const floorStart = live.length - 1 // 保底区只圈 step 7

  const run = (stubSteps: number) => {
    const activated: number[] = []
    activateBeyondStubZone({
      live,
      floorStart,
      stubSteps,
      stubTokens: 1e9, // 只让 step 界起作用
      summaries: () => [summary(1, 1, 3), summary(2, 4, 6)],
      activateSummary: (stepId) => {
        activated.push(stepId)
        return true
      },
    })
    return activated
  }

  it('同一个 turn 里的多个 step 分别计数：区外段进场、区内段不进', () => {
    expect(run(3)).toEqual([1]) // step 1..3 出区 → 摘要 1 进场；4..6 在区内
  })

  it('区装得下全部 step 时一条都不进（对照组，排除「无条件进场」的假绿）', () => {
    expect(run(6)).toEqual([])
  })
})

describe('孤儿段进场：段内无 live、摘要不在场（2026-09-28 真库 409 步空洞）', () => {
  // 真库形状：step 1..3 的原文早已卸载（live 里没有），摘要 ready 却 in_context=0
  // ——被旧机制撤了场。live 只剩 step 10、11
  const live = [msg(5, 10), msg(6, 11)]
  const run = (summaries: Summary[], floorStart = live.length - 1) => {
    const activated: number[] = []
    activateBeyondStubZone({
      live,
      floorStart,
      stubSteps: 30,
      stubTokens: 1e9,
      summaries: () => summaries,
      activateSummary: (stepId) => {
        activated.push(stepId)
        return true
      },
    })
    return activated
  }

  it('孤儿段的摘要进场——哪怕存根区装得下全部 live（ceiling=0 也不挡）', () => {
    expect(run([summary(1, 1, 3)])).toEqual([1])
  })

  it('与在场摘要重叠的不进（不重复顶替同一段）', () => {
    const inCtx = { ...summary(9, 2, 5), inContext: true }
    expect(run([summary(1, 1, 3), inCtx])).toEqual([])
  })

  it('同段 L1 与未合并 L0 并存：先进 L1，L0 随之判重叠', () => {
    const l1 = { ...summary(2, 1, 6), level: 1 }
    expect(run([summary(1, 1, 3), l1])).toEqual([1]) // 只进了一条（L1，coversFrom 1）
  })

  it('段内还有 live 的不走孤儿通道（仍按存根区位置判）', () => {
    // step 10 在存根区里（ceiling=0）→ 不进
    expect(run([summary(1, 10, 10)])).toEqual([])
  })
})
