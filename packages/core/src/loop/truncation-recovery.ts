import type { Message } from '../llm/types.ts'

export const RESUME_STARVED_PROMPT =
  '本次输出达到长度上限，尚未生成正文。请把任务拆成小步骤，先完成一个可验证的步骤，再根据结果继续。'

// df57fb9 生成的完整提示。只迁移独立 user 文本，不匹配工具输出、引用或片段。
// 2026-10-23 140+SDK 六次对照定位文件续读句；中性提示两次均正常。
const LEGACY_STARVED_PROMPT = /^输出被长度上限截断了，正文一个字都没写出来——整个预算都花在了推理上。你被截断前的推理已保存在 [^\r\n]+，可读取它看看自己思考到了哪一步；但不要照原样继续长推理。不要试图一次想清整个任务：先只推进一步，能查证的就直接调工具、用结果代替长推理，得到结果后再想下一步。避免再次被截断。$/u

/** 只改变发送副本，原消息留给 checkpoint/归档；重建会话后变换仍相同。 */
export function replaceLegacyResumePrompts(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || message.parts.length !== 1) return message
    const part = message.parts[0]
    if (part?.type !== 'text' || !LEGACY_STARVED_PROMPT.test(part.text)) return message
    return { ...message, parts: [{ type: 'text', text: RESUME_STARVED_PROMPT }] }
  })
}
