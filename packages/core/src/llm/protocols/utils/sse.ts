import type { SSEMessage } from '../../events.ts'

/** OpenAI 系的流终止哨兵。Anthropic 不发这个，靠 message_stop 收尾 */
const DONE = '[DONE]'

type Pending = { event: string; data: string[] }

/**
 * SSE 行解析，协议无关。
 *
 * 输入是字节流而不是字符串流：fetch 的 chunk 边界可以落在任何位置，包括
 * **UTF-8 多字节字符中间**。TextDecoder 的 `{ stream: true }` 负责把半个
 * 字符攒到下一个 chunk——自己按 chunk 调 toString() 会得到替换字符 U+FFFD。
 */
export async function* parseSSE(stream: AsyncIterable<Uint8Array>): AsyncIterable<SSEMessage> {
  const decoder = new TextDecoder('utf-8')
  const pending: Pending = { event: '', data: [] }
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const msg = feedLine(stripCR(buffer.slice(0, nl)), pending)
      buffer = buffer.slice(nl + 1)
      if (msg) {
        // DONE 不是静默吞掉而是转成结构化哨兵传下去：chat 协议的终止
        // 标记就是它本身，吞了的话协议层没法区分「完整结束」和「断流」
        if (msg.data === DONE) {
          yield { event: '', data: '', done: true }
          return
        }
        yield msg
      }
      nl = buffer.indexOf('\n')
    }
  }

  // 流结束时末尾可能没有空行（也可能没有换行符）。补一次 flush，
  // 否则最后一条 message 会被静默吞掉——这种丢失不会报错，只会行为不对。
  buffer += decoder.decode()
  const tail = feedLine(stripCR(buffer), pending)
  if (tail && tail.data === DONE) yield { event: '', data: '', done: true }
  else if (tail) yield tail
  const flushed = feedLine('', pending)
  if (flushed && flushed.data === DONE) yield { event: '', data: '', done: true }
  else if (flushed) yield flushed
}

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** 返回非 null 表示这一行凑齐了一条完整 message */
function feedLine(line: string, pending: Pending): SSEMessage | null {
  if (line === '') return flush(pending)

  // SSE 注释行。真实网关拿它做心跳，fixture 里就有 `: gateway-keepalive`
  if (line.startsWith(':')) return null

  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  const raw = colon === -1 ? '' : line.slice(colon + 1)
  // 规范：冒号后跳过一个空格，且只跳一个
  const value = raw.startsWith(' ') ? raw.slice(1) : raw

  if (field === 'event') pending.event = value
  else if (field === 'data') pending.data.push(value)
  // id / retry 我们用不上

  return null
}

function flush(pending: Pending): SSEMessage | null {
  if (pending.data.length === 0 && pending.event === '') return null
  // 多行 data 用 \n 连接（SSE 规范）。三个协议实际都只发一行，但成本为零
  const msg: SSEMessage = { event: pending.event, data: pending.data.join('\n') }
  pending.event = ''
  pending.data = []
  return msg
}
