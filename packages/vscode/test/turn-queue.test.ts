import { describe, expect, it } from 'vitest'
import { createTurnQueue } from '../src/turn-queue.ts'

/**
 * 排队发送的纯逻辑（docs/proposals/queued-sends.md）。这里的 bug 都不抛异常：
 * 该发的没发 = 队列静静躺着；不该发的发了 = 停止后照样去「提交并装机」。
 * busy 由用例手动拨（dispatch 同步置 busy，同真实的 send / tasks.send）
 */
function setup() {
  const busy = new Map<string, boolean>()
  const sent: Array<[string, string]> = []
  let changes = 0
  const q = createTurnQueue({
    busy: (owner) => busy.get(owner) === true,
    dispatch: (owner, item) => {
      sent.push([owner, item.text])
      busy.set(owner, true) // 真实的 send 同步把目标置为在跑
    },
    changed: () => {
      changes++
    },
  })
  const nameOf = (owner: string): string | null => (owner === 'o1' ? '任务一' : null)
  /** 模拟一轮结束：先回落 busy，再通知（同 finally 的顺序） */
  const end = (owner: string, how: 'done' | 'stopped' | 'error'): void => {
    busy.set(owner, false)
    q.turnEnded(owner, how)
  }
  return { q, busy, sent, end, nameOf, changes: () => changes }
}

describe('排队发送：何时发', () => {
  it('空闲入队立刻发（不发就死队列）', () => {
    const s = setup()
    s.q.add('', 'A')
    expect(s.sent).toEqual([['', 'A']])
    expect(s.q.view(s.nameOf).main.items).toEqual([])
  })

  it('在跑只入队；done 才发队首，且一次只发一条（串行）', () => {
    const s = setup()
    s.busy.set('', true)
    s.q.add('', 'A')
    s.q.add('', 'B')
    expect(s.sent).toEqual([]) // 前提：在跑时一条都没发
    s.end('', 'done')
    expect(s.sent).toEqual([['', 'A']])
    expect(s.q.view(s.nameOf).main.items.map((x) => x.text)).toEqual(['B'])
    s.end('', 'done')
    expect(s.sent).toEqual([
      ['', 'A'],
      ['', 'B'],
    ])
    expect(s.q.view(s.nameOf).main.items).toEqual([])
  })

  it('stopped / error 暂停：不发，条目保留', () => {
    for (const how of ['stopped', 'error'] as const) {
      const s = setup()
      s.busy.set('', true)
      s.q.add('', 'B')
      s.end('', how)
      expect(s.sent).toEqual([])
      expect(s.q.view(s.nameOf).main).toEqual({
        paused: true,
        items: [{ id: 1, text: 'B', imageCount: 0 }],
      })
    }
  })

  it('暂停中别的轮（闹钟/回调）正常结束也不发——只有手动发话解除', () => {
    const s = setup()
    s.busy.set('', true)
    s.q.add('', 'B')
    s.end('', 'stopped')
    // 闹钟开的轮：不调 resume
    s.busy.set('', true)
    s.end('', 'done')
    expect(s.sent).toEqual([])
    // 暂停中空闲时再 Ctrl+Enter：只排到队尾，不越过暂停
    s.q.add('', 'C')
    expect(s.sent).toEqual([])
    // 用户手动发话（Enter）→ resume；那一轮正常结束才接着发
    s.q.resume('')
    s.busy.set('', true)
    expect(s.sent).toEqual([]) // resume 本身不发（那一轮还在跑）
    s.end('', 'done')
    expect(s.sent).toEqual([['', 'B']])
  })

  it('取消光了暂停也跟着清：之后空闲 Ctrl+Enter 照常立刻发', () => {
    const s = setup()
    s.busy.set('', true)
    s.q.add('', 'B')
    s.end('', 'stopped')
    const id = s.q.view(s.nameOf).main.items[0]?.id as number
    s.q.cancel(id)
    expect(s.q.view(s.nameOf).main).toEqual({ paused: false, items: [] })
    s.q.add('', 'C')
    expect(s.sent).toEqual([['', 'C']])
  })

  it('队列空时停止不留暂停态（对照：上一条用例的前提不是靠取消清的）', () => {
    const s = setup()
    s.busy.set('', true)
    s.end('', 'stopped')
    s.q.add('', 'C')
    expect(s.sent).toEqual([['', 'C']])
  })
})

describe('排队发送：取消与归属', () => {
  it('按 id 取消；队首已发出后再取消它的 id 是空操作，不误删下一条', () => {
    const s = setup()
    s.busy.set('', true)
    s.q.add('', 'A')
    s.q.add('', 'B')
    const [a, b] = s.q.view(s.nameOf).main.items
    expect(a?.text).toBe('A')
    s.end('', 'done') // A 恰在此刻发出
    s.q.cancel(a?.id as number) // webview 上点的是 A 的 ×
    expect(s.q.view(s.nameOf).main.items).toEqual([b]) // B 还在
    s.q.cancel(b?.id as number)
    expect(s.q.view(s.nameOf).main.items).toEqual([])
  })

  it('主任务与任务各排各的；任务按名字出现在快照里', () => {
    const s = setup()
    s.busy.set('', true)
    s.busy.set('o1', true)
    s.q.add('', '主')
    s.q.add('o1', '任')
    s.end('o1', 'done')
    expect(s.sent).toEqual([['o1', '任']])
    const v = s.q.view(s.nameOf)
    expect(v.main.items.map((x) => x.text)).toEqual(['主'])
    expect(v.tasks).toEqual({})
    s.busy.set('o1', true)
    s.q.add('o1', '任2')
    expect(s.q.view(s.nameOf).tasks['任务一']?.items.map((x) => x.text)).toEqual(['任2'])
  })

  it('drop 丢掉任务的队列；翻不出名字的 owner 不进快照', () => {
    const s = setup()
    s.busy.set('o1', true)
    s.busy.set('o2', true)
    s.q.add('o1', 'x')
    s.q.add('o2', 'y') // nameOf('o2') = null：任务已不在
    expect(Object.keys(s.q.view(s.nameOf).tasks)).toEqual(['任务一'])
    s.q.drop('o1')
    expect(s.q.view(s.nameOf).tasks).toEqual({})
    s.end('o1', 'done')
    expect(s.sent).toEqual([])
  })

  it('图片只报张数；每次变化都通知', () => {
    const s = setup()
    s.busy.set('', true)
    s.q.add('', '看图', [{ mimeType: 'image/png', data: 'x' }])
    expect(s.q.view(s.nameOf).main.items[0]?.imageCount).toBe(1)
    const before = s.changes()
    s.end('', 'stopped')
    s.q.resume('')
    expect(s.changes()).toBe(before + 2)
  })
})
