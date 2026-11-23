/** 卡片点击（card.action.trigger）的解析（§15.3）。两种形状，集中在这一个
 *  函数——实测后形状有变只改这里：
 *  1. 独立按钮（列表「切换」，20:53 实测 .simple-code/tmp/card-cb.ndjson）：
 *     action_value 是 JSON 字符串（需 parse），无 action_name。
 *  2. form 提交（审批，20:58 实测 .simple-code/tmp/card-form.ndjson）：
 *     action_name=按钮 name（"allow"/"deny"）、form_value 是 JSON 字符串
 *     （取 reason）、**没有 action_value 字段**——判 allow/deny 只看
 *     action_name，别依赖 action_value。
 *  timestamp 是 16 位微秒（lark-cli 文档写 timestamp_ms，与实测不符），
 *  点击即当下、不做晚到判定，这里不碰它。 */
import type { Card } from './gateway-cards.ts'

export type CardAction =
  | { kind: 'approval'; act: 'allow' | 'deny'; reason: string | undefined }
  | { kind: 'to'; folder: string; owner: string }

export type CardClick = {
  eventId: string
  operatorId: string
  chatId: string
  messageId: string
  token: string
  action: CardAction
}

const str = (v: unknown): v is string => typeof v === 'string'

/** 一行 NDJSON → CardClick。不是本应用的点击（字段缺/坏、形状不认）→ null */
export function parseCardAction(raw: Record<string, unknown>): CardClick | null {
  if (raw.type !== 'card.action.trigger') return null
  if (!str(raw.event_id) || !str(raw.operator_id) || !str(raw.chat_id)) return null
  if (!str(raw.message_id) || !str(raw.token)) return null
  const base = {
    eventId: raw.event_id,
    operatorId: raw.operator_id,
    chatId: raw.chat_id,
    messageId: raw.message_id,
    token: raw.token,
  }
  if (str(raw.action_value)) {
    // 独立按钮：value 是 JSON 字符串
    try {
      const v = JSON.parse(raw.action_value) as Record<string, unknown>
      if (v.act !== 'to' || !str(v.folder) || !str(v.owner)) return null
      return { ...base, action: { kind: 'to', folder: v.folder, owner: v.owner } }
    } catch {
      return null
    }
  }
  // form 提交：action_name 判 allow/deny，form_value.reason 取理由
  if (raw.action_name === 'allow' || raw.action_name === 'deny') {
    let reason: string | undefined
    if (str(raw.form_value)) {
      try {
        const v = JSON.parse(raw.form_value) as Record<string, unknown>
        if (str(v.reason) && v.reason.trim() !== '') reason = v.reason.trim()
      } catch {
        // form_value 坏了当没填理由
      }
    }
    return { ...base, action: { kind: 'approval', act: raw.action_name, reason } }
  }
  return null
}

/** card/update 的 payload（适配器拿去 --data @临时文件） */
export const cardUpdateData = (token: string, card: Card): Record<string, unknown> => ({
  token,
  card,
})
