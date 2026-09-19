// @vitest-environment jsdom
// 同 toolrow.test.ts：activity.tsx 经 markdown.ts 间接依赖 DOMPurify，导入期要 window
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityGroup, ProcessGroup } from '../webview/activity.tsx'
import type { ActivityItem } from '../webview/events.ts'

/**
 * 第三层折叠的渲染契约。**分组逻辑在 events.test.ts 测，这里只测头部文案和
 * 「默认收起」**——两者都是 typecheck 和 lint 放行、只有肉眼能发现的那一类
 * （toolrow.test.ts 开头记的教训）。
 */

const tool = (id: string): ActivityItem => ({
  kind: 'tool',
  id,
  name: 'bash',
  command: 'ls',
  output: '',
  failed: false,
})
const thinking = (text: string): ActivityItem => ({ kind: 'reasoning', text })

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node)

describe('活动组头：只数工具', () => {
  it('1 次思考 + 2 条命令 → 「2 个操作」，不是 3', () => {
    // 原来是 items.length，而 ActivityItem = reasoning | tool。第三层折叠也
    // 报条数，两处口径不一致会当场露馅：外层说 34、点开内层加起来 41
    const out = html(
      h(ActivityGroup, {
        items: [thinking('想一下'), tool('t1'), tool('t2')],
        last: false,
        running: false,
        approvals: [],
        onApprovalReply: () => {},
      }),
    )
    expect(out).toContain('2 个操作')
    expect(out).not.toContain('3 个操作')
  })

  it('**纯思考的组不套组头**——「思考过程 ▸ 已思考」是同一件事折了两次', () => {
    const out = html(h(ActivityGroup, { items: [thinking('想一下')], last: false, running: false, approvals: [], onApprovalReply: () => {} }))
    expect(out).not.toContain('activity-head')
    expect(out).not.toContain('0 个操作')
    // 对照组：组头没了，thinking 块本身还得在——别把内容跟着组头一起摊没了
    expect(out).toContain('thinking-head')
  })
})

describe('处理过程头', () => {
  it('「处理过程 · N 个操作 · 耗时」，用 · 连起来', () => {
    const out = html(
      h(ProcessGroup, { tools: 34, elapsedMs: 192_000, children: h('div', null, '内容') }),
    )
    expect(out).toContain('处理过程 · 34 个操作 · 3m 12s')
  })

  it('**回放的历史没有耗时就不带**，别显示一个编的', () => {
    const out = html(
      h(ProcessGroup, { tools: 3, elapsedMs: undefined, children: h('div', null, 'x') }),
    )
    expect(out).toContain('处理过程 · 3 个操作')
    expect(out).not.toContain(' · 0')
  })

  it('**默认收起：折进去的内容一个字都不在 DOM 里**', () => {
    // 「收起 = 一条都不留」跟活动组同一个决定（activity.tsx 的注释）。
    // 留预览的话既读不出上下文，又让「已收起」看起来像没收起
    const out = html(
      h(ProcessGroup, { tools: 1, elapsedMs: undefined, children: h('div', null, '过程正文') }),
    )
    expect(out).not.toContain('过程正文')
  })
})
