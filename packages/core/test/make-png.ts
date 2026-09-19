import { crc32, deflateSync } from 'node:zlib'

/** 确定性 PRNG——夹具字节稳定，测试可复现 */
export function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 手写 RGB PNG（8bit、无 interlace）。不引图像库，夹具自包含。
 * 每行必须独立 buffer——共享引用会把「最后一行的值」复制 height 份，
 * 图变成高度重复的图案，deflate 压到 1%，测试前提就没了。
 */
export function makePng(width: number, height: number, rand: () => number): Buffer {
  const raw = Buffer.concat(
    Array.from({ length: height }, () => {
      const row = Buffer.alloc(1 + width * 3) // filter byte 0 + RGB
      for (let i = 1; i < row.length; i++) row[i] = (rand() * 256) | 0
      return row
    }),
  )
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = crc32(body)
    return Buffer.concat([
      Buffer.from([data.length >>> 24, data.length >>> 16, data.length >>> 8, data.length]),
      body,
      Buffer.from([crc >>> 24, crc >>> 16, crc >>> 8, crc]),
    ])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
