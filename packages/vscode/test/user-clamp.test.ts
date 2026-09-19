// @vitest-environment jsdom
/**
 * UserBubble 折叠状态机。jsdom 无 layout，scrollHeight/clientHeight 全 0，
 * mock 成 600/300 造「溢出」。曾出的 bug：展开后 effect 重测恒不溢出 →
 * clamped=false → 按钮连同「收起」入口一起消失，展开就收不回去了
 */
import { act } from 'react'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { UserBubble } from '../webview/App.tsx'

const LONG = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行`).join('\n')

beforeAll(() => {
  // 按内容长度模拟 layout：>100 字符的气泡视作溢出（600>300），
  // 短文本不溢出（300==300）
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return (this.textContent?.length ?? 0) > 100 ? 600 : 300
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 300,
  })
})

describe('UserBubble 折叠状态机', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
    root = null
  })

  const renderBubble = async (text: string): Promise<HTMLElement> => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const r = root
    await act(() => r.render(createElement(UserBubble, { text })))
    return container
  }

  it('长文本出「展开 N 行」，展开后按钮变为「收起」且不消失，再点收回', async () => {
    const container = await renderBubble(LONG)
    const btn = container.querySelector<HTMLButtonElement>('.user-toggle')
    expect(btn?.textContent).toBe('展开 30 行')

    await act(() => btn?.click())
    const btn2 = container.querySelector<HTMLButtonElement>('.user-toggle')
    // 旧 bug 在这：展开后 clamped 被重测抹掉，按钮整个消失
    expect(btn2?.textContent).toBe('收起')

    await act(() => btn2?.click())
    const btn3 = container.querySelector<HTMLButtonElement>('.user-toggle')
    expect(btn3?.textContent).toBe('展开 30 行')
  })

  it('短文本无按钮', async () => {
    const container = await renderBubble('就一行')
    expect(container.querySelector('.user-toggle')).toBeNull()
  })
})
