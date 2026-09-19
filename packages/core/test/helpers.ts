import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { LLMEvent, SSEMessage } from '../src/llm/events.ts'
import { parseSSE } from '../src/llm/protocols/utils/sse.ts'

export const readFixture = (name: string) =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

/** 把录制的 fixture 喂给协议，收集 LLMEvent 序列 */
export async function eventsFromFixture(
  parse: (raw: AsyncIterable<SSEMessage>) => AsyncIterable<LLMEvent>,
  name: string,
): Promise<LLMEvent[]> {
  const bytes = await readFixture(name)
  const out: LLMEvent[] = []
  for await (const llmEv of parse(parseSSE(once(bytes)))) out.push(llmEv)
  return out
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

/** 事件序列的骨架，用来断言「发生了什么、什么顺序」而不纠结每个 delta 的内容 */
export const shape = (events: LLMEvent[]): string[] => events.map((e) => e.type)
