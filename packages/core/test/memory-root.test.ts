/**
 * P1：memoryRoot 分流（fork-merge.md §3）——记忆落它处、其余全在 root。
 *
 * 只测分流本身：turns/state.db 落 memoryRoot、配置仍读 root。任务的引擎
 * 测试在 task.test.ts。
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { forkTask, scopeOf } from '../src/session/task.ts'
import { getSession } from '../src/session/session.ts'
import { DatabaseSync } from 'node:sqlite'
import { readFixture } from './helpers.ts'

const KEY = 'k'

async function workspace(): Promise<{ dir: string; taskDir: string; globalPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-memroot-'))
  const taskDir = await mkdtemp(join(tmpdir(), 'sc-memroot-task-'))
  // provider/baseUrl/apiKey 在工作区黑名单里（denylist.ts），只认全局——
  // e2e.test.ts 的同款布局：globalPath 是一份 settings.json 文件
  const globalPath = join(dir, 'settings.json')
  await writeFile(
    globalPath,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      providers: {
        p: {
          protocol: 'openai-chat',
          baseUrl: 'https://example.invalid',
          apiKey: '${TEST_KEY}',
          models: { m: { contextWindow: 100_000 } },
        },
      },
      memory: { idleSummarizeDelayMs: 0 },
    }),
    'utf8',
  )
  return { dir, taskDir, globalPath }
}

const bodyOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.subarray(i, i + 64))
      controller.close()
    },
  })

/** 第一轮回放 fixture（一次 bash），之后一律「做完了」收口（e2e.test.ts 同款） */
function fetchImpl(bytes: Uint8Array): typeof fetch {
  const done = [
    'data: {"choices":[{"delta":{"content":"做完了"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  let first = true
  return (async (_url: string | URL | globalThis.Request, _init?: RequestInit) => {
    const payload = first ? bytes : new TextEncoder().encode(done)
    first = false
    return new Response(bodyOf(payload), { status: 200 })
  }) as unknown as typeof fetch
}

describe('memoryRoot 分流', () => {
  it('turns/state.db 落 memoryRoot，root 下没有记忆', async () => {
    const { dir, taskDir, globalPath } = await workspace()
    const bytes = new TextEncoder().encode(String(await readFixture('openai-chat.tool-call.sse')))
    const session = await getSession(dir, {
      globalPath,
      memoryRoot: taskDir,
      env: { TEST_KEY: KEY },
      skipLock: true,
      fetchImpl: fetchImpl(bytes),
    })
    for await (const _ev of session.send('列出当前目录')) {
      // 消费完
    }
    await session.close()

    // 记忆落任务目录：state.db + turn 归档都在 taskDir 下
    expect(existsSync(join(taskDir, '.simple-code/memory/state.db'))).toBe(true)
    const turnArchive = join(taskDir, '.simple-code/memory/turns/000/turn-000001.jsonl')
    expect(existsSync(turnArchive)).toBe(true)
    // root 下没有记忆（目录可能因锁/审批被建出来，但 state.db 不在）
    expect(existsSync(join(dir, '.simple-code/memory/state.db'))).toBe(false)
    // 归档内容是 canonical 消息，和正常落盘同构
    const lines = (await readFile(turnArchive, 'utf8')).trim().split('\n')
    const first = lines.shift()
    expect(first !== undefined && JSON.parse(first).role).toBe('user')
  })
})

describe('任务跑超（task-v3 配额闸，session.send 入口）', () => {
  it('turns 段满：send 入口即拒（不写 turns）、可重复拒绝——只能关闭', async () => {
    const { dir, globalPath } = await workspace()
    const bytes = new TextEncoder().encode(String(await readFixture('openai-chat.tool-call.sse')))
    const opts = {
      globalPath,
      env: { TEST_KEY: KEY },
      skipLock: true,
      fetchImpl: fetchImpl(bytes),
    }
    // 对话真跑一轮（fork 的继承面要有内容）
    const main = await getSession(dir, opts)
    for await (const _ev of main.send('列出当前目录')) {
      // 消费完
    }
    await main.close()
    // 真 fork：reserved 锚行在 forkTurn+1000
    const m = forkTask(dir, '长跑任务')
    // 把 turns 段填满：锚行之后插满到 turnCeil（alloc.turn 见 n >= turnCeil 即抛）
    const db = new DatabaseSync(join(dir, '.simple-code/memory/state.db'))
    const ins = db.prepare(
      `INSERT INTO turns(id, started_at, state, meta, elapsed_ms, owner) VALUES (?, ?, 'live', NULL, NULL, ?)`,
    )
    for (let id = m.forkTurn + 1; id < m.turnCeil; id++) {
      ins.run(id, '2026-09-23T00:00:00Z', m.owner)
    }
    db.close()

    const task = await getSession(dir, { ...opts, task: scopeOf(m) })
    const readErr = async (): Promise<string[]> => {
      const errors: string[] = []
      for await (const ev of task.send('再来一轮')) {
        if (ev.type === 'error') errors.push(ev.message)
      }
      return errors
    }
    const errors = await readErr()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('跑超')
    expect(errors[0]).toContain('只能关闭')
    // 再发还是拒——停了就是停了
    expect((await readErr())[0]).toContain('只能关闭')
    await task.close()

    // beginTurn 从未发生：段内一个新行都没写（段满前插的那些不算——
    // 检查没有 id 落在插入批之后：max 仍 = turnCeil-1）
    const db2 = new DatabaseSync(join(dir, '.simple-code/memory/state.db'))
    const max = db2.prepare('SELECT MAX(id) AS m FROM turns WHERE owner = ?').get(m.owner) as {
      m: number
    }
    db2.close()
    expect(max.m).toBe(m.turnCeil - 1)
  })
})
