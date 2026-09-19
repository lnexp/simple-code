import type { Protocol, ProtocolName } from './protocol.ts'
import { anthropicMessages } from './protocols/anthropic-messages.ts'
import { openaiChat } from './protocols/openai-chat.ts'
import { openaiResponses } from './protocols/openai-responses.ts'

/**
 * 没有默认协议（CLAUDE.md §1.2）。配置里写了哪个就用哪个，写错就报错。
 * 这个表是 loop 与协议实现之间唯一的连接点——loop 只拿到 Protocol 接口，
 * 不知道背后是谁。
 */
const REGISTRY: Record<ProtocolName, Protocol> = {
  'anthropic-messages': anthropicMessages,
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
}

export function resolveProtocol(name: string): Protocol {
  const protocol = REGISTRY[name as ProtocolName]
  if (!protocol) {
    const known = Object.keys(REGISTRY).join(' / ')
    throw new Error(`未知的 protocol "${name}"，可选：${known}`)
  }
  return protocol
}

export const PROTOCOL_NAMES = Object.keys(REGISTRY) as ProtocolName[]
