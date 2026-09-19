import { describe, expect, it } from 'vitest'
import { type MenuOption, rowsOf } from '../webview/menu.tsx'

/**
 * rowsOf：选项序列 → 渲染行序列（相邻同 section 只出一条节头）。
 * 这是渲染里唯一有逻辑的地方，抽成纯函数就是为了这里能测——内联在 JSX
 * 里的话每次改动都得真机看一眼节头有没有重复
 */

const opt = (key: string, section?: string): MenuOption<number> => ({
  key,
  label: key,
  ...(section === undefined ? {} : { section }),
  selected: false,
  payload: 0,
})

const shape = (options: MenuOption<number>[]) =>
  rowsOf(options).map((r) => ('head' in r ? `#${r.head}` : r.opt.key))

describe('rowsOf', () => {
  it('没有 section 就没有节头', () => {
    expect(shape([opt('a'), opt('b'), opt('c')])).toEqual(['a', 'b', 'c'])
  })

  it('相邻同 section 只出一条节头', () => {
    expect(shape([opt('a', 'p'), opt('b', 'p'), opt('c', 'q')])).toEqual([
      '#p',
      'a',
      'b',
      '#q',
      'c',
    ])
  })

  it('section 交错重复出现就重复出头（p q p = 三条）', () => {
    expect(shape([opt('a', 'p'), opt('b', 'q'), opt('c', 'p')])).toEqual([
      '#p',
      'a',
      '#q',
      'b',
      '#p',
      'c',
    ])
  })

  it('at 永远等于该选项在原数组里的下标（键盘导航靠它索引 payload）', () => {
    const rows = rowsOf([opt('a', 'p'), opt('b', 'p'), opt('c', 'q')])
    // 节头行不是选项，占位 null——下标在节头之间仍然连续、对应原数组
    expect(rows.map((r) => ('opt' in r ? r.at : null))).toEqual([null, 0, 1, null, 2])
  })
})
