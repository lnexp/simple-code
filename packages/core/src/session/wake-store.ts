/**
 * 闹钟持久层（loop-interrupt.md §5；2026-11-09 持久化拍板，推翻最初
 * 「不持久化、重启即丢」）。归属两级：**项目**（<root>/.simple-code/wake.json，
 * 随项目走，与任务清单/记忆同级）→ **任务**（owner——任务只能 awake
 * 自己：list/cancel 只见自己的，上限按任务算）。
 *
 * 文件是真源：add 写入；fire 前校验（跨窗口 cancel 过的不再响）；
 * 面板重建时 restore 读它重挂，过点的补投一条迟到的叫醒。
 * 同项目双窗口并发写会丢条目——低频轻后果不防（拍板记录在 §5）。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type WakeAlarm =
  | { id: string; owner: string; kind: 'after' | 'at'; dueAt: number; note: string }
  | { id: string; owner: string; kind: 'until'; cmd: string; everyMs: number; note: string }

export function wakeStorePath(root: string): string {
  return join(root, '.simple-code', 'wake.json')
}

export function newWakeId(): string {
  return `wake-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
}

/** 读全量。损坏文件改名 .broken-<ts> 留给人看，按空处理——闹钟坏一天
 *  的代价小于全项目闹钟功能卡死 */
export function loadWakeAlarms(root: string): WakeAlarm[] {
  let text: string
  try {
    text = readFileSync(wakeStorePath(root), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) throw new Error('not array')
    return parsed.filter((a): a is WakeAlarm => {
      if (typeof a !== 'object' || a === null) return false
      const e = a as Record<string, unknown>
      return typeof e.id === 'string' && typeof e.owner === 'string' && typeof e.note === 'string'
    })
  } catch {
    const broken = `${wakeStorePath(root)}.broken-${Date.now().toString(36)}`
    renameSync(wakeStorePath(root), broken)
    return []
  }
}

export function saveWakeAlarms(root: string, alarms: WakeAlarm[]): void {
  const path = wakeStorePath(root)
  const tmp = `${path}.tmp-${process.pid}`
  mkdirSync(dirname(path), { recursive: true }) // .simple-code 恒在（真实项目），测试与首用兜底
  writeFileSync(tmp, `${JSON.stringify(alarms, null, 2)}\n`, 'utf8')
  renameSync(tmp, path) // 原子替换：要么旧要么新，无中间态
}

/** fire 前的校验+摘除：在（没被取消）→ 从文件删掉并返回，由调用方投递 */
export function takeWakeAlarm(root: string, id: string): WakeAlarm | null {
  const alarms = loadWakeAlarms(root)
  const hit = alarms.find((a) => a.id === id)
  if (hit === undefined) return null
  saveWakeAlarms(
    root,
    alarms.filter((a) => a.id !== id),
  )
  return hit
}

/** 任务级取消：只删自己的（owner 对不上 = 别人的任务，拒绝）。
 *  返回 null = 成功；字符串 = 给 CLI 的报错 */
export function dropWakeAlarm(root: string, id: string, owner: string): string | null {
  const alarms = loadWakeAlarms(root)
  const hit = alarms.find((a) => a.id === id)
  if (hit === undefined) return `没有这条闹钟：${id}（--list 看自己设的）`
  if (hit.owner !== owner) return '这条闹钟是别的任务设的，任务只能取消自己的'
  saveWakeAlarms(
    root,
    alarms.filter((a) => a.id !== id),
  )
  return null
}

export function countOwnerWake(root: string, owner: string): number {
  return loadWakeAlarms(root).filter((a) => a.owner === owner).length
}

/** 到点时刻的显示：本地化时间 + 相对剩余（<1 分钟精确到秒） */
export function wakeDueText(dueAt: number, now = Date.now()): string {
  const remain = dueAt - now
  const head = new Date(dueAt).toLocaleString('zh-CN', { hour12: false })
  const rel =
    remain < 60_000
      ? `${Math.max(0, Math.round(remain / 1000))} 秒后`
      : `${Math.max(0, Math.round(remain / 60000))} 分钟后`
  return `${head}（${rel}）`
}

/** CLI --list：只列当前任务（owner 相同）的。主任务（owner=''）同样
 *  只见自己的——任务 awake 自己的拍板；要全局视野另议 */
export function renderWakeList(root: string, owner: string): string {
  const mine = loadWakeAlarms(root).filter((a) => a.owner === owner)
  if (mine.length === 0)
    return owner === '' ? '没有闹钟（主任务视角；任务设的归任务自己管）' : '没有闹钟'
  const due = (a: WakeAlarm): string =>
    a.kind === 'until'
      ? `条件满足（每 ${Math.round(a.everyMs / 60000)} 分钟探测）`
      : wakeDueText(a.dueAt)
  return [
    `${mine.length} 条闹钟（只能看见自己设的）：`,
    ...mine.map((a) => `  ${a.id}  ${due(a)}${a.note ? `  ${a.note}` : ''}`),
  ].join('\n')
}
