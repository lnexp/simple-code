import type { ImageInput } from '@simple-code/core'
import type { TurnQueueView } from './protocol.ts'
import type { TurnEnd } from './robot-feed.ts'

/**
 * 排队发送（docs/proposals/queued-sends.md，2026-11-14 拍板）：Ctrl+Enter 的
 * 消息按 owner 排队（'' = 主任务，任务 = manifest.owner），这个 owner 的一轮
 * **正常结束**（done）就发队首，串行发完；停止/出错暂停，条目保留，只有用户
 * 手动发消息才解除。
 *
 * 和插话不是一条队列：插话（core 的 tasks.push，迭代顶投递）影响正在做的事；
 * 这里是「这一轮跑完再说」的新安排，宿主层自己管，core 不知道。
 * 只放内存，reload 即丢（拍板：同输入框里没发出的草稿）。
 *
 * 按 owner 不按任务名：任务名是人起的、关闭后可复用（lesson
 * cross-boundary-identity-not-name）。主任务与任务共用这一份（task-parity）。
 */
export type TurnQueueItem = { id: number; text: string; images?: ImageInput[] }

export type TurnQueueDeps = {
  /** owner 此刻在跑吗。在跑只入队 */
  busy: (owner: string) => boolean
  /** 发出一条：走现有发送路径（主任务 bridge 的 send、任务 tasks.send） */
  dispatch: (owner: string, item: TurnQueueItem) => void
  /** 队列变了（入队/取消/发出/暂停/解除）：推 webview */
  changed: () => void
}

type Queue = { items: TurnQueueItem[]; paused: boolean }

const EMPTY: TurnQueueView = { paused: false, items: [] }

export function createTurnQueue(deps: TurnQueueDeps) {
  const queues = new Map<string, Queue>()
  let seq = 0

  /** 空了就整个删：暂停只对还有待发条目有意义——停止后把条目都取消了，
   *  之后空闲按 Ctrl+Enter 照常立即发，不该被一个空的暂停态挡住 */
  const prune = (owner: string): void => {
    if (queues.get(owner)?.items.length === 0) queues.delete(owner)
  }

  /** 能发就发队首。先出队并推快照、再 dispatch：dispatch 同步把目标置为
   *  在跑，webview 先看到条目消失、再看到它作为用户消息上屏 */
  const next = (owner: string): void => {
    const q = queues.get(owner)
    if (q === undefined || q.paused || deps.busy(owner)) return
    const item = q.items.shift()
    if (item === undefined) return
    prune(owner)
    deps.changed()
    deps.dispatch(owner, item)
  }

  const toView = (q: Queue): TurnQueueView => ({
    paused: q.paused,
    items: q.items.map(({ id, text, images }) => ({ id, text, imageCount: images?.length ?? 0 })),
  })

  return {
    add(owner: string, text: string, images?: ImageInput[]): void {
      const q = queues.get(owner) ?? { items: [], paused: false }
      queues.set(owner, q)
      q.items.push({
        id: ++seq,
        text,
        ...(images !== undefined && images.length > 0 ? { images } : {}),
      })
      deps.changed()
      // 空闲且没暂停：立刻发（不发就死队列——闲着就没有轮结束来触发）
      next(owner)
    },

    /** 按 id 取消。不在队里 = 空操作：队首恰在点 × 的瞬间发出了（竞态），
     *  按序号取消的话这时会删掉下一条 */
    cancel(id: number): void {
      for (const [owner, q] of queues) {
        const i = q.items.findIndex((x) => x.id === id)
        if (i < 0) continue
        q.items.splice(i, 1)
        prune(owner)
        deps.changed()
        return
      }
    },

    /** 一轮结束（bridge send / tasks runLoop 的 finally 末尾）。done 才接着
     *  发；stopped/error 暂停——上一轮没做完，后面排的话多半以它为前提 */
    turnEnded(owner: string, end: TurnEnd['end']): void {
      const q = queues.get(owner)
      if (q === undefined) return
      if (end === 'done') {
        next(owner)
        return
      }
      if (q.paused) return
      q.paused = true
      deps.changed()
    },

    /** 用户手动发消息（Enter，含运行中插话）：解除暂停，那一轮正常结束时
     *  接着发。闹钟、任务回调开的轮不走这里——它们正常结束不解除暂停 */
    resume(owner: string): void {
      const q = queues.get(owner)
      if (q === undefined || !q.paused) return
      q.paused = false
      deps.changed()
    },

    /** 任务关闭：它的队列跟着丢 */
    drop(owner: string): void {
      if (queues.delete(owner)) deps.changed()
    },

    /** webview 快照：主任务一份 + 各任务按名字（nameOf 翻不出 = 任务已不在，
     *  不推）。图片原文留在宿主，只给张数 */
    view(nameOf: (owner: string) => string | null): {
      main: TurnQueueView
      tasks: Record<string, TurnQueueView>
    } {
      const main = queues.get('')
      const tasks: Record<string, TurnQueueView> = {}
      for (const [owner, q] of queues) {
        if (owner === '') continue
        const name = nameOf(owner)
        if (name !== null) tasks[name] = toView(q)
      }
      return { main: main === undefined ? EMPTY : toView(main), tasks }
    },
  }
}

export type TurnQueue = ReturnType<typeof createTurnQueue>
