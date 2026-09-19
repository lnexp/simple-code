// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * user 消息带图的**接线**（copy-wiring 同款立场）。数据链路（hydrateItems
 * 收图、pendingUser 带图）早就通，App 的 case 'user' 此前只渲 text——贴过
 * 的图在聊天记录里无迹可查。从最外层驱动：hydrate 一条带图 user → 断言
 * .user-images img 的 src 是 data URL。96px 尺寸是 CSS 的（jsdom 不算
 * 样式），这里只断 DOM 结构
 */

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
})

function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return {
    send: (msg: ToWebview) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: msg }))
      }),
  }
}

describe('user 消息图片渲染', () => {
  it('带图 user 渲染缩略图，src 是 data URL', () => {
    const { send } = mount()
    send({
      type: 'hydrate',
      items: [
        {
          kind: 'user',
          text: '这张图怎么修',
          images: [{ mimeType: 'image/png', data: 'aVBORw0KGgo=' }],
        },
      ],
    } satisfies ToWebview)
    const img = document.querySelector<HTMLImageElement>('.user-images img')
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,aVBORw0KGgo=')
  })

  it('不带图的 user 不出 .user-images 空壳', () => {
    const { send } = mount()
    send({ type: 'hydrate', items: [{ kind: 'user', text: '纯文字' }] } satisfies ToWebview)
    expect(document.querySelector('.user-images')).toBeNull()
  })
})

describe('缩略图点击放大（lightbox）', () => {
  const PNG = 'iVBORw0KGgo='

  it('点 user 缩略图开浮层，显示原图，点浮层空白处关闭', () => {
    const { send } = mount()
    send({
      type: 'hydrate',
      items: [{ kind: 'user', text: '看图', images: [{ mimeType: 'image/png', data: PNG }] }],
    })
    // 前提：缩略图在，且带 data-zoom（App 根级委托靠它识别）
    const thumb = document.querySelector('.user-images img[data-zoom]')
    expect(thumb?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)

    act(() => thumb?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const box = document.querySelector('.lightbox img')
    expect(box?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)

    // 点浮层空白处（img 之外的 div）关闭。stopPropagation 挡的是点图本身
    act(() =>
      document
        .querySelector('.lightbox')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    expect(document.querySelector('.lightbox')).toBeNull()
  })

  it('点浮层里的图不关闭——stopPropagation 在 img 上', () => {
    const { send } = mount()
    send({
      type: 'hydrate',
      items: [{ kind: 'user', text: '看图', images: [{ mimeType: 'image/png', data: PNG }] }],
    })
    const thumb = document.querySelector('.user-images img[data-zoom]')
    act(() => thumb?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const box = document.querySelector('.lightbox img')
    expect(box).not.toBeNull() // 前提：浮层开着

    act(() => box?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.querySelector('.lightbox')).not.toBeNull() // 还开着
  })

  it('Esc 关闭', () => {
    const { send } = mount()
    send({
      type: 'hydrate',
      items: [{ kind: 'user', text: '看图', images: [{ mimeType: 'image/png', data: PNG }] }],
    })
    act(() =>
      document
        .querySelector('.user-images img[data-zoom]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    const box = document.querySelector('.lightbox')
    expect(box).not.toBeNull()
    act(() => box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('.lightbox')).toBeNull()
  })
})
