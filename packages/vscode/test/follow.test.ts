import { describe, expect, it } from 'vitest'
import { nextPinned } from '../webview/follow.ts'

describe('nextPinned：只有往上翻才取消跟随', () => {
  it('在底部（容差内）→ 跟随，不管之前', () => {
    expect(nextPinned(false, { top: 500, lastTop: 900, distance: 10 })).toBe(true)
  })
  it('往上翻、离开底部 → 不跟', () => {
    expect(nextPinned(true, { top: 300, lastTop: 500, distance: 200 })).toBe(false)
  })
  it('**没动但内容长了**（节流提交晚于程序滚动）→ 保持跟随', () => {
    // 改前按距离重算，这里会变 false，之后再也不跟——就是这次的 bug
    expect(nextPinned(true, { top: 500, lastTop: 500, distance: 136 })).toBe(true)
  })
  it('程序往下滚但没到底（内容同时又长了）→ 保持跟随', () => {
    expect(nextPinned(true, { top: 700, lastTop: 500, distance: 80 })).toBe(true)
  })
  it('已取消跟随时往下拖但没到底 → 仍不跟，到底才恢复', () => {
    expect(nextPinned(false, { top: 700, lastTop: 500, distance: 80 })).toBe(false)
    expect(nextPinned(false, { top: 780, lastTop: 700, distance: 0 })).toBe(true)
  })
})
