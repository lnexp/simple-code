// @vitest-environment jsdom
// 同 toolrow.test.ts：activity.tsx 经 markdown.ts 间接依赖 DOMPurify，导入期要 window
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProcessGroup } from '../webview/activity.tsx'
import type { ActivityItem, Block, ChatItem } from '../webview/events.ts'
import { MessageFooter } from '../webview/footer.tsx'
import { buildSteps, stepStats } from '../webview/steps.ts'
import { Timeline, withToken } from '../webview/timeline.tsx'

/**
 * 时间线和处理过程头的渲染契约。**配对规则在 steps.test.ts 测，这里只测
 * 文案、计数口径和「默认收起」**——都是 typecheck 和 lint 放行、只有肉眼
 * 能发现的那一类（toolrow.test.ts 开头记的教训）。
 */

const tool = (id: string, failed = false): ActivityItem => ({
  kind: 'tool',
  id,
  desc: `命令${id}`,
  name: 'bash',
  command: 'ls',
  output: failed ? 'Error: boom' : '',
  failed,
})
const thinking = (text: string): ActivityItem => ({ kind: 'reasoning', text })
const say = (text: string): Block => ({
  kind: 'single',
  item: { kind: 'assistant', text } as Extract<ChatItem, { kind: 'assistant' }>,
})
const act = (...items: ActivityItem[]): Block => ({ kind: 'activity', items })
const approval = (toolCallId: string) => ({
  type: 'approval_request' as const,
  expiresAt: Date.now() + 60_000,
  id: 1,
  command: 'curl x',
  toolCallId,
  category: 'ask_rule' as const,
  detail: '',
  reason: '网络命令',
})

const timeline = (blocks: Block[], live = false): string =>
  renderToStaticMarkup(
    h(Timeline, {
      rows: buildSteps(blocks.map((block, at) => ({ block, at }))),
      live,
      streamingAt: null,
      approvals: [],
      onApprovalReply: () => {},
      renderBlock: () => null,
    }),
  )

describe('步骤句尾计数：只数工具', () => {
  it('1 次思考 + 2 条命令 → 「2 个操作」，不是 3', () => {
    // ActivityItem = reasoning | tool，按 items.length 数会名不副实；外层
    // 折叠头也报条数，两处口径不一致会当场露馅
    const out = timeline([say('说明'), act(thinking('想一下'), tool('t1'), tool('t2'))])
    expect(out).toContain('2 个操作')
    expect(out).not.toContain('3 个操作')
  })

  it('计数挂在说明最后一段的句尾，不另起一行', () => {
    const out = timeline([say('第一段\n\n第二段'), act(tool('t1'))])
    expect(out).toMatch(/<p>第二段<button type="button" class="tl-count"/)
  })

  it('有失败：句尾带「· N 个失败」，节点标红', () => {
    const out = timeline([say('说明'), act(tool('t1', true), tool('t2'))])
    expect(out).toContain('· 1 个失败')
    expect(out).toContain('data-failed="true"')
  })

  it('**纯思考的步骤不出「0 个操作」**，思考入口常显', () => {
    const out = timeline([act(thinking('想一下'))])
    expect(out).not.toContain('0 个操作')
    expect(out).toContain('data-bare="true"')
    expect(out).toContain('思考 1')
  })
})

describe('开合', () => {
  it('**收起 = 一条命令都不留**：跑完的时间线各步默认收起', () => {
    const out = timeline([say('说明'), act(tool('t1'))])
    expect(out).toContain('说明')
    expect(out).not.toContain('tool-row')
  })

  it('跑着的那一轮：只展开最后一步', () => {
    const out = timeline([say('甲'), act(tool('t1')), say('乙'), act(tool('t2'))], true)
    expect(out).toContain('命令t2')
    expect(out).not.toContain('命令t1')
    expect(out.match(/data-current="true"/g)).toHaveLength(1)
  })

  it('挂着审批卡的步骤强制展开（别把要批的东西收进去）', () => {
    const out = renderToStaticMarkup(
      h(Timeline, {
        rows: buildSteps(
          [say('甲'), act(tool('t1')), say('乙')].map((block, at) => ({ block, at })),
        ),
        live: true,
        streamingAt: null,
        approvals: [approval('t1')],
        onApprovalReply: () => {},
        renderBlock: () => null,
      }),
    )
    expect(out).toContain('approval-card')
  })

  it('toolCallId 不匹配的审批不挂在这一步', () => {
    const out = renderToStaticMarkup(
      h(Timeline, {
        rows: buildSteps([say('甲'), act(tool('t1'))].map((block, at) => ({ block, at }))),
        live: true,
        streamingAt: null,
        approvals: [approval('t9')],
        onApprovalReply: () => {},
        renderBlock: () => null,
      }),
    )
    expect(out).toContain('tool-row')
    expect(out).not.toContain('approval-card')
  })
})

describe('withToken：计数挂到哪', () => {
  const T = '<button class="tl-count">N</button>'
  it('最后一块是列表 → 挂进最后一项', () => {
    expect(withToken('<ul><li>甲</li><li>乙</li></ul>', T)).toContain(`<li>乙${T}</li>`)
  })
  it('最后一块是代码块 → 另起一行，不塞进代码里', () => {
    const out = withToken('<p>说明</p><pre><code>x</code></pre>', T)
    expect(out).toContain(`</pre><div class="tl-count-row">${T}</div>`)
  })
  it('空说明（没有正文的步骤）→ 只有计数一行', () => {
    expect(withToken('', T)).toBe(`<div class="tl-count-row">${T}</div>`)
  })
})

describe('处理过程头', () => {
  const stats = (blocks: Block[]) =>
    stepStats(buildSteps(blocks.map((block, at) => ({ block, at }))))
  const text = (html: string) => html.replace(/<[^>]+>/g, '')
  // 计数项：图标 + 文字，按出现顺序取文字（10-29 P3：替掉「 · 」点号串）
  const metas = (html: string) =>
    [
      ...html.matchAll(
        /<span class="process-meta[^"]*"><i class="codicon codicon-([\w-]+)"[^>]*><\/i>([^<]*)<\/span>/g,
      ),
    ].map((m) => `${m[1]}:${m[2]}`)

  it('「处理过程」+ 图标打头的 N 步 / N 个操作 / N 个失败 / 耗时，不再用 · 连', () => {
    const s = stats([say('甲'), act(tool('a'), tool('b', true)), say('乙'), act(tool('c'))])
    const out = renderToStaticMarkup(
      h(ProcessGroup, { stats: s, elapsedMs: 192_000, children: h('div', null, '内容') }),
    )
    expect(text(out)).toContain('处理过程')
    expect(text(out)).not.toContain('·')
    expect(metas(out)).toEqual([
      'list-ordered:2 步',
      'tools:3 个操作',
      'error:1 个失败',
      'watch:3m 12s',
    ])
    expect(out).toContain('class="process-meta process-fail"')
  })

  it('操作条：一格一条命令，失败的格子带标记，按步分组', () => {
    const s = stats([say('甲'), act(tool('a'), tool('b', true)), say('乙'), act(tool('c'))])
    const out = renderToStaticMarkup(
      h(ProcessGroup, { stats: s, elapsedMs: undefined, children: null }),
    )
    expect(out.match(/class="strip-step"/g)).toHaveLength(2)
    expect(out.match(/<i data-failed="(true|false)"><\/i>/g)).toHaveLength(3)
    expect(out.match(/<i data-failed="true"><\/i>/g)).toHaveLength(1)
  })

  it('**回放的历史没有耗时就不带**，别显示一个编的', () => {
    const out = renderToStaticMarkup(
      h(ProcessGroup, {
        stats: stats([say('甲'), act(tool('a'))]),
        elapsedMs: undefined,
        children: null,
      }),
    )
    expect(text(out)).toBe('处理过程1 步1 个操作')
    expect(metas(out)).toEqual(['list-ordered:1 步', 'tools:1 个操作'])
  })

  it('**默认收起：折进去的内容一个字都不在 DOM 里**', () => {
    const out = renderToStaticMarkup(
      h(ProcessGroup, {
        stats: stats([say('甲')]),
        elapsedMs: undefined,
        children: h('div', null, '过程正文'),
      }),
    )
    expect(out).not.toContain('过程正文')
  })
})

describe('回答底部耗时不和「处理过程」那一行重复（10-29 F1）', () => {
  it('页脚的耗时带 footer-elapsed，供 CSS 按有无处理过程那一行藏', () => {
    const out = renderToStaticMarkup(
      h(MessageFooter, { model: 'm', elapsedMs: 283_222, finishedAt: 0, text: '' }),
    )
    expect(out).toMatch(/<span class="footer-item footer-elapsed" title="本轮耗时">/)
  })

  it('CSS：只在本轮直接带 .process 时藏（没有命令的轮照旧显示）', async () => {
    const { STYLE } = await import('../src/style.ts')
    expect(STYLE).toContain('.turn:has(> .process) .footer-elapsed { display: none; }')
  })
})
