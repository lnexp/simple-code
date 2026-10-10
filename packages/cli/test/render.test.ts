import type { AgentEvent, Usage } from '@simple-code/core'
import { describe, expect, it } from 'vitest'
import { createRenderer, type Sink } from '../src/render.ts'

/** collector sink：out/err 分开收集 */
const collector = (): Sink & { out_(): string; err_(): string } => {
  let o = ''
  let e = ''
  return {
    out: (s) => { o += s },
    err: (s) => { e += s },
    out_: () => o,
    err_: () => e,
  }
}

const usage = (): Usage => ({
  inputTokens: 10,
  outputTokens: 4,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

const ev = (e: Partial<AgentEvent>): AgentEvent => e as AgentEvent
const finish = (): AgentEvent => ev({ type: 'step_finish', usage: usage(), contextTokens: 100 })
const timing = (): AgentEvent => ev({ type: 'request_timing', ttftMs: 3, totalMs: 25 })

describe('renderer 感知层（着色 + 代码块缓冲）', () => {
  it('无 TTY：零色码，内容逐字完整（管道里拿到的是干净文本）', () => {
    const c = collector()
    const r = createRenderer(c)
    r.on(ev({ type: 'text_delta', text: '看代码\n' }))
    r.on(ev({ type: 'text_delta', text: '```ts\n' }))
    r.on(ev({ type: 'text_delta', text: 'const x = 1\n' }))
    r.on(ev({ type: 'text_delta', text: '```\n' }))
    r.on(ev({ type: 'text_delta', text: '完' }))
    r.on(ev({ type: 'text_end' }))
    r.on(finish())
    r.done()
    expect(c.out_()).toBe('看代码\n```ts\nconst x = 1\n```\n完\n')
    expect(c.out_()).not.toContain('\x1b')
    expect(c.err_()).not.toContain('\x1b')
  })

  it('TTY：元信息暗灰、思考暗灰、代码高亮带 ANSI', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'reasoning_start' }))
    r.on(ev({ type: 'reasoning_delta', text: '想想' }))
    r.on(ev({ type: 'reasoning_end' }))
    r.on(ev({ type: 'text_delta', text: '```ts\n' }))
    r.on(ev({ type: 'text_delta', text: 'const x = 1\n' }))
    r.on(ev({ type: 'text_delta', text: '```\n' }))
    r.on(ev({ type: 'text_end' }))
    r.on(finish())
    r.on(timing())
    r.done()
    // 思考与统计行暗灰
    expect(c.err_()).toContain('\x1b[90m[思考]\x1b[0m')
    // 页脚与插件底栏一字不差（App.tsx）：首字 · 总 · ↑↓ · 上下文
    expect(c.err_()).toContain('\x1b[90m首字 3ms · 总 25ms · ↑10 ↓4 ｜ 上下文 100\n\x1b[0m')
    // 围栏行暗灰、ts 代码 keyword 高亮（const → hlKeyword 35）
    expect(c.out_()).toContain('\x1b[90m```ts\n\x1b[0m')
    expect(c.out_()).toContain('\x1b[35mconst\x1b[0m')
    // 内容完整（剥掉色码后逐字对）
    const stripped = c.out_().replace(/\x1b\[[0-9;]*m/g, '')
    expect(stripped).toBe('```ts\nconst x = 1\n```\n\n')
  })

  it('围栏没闭合（模型被截断/忘写）：整块原样放出，一字不丢', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_delta', text: '```py\n' }))
    r.on(ev({ type: 'text_delta', text: 'print(1)\n' }))
    r.on(ev({ type: 'text_delta', text: '没了' }))
    r.on(ev({ type: 'text_end' }))
    r.on(finish())
    r.done() // 兜底冲刷发生在 done：整轮结束围栏还开着才原样放
    expect(c.out_().replace(/\x1b\[[0-9;]*m/g, '')).toBe('```py\nprint(1)\n没了\n')
  })

  it('qwen 式多段 text：text_end 劈在代码块中途，块仍然高亮完整', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_start' }))
    r.on(ev({ type: 'text_delta', text: '``' }))   // 围栏被劈
    r.on(ev({ type: 'text_delta', text: '`ts\n' }))
    r.on(ev({ type: 'text_end' }))                  // ← 中途被 part 边界劈开
    r.on(ev({ type: 'text_start' }))
    r.on(ev({ type: 'text_delta', text: 'const x = 1\n' }))
    r.on(ev({ type: 'text_delta', text: '```\n' }))
    r.on(ev({ type: 'text_end' }))
    r.on(finish())
    r.done()
    expect(c.out_()).toContain('\x1b[90m```ts\n\x1b[0m')
    expect(c.out_()).toContain('\x1b[35mconst\x1b[0m')
    // text_end 的补行不插进块中间：剥色后逐字完整、无多余换行
    expect(c.out_().replace(/\x1b\[[0-9;]*m/g, '')).toBe('```ts\nconst x = 1\n```\n\n')
  })

  it('qwen 真实劈法：闭合围栏不带尾换行、紧跟 text_end，块照样高亮', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_start' }))
    r.on(ev({ type: 'text_delta', text: '```typescript' }))      // 无换行
    r.on(ev({ type: 'text_delta', text: '\nfunction add(a' }))    // 换行在下一个 delta 开头
    r.on(ev({ type: 'text_delta', text: ': number): number {\n  return 1;\n}\n```' })) // 闭合无尾换行
    r.on(ev({ type: 'text_end' }))
    r.on(finish())
    r.done()
    expect(c.out_()).toContain('\x1b[35mfunction\x1b[0m')
    expect(c.out_().replace(/\x1b\[[0-9;]*m/g, '')).toBe('```typescript\nfunction add(a: number): number {\n  return 1;\n}\n```\n\n')
  })

  it('围栏被劈在两个 delta（`` + \\n）：不当代码块，内容照样完整直出', () => {
    const c = collector()
    const r = createRenderer(c)
    r.on(ev({ type: 'text_delta', text: 'a``' }))
    r.on(ev({ type: 'text_delta', text: '`md\nx\n' }))
    r.on(ev({ type: 'text_end' }))
    // a``` 不是行首围栏（前面有字）→ 整行直出，md/x 都不进缓冲
    expect(c.out_()).toBe('a```md\nx\n\n')
  })

  it('工具调用：$ 前缀青色，结果暗灰，退出码标注保留', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'tool_call', name: 'bash', input: { command: 'ls -la' } }))
    r.on(ev({ type: 'tool_result', output: 'a\nb', exitCode: 0 }))
    r.on(ev({ type: 'tool_result', output: 'boom', exitCode: 1 }))
    expect(c.out_()).toContain('\x1b[36m$\x1b[0m ls -la')
    expect(c.out_()).toContain('\x1b[90ma\nb\n\x1b[0m')
    expect(c.out_()).toContain('（退出码 1）')
  })

  it('不认识的语言：原样返回不高亮，内容不丢', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_delta', text: '```no-such-lang\nhello\n```\n' }))
    r.on(ev({ type: 'text_end' }))
    expect(c.out_().replace(/\x1b\[[0-9;]*m/g, '')).toBe('```no-such-lang\nhello\n```\n\n')
  })

  it('高亮输出无残留 span 标签（嵌套与 title function_ 类名都转成 ANSI）', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_delta', text: '```ts\nconst s: string = "x"\nfunction add(a: number): number { return a }\n```\n' }))
    r.on(ev({ type: 'text_end' }))
    const raw = c.out_()
    expect(raw).not.toContain('<span')
    expect(raw).not.toContain('hljs-')
    // 剥色后内容逐字完整
    expect(raw.replace(/\x1b\[[0-9;]*m/g, '')).toContain('function add(a: number): number { return a }')
  })

  it('Markdown 行内渲染：标题 bold、加粗、行内 code、bullet（仅 tty）', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_delta', text: '## 结论\n这是**重点**，跑 `ls` 看\n- 第一项\n' }))
    r.on(ev({ type: 'text_end' }))
    const raw = c.out_()
    expect(raw).toContain('\x1b[1m## 结论\x1b[0m')
    expect(raw).toContain('\x1b[1m重点\x1b[0m')
    expect(raw).toContain('\x1b[7mls\x1b[0m')
    expect(raw).toContain('\x1b[36m•\x1b[0m 第一项')
  })

  it('非 tty：Markdown 全部原样（sc > file 零污染）', () => {
    const c = collector()
    const r = createRenderer(c, { out: false, err: false })
    const text = '## 结论\n这是**重点**，跑 `ls` 看\n- 第一项\n'
    r.on(ev({ type: 'text_delta', text }))
    r.on(ev({ type: 'text_end' }))
    expect(c.out_()).toBe(`${text}\n`)
  })

  it('表格：攒齐重放（流式 delta 劈开也不散架），中文列对齐', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    // 表格被劈在多个 delta 里，且中间隔了 text_end（qwen 流多段交替）
    r.on(ev({ type: 'text_delta', text: '结论：\n| 目录 | 内容 |\n| --- | --- |\n' }))
    r.on(ev({ type: 'text_end' }))
    r.on(ev({ type: 'text_delta', text: '| 广州资产POC | 尽调 |\n| 评测 | 报告 |\n' }))
    r.on(ev({ type: 'text_end' }))
    // 表格是最后一块：靠 done() 冲（与未闭合围栏同语义——块尾才重放）
    r.done()
    const raw = c.out_()
    // 前导行先出（不等表格），表格整块在后面
    expect(raw.indexOf('结论：')).toBeLessThan(raw.indexOf('┌'))
    expect(raw).toContain(`┌${'─'.repeat(13)}┬${'─'.repeat(6)}┐`)
    expect(raw).toContain('广州资产POC')
    // 攒表期间 text_end 的换行不插进表中间：框线后紧跟数据不空行
    expect(raw).not.toMatch(/┐\n\n/)
  })

  it('done 时表格兜底：凑齐的渲染、截断行内容不丢', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_delta', text: '| a | b |\n| --- | --- |\n| c |' }))
    r.on(ev({ type: 'text_end' }))
    r.done()
    const raw = c.out_()
    // 表头+分隔行已齐 → 按表格渲染（与流中触发的表格同效果）
    expect(raw).toContain('┌')
    expect(raw).toContain('a')
    expect(raw).toContain('c')
  })

  it('代码围栏内不做 Markdown 渲染（** 和 | 原样）', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'text_delta', text: '```sh\necho **not-bold** | grep x\n```\n' }))
    r.on(ev({ type: 'text_end' }))
    expect(c.out_()).not.toContain('\x1b[1m')
    expect(c.out_()).not.toContain('•')
  })
})

describe('bash 入参 desc 前置（2026-09-28）', () => {
  it('带 desc：青色短语 + 暗色 · + 命令；缺省维持现状', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'tool_call', name: 'bash', input: { command: 'npx vitest run', desc: '跑全量测试' } }))
    r.on(ev({ type: 'tool_call', name: 'bash', input: { command: 'ls' } }))
    expect(c.out_()).toContain('跑全量测试\x1b[0m \x1b[90m·\x1b[0m npx vitest run')
    expect(c.out_()).toContain('$\x1b[0m ls\n')
  })

  it('写成 description（glm 照官方 Bash 工具参数名）同样前置', () => {
    const c = collector()
    const r = createRenderer(c, { out: true, err: true })
    r.on(ev({ type: 'tool_call', name: 'bash', input: { command: 'ls', description: '列目录', timeout: 15 } }))
    expect(c.out_()).toContain('列目录\x1b[0m \x1b[90m·\x1b[0m ls')
  })
})
