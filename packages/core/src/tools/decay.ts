/** 时间衰减 ②（memory-time-decay.md，2026-10-21 拍板）：超半年未用的
 * note/lesson/event 不进 list/search 曝光面，`--all` 显式全量。
 *
 * 月度锚点：cutoff = 当月第一天 − 180 天——当月内恒定（曝光面稳定：
 * 进 system prompt / recall 注入的部分一变，前缀变、缓存 miss），月初
 * 跳变一次。零状态零定时器，一行日期取整。
 *
 * 时间信号：note `lastRead ?? created`（superseded 不收——语义退场线与
 * 时间遗忘线独立，2026-10-21 拍板不混）；lesson `lastRead ?? mtime`
 * （lesson 无 created 字段，mtime 含盖章写入）；event
 * `max(lastRead, updated) ?? created`——progress 追加算活动，活跃战役
 * 不误收。信号缺失算可见：宁可不遗忘，不误杀。
 *
 * skill 不在衰减范围：用户指令区（人策展、量小、无时间信号字段）——
 * 按时间藏用户装的指令是藏能力，不是清噪声。 */

export const DECAY_DAYS = 180

/** 当月第一天 − DECAY_DAYS 天 */
export function decayCutoff(now?: Date): number {
  const d = now ?? new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime() - DECAY_DAYS * 86_400_000
}

/** localStamp 格式（2026-10-21 16:29:50）→ ms。解析不了返回 null */
export function parseStamp(s: string): number | null {
  const t = Date.parse(s.includes(' ') ? s.replace(' ', 'T') : s)
  return Number.isNaN(t) ? null : t
}

/** 拆可见/超期。signalOf 返回 null = 无从判定，算可见 */
export function splitByDecay<T>(
  items: T[],
  signalOf: (item: T) => number | null,
): { visible: T[]; hidden: number } {
  const cutoff = decayCutoff()
  const visible: T[] = []
  let hidden = 0
  for (const it of items) {
    const s = signalOf(it)
    if (s !== null && s < cutoff) hidden++
    else visible.push(it)
  }
  return { visible, hidden }
}

/** 护栏行：silent 和 noticed forgetting 的全部区别——知道有 N 条被收起，
 * 一条 --all 就能看回来（2026-10-21 拍板保留） */
export function decayNotice(hidden: number): string {
  return `（另有 ${hidden} 条超半年未用已收起，--all 查看全量）`
}
