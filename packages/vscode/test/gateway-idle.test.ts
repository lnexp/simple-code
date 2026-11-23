import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { syncLogRunTo } from '@simple-code/core'
import { createIdleWatch } from '../src/gateway-core.ts'

/** 网关空闲退出（§5.3）：按连接数判，不是按消息流量（2026-11-17 两个网关
 * 实例把「窗口连着但用户没动 VS Code」当「断开」，最后一条 status 后整
 * 60 秒自杀——本文件两条用例分别钉住正确与错误的判法） */
describe('网关空闲退出（createIdleWatch）', () => {
  it('连接在线、长时间没有消息：超时后网关仍活着（不退）', async () => {
    let idled = false
    const watch = createIdleWatch({
      connCount: () => 1,
      idleMs: 150,
      log: () => {},
      onIdle: () => {
        idled = true
      },
    })
    await new Promise((r) => setTimeout(r, 450)) // 3 倍 idleMs，全程连接在线
    watch.dispose()
    expect(idled).toBe(false)
  })

  it('连接断开超时后退出：gateway_idle_exit 与 gateway_exit 两条日志都已落盘', async () => {
    // 真实退出路径的日志走 syncLogRunTo + process.exit——这里用同一个
    // 同步写函数，验证「写完立即退出也不丢」
    const dir = mkdtempSync(join(tmpdir(), 'sc-gw-idle-'))
    const logSync = syncLogRunTo(join(dir, 'logs'))
    let idleExitAt = 0
    const watch = createIdleWatch({
      connCount: () => 0,
      idleMs: 120,
      log: logSync,
      onIdle: () => {
        idleExitAt = Date.now()
        logSync({ ev: 'gateway_exit', code: 0 }) // 模拟 main 的 exit()
      },
    })
    await new Promise((r) => setTimeout(r, 600)) // idleMs + 起始判定两跳
    watch.dispose()
    expect(idleExitAt).toBeGreaterThan(0)
    const written = readFileSync(join(dir, 'logs', `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8')
    const lines = written.split('\n').filter((l) => l.trim() !== '')
    const names = lines.map((l) => JSON.parse(l).ev)
    expect(names).toContain('gateway_idle_exit')
    expect(names).toContain('gateway_exit')
  })
})
