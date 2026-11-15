/**
 * 闹钟中心（loop-interrupt.md §5）：宿主层的定时器——到点/条件满足时给
 * 设闹钟的会话（root+owner）投一条〔wake〕消息。**循环活在宿主**（--until-ok
 * 每 --every 跑一次命令，不经模型、零 token）——断网时 agent 唤不醒（唤醒 =
 * 模型调用），只有宿主能反复探测、恢复时才第一次唤醒。
 *
 * 持久化（2026-11-09 拍板，推翻最初「不持久化、重启即丢」）：真源是
 * <root>/.simple-code/wake.json（core/src/session/wake-store.ts）——闹钟
 * 按项目（随项目走）+ 任务（owner，任务只能 awake 自己）两级归属。
 * add 写文件；fire 前 take 校验（被 cancel 的不再响）；面板重建时
 * restore 重挂，过点的补投一条迟到的叫醒。同项目双窗口并发写会丢条目、
 * 双窗口会双响——低频轻后果，不防（§5 记录）。
 * App Nap 会把长定时器节流到 ~15 分钟一拍：精度按分钟级设计，不做秒级场景。
 */
import { spawn } from 'node:child_process'
import type { WakeRequest, WakeResponse } from '@simple-code/core'
import {
  countOwnerWake,
  loadWakeAlarms,
  newWakeId,
  saveWakeAlarms,
  takeWakeAlarm,
  type WakeAlarm,
  wakeDueText,
} from '@simple-code/core/src/session/wake-store.ts'

/** 防呆：单个任务的闹钟上限（按 owner 计——防的是单个 agent 设一串变轮询） */
const MAX_ALARMS = 20

export type WakeFire = (root: string, owner: string, text: string) => void

export function createWakeCenter(fire: WakeFire) {
  const timers = new Map<string, { stop: () => void; desc: string; root: string }>()

  const wakeText = (note: string | undefined): string =>
    `〔wake〕${note === undefined || note === '' ? '闹钟到点（未留备忘）' : `你设的闹钟：${note}`}`

  const register = (id: string, root: string, stop: () => void, desc: string): void => {
    timers.set(id, { stop, desc, root })
  }

  /** fire 前的统一闸口：文件里还在（没被 cancel）才投递，响过即从文件摘除 */
  const wakeup = (root: string, owner: string, id: string, note: string): void => {
    if (takeWakeAlarm(root, id) === null) return
    fire(root, owner, wakeText(note))
  }

  /** 挂一个绝对时刻的 timer（restore 复用；add 先算好 dueAt 再走这里） */
  const armAbsolute = (
    root: string,
    owner: string,
    id: string,
    dueAt: number,
    note: string,
  ): void => {
    const t = setTimeout(
      () => {
        timers.delete(id)
        wakeup(root, owner, id, note)
      },
      Math.max(0, dueAt - Date.now()),
    )
    t.unref?.()
    register(id, root, () => clearTimeout(t), wakeDueText(dueAt))
  }

  /** 挂条件探测循环（--until-ok）：立即先跑一次，成功即刻唤醒 */
  const armUntil = (
    root: string,
    owner: string,
    id: string,
    cmd: string,
    everyMs: number,
    note: string,
  ): void => {
    const probe = (): void => {
      // 扩展宿主进程的默认 cwd 是 /，探测命令里的相对路径必须按项目根解析
      const child = spawn('/bin/zsh', ['-c', cmd], { cwd: root, stdio: 'ignore' })
      child.on('exit', (code) => {
        if (code === 0) {
          stop()
          wakeup(root, owner, id, note)
        }
      })
      child.on('error', () => {
        /* 命令本身起不来（如 curl 不存在）：按不满足处理，下轮再试 */
      })
    }
    const interval = setInterval(probe, everyMs)
    interval.unref?.()
    const stop = (): void => {
      clearInterval(interval)
      timers.delete(id)
    }
    register(id, root, stop, `条件满足（每 ${Math.round(everyMs / 60000)} 分钟探测）`)
    probe()
  }

  const persist = (root: string, alarm: WakeAlarm): void => {
    saveWakeAlarms(root, [...loadWakeAlarms(root), alarm])
  }

  const add = (req: WakeRequest): WakeResponse => {
    if (countOwnerWake(req.root, req.owner) >= MAX_ALARMS)
      return { ok: false, error: `本任务的闹钟已达上限 ${MAX_ALARMS}，先等现有的响` }
    const id = newWakeId()

    if (req.afterMs !== undefined && req.afterMs > 0) {
      const dueAt = Date.now() + req.afterMs
      persist(req.root, { id, owner: req.owner, kind: 'after', dueAt, note: req.note ?? '' })
      armAbsolute(req.root, req.owner, id, dueAt, req.note ?? '')
      return { ok: true, id }
    }

    if (req.at !== undefined) {
      const hit = /^(\d{1,2}):(\d{2})$/.exec(req.at)
      if (hit === null) return { ok: false, error: '--at 要写 HH:MM 形态（如 08:00）' }
      const now = new Date()
      let at = new Date(now)
      at.setHours(Number(hit[1]), Number(hit[2]), 0, 0)
      if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000) // 已过则明天
      persist(req.root, {
        id,
        owner: req.owner,
        kind: 'at',
        dueAt: at.getTime(),
        note: req.note ?? '',
      })
      armAbsolute(req.root, req.owner, id, at.getTime(), req.note ?? '')
      return { ok: true, id }
    }

    if (req.untilOk !== undefined && req.untilOk.trim() !== '') {
      const every = req.everyMs !== undefined && req.everyMs >= 60_000 ? req.everyMs : 30 * 60_000
      persist(req.root, {
        id,
        owner: req.owner,
        kind: 'until',
        cmd: req.untilOk,
        everyMs: every,
        note: req.note ?? '',
      })
      armUntil(req.root, req.owner, id, req.untilOk, every, req.note ?? '')
      return { ok: true, id }
    }

    return { ok: false, error: '三种形态择一：--after 30m / --at 08:00 / --until-ok "命令"' }
  }

  /** 面板重建时恢复：未到点的重挂，过点的补投一条迟到的叫醒，
   *  条件型直接重挂探测。不做 owner 校验——按各自的 owner 投是宿主行为 */
  const restore = (roots: string[]): void => {
    for (const root of roots) {
      const alarms = loadWakeAlarms(root)
      const overdue: WakeAlarm[] = []
      for (const a of alarms) {
        if (a.kind === 'until') {
          armUntil(root, a.owner, a.id, a.cmd, a.everyMs, a.note)
        } else if (a.dueAt > Date.now()) {
          armAbsolute(root, a.owner, a.id, a.dueAt, a.note)
        } else {
          overdue.push(a)
        }
      }
      if (overdue.length > 0) {
        const ids = new Set(overdue.map((a) => a.id))
        saveWakeAlarms(
          root,
          alarms.filter((a) => !ids.has(a.id)),
        )
        for (const a of overdue)
          fire(root, a.owner, `${wakeText(a.note)}（这条闹钟在你重载期间到点，迟到的叫醒）`)
      }
    }
  }

  /** 目录移出工作区：停掉它的 timer（文件留着，目录回来时 restore 重挂） */
  const stopRoot = (folder: string): void => {
    for (const t of timers.values()) if (t.root === folder) t.stop()
  }

  const dispose = (): void => {
    for (const { stop } of timers.values()) stop()
    timers.clear()
  }

  return {
    add,
    dispose,
    restore,
    stopRoot,
    size: (): number => timers.size,
    describe: (): string[] => [...timers.values()].map((t) => t.desc),
  }
}
