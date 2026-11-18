import { describe, expect, it } from 'vitest'
import { accumulate, emptyAccumulator, finishAccumulator } from '../src/loop/accumulate.ts'
import type { StreamEvent } from '../src/loop/retry.ts'

const fold = (events: StreamEvent[]) =>
  finishAccumulator(events.reduce((acc, ev) => accumulate(acc, ev)[0], emptyAccumulator())).parts

// 协议层漏发 end 时的防线：没收尾的块被新块直接覆盖，内容静默消失、不报错
// （2026-11-14 openai-chat 推理/正文交错丢正文，网关多轮事故）
describe('accumulate / 没收尾的块不能被新块覆盖', () => {
  it('上一个块没收尾就来了新块的 start：旧块先结算成 part', () => {
    const parts = fold([
      { type: 'text_start' },
      { type: 'text_delta', text: '正文' },
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', text: '推理' },
      { type: 'reasoning_end' },
    ])
    expect(parts).toEqual([
      { type: 'text', text: '正文' },
      { type: 'reasoning', text: '推理' },
    ])
  })

  it('没有 start 就来了另一种块的 delta：旧块先结算成 part', () => {
    const parts = fold([
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', text: '推理' },
      { type: 'text_delta', text: '正文' },
      { type: 'text_end' },
    ])
    expect(parts).toEqual([
      { type: 'reasoning', text: '推理' },
      { type: 'text', text: '正文' },
    ])
  })

  it('收尾齐全的块照旧：同种 delta 拼进同一个块，空正文块不产出 part', () => {
    const parts = fold([
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', text: '推' },
      { type: 'reasoning_delta', text: '理' },
      { type: 'reasoning_end' },
      { type: 'text_start' },
      { type: 'text_end' },
    ])
    expect(parts).toEqual([{ type: 'reasoning', text: '推理' }])
  })
})
