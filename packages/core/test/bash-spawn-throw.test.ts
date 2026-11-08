// spawn 同步 throw（南夷非 7 天日志 70 次 spawn EBADF）不得炸穿「工具
// 永不抛」契约——run.ts 的工具调用只有 finally 没有 catch，同步 throw
// 直接终止整轮 turn。这条用 mock 复现：spawn 抛 EBADF，execute 应返回
// 工具错误而不是 reject
import { expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return {
    ...orig,
    spawn: () => {
      throw new Error('spawn EBADF')
    },
  }
})

import { createBashTool } from '../src/tools/bash.ts'
import type { ToolContext } from '../src/tools/types.ts'

const bash = createBashTool({
  defaultTimeoutMs: 1000,
  maxTimeoutMs: 2000,
  maxOutputChars: 16_000,
  killGraceMs: 200,
  envPassthrough: ['PATH', 'HOME'],
})

it('spawn 同步抛 EBADF 时返回工具错误，不 reject', async () => {
  const ctx: ToolContext = { root: '/tmp', signal: new AbortController().signal }
  const r = await bash.execute({ command: 'echo hi', desc: '测试' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.exitCode).toBe(-1)
  expect(r.output).toContain('命令无法启动')
  expect(r.output).toContain('spawn EBADF')
})
