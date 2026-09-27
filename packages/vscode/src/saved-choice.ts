import type { Effort } from '@simple-code/core'
import type { SavedChoice } from './bridge.ts'

/** core 的 Effort 联合，数组形态给 includes/find 用（校验持久化的档位） */
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * 持久化选择读回时的形状校验。**透传全部字段**（provider / model /
 * effort / preset）：读回丢字段 = 「存了也白存」——preset 被剥掉时，
 * 切过线路的目录一重建（切目录 / 配置热重载 / 重启）就回默认线路，
 * 而用户以为还选着（2026-09-20 实测踩中）。preset 名字失效不用在这里
 * 防：restore 的 setModel 会抛，走既有的清选择 + 提醒一次自愈
 */
export function asSavedChoice(value: unknown): SavedChoice | null {
  if (typeof value !== 'object' || value === null) return null
  const { provider, model, effort, preset } = value as {
    provider?: unknown
    model?: unknown
    effort?: unknown
    preset?: unknown
  }
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  const valid = EFFORTS.find((e) => e === effort)
  const withPreset = typeof preset === 'string' ? { preset } : {}
  return valid ? { provider, model, effort: valid, ...withPreset } : { provider, model, ...withPreset }
}
