import { describe, expect, it } from 'vitest'
import { type SetTimer, watchIdle } from '../src/session/idle.ts'
import type { Session } from '../src/session/session.ts'

/** 手动定时器：记下排了几个、手动触发 */
const manualTimer = () => {
  const pending: (() => void)[] = []
  const setTimer: SetTimer = (_ms, fn) => {
    pending.push(fn)
    return () => {
      const i = pending.indexOf(fn)
      if (i >= 0) pending.splice(i, 1)
    }
  }
  return { pending, setTimer }
}

/** summarizeIdle 由测试手动放行，模拟「摘要正在跑」 */
const fakeSession = () => {
  let finish: () => void = () => {}
  const session = {
    config: { config: { memory: { idleSummarizeDelayMs: 3000 } } },
    summarizeIdle: () => new Promise<void>((resolve) => { finish = resolve }),
  } as unknown as Session
  return { session, finish: () => finish() }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('watchIdle', () => {
  it('摘要跑完接着排下一次', async () => {
    const t = manualTimer()
    const s = fakeSession()
    const idle = watchIdle(s.session, t.setTimer)
    idle.arm()
    t.pending.shift()?.()
    s.finish()
    await flush()
    expect(t.pending).toHaveLength(1)
  })

  // 2026-09-28~30 exthost 里 8 次 `database is not open`：会话关闭先 disarm
  // 再关库，但在跑的摘要撤不掉，跑完 .then(arm) 又排一个，3 秒后读已关的库
  it('**摘要在跑时 disarm，跑完不再重新排**', async () => {
    const t = manualTimer()
    const s = fakeSession()
    const idle = watchIdle(s.session, t.setTimer)
    idle.arm()
    t.pending.shift()?.()
    idle.disarm()
    s.finish()
    await flush()
    expect(t.pending).toHaveLength(0)
  })
})
