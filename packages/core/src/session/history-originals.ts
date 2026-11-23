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
  // 两个分支都用 IN(step 列表) + 强制 messages_restore(owner,state,step_id)：
  // 范围版（step_id >= 窗口下界）会把压缩清掉存根的旧轮原文一起捞出来
  // ——真库 209 行 live 要捞 14290 行（127 倍），冷跑 1.1s 卡事件
  // 循环（2026-11-18 任务切换卡顿排查）。不加 INDEXED BY 时优化器给
  // IN 选 messages_owner（owner 子树全扫 + bloom 过滤），冷跑 3.4s，
  // 比 2026-11-06 测的 865ms 还糟——那次的结论（范围优于 IN）在
  // messages_restore 索引落下后反了：强制走它，实测同库 2ms/112 行
  const originals = db.all<{ id: number; step_id: number; role: string; content_json: string }>(
    `SELECT id, step_id, role, content_json FROM messages
     INDEXED BY messages_restore
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
