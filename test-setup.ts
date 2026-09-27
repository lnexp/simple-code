import { vi } from 'vitest'

// 测试环境剥掉宿主注入的分流变量——vitest 若从 agent 的 bash 子进程启动
// （$SIMPLE_CODE_MEMORY_DIR 会随 env 传进来），findMemoryRoot 的 env 优先
// 分支会把 fixture 测试指到真库上（2026-09-22 全套测试 10 红的根因）
delete process.env.SIMPLE_CODE_MEMORY_DIR


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
