import { describe, expect, it } from 'vitest'
import { makePaint } from '../src/colors.ts'
import { renderInline, renderTable, wcwidth } from '../src/markdown.ts'

const tty = makePaint(true)
const plain = makePaint(false)

describe('wcwidth（表格对齐的地基）', () => {
  it('ASCII 1、CJK/全角 2、常用 emoji 2', () => {
    expect(wcwidth('abc')).toBe(3)
    expect(wcwidth('中文')).toBe(4)
    expect(wcwidth('，。')).toBe(4) // 全角标点
    expect(wcwidth('🎉')).toBe(2)
    expect(wcwidth('a中b')).toBe(4)
  })
})

describe('renderInline（单行）', () => {
  it('非 tty：全部原样，零色码', () => {
    expect(renderInline('## 标题 **加粗** `code`\n', plain)).toBe('## 标题 **加粗** `code`\n')
  })
  it('标题整行 bold、分隔线 dim（# 原样保留——层级是内容）', () => {
    expect(renderInline('## 标题\n', tty)).toBe('\x1b[1m## 标题\x1b[0m\n')
    expect(renderInline('---\n', tty)).toBe('\x1b[90m---\x1b[0m\n')
  })
  it('加粗/行内 code/列表 bullet', () => {
    expect(renderInline('这是**重点**吗\n', tty)).toBe('这是\x1b[1m重点\x1b[0m吗\n')
    expect(renderInline('跑 `ls -la` 看看\n', tty)).toBe('跑 \x1b[7mls -la\x1b[0m 看看\n')
    expect(renderInline('  - 第一项\n', tty)).toBe('  \x1b[36m•\x1b[0m 第一项\n')
  })
  it('普通文本原样（含 | 的非表格行、链接原文可复制）', () => {
    expect(renderInline('a | b 或然\n', tty)).toBe('a | b 或然\n')
    expect(renderInline('见 [文档](https://x)\n', tty)).toBe('见 [文档](https://x)\n')
  })
})

describe('renderTable（整块）', () => {
  const md = ['| 目录 | 内容 |\n', '| --- | --- |\n', '| 广州资产POC | 尽调 |\n', '| 评测 | 报告 |\n']
  // （非 tty 的零污染由挂载层保证——render.ts 只在 tty.out 时调
  // renderTable/renderInline，见 render.test.ts 的管道用例）
  it('tty：框线重画，表头 bold，列宽按显示宽对齐（中文 2）', () => {
    const out = renderTable(md, tty)
    // 列宽：col1 = max(目录4, 广州资产POC 8+3=11) → 13 dash；col2 = max(内容4, 尽调4) → 6
    expect(out).toContain(`\x1b[90m┌${'─'.repeat(13)}┬${'─'.repeat(6)}┐\x1b[0m`)
    expect(out).toContain('\x1b[1m')
    expect(out).toContain('广州资产POC')
  })
  it('不像表格（无分隔行）不硬渲染：原样返回', () => {
    expect(renderTable(['| 就一行 |\n'], tty)).toBe('| 就一行 |\n')
    expect(renderTable(['| a | b |\n', '| c | d |\n'], tty)).toBe('| a | b |\n| c | d |\n')
  })
  it('短行缺列补空占位、cell 内加粗不挤歪（pad 按纯文本宽）', () => {
    const out = renderTable(['| a | b |\n', '| --- | --- |\n', '| **长项** |\n'], tty)
    // 长项 bold 后色码不占宽，第二列空占位
    expect(out).toContain('\x1b[1m长项\x1b[0m')
    expect(out).not.toContain('undefined')
  })
})
