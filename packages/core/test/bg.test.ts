import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BashConfig, createBashTool } from '../src/tools/bash.ts'
import { BgRegistry } from '../src/tools/bg.ts'
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
    const out = await bash.execute({ command: '(sleep 30 >/dev/null 2>&1 &); echo started' }, ctx)
    expect(out.output).toContain('started')
    // collect 在 close 后异步收尾，execute resolve 时已登记
    const items = bg.snapshot()
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items.some((p) => p.command.includes('sleep 30'))).toBe(true)
    const ev = bg.drain()
    expect(ev?.type).toBe('bg_processes')
    expect(ev?.items.some((p) => p.command.includes('sleep 30'))).toBe(true)
    // 清场：terminate 掉所有 sleep，别让测试机攒孤儿
    for (const p of bg.snapshot()) if (p.command.includes('sleep 30')) bg.terminate(p.pgid)
  })

  it('terminate 后快照为空、drain 再报一次', async () => {
    const bg = new BgRegistry()
    await bash.execute(
      { command: '(sleep 30 >/dev/null 2>&1 &); echo ok' },
      {
        root,
        signal: new AbortController().signal,
        bg,
      },
    )
    bg.drain() // 清 dirty
    const items = bg.snapshot()
    expect(items.length).toBeGreaterThanOrEqual(1)
    bg.terminate(items[0]!.pgid)
    expect(bg.snapshot().some((p) => p.pgid === items[0]!.pgid)).toBe(false)
    expect(bg.drain()?.items).toEqual([])
  })

  it('进程自然退出后 snapshot 自动清掉', async () => {
    const bg = new BgRegistry()
    await bash.execute(
      { command: '(sleep 1 >/dev/null 2>&1 &); echo ok' },
      {
        root,
        signal: new AbortController().signal,
        bg,
      },
    )
    expect(bg.snapshot().length).toBeGreaterThanOrEqual(1)
    await new Promise((r) => setTimeout(r, 1500))
    expect(bg.snapshot()).toEqual([])
  })

  it('命令不含 & 时不查 ps（纯前台命令零开销）', async () => {
    const bg = new BgRegistry()
    // 不含 &：即使进程组里理论上没有残留，也不该报事件
    await bash.execute(
      { command: 'echo plain' },
      {
        root,
        signal: new AbortController().signal,
        bg,
      },
    )
    expect(bg.drain()).toBeNull()
  })
})

/**
 * 一条命令 = 一组 = 一行（2026-10-28 用户拍板 A2）。起因截图：一次 headless
 * Chrome 截图摊成 10 行（主进程 + 8 个 helper + 1 个 <defunct>），行内显示
 * ps 的命令尾巴（--seatbelt-client=26），真正有用的两行被挤到最底
 */
describe('按进程组登记', () => {
  const ctxOf = (bg: BgRegistry): ToolContext => ({
    root,
    signal: new AbortController().signal,
    bg,
  })
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }

  it('一条命令起多个后台进程：只出一行，标签是 desc，成员都在 pids 里', async () => {
    const bg = new BgRegistry()
    await bash.execute(
      {
        desc: '起两个睡眠',
        command: '(sleep 30 >/dev/null 2>&1 &); (sleep 31 >/dev/null 2>&1 &); echo ok',
      },
      ctxOf(bg),
    )
    const items = bg.snapshot()
    expect(items).toHaveLength(1)
    const g = items[0]!
    expect(g.label).toBe('起两个睡眠')
    expect(g.pids).toHaveLength(2)
    // 显示的是 agent 写的原命令，不是 ps 的 command 列
    expect(g.command).toContain('sleep 31')
    expect(g.startedAt).toBeGreaterThan(0)

    // × 结束整组：两个成员都得死
    bg.terminate(g.pgid)
    await new Promise((r) => setTimeout(r, 300))
    expect(g.pids.every(gone)).toBe(true)
    expect(bg.snapshot()).toEqual([])
  })

  it('僵尸成员不计入（父进程不收尸的 <defunct>）', async () => {
    const bg = new BgRegistry()
    // perl 父进程 fork 后不 wait：子进程立即退出成僵尸，父进程睡着不收尸
    await bash.execute(
      {
        desc: '造一个僵尸',
        command: "(perl -e 'fork or exit; sleep 30' >/dev/null 2>&1 &); sleep 0.5; echo ok",
      },
      ctxOf(bg),
    )
    const items = bg.snapshot()
    expect(items).toHaveLength(1)
    expect(items[0]!.pids).toHaveLength(1) // 只有 perl 父进程
    bg.terminate(items[0]!.pgid)
  })

  it('漏写 desc：glm 的 description 键也认；都没有就取命令首行', async () => {
    const bg = new BgRegistry()
    await bash.execute(
      { description: '照官方键名写的', command: '(sleep 30 >/dev/null 2>&1 &); echo a' },
      ctxOf(bg),
    )
    await bash.execute({ command: '(sleep 32 >/dev/null 2>&1 &); echo b\necho c' }, ctxOf(bg))
    const labels = bg.snapshot().map((g) => g.label)
    expect(labels).toContain('照官方键名写的')
    expect(labels).toContain('(sleep 32 >/dev/null 2>&1 &); echo b')
    for (const g of bg.snapshot()) bg.terminate(g.pgid)
  })
})
