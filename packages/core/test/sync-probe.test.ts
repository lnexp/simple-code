import { describe, expect, it } from 'vitest'
import { probeSync } from '../src/sync-probe.ts'

// 三个数要能把「同步段为什么慢」分开（note kick-summary-sync-cost-480ms）：
// 干活 → cpuMs 跟着涨；干等 → cpuMs 不涨；分配多 → gcN/gcMs 记得到
const spin = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* 占着 CPU */
  }
}

describe('probeSync', () => {
  it('忙等：线程 CPU 时间跟墙钟同量级', () => {
    const r = probeSync(() => spin(40))
    expect(r.ms).toBeGreaterThanOrEqual(39)
    expect(r.cpuMs).toBeGreaterThanOrEqual(20)
    expect(r.cpuMs).toBeLessThanOrEqual(r.ms + 5)
  })

  it('干等（线程挂起）：墙钟涨、线程 CPU 不涨', () => {
    const r = probeSync(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40))
    expect(r.ms).toBeGreaterThanOrEqual(39)
    expect(r.cpuMs).toBeLessThan(10)
  })

  it('大量分配：窗口内的 GC 次数与暂停记得到', () => {
    const keep: unknown[] = []
    const r = probeSync(() => {
      for (let i = 0; i < 300_000; i++) keep.push({ i, s: `${'x'.repeat(50)}${i}` })
    })
    expect(keep).toHaveLength(300_000)
    expect(r.gcN).toBeGreaterThan(0)
    expect(r.gcMs).toBeGreaterThan(0)
  })

  it('窗口外的 GC 不算进来', () => {
    const keep: unknown[] = []
    for (let i = 0; i < 300_000; i++) keep.push({ i, s: `${'x'.repeat(50)}${i}` })
    const r = probeSync(() => {})
    expect(r.gcN).toBe(0)
    expect(r.gcMs).toBe(0)
  })

  it('被量的函数抛错照样抛出', () => {
    expect(() =>
      probeSync(() => {
        throw new Error('炸')
      }),
    ).toThrow('炸')
  })
})
