import { vi } from 'vitest'

/**
 * 全局 setup：跑测试时挡掉运行日志的真写盘。
 *
 * logRun 是 fire-and-forget 的副作用（runlog.ts），接线在 client/retry/run/
 * bridge 里散着——单测一跑，~/.simple-code/logs 就混进 test-model-9 这种
 * 噪音行。这里统一换成 no-op；落盘契约由 runlog.test.ts 用注入目录实测。
 */
vi.mock(import('./packages/core/src/runlog.ts'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('./packages/core/src/runlog.ts')>()
  return { ...actual, logRun: vi.fn(), logRunTo: actual.logRunTo }
})
