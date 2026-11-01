import type { Message } from '../llm/types.ts'
import type { LiveMessage } from '../loop/assemble.ts'
import type { Db } from './db.ts'

/** UI 使用原文，模型继续使用 live 存根；不改消息、不改库。
 * CX tui/chatwidget/replay.rs 同样从历史 item 回放 UI，而非压缩后请求。
 * step/role 配对沿用本项目 pruneMessages 的规则，owner 必须一致。 */
export function restoreHistoryOriginals(
  db: Db,
  live: LiveMessage[],
  owner: string | null,
): {
  rows: LiveMessage[]
  restoredIds: number[]
} {
  if (!live.length) return { rows: [], restoredIds: [] }
  const steps = [...new Set(live.map((l) => l.stepId))]
  const originals = db.all<{ id: number; step_id: number; role: string; content_json: string }>(
    `SELECT id, step_id, role, content_json FROM messages
     WHERE state = 'unloaded' AND owner IS ?
       AND step_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    owner,
    JSON.stringify(steps),
  )
  const byRole = new Map<string, typeof originals>()
  for (const row of originals) {
    const key = `${row.step_id}:${row.role}`
    const group = byRole.get(key) ?? []
    group.push(row)
    byRole.set(key, group)
  }
  const restoredIds: number[] = []
  const rows = live.map((l) => {
    const original = byRole.get(`${l.stepId}:${l.message.role}`)?.shift()
    if (!original) return l
    restoredIds.push(original.id)
    return { ...l, message: JSON.parse(original.content_json) as Message }
  })
  return { rows, restoredIds }
}
