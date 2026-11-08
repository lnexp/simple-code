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
  /** 只恢复最近 N 个不同 step 的原文（其余行原样返回存根）。省略 = 全量。
   * fold 每轮 turn 结束都跑：996 行 live 对应的原文散布在 379MB 库的随机
   * 页，冷页缓存实测 650ms——而 webview 只显示最近几屏，全量恢复九成是
   * 白干的（2026-11-06 拍板：窗口化 + 窗口外聚合占位）。冷启动基线
   * （session_open）不传参保持全量——用户重开面板仍能看全部原文 */
  recentSteps?: number,
): {
  rows: LiveMessage[]
  restoredIds: number[]
} {
  if (!live.length) return { rows: [], restoredIds: [] }
  const all = [...new Set(live.map((l) => l.stepId))]
  const steps = recentSteps === undefined ? all : all.slice(-recentSteps)
  // 窗口版用范围条件而不是 IN 列表：实测真库冷跑 IN(100 steps) 865ms
  // （每值一次索引树寻路）比一次范围扫还慢——窗口的 step 连续，
  // >= 下界即可等价（窗口外多余的 unloaded 行在配对时自然丢弃）
  const windowed = recentSteps !== undefined
  const originals = db.all<{ id: number; step_id: number; role: string; content_json: string }>(
    `SELECT id, step_id, role, content_json FROM messages
     WHERE state = 'unloaded' AND owner IS ?
       AND step_id ${windowed ? '>= ?' : 'IN (SELECT value FROM json_each(?))'} ORDER BY id`,
    ...(windowed ? [owner, steps[0] ?? 0] : [owner, JSON.stringify(steps)]),
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
