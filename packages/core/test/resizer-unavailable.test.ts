import { describe, expect, it, vi } from 'vitest'

// photon 整包加载失败（wasm 缺失/架构不符）——resizer 应当退化成「图原样放行」，
// 而不是让请求炸掉。这个文件单独 mock，不和 resizer.test.ts 共享模块状态
vi.mock('@silvia-odwyer/photon-node', () => {
  throw new Error('wasm not available')
})

describe('resizer 不可用时', () => {
  it('所有图原样放行', async () => {
    const { resizeImageParts } = await import('../src/llm/resizer')
    const part = { type: 'image' as const, data: 'garbage!', mimeType: 'image/png' }
    const [msg] = await resizeImageParts([{ role: 'user', parts: [part] }])
    expect(msg?.parts[0]).toBe(part)
  })
})
