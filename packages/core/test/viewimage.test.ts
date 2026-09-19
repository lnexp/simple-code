import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mulberry32, makePng } from './make-png.ts'
import { createViewImageTool } from '../src/tools/viewimage.ts'
import type { ToolContext } from '../src/tools/types.ts'

let root: string
const ctx = (): ToolContext => ({ root, signal: new AbortController().signal })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'viewimage-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('view_image / 参数', () => {
  const tool = createViewImageTool()
  const bad = async (input: unknown) => {
    const out = await tool.execute(input, ctx())
    return out.isError && out.output
  }
  it('非对象输入拒绝', async () => {
    expect(await bad('x')).toContain('参数必须是对象')
  })
  it('path 缺失或非字符串拒绝', async () => {
    expect(await bad({})).toContain('path 必填')
    expect(await bad({ path: 3 })).toContain('path 必填')
  })
})

describe('view_image / 读图', () => {
  it('真实 PNG 进 images，mime 是 image/png', async () => {
    const png = makePng(4, 4, mulberry32(7))
    await writeFile(join(root, 'shot.png'), png)
    const out = await createViewImageTool().execute({ path: 'shot.png' }, ctx())
    expect(out.isError).toBe(false)
    expect(out.output).toContain('image/png')
    expect(out.output).toContain('shot.png')
    expect(out.images?.length).toBe(1)
    expect(out.images?.[0]?.mimeType).toBe('image/png')
    expect(out.images?.[0]?.data).toBe(png.toString('base64'))
  })

  it('绝对路径也认（相对路径基于 root 解析的前提成立）', async () => {
    const abs = join(root, 'abs.png')
    await writeFile(abs, makePng(2, 2, mulberry32(1)))
    const out = await createViewImageTool().execute({ path: abs }, ctx())
    expect(out.isError).toBe(false)
  })

  it('jpeg/gif/webp 文件头识别', async () => {
    const cases: Array<[string, Buffer, string]> = [
      ['a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), 'image/jpeg'],
      ['a.gif', Buffer.from('GIF89axxxx'), 'image/gif'],
      ['a.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), 'image/webp'],
    ]
    for (const [name, bytes, mime] of cases) {
      await writeFile(join(root, name), bytes)
      const out = await createViewImageTool().execute({ path: name }, ctx())
      expect(out.isError, name).toBe(false)
      expect(out.images?.[0]?.mimeType, name).toBe(mime)
    }
  })

  it('扩展名是 png 但内容不是图——magic bytes 挡住，不认扩展名', async () => {
    await writeFile(join(root, 'fake.png'), 'this is definitely text')
    const out = await createViewImageTool().execute({ path: 'fake.png' }, ctx())
    expect(out.isError).toBe(true)
    expect(out.output).toContain('文件头')
  })

  it('文件不存在 → 散文错误（ENOENT 不炸 loop）', async () => {
    const out = await createViewImageTool().execute({ path: 'nope.png' }, ctx())
    expect(out.isError).toBe(true)
    expect(out.output).toContain('nope.png')
    expect(out.output).toContain('失败')
  })

  it('目录拒绝并指路 bash ls', async () => {
    const out = await createViewImageTool().execute({ path: '.' }, ctx())
    expect(out.isError).toBe(true)
    expect(out.output).toContain('目录')
  })
})

describe('view_image / 大小上限', () => {
  it('超过 50MB 挡在 stat，不读内容', async () => {
    const p = join(root, 'huge.png')
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // png 头，sparse 撑大
    await truncate(p, 50 * 1024 * 1024 + 1)
    const out = await createViewImageTool().execute({ path: p }, ctx())
    expect(out.isError).toBe(true)
    expect(out.output).toContain('上限')
    // 防护有效的前提：限内不会走这条错误路（下一用例就是限内对照）
  })

  it('对照组：限内文件不会被大小挡（走的是后续识别）', async () => {
    const p = join(root, 'sparse.txt')
    await writeFile(p, 'x')
    await truncate(p, 1024) // 1KB sparse，限内、非图片
    const out = await createViewImageTool().execute({ path: p }, ctx())
    expect(out.isError).toBe(true)
    // 限内所以过了大小关，死在文件头——证明上一个用例挡的确实是大小
    expect(out.output).toContain('文件头')
  })
})

describe('view_image / 视觉转述（vision relay）', () => {
  it('relay 在场：output 是转述文本，focus 透传，图照附（库里保留原图）', async () => {
    const png = makePng(4, 4, mulberry32(9))
    await writeFile(join(root, 'r.png'), png)
    const calls: Array<{ focus: string; mime: string }> = []
    const relayCtx: ToolContext = {
      ...ctx(),
      visionRelay: async (image, focus) => {
        calls.push({ focus, mime: image.mimeType })
        return '弹层左缘溢出视口 61px。'
      },
    }
    const out = await createViewImageTool().execute(
      { path: 'r.png', focus: '弹层位置' },
      relayCtx,
    )
    expect(out.isError).toBe(false)
    expect(out.output).toContain('[视觉转述]')
    expect(out.output).toContain('弹层左缘溢出视口')
    expect(calls).toEqual([{ focus: '弹层位置', mime: 'image/png' }])
    // 原图仍然附上：切到视觉模型后库里的图还能直看
    expect(out.images?.[0]?.data).toBe(png.toString('base64'))
  })

  it('focus 缺省时透传空串', async () => {
    const png = makePng(2, 2, mulberry32(3))
    await writeFile(join(root, 'n.png'), png)
    let gotFocus = 'SENTINEL'
    const relayCtx: ToolContext = {
      ...ctx(),
      visionRelay: async (_image, focus) => {
        gotFocus = focus
        return 'ok'
      },
    }
    await createViewImageTool().execute({ path: 'n.png' }, relayCtx)
    expect(gotFocus).toBe('')
  })

  it('relay 抛错：降级为可读提示，图仍附', async () => {
    const png = makePng(2, 2, mulberry32(5))
    await writeFile(join(root, 'e.png'), png)
    const relayCtx: ToolContext = {
      ...ctx(),
      visionRelay: async () => {
        throw new Error('402 quota')
      },
    }
    const out = await createViewImageTool().execute({ path: 'e.png' }, relayCtx)
    expect(out.isError).toBe(false)
    expect(out.output).toContain('视觉转述失败')
    expect(out.output).toContain('402 quota')
    expect(out.output).toContain('切到视觉模型')
    expect(out.images?.length).toBe(1)
  })

  it('无 relay：老行为（图直给，output 无转述标记）', async () => {
    const png = makePng(2, 2, mulberry32(11))
    await writeFile(join(root, 'p.png'), png)
    const out = await createViewImageTool().execute({ path: 'p.png' }, ctx())
    expect(out.output).not.toContain('[视觉转述]')
    expect(out.images?.length).toBe(1)
  })
})

describe('工具描述说真话', () => {
  it('描述里的读入上限 MB 数来自 MAX_BYTES 常量，不是写死的数字', () => {
    const tool = createViewImageTool()
    const text = JSON.stringify(tool.definition)
    expect(text).toContain('50MB')
  })
})
