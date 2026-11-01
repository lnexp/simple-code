/**
 * 同步段耗时拆解：墙钟、本线程 CPU、窗口内的 GC 暂停（观测版，2026-10-31）。
 *
 * 起因：step_persist 的 kickMs 真机主任务中位约 480ms，真库副本跑同样的
 * 查询稳态约 95ms；运行时差异（Electron vs node）与系统文件缓存已排除
 * （note kick-summary-sync-cost-480ms）。多出来的部分靠三个数分辨：
 * - cpuMs ≈ ms 且 gcMs 占大头 → V8 GC
 * - cpuMs ≈ ms 且 gcMs 小 → 同样的活干得慢（慢核/降频）
 * - cpuMs 远小于 ms → 线程在等（IO、被抢占）
 *
 * GC 用 v8.GCProfiler 而不用 PerformanceObserver('gc')：后者的条目异步送达，
 * 当场不知道窗口里有没有 GC；GCProfiler 的 stop() 当场返回窗口内的统计。
 * cost 单位是微秒（Electron 实测：分配加强制 GC，cost 合计约占墙钟八成）。
 */
import { GCProfiler } from 'node:v8'

export type SyncProbe = {
  /** 墙钟，Date.now() 差（与原 kickMs 同口径） */
  ms: number
  /** 本线程 user+system CPU；运行时没有 threadCpuUsage 时缺省 */
  cpuMs?: number
  gcMs: number
  gcN: number
}

export function probeSync(f: () => void): SyncProbe {
  const profiler = new GCProfiler()
  profiler.start()
  // threadCpuUsage 是 node 23.9 起才有（扩展宿主的 Electron 自带 24.x）。
  // 没有就不记，不退回 process.cpuUsage——那是全进程口径，会把 V8 后台
  // 并发标记线程也算进来，正好混淆要分辨的东西
  const cpu0 = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null
  const t0 = Date.now()
  try {
    f()
  } catch (e) {
    profiler.stop()
    throw e
  }
  const ms = Date.now() - t0
  const cpu = cpu0 ? process.threadCpuUsage(cpu0) : null
  const gc = profiler.stop().statistics
  return {
    ms,
    ...(cpu ? { cpuMs: Math.round((cpu.user + cpu.system) / 1000) } : {}),
    gcMs: Math.round(gc.reduce((sum, s) => sum + s.cost, 0) / 1000),
    gcN: gc.length,
  }
}
