// @vitest-environment jsdom
// App.tsx 间接 import markdown.ts，DOMPurify 在导入期就要 window。
// 和 markdown.test.ts 同样的理由用 jsdom 而不是 happy-dom。
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityGroup, ThinkingBlock, ToolRow } from '../webview/activity.tsx'

/**
 * 工具行的渲染契约。**这一整个文件对应一类 typecheck 和 lint 都放行、
 * 只有肉眼能发现的错**——JSX 里漏写花括号的条件表达式不是语法错误，
 * 它是合法的文本子节点，于是 `tool.output !== '' && (` 被原样画到界面上。
 * tsc 绿、biome 绿、构建通过，只有截图里能看见。（踩过，见本文件第二组）
 *
 * 用 createElement 而不是 JSX：vitest 的 include 是 `*.test.ts`，
 * 改成 .tsx 得动 vitest.config，不值得为一个测试文件动全局配置。
 */

const toolItem = (over: Partial<Parameters<typeof ToolRow>[0]['tool']> = {}) =>
  ({
    kind: 'tool' as const,
    id: 't1',
    name: 'bash',
    command: 'ls -la',
    output: 'file-a.txt\nfile-b.txt',
    failed: false,
    startedAt: 1000,
    // 用整 400ms：350ms 会走到 (0.35).toFixed(1) === '0.3' 的浮点边界上，
    // 断言值得看着像错的。时长舍入不是这个文件要测的东西
    endedAt: 1400,
    ...over,
  }) as Parameters<typeof ToolRow>[0]['tool']

const render = (over = {}) => renderToStaticMarkup(createElement(ToolRow, { tool: toolItem(over), onReply: () => {} }))

describe('对照组：确认测试真的渲染了东西', () => {
  /**
   * §6.1——下面「不含源码字面量」的断言，在组件渲染成空字符串时也会通过。
   * 先钉死「确实渲出了内容」，那些断言才有意义
   */
  it('命令、耗时、输出都在', () => {
    const html = render()
    expect(html).toContain('ls -la')
    expect(html).toContain('0.4s')
    expect(html).toContain('file-a.txt')
  })
})

describe('JSX 条件表达式不能漏出源码', () => {
  it('不含未求值的条件表达式文本', () => {
    const html = render()
    // 漏花括号时这里会出现 `tool.output !== '' && (`
    expect(html).not.toContain('tool.output')
    expect(html).not.toContain("!== ''")
    expect(html).not.toContain('&& (')
  })
})

describe('开合状态走 data-open，不走 hidden', () => {
  /**
   * style.ts 的 `.tool-body { display:grid }` 是作者样式表，优先级压过
   * `hidden` 的 UA 默认 `display:none`——用 hidden 控制开合是静默失效的，
   * 界面上表现为「点开工具行永远看不到输出」。CSS 真正读的是
   * `.tool-body[data-open="true"]` 切 grid-template-rows（style.ts:173）
   *
   * **只有这两个 wrapper 的 data-open 是活的。** 一度还给 .tool-row /
   * .thinking / .activity 也挂了，没有任何选择器读它们——删掉时全套测试
   * 一条都没红，正是这组测试当时只盖了 tool-body。thinking-wrap 那条是
   * 补上的：漏掉它的话，误删就是「思考块永远展不开」且全绿
   */
  it('tool-body 带 data-open 且不带 hidden', () => {
    const html = render()
    expect(html).toMatch(/class="tool-body"[^>]*data-open=/)
    expect(html).not.toMatch(/class="tool-body"[^>]*hidden/)
  })

  it('默认折叠', () => {
    expect(render()).toMatch(/class="tool-body"[^>]*data-open="false"/)
  })

  it('thinking-wrap 同样带 data-open，且跟着 streaming 走', () => {
    const block = { kind: 'reasoning' as const, text: '想想看', startedAt: 1000, endedAt: 1400 }
    const open = renderToStaticMarkup(createElement(ThinkingBlock, { block, streaming: true }))
    const shut = renderToStaticMarkup(createElement(ThinkingBlock, { block, streaming: false }))
    // 前提：两次都真的渲出了内容，不是在空壳上比字符串
    expect(open).toContain('想想看')
    expect(open).toMatch(/class="thinking-wrap"[^>]*data-open="true"/)
    // 对照：无条件写死 true 的话这条会红
    expect(shut).toMatch(/class="thinking-wrap"[^>]*data-open="false"/)
  })
})

describe('body 渲染条件与完整命令', () => {
  it('output 为空但命令非空：仍渲染 body（展开看完整命令）', () => {
    const html = render({ output: '' })
    expect(html).toContain('tool-body')
    expect(html).toContain('ls -la') // 头部还在
  })

  it('body 顶部是完整命令（tool-cmd-full）——收起态 head 上只有单行省略版', () => {
    // 不带 &/<>：renderToStaticMarkup 会做 HTML 转义，断言原始串命不中
    const long = 'pnpm exec vitest run packages/vscode/test --reporter=verbose'
    const html = render({ command: long })
    expect(html).toContain('tool-cmd-full')
    expect(html).toContain(long)
  })

  it('command 为空（非 bash 工具）：body 里没有命令块', () => {
    const html = render({ command: '' })
    expect(html).not.toContain('tool-cmd-full')
  })

  it('command 和 output 都空：没有 tool-body', () => {
    const html = render({ command: '', output: '' })
    expect(html).not.toContain('tool-body')
  })
})

/**
 * 工具名 → 人话名。映射漏了不报错，界面上显示原始的 `bash`——不难看，
 * 但人话名映射的意义就没了，而且没人会注意到。
 */
describe('工具显示名与图标', () => {
  it('bash 显示成「Shell 命令」并配 terminal 图标', () => {
    const html = render()
    expect(html).toContain('Shell 命令')
    expect(html).toContain('codicon-terminal')
  })

  it('命令降为次要描述，不再顶着 $ 前缀', () => {
    const html = render()
    expect(html).toContain('class="tool-cmd"')
    // 旧版是 `${command}`，命令和标题挤在一行
    expect(html).not.toContain('$ls -la')
  })

  it('有 desc：desc 顶替「Shell 命令」当标题，命令格照旧跟在后面（方案 C）', () => {
    const html = render({ desc: '列出目录', command: 'ls -la /tmp/xyz' })
    const head = html.slice(0, html.indexOf('tool-body'))
    // desc 站标题位（界面字体、亮色、无底色），不再有「Shell 命令」
    expect(head).toContain('<span class="tool-title">列出目录</span>')
    expect(head).not.toContain('Shell 命令')
    // 命令格原样（code 底色、单行截断）跟在后面
    expect(head).toContain('<code class="tool-cmd">ls -la /tmp/xyz</code>')
    // 完整命令仍在展开区
    expect(html).toContain('class="tool-cmd-full"')
    expect(html.slice(html.indexOf('tool-body'))).toContain('ls -la /tmp/xyz')
  })

  it('没 desc：标题仍是「Shell 命令」，命令格不变（旧历史/其他工具）', () => {
    const head = render({ desc: '' }).split('tool-body')[0] ?? ''
    expect(head).toContain('<span class="tool-title">Shell 命令</span>')
    expect(head).toContain('<code class="tool-cmd">ls -la</code>')
  })

  it('**未知工具兜底显示原始名**，不是空白', () => {
    // core 加了新工具而这里忘了加映射时，宁可显示 `grep` 也不能显示空行
    const html = render({ name: 'grep', command: 'grep -rn foo' })
    expect(html).toContain('grep')
    expect(html).toContain('codicon-tools')
  })
})

describe('审批卡挂在工具行下方（approval.md §4.2 位置 + 样式）', () => {
  const approval = {
    type: 'approval_request' as const,
    expiresAt: 1,
    id: 7,
    command: 'cat ~/.ssh/id_rsa',
    toolCallId: 't1',
    category: 'external_dir' as const,
    detail: '~/.ssh/id_rsa',
    reason: '要触碰项目外路径',
  }
  const renderWithApproval = () => renderToStaticMarkup(
    createElement(ToolRow, { tool: toolItem({ id: 't1' }), approval, onReply: () => {} }),
  )

  it('审批卡与工具行同根渲染（上下相邻），不在别处', () => {
    const out = renderWithApproval()
    expect(out).toContain('tool-row')
    expect(out).toContain('approval-card')
    // 卡片在工具行之后出现（DOM 顺序 = 渲染顺序）
    expect(out.indexOf('tool-row')).toBeLessThan(out.indexOf('approval-card'))
  })

  it('展示类别标签 + 触碰的路径', () => {
    const out = renderWithApproval()
    expect(out).toContain('项目外路径')
    expect(out).toContain('触碰：~/.ssh/id_rsa')
    expect(out).toContain('cat ~/.ssh/id_rsa')
  })

  it('审批卡显示倒计时；过期（expiresAt 已过）不显示', () => {
    approval.expiresAt = Date.now() + 90_000
    expect(renderWithApproval()).toMatch(/1:(29|30)/)
    approval.expiresAt = Date.now() + 30_000
    expect(renderWithApproval()).toContain('data-urgent="true"')
    approval.expiresAt = 1
    expect(renderWithApproval()).not.toContain('后自动拒绝')
  })

  it('toolCallId 不匹配时（别条命令的审批）不挂在这行——匹配在 ActivityGroup', () => {
    // ToolRow 只认传入的 approval；过滤由上层 ActivityGroup 做
    const out = renderToStaticMarkup(
      createElement(ActivityGroup, {
        items: [toolItem({ id: 't1' })],
        last: false,
        running: false,
        approvals: [{ ...approval, toolCallId: 't9' }],
        onApprovalReply: () => {},
      }),
    )
    expect(out).not.toContain('approval-card')
  })

  it('批量目录预览（paths）：列出各目录，按钮带数量（2026-09-21 方案 1）', () => {
    // multi 卡的第三键：触发点全是项目外目录时一键全记。本地 fixture——
    // 共享的 approval 会被倒计时用例原地改字段，别碰它
    const out = renderToStaticMarkup(
      createElement(ToolRow, {
        tool: toolItem({ id: 't1' }),
        approval: {
          ...approval,
          category: 'multi' as const,
          always: { kind: 'paths', dirs: ['/Users/x/proj-a', '/Users/x/proj-b'] },
        },
        onReply: () => {},
      }),
    )
    // 按钮文案带数量（区别于单目录的「始终允许」）
    expect(out).toContain('始终允许这 2 个目录')
    // 预览列出会记什么：每个目录的 /* 形态
    expect(out).toContain('/Users/x/proj-a/*、/Users/x/proj-b/*')
  })
})

describe('折叠 CSS 契约（grid-auto-rows）', () => {
  // jsdom 不做 layout，0fr 隐式行漏内容的 bug 截图才能看见（无头 Chrome
  // 复现确认过：view_image 带图时 pre 掉到隐式第二行，收起态文本全量漏出）。
  // 这里只锁「规则存在」——两行被删掉的话这个用例先红，至于视觉回归仍靠截图。
  it('tool-body 的隐式行规则在（收起 0fr / 展开 auto——各自内容高度）', async () => {
    const { STYLE } = await import('../src/style.ts')
    const text = STYLE
    expect(text).toContain('.tool-body { grid-auto-rows: 0fr; }')
    // 展开是 auto 不是 1fr：fr 平分把各行拉成等高（以最高一行为准），
    // 短命令块被长输出撑到一样高。auto 才是各块独立自适应 + 各自 46vh 封顶
    expect(text).toContain('.tool-body[data-open="true"] { grid-auto-rows: auto; }')
  })
})

/**
 * 图标按工具名查表：渠道会改写工具名（GLM 把 bash 采样成 Bash；
 * claude-opus-5-5 网关包成 mcp__client__bash）。流式阶段的行是
 * tool_input_start 用渠道原名建的，core 归一后的 tool_call 不改行名，
 * 所以 displayOf 必须和 core resolveTool 同规则回退——2026-10-22 opus
 * 会话里 bash 行图标从终端变扳手就是这么来的
 */
describe('工具图标：渠道改写名回退到 bash', () => {
  for (const name of ['bash', 'Bash', 'mcp__client__bash']) {
    it(`${name} → codicon-terminal`, () => {
      expect(render({ name })).toContain('codicon-terminal')
    })
  }

  it('真不认识的工具仍落扳手兜底', () => {
    expect(render({ name: 'mcp__client__unknown' })).toContain('codicon-tools')
  })
})
