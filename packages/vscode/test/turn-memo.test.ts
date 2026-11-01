// @vitest-environment jsdom
// timeline.tsx 经 markdown.ts 间接依赖 DOMPurify，导入期要 window
import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../webview/events.ts'
import { groupTurns } from '../webview/steps.ts'
import { MTurnView } from '../webview/timeline.tsx'

describe('MTurnView：内容没变的轮跳过渲染', () => {
  // 流式中 Log 每 100ms 重渲，每次都重建 turn 外壳。这里数 renderBlock 被调
  // 了几次：跳过 = 没调；内容变了 / renderBlock 换了 = 必须调（写漏就是
  // 「界面不更新」）
  const user = { kind: 'user', text: '问' } as Extract<ChatItem, { kind: 'user' }>
  const answer = { kind: 'assistant', text: '答' } as Extract<ChatItem, { kind: 'assistant' }>
  const turnOf = (a = answer) =>
    groupTurns([
      { kind: 'block', block: { kind: 'single', item: user }, at: 0 },
      { kind: 'block', block: { kind: 'single', item: a }, at: 1 },
    ])[0] as ReturnType<typeof groupTurns>[number]

  it('外壳新建 → 不重渲；item 换了 / renderBlock 换了 → 重渲', () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    let calls = 0
    const renderBlock = () => {
      calls++
      return null
    }
    const host = document.createElement('div')
    const root = createRoot(host)
    const props = { live: false, streamingAt: null, approvals: [], onApprovalReply: () => {} }
    act(() => root.render(h(MTurnView, { ...props, turn: turnOf(), renderBlock })))
    const first = calls
    expect(first).toBeGreaterThan(0)

    act(() => root.render(h(MTurnView, { ...props, turn: turnOf(), renderBlock })))
    expect(calls).toBe(first)

    const changed = { ...answer, text: '答。' }
    act(() => root.render(h(MTurnView, { ...props, turn: turnOf(changed), renderBlock })))
    expect(calls).toBe(first * 2)

    // 内容不变（同一个 changed），只换 renderBlock：也得重渲
    const another = () => {
      calls++
      return null
    }
    act(() => root.render(h(MTurnView, { ...props, turn: turnOf(changed), renderBlock: another })))
    expect(calls).toBe(first * 3)
    act(() => root.unmount())
  })
})
