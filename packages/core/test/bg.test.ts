import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BgRegistry } from '../src/tools/bg.ts'
import { type BashConfig, createBashTool } from '../src/tools/bash.ts'
import type { ToolContext } from '../src/tools/types.ts'

const config: BashConfig = {
  defaultTimeoutMs: 5000,
  maxTimeoutMs: 10_000,
  maxOutputChars: 16_000,
  killGraceMs: 200,
  envPassthrough: ['PATH', 'HOME'],
}

let root = ''
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'simple-code-bg-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))

const bash = createBashTool(config)

/** 真链路：跑一条留下后台进程的命令，断言登记、清理、事件三件事 */
describe('bash → BgRegistry 集成', () => {
  it('重定向后台命令被登记，drain 给出快照事件', async () => {
    const bg = new BgRegistry()
    const ctx: ToolContext = {
      root,
      signal: new AbortController().signal,
      bg,
    }
    const out = await bash.execute(
      { command: '(sleep 30 >/dev/null 2>&1 &); echo started' },
      ctx,
    )
    expect(out.output).toContain('started')
    // collect 在 close 后异步收尾，execute resolve 时已登记
    const items = bg.snapshot()
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items.some((p) => p.command.includes('sleep 30'))).toBe(true)
    const ev = bg.drain()
    expect(ev?.type).toBe('bg_processes')
    expect(ev?.items.some((p) => p.command.includes('sleep 30'))).toBe(true)
    // 清场：terminate 掉所有 sleep，别让测试机攒孤儿
    for (const p of bg.snapshot()) if (p.command.includes('sleep 30')) bg.terminate(p.pid)
  })

  it('terminate 后快照为空、drain 再报一次', async () => {
    const bg = new BgRegistry()
    await bash.execute({ command: '(sleep 30 >/dev/null 2>&1 &); echo ok' }, {
      root,
      signal: new AbortController().signal,
      bg,
    })
    bg.drain() // 清 dirty
    const items = bg.snapshot()
    expect(items.length).toBeGreaterThanOrEqual(1)
    bg.terminate(items[0]!.pid)
    expect(bg.snapshot().some((p) => p.pid === items[0]!.pid)).toBe(false)
    expect(bg.drain()?.items).toEqual([])
  })

  it('进程自然退出后 snapshot 自动清掉', async () => {
    const bg = new BgRegistry()
    await bash.execute({ command: '(sleep 1 >/dev/null 2>&1 &); echo ok' }, {
      root,
      signal: new AbortController().signal,
      bg,
    })
    expect(bg.snapshot().length).toBeGreaterThanOrEqual(1)
    await new Promise((r) => setTimeout(r, 1500))
    expect(bg.snapshot()).toEqual([])
  })

  it('命令不含 & 时不查 ps（纯前台命令零开销）', async () => {
    const bg = new BgRegistry()
    // 不含 &：即使进程组里理论上没有残留，也不该报事件
    await bash.execute({ command: 'echo plain' }, {
      root,
      signal: new AbortController().signal,
      bg,
    })
    expect(bg.drain()).toBeNull()
  })
})
