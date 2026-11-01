// 线条与面板边框在「面板色 = 页面底色」的主题里也要看得见。
// IntelliJ IDEA New UI Dark：--vscode-panel-border = 页面底色 #1e1f22，
// 用它画的表格横线、分隔线、引用竖线、工具输出框、上下文面板全部消失
// （2026-10-29 实测 computed 颜色与外层底色相同）。
import { describe, expect, it } from 'vitest'
import { STYLE } from '../src/style.ts'

/** 取某个选择器（整段相等）的全部声明，多条同名规则拼在一起 */
const rule = (sel: string): string =>
  STYLE.split('}')
    .filter(
      (chunk) =>
        chunk
          .split('{')[0]
          ?.replace(/\/\*[\s\S]*?\*\//g, '')
          .trim() === sel,
    )
    .map((chunk) => chunk.split('{')[1] ?? '')
    .join(';')

const LINES = [
  '.markdown blockquote',
  '.markdown th, .markdown td',
  '.markdown hr',
  '.tool-body[data-open="true"]',
  '.tool-body[data-open="true"] .tool-cmd-full:not(:last-child)',
  '.tl-thinks',
  '.ctx-panel',
  '.ctx-compact',
]

describe('线条颜色不依赖 panel-border', () => {
  for (const sel of LINES) {
    it(sel, () => {
      const body = rule(sel)
      expect(body).not.toBe('')
      expect(body).not.toContain('--vscode-panel-border')
      expect(body).toMatch(/border[\w-]*:[^;]*color-mix\(in srgb, var\(--vscode-foreground\)/)
    })
  }
})

// 2026-10-29 第二批（用户看过 IDEA 主题改前/改后对比图后拍板全改）：分割线、
// 后台进程条、贴图与文件块、图片框、思考竖线、代码块、继续按钮、转圈底圈
it('样式里不再引用 panel-border', () => {
  const code = STYLE.replace(/\/\*[\s\S]*?\*\//g, '')
  expect(code.match(/[^\n]*var\(--vscode-panel-border[^\n]*/g) ?? []).toEqual([])
})
