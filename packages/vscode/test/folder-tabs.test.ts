// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderState } from '../src/protocol.ts'
import { FolderTabs } from '../webview/controls.tsx'
import { post } from '../webview/vscode.ts'

/**
 * 文件夹平铺 tab 的接线与渲染。
 *
 * jsdom 没有布局（offsetWidth 恒 0、无 ResizeObserver），measure 会
 * 退化成「全平铺、无溢出」——正好测主路径：tab 渲染、active 高亮、
 * running 点、单击发出 switchFolder。溢出折叠那半边依赖真实布局，
 * 这里测不了（无头 Chrome 复刻页验证，见 webview-shot skill）。
 */

vi.mock('../webview/vscode.ts', () => ({ post: vi.fn() }))

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  vi.mocked(post).mockClear()
})

const folder = (path: string, running = false, pendingApprovals = 0): FolderState => ({
  path,
  running,
  pendingApprovals,
})

function mount(folders: FolderState[], active: string) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(FolderTabs, { folders, active })))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return host
}

describe('平铺 tab 渲染', () => {
  it('每个文件夹一个 tab，active 的带高亮类', () => {
    const host = mount(
      [folder('/w/a'), folder('/w/b'), folder('/w/c')],
      '/w/b',
    )
    const tabs = [...host.querySelectorAll('.folder-tab')]
    expect(tabs.map((t) => t.textContent)).toEqual(['a', 'b', 'c'])
    expect(tabs[1]?.className).toContain('active')
    expect(tabs[0]?.className).not.toContain('active')
  })

  it('跑着的文件夹带状态点，静态的不带', () => {
    const host = mount(
      [folder('/w/a', true), folder('/w/b')],
      '/w/a',
    )
    const dots = [...host.querySelectorAll('.folder-tab .tab-dot')]
    expect(dots).toHaveLength(1)
    expect(dots[0]?.getAttribute('aria-label')).toBe('跑着')
  })
})

describe('单击切换接线', () => {
  it('点 tab 发出 switchFolder，不带弹层', () => {
    const host = mount([folder('/w/a'), folder('/w/b')], '/w/a')
    const before = vi.mocked(post).mock.calls.length
    act(() => {
      host.querySelectorAll('.folder-tab')[1]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    const calls = vi.mocked(post).mock.calls
    expect(calls.length).toBe(before + 1)
    expect(calls.at(-1)?.[0]).toEqual({ type: 'switchFolder', folder: '/w/b' })
    // 平铺直点：不经过 Menu，DOM 里不该有弹层
    expect(host.querySelector('.menu')).toBeNull()
  })
})

describe('溢出折叠（mock 宽度）', () => {
  // tab 各 100px、容器 250px → 放得下 2 个。jsdom 布局恒 0，这里
  // defineProperty 造出来；测的是 measure 的分区逻辑，不是真实排版
  const WIDE = 250
  let restore: (() => void) | null = null
  const install = () => {
    const off = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    const cli = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLButtonElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => 100,
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => WIDE,
    })
    restore = () => {
      Reflect.deleteProperty(HTMLButtonElement.prototype, 'offsetWidth')
      if (off) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', off)
      if (cli) Object.defineProperty(HTMLElement.prototype, 'clientWidth', cli)
    }
  }
  afterEach(() => {
    restore?.()
    restore = null
  })

  it('放不下的折进「»」，激活的从溢出区提升到平铺末位', () => {
    install()
    const host = mount(
      [folder('/w/a'), folder('/w/b'), folder('/w/c'), folder('/w/d')],
      '/w/d',
    )
    // 溢出菜单的触发器存在（还有折进去的）
    expect(host.querySelector('.folder-overflow')).not.toBeNull()
    // 平铺区：a、d。d 是 active 从溢出区提升，b（平铺末位）给它让位
    // 挤下去——active 必须可见，代价只摊到末位这一个 tab
    const tabs = [...host.querySelectorAll('.folder-tab:not(.tab-shadow)')]
    expect(tabs.map((t) => t.textContent)).toEqual(['a', 'd'])
    // 影子测量层承载被挤下的 b、c：不显示但可测宽（拖宽回来的数据源）
    const shadows = [...host.querySelectorAll('.folder-tab.tab-shadow')]
    expect(shadows.map((t) => t.textContent)).toEqual(['c', 'b'])
    expect(shadows[0]?.getAttribute('aria-hidden')).toBe('true')
  })

  it('active 在平铺区时不换位——位置稳定（肌肉记忆）', () => {
    install()
    const host = mount(
      [folder('/w/a'), folder('/w/b'), folder('/w/c'), folder('/w/d')],
      '/w/b',
    )
    const tabs = [...host.querySelectorAll('.folder-tab:not(.tab-shadow)')]
    expect(tabs.map((t) => t.textContent)).toEqual(['a', 'b'])
  })
})
