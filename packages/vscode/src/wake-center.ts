/**
 * 闹钟中心（loop-interrupt.md §5，实现项 3）：宿主层的定时器——到点/条件
 * 满足时给设闹钟的会话投一条〔wake〕消息。**循环活在宿主**（--until-ok 每
 * --every 跑一次命令，不经模型、零 token）——断网时 agent 唤不醒（唤醒 =
 * 模型调用），只有宿主能反复探测、恢复时才第一次唤醒。
 *
 * 不持久化：Map 在内存，重启即丢（方案拍板——落回「醒来看现场」兜底）。
 * App Nap 会把长定时器节流到 ~15 分钟一拍：精度按分钟级设计，不做秒级场景。
 */
import { spawn } from 'node:child_process'
import type { WakeRequest, WakeResponse } from '@simple-code/core'

/** 防呆：闹钟总量上限。正常用法是个位数；agent 失控设一串等于变相轮询 */
const MAX_ALARMS = 20

export type WakeFire = (root: string, owner: string, text: string) => void

export function createWakeCenter(fire: WakeFire) {
  const timers = new Map<string, { stop: () => void; desc: string }>()

  const wakeText = (note: string | undefined): string =>
    `〔wake〕${note === undefined || note === '' ? '闹钟到点（未留备忘）' : `你设的闹钟：${note}`}`

  const register = (id: string, stop: () => void, desc: string): void => {
    timers.set(id, { stop, desc })
  }

  const add = (req: WakeRequest): WakeResponse => {
    if (timers.size >= MAX_ALARMS)
      return { ok: false, error: `闹钟已达上限 ${MAX_ALARMS}，先等现有的响` }
    const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    if (req.afterMs !== undefined && req.afterMs > 0) {
      const t = setTimeout(() => {
        fire(req.root, req.owner, wakeText(req.note))
        timers.delete(id)
      }, req.afterMs)
      t.unref?.()
      register(id, () => clearTimeout(t), `${Math.round(req.afterMs / 60000)} 分钟后`)
      return { ok: true, id }
    }

    if (req.at !== undefined) {
      const hit = /^(\d{1,2}):(\d{2})$/.exec(req.at)
      if (hit === null) return { ok: false, error: '--at 要写 HH:MM 形态（如 08:00）' }
      const now = new Date()
      let at = new Date(now)
      at.setHours(Number(hit[1]), Number(hit[2]), 0, 0)
      if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000) // 已过则明天
      const t = setTimeout(() => {
        fire(req.root, req.owner, wakeText(req.note))
        timers.delete(id)
      }, at.getTime() - now.getTime())
      t.unref?.()
      register(id, () => clearTimeout(t), `${req.at}（${at.toLocaleDateString()}）`)
      return { ok: true, id }
    }

    if (req.untilOk !== undefined && req.untilOk.trim() !== '') {
      const every = req.everyMs !== undefined && req.everyMs >= 60_000 ? req.everyMs : 30 * 60_000
      // 立即先跑一次（不等第一个间隔），成功即刻唤醒
      const probe = (): void => {
        const child = spawn('/bin/zsh', ['-c', req.untilOk as string], { stdio: 'ignore' })
        child.on('exit', (code) => {
          if (code === 0) {
            stop()
            fire(req.root, req.owner, wakeText(req.note))
          }
        })
        child.on('error', () => {
          /* 命令本身起不来（如 curl 不存在）：按不满足处理，下轮再试 */
        })
      }
      const interval = setInterval(probe, every)
      interval.unref?.()
      const stop = (): void => {
        clearInterval(interval)
        timers.delete(id)
      }
      register(id, stop, `条件满足（每 ${Math.round(every / 60000)} 分钟探测）`)
      probe()
      return { ok: true, id }
    }

    return { ok: false, error: '三种形态择一：--after 30m / --at 08:00 / --until-ok "命令"' }
  }

  const dispose = (): void => {
    for (const { stop } of timers.values()) stop()
    timers.clear()
  }

  return {
    add,
    dispose,
    size: (): number => timers.size,
    describe: (): string[] => [...timers.values()].map((t) => t.desc),
  }
}
