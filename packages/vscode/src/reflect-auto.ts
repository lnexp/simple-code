/**
 * 自动反思（2026-11-12 拍板，note reflection-design-memory-5w1h）：任何任务
 * 开始一轮时查一次门槛，到了就派反思任务——与记忆面板的反思按钮同一份
 * 任务书、同一个入口（tasks.dispatch：via 'user'，不回调、有完成提醒）。
 *
 * 不用定时器：素材（note/event/对话）只在人用 SC 时增长；机器睡眠、窗口
 * 关着时定时器本来也不跑（t17084 用户：「定时可能不行，因为机器不会一直
 * 开着」）。CC 的 autoDream 也挂在轮次上（query/stopHooks.ts），不是定时器。
 * 挂开轮不挂轮末：轮末人可能马上关窗口，反思跑一半就断。
 *
 * 门槛：距上次反思 ≥24h，且之后所有任务合计 ≥30 轮——主任务与其他任务
 * 平权，不只数主任务（note task-parity，t21632 用户订正）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lastReflectAt, localStamp, logRun, parseStamp } from '@simple-code/core'
import { REFLECT_TASK_BOOK } from './reflect.ts'
import type { TaskCenter } from './tasks.ts'

export const REFLECT_GAP_MS = 24 * 3600_000
export const REFLECT_MIN_TURNS = 30
/** = REFLECT_TASK_BOOK 首行（reflect.test.ts 锁定）：tasks 拿它当任务名 */
const NAME = '反思'

/** 上次派出反思的时刻（按钮与自动都记）。反思失败不写收尾 event——只看
 *  event 的话，失败之后每一轮都会重派 */
const startFile = (folder: string): string => join(folder, '.simple-code', 'reflect.json')

export function lastReflectStart(folder: string): number | null {
  try {
    const saved = JSON.parse(readFileSync(startFile(folder), 'utf8')) as { lastStart?: unknown }
    return typeof saved.lastStart === 'string' ? parseStamp(saved.lastStart) : null
  } catch {
    return null // 没有或写坏了：当没派过，代价是最多多跑一次反思
  }
}

/** 不抛：记不下来的代价同上，不该挡住派任务 */
export function recordReflectStart(folder: string): void {
  try {
    const path = startFile(folder)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ lastStart: localStamp() }, null, 2)}\n`, 'utf8')
  } catch (error) {
    logRun({ ev: 'reflect_record_fail', folder, error: String(error) })
  }
}

type TurnsSince = (at: number) => number

export type AutoReflectDeps = {
  folder: string
  tasks: Pick<TaskCenter, 'listOverview' | 'close' | 'dispatch'>
  now?: () => number
}

/** 返回给 session 的 onTurnStart。门槛没到时只读几个小文件、至多查一次库，
 *  不调模型；关旧任务、派新任务都不等（不耽误这一轮） */
export function createAutoReflect(deps: AutoReflectDeps): (turnsSince: TurnsSince) => void {
  const now = deps.now ?? Date.now

  const check = async (turnsSince: TurnsSince): Promise<void> => {
    const marks = [lastReflectAt(deps.folder), lastReflectStart(deps.folder)].filter(
      (at): at is number => at !== null,
    )
    // 从没反思过：时间这关算过，轮数从库里第一轮数起
    const last = marks.length > 0 ? Math.max(...marks) : 0
    if (now() - last < REFLECT_GAP_MS) return
    const turns = turnsSince(last)
    if (turns < REFLECT_MIN_TURNS) return
    const old = deps.tasks.listOverview().find((t) => t.name === NAME)
    if (old?.status === 'running') return
    // 先记再关再派：关或派失败也等满 24h 再试，不在之后每一轮重来。
    // 记在第一个 await 之前（同步段）：主任务和任务同时开轮时，后一个
    // 检查看得见这条记录，不会派出两个——别在这之前加 await
    recordReflectStart(deps.folder)
    const since = last === 0 ? null : new Date(last).toISOString()
    const log = { ev: 'reflect_auto', folder: deps.folder, since, turns }
    if (old !== undefined) {
      // 停着的旧反思先关（关闭即归档，不丢）——同按钮的「关闭并重开」
      const closed = await deps.tasks.close(NAME)
      if (!closed.ok) {
        logRun({ ...log, error: `关闭旧反思任务失败：${closed.error ?? ''}` })
        return
      }
    }
    const error = await deps.tasks.dispatch(REFLECT_TASK_BOOK)
    logRun({ ...log, replaced: old !== undefined, ...(error !== null ? { error } : {}) })
  }

  return (turnsSince) => {
    void check(turnsSince).catch((error: unknown) =>
      logRun({ ev: 'reflect_auto', folder: deps.folder, error: String(error) }),
    )
  }
}
