import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { bracketPaste, type PasteBox } from '../src/paste.ts'

const collect = async (box: PasteBox, chunks: string[]): Promise<string> => {
  const src = new PassThrough()
  const t = bracketPaste(src, box)
  let out = ''
  t.on('data', (d: Buffer) => (out += d.toString()))
  for (const c of chunks) src.write(c)
  src.end()
  await new Promise((r) => t.on('end', r))
  return out
}

const box = (): PasteBox & { arrived: string[] } => {
  const arrived: string[] = []
  return {
    pending: null,
    onArrive: (text) => arrived.push(text),
    get arrived() {
      return arrived
    },
  }
}

describe('bracketPaste', () => {
  it('整段包裹：readline 侧零字节，pending 收全文', async () => {
    const b = box()
    const out = await collect(b, ['\x1b[200~line1\nline2\nline3\x1b[201~'])
    expect(out).toBe('')
    expect(b.pending).toBe('line1\nline2\nline3')
  })

  it('包裹前后的手敲数据原样透传', async () => {
    const b = box()
    const out = await collect(b, ['hi\n\x1b[200~pasted\x1b[201~\nbye\n'])
    expect(out).toBe('hi\n\nbye\n') // 粘贴段被吞，前后手敲完整保留
    expect(b.pending).toBe('pasted')
  })

  it('序列跨 chunk 分裂也能识别', async () => {
    const b = box()
    const out = await collect(b, ['\x1b[2', '00~abc', '\x1b[2', '01~', 'tail'])
    expect(out).toBe('tail')
    expect(b.pending).toBe('abc')
  })

  it('EOF 没等闭合：半段交付，不吞输入', async () => {
    const b = box()
    const out = await collect(b, ['\x1b[200~partial'])
    expect(out).toBe('')
    expect(b.pending).toBe('partial')
  })

  it('无序列的流一字不动（不开 bp 的终端/管道不受影响）', async () => {
    const b = box()
    const out = await collect(b, ['普通输入\n\x1b[1A 光标键也照过\n'])
    expect(out).toBe('普通输入\n\x1b[1A 光标键也照过\n')
    expect(b.pending).toBeNull()
  })

  it('空粘贴（只有一对序列）不当回事', async () => {
    const b = box()
    const out = await collect(b, ['\x1b[200~\x1b[201~x\n'])
    expect(out).toBe('x\n')
    expect(b.pending).toBeNull()
  })
})
