import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSSE } from '../src/llm/protocols/utils/sse.ts'

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

const collect = async (bytes: Uint8Array, chunkSize: number) => {
  const out = []
  for await (const msg of parseSSE(chunked(bytes, chunkSize))) out.push(msg)
  return out
}

const enc = (s: string) => new TextEncoder().encode(s)
const DONE_LITERAL = '[DONE]'

describe('parseSSE', () => {
  it('解析 event + data 对，空行分隔', async () => {
    const msgs = await collect(enc('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'), 1024)
    expect(msgs).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
  })

  it('忽略注释行，但不吞掉它所在的 message', async () => {
    const msgs = await collect(enc(': heartbeat\nevent: a\n: mid\ndata: 1\n\n'), 1024)
    expect(msgs).toEqual([{ event: 'a', data: '1' }])
  })

  it('[DONE] 终止流，其后的内容不再产出', async () => {
    const msgs = await collect(enc('data: 1\n\ndata: [DONE]\n\ndata: 2\n\n'), 1024)
    // 哨兵以结构化形态（done: true）外传给协议层做断流校验，
    // 但其后（data: 2）不再产出
    expect(msgs[1]?.done).toBe(true)
    expect(msgs.filter((m) => m.data)).toEqual([{ event: '', data: '1' }])
  })

  it('末尾没有空行时不丢最后一条', async () => {
    // 这种丢失不会报错，只会行为不对——所以必须有用例
    const msgs = await collect(enc('data: 1\n\ndata: 2'), 1024)
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toEqual({ event: '', data: '2' })
  })

  it('多行 data 用 \\n 连接', async () => {
    const msgs = await collect(enc('data: a\ndata: b\n\n'), 1024)
    expect(msgs).toEqual([{ event: '', data: 'a\nb' }])
  })

  it('只跳过冒号后的一个空格', async () => {
    const msgs = await collect(enc('data:  x\n\n'), 1024)
    expect(msgs[0]?.data).toBe(' x')
  })
})

describe('parseSSE 对真实录制的 fixture', () => {
  it('anthropic：31 行里含心跳注释，仍解析出完整事件序列', async () => {
    const bytes = await fixture('anthropic-messages.tool-call.sse')

    // 先证明前提成立：这份 fixture 确实含注释行，否则「忽略注释」根本没被测到
    expect(bytes.toString('utf8')).toContain('\n: gateway-keepalive')

    const msgs = await collect(bytes, 1 << 20)
    expect(msgs.map((m) => m.event)).toEqual([
      'message_start',
      'content_block_start',
      'ping',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    // 每条 data 都是完整 JSON——分片切在 JSON 字符串字面量中间时最容易在这里露馅
    for (const m of msgs) expect(() => JSON.parse(m.data)).not.toThrow()
  })

  it('openai-chat：没有 event 字段，以 [DONE] 收尾', async () => {
    const bytes = await fixture('openai-chat.tool-call.sse')
    expect(bytes.toString('utf8')).toContain('data: [DONE]')

    const msgs = await collect(bytes, 1 << 20)
    expect(msgs.every((m) => m.event === '')).toBe(true)
    // 哨兵以 done: true 外传（chat 协议靠它判「完整结束 vs 断流」），
    // 裸 [DONE] 字符串本身不外传
    expect(msgs.some((m) => m.done === true)).toBe(true)
    expect(msgs.some((m) => m.data === DONE_LITERAL)).toBe(false)
    for (const m of msgs) {
      if (m.done === undefined) expect(() => JSON.parse(m.data)).not.toThrow()
    }
  })

  it('openai-responses：event 字段齐全', async () => {
    const msgs = await collect(await fixture('openai-responses.tool-call.sse'), 1 << 20)
    expect(msgs[0]?.event).toBe('response.created')
    expect(msgs.at(-1)?.event).toBe('response.completed')
    for (const m of msgs) expect(() => JSON.parse(m.data)).not.toThrow()
  })
})

describe('parseSSE 的 chunk 边界', () => {
  const names = [
    'anthropic-messages.tool-call.sse',
    'openai-chat.tool-call.sse',
    'openai-responses.tool-call.sse',
  ]

  // 这组测的是**行边界**：逐字节喂入时每个 \n 都落在不同的 chunk 里
  for (const name of names) {
    it(`${name}：逐字节喂入与整体喂入结果一致`, async () => {
      const bytes = await fixture(name)
      expect(await collect(bytes, 1)).toEqual(await collect(bytes, 1 << 20))
    })
  }

  // 这组测的是 **UTF-8 边界**，必须单独写：三份 fixture 里只有 responses 含
  // 多字节字符（另两份的响应体全是 ASCII），拿它们测解码等于什么都没测。
  it('响应体含多字节字符的 fixture 才走得到解码路径', async () => {
    const ascii = (b: Buffer) => b.byteLength === b.toString('utf8').length
    expect(ascii(await fixture('anthropic-messages.tool-call.sse'))).toBe(true)
    expect(ascii(await fixture('openai-chat.tool-call.sse'))).toBe(true)
    expect(ascii(await fixture('openai-responses.tool-call.sse'))).toBe(false)
  })

  it('chunk 切在 UTF-8 多字节序列中间时不产生替换字符', async () => {
    const payload = 'data: {"text":"你好，世界"}\n\n'
    const bytes = enc(payload)
    expect(bytes.byteLength).toBeGreaterThan(payload.length) // 前提：确实有多字节

    // 对照组：按 chunk 独立解码的写法会被这份输入打挂。两个都通过才说明
    // 我们的实现真的解决了问题，而不是这份输入本来就切不坏
    const naive = Array.from(bytes, (b) => Buffer.from([b]).toString('utf8')).join('')
    expect(naive).toContain('�')

    const msgs = await collect(bytes, 1)
    expect(msgs).toEqual([{ event: '', data: '{"text":"你好，世界"}' }])
  })
})
