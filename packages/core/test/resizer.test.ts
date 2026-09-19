import { describe, expect, it } from 'vitest'
import { type Photon, resizeImageParts, stripImagesWhenUnsupported, thumbnailDataUrl } from '../src/llm/resizer'
import type { ImagePart, Message, Part } from '../src/llm/types'
import { makePng, mulberry32 } from './make-png'

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const text = (t: string): Part => ({ type: 'text', text: t })
const image = (data: string, mimeType = 'image/png'): ImagePart => ({
  type: 'image',
  data,
  mimeType,
})

/** 解包第一条消息的第一个 part——输入是测试手拼的，长度恒 1 */
async function firstPart(parts: Part[]) {
  const [msg] = await resizeImageParts([{ role: 'user', parts }])
  const part = msg?.parts[0]
  if (!part) throw new Error('no part')
  return part
}

describe('resizeImageParts', () => {
  it('小图原样放行——不重编码、对象同一', async () => {
    const part = image(tinyPng.toString('base64'))
    expect(await firstPart([part])).toBe(part)
  })

  it('超边的图缩进 2048 并重编码为 JPEG，detail 透传', async () => {
    const big = makePng(2100, 2100, mulberry32(42)).toString('base64')
    const out = await firstPart([{ ...image(big), detail: 'high' }])
    expect(out.type).toBe('image')
    if (out.type !== 'image') return
    expect(out.mimeType).toBe('image/jpeg')
    expect(Buffer.byteLength(out.data, 'utf-8')).toBeLessThanOrEqual(5 * 1024 * 1024)
    expect(out.detail).toBe('high')
    // decode 回来看边长——锁「缩进 2048」的语义，不靠字节长度猜
    const photon = (await import('@silvia-odwyer/photon-node')) as unknown as Photon
    const decoded = photon.PhotonImage.new_from_byteslice(
      new Uint8Array(Buffer.from(out.data, 'base64')),
    )
    expect(Math.max(decoded.get_width(), decoded.get_height())).toBeLessThanOrEqual(2048)
    decoded.free()
  })

  it('非图片字节换占位符，请求不炸', async () => {
    expect(await firstPart([image(Buffer.from('hello, not an image').toString('base64'))])).toEqual(
      {
        type: 'text',
        text: expect.stringMatching(/^\[image omitted:/),
      },
    )
  })

  it('文本与 tool part 不动，多消息只改带图那条', async () => {
    const textMsg = { role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] }
    const imgMsg = { role: 'user' as const, parts: [image(Buffer.from('x').toString('base64'))] }
    const out = await resizeImageParts([textMsg, imgMsg])
    expect(out[0]).toBe(textMsg)
    expect(out[1]?.parts[0]?.type).toBe('text') // 占位符，不是图片
  })
})

describe('thumbnailDataUrl', () => {
  it('出 256px JPEG data URL', async () => {
    const big = makePng(1024, 768, mulberry32(7)).toString('base64')
    const url = await thumbnailDataUrl({ type: 'image', data: big, mimeType: 'image/png' })
    const PREFIX = 'data:image/jpeg;base64,'
    expect(url?.startsWith(PREFIX)).toBe(true)
    if (!url) return
    const photon = (await import('@silvia-odwyer/photon-node')) as unknown as Photon
    const decoded = photon.PhotonImage.new_from_byteslice(
      new Uint8Array(Buffer.from(url.slice(PREFIX.length), 'base64')),
    )
    expect(Math.max(decoded.get_width(), decoded.get_height())).toBeLessThanOrEqual(256)
    decoded.free()
  })

  it('垃圾字节返回 undefined，不抛', async () => {
    const url = await thumbnailDataUrl({
      type: 'image',
      data: Buffer.from('nope').toString('base64'),
      mimeType: 'image/png',
    })
    expect(url).toBeUndefined()
  })
})

describe('stripImagesWhenUnsupported', () => {
  it('不支持时图换成占位文本，数量不变', () => {
    const [msg] = stripImagesWhenUnsupported(
      [{ role: 'user', parts: [text('看这张'), image(tinyPng.toString('base64'))] }],
      { images: false },
    )
    expect(msg?.parts).toHaveLength(2)
    expect(msg?.parts[1]).toMatchObject({ type: 'text' })
    expect((msg?.parts[1] as { text?: string }).text).toContain('不支持图片')
  })

  it('支持时原样返回——同一引用，不复制', () => {
    const input: Message[] = [
      { role: 'user', parts: [text('看这张'), image(tinyPng.toString('base64'))] },
    ]
    expect(stripImagesWhenUnsupported(input, { images: true })).toBe(input)
  })

  it('captions 命中的图换成转述文本，miss（含空串失败态）落占位符', () => {
    const [msg] = stripImagesWhenUnsupported(
      [
        {
          role: 'user',
          parts: [
            text('看这两张'),
            image('D-RELAYED'),
            image('D-MISSED'),
            image('D-FAILED'),
          ],
        },
      ],
      { images: false },
      new Map([
        ['D-RELAYED', '[视觉转述] 图里是一个红方块'],
        ['D-FAILED', ''], // relay 失败存 ''：不算转述，兜底占位
      ]),
    )
    expect((msg?.parts[1] as { text: string }).text).toBe('[视觉转述] 图里是一个红方块')
    expect((msg?.parts[2] as { text: string }).text).toContain('不支持图片')
    expect((msg?.parts[3] as { text: string }).text).toContain('不支持图片')
  })
})

describe('tool_result 附图（洞①②回归：字段不是 part，曾被 strip/resize 双双漏掉）', () => {
  const toolPart = (images: ImagePart[]): Part =>
    ({ type: 'tool_result', toolCallId: 't1', output: '图片 image/png，10 字节', isError: false, images })

  it('strip：不支持时 images 消失，占位进 output（每张一行）', () => {
    const [msg] = stripImagesWhenUnsupported(
      [{ role: 'tool', parts: [toolPart([image('AAA'), image('BBB')])] }],
      { images: false },
    )
    const part = msg?.parts[0] as { images?: unknown } | undefined
    expect(part?.images).toBeUndefined()
    expect(part && 'output' in part ? part.output : '').toContain('[图片已省略：当前模型不支持图片输入]')
    expect((part as { output: string }).output.match(/图片已省略/g)).toHaveLength(2)
  })

  it('resize：超边大图压成 jpeg 挂回 images', async () => {
    // 2400px 超过 2048 边线——shrinkPart 必须重编码，data 必变
    const big = makePng(2400, 100, mulberry32(3)).toString('base64')
    const [msg] = await resizeImageParts([
      { role: 'tool', parts: [toolPart([{ type: 'image', data: big, mimeType: 'image/png' }])] },
    ])
    const part = msg?.parts[0]
    const imgs = part && 'images' in part ? part.images : undefined
    expect(imgs?.length).toBe(1)
    expect(imgs?.[0]?.mimeType).toBe('image/jpeg')
    expect(imgs?.[0]?.data).not.toBe(big)
  })

  it('resize：垃圾字节图换成 output 注脚，images 字段删掉', async () => {
    const junk = Buffer.from('not an image').toString('base64')
    const [msg] = await resizeImageParts([
      { role: 'tool', parts: [toolPart([{ type: 'image', data: junk, mimeType: 'image/png' }])] },
    ])
    const part = msg?.parts[0] as { images?: unknown; output?: string } | undefined
    expect(part?.images).toBeUndefined()
    expect(part?.output).toContain('image omitted')
  })
})
