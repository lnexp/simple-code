/**
 * 任务也跑 recall（2026-11-20 用户：「任务要运行 recall，不管触发任务的是
 * SC 自己，还是人工开的任务」）。锁定：
 *
 * - 任务会话发选择器请求、注入〔recall·async〕，动作联想同样提
 * - 注入按 owner 落库：主任务看不到任务的，任务的去重不算主任务的
 * - 重开任务会话从库里原位贴回，前缀守卫不报
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getSession } from '../src/session/session.ts'
import { openStore } from '../src/session/store.ts'
import { createTask, scopeOf } from '../src/session/task.ts'
import { readFixture } from './helpers.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-task-recall-'))
  dirs.push(dir)
  return dir
}

describe('落库：注入按 owner 分开', () => {
  it('任务写的主任务看不到；任务渲染读得到主任务的；任务去重只算自己的', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    main.saveAsyncCue(1, { stepId: 30, after: 1, lines: ['主A'], names: ['lesson:a'] })
    const task = openStore(dir, { task: scopeOf(createTask(dir, 'A')) })
    task.saveAsyncCue(2, { stepId: 9000, after: 1, lines: ['任B'], names: ['lesson:b'] })
    task.saveTouchCue({ stepId: 9001, after: 1, lines: ['任C'], names: ['note:c'] })
    expect([...main.asyncCues().keys()]).toEqual([30])
    expect(main.asyncCuedNamesSince(0)).toEqual(new Set(['lesson:a']))
    expect([...task.asyncCues().keys()].sort((a, b) => a - b)).toEqual([30, 9000, 9001])
    expect(task.asyncCuedNamesSince(0)).toEqual(new Set(['lesson:b', 'note:c']))
    main.close()
    task.close()
  })
})

const textSse = (text: string) =>
  [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')

type Body = {
  system?: unknown
  messages: { role: string; content: { type: string; text?: string }[] }[]
}
const RECALL = '〔recall·async〕'
const recallIndex = (body: Body) =>
  body.messages.findIndex((m) =>
    m.content.some((c) => c.type === 'text' && c.text?.startsWith(RECALL)),
  )

async function setup() {
  const dir = await workspace()
  await mkdir(join(dir, '.simple-code', 'lessons'), { recursive: true })
  const lesson = (name: string, description: string) =>
    writeFile(
      join(dir, '.simple-code', 'lessons', `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    )
  await lesson('lesson-alpha', '改 alpha 前必读')
  await lesson('lesson-ctl', '跑 alphactl 前必读')
  const rawSse = new TextDecoder().decode(await readFixture('anthropic-messages.tool-call.sse'))
  const toolSse = (tail: string) =>
    rawSse.replace('"partial_json":"s\\"}"', `"partial_json":"s${tail}\\"}"`)
  const requests: Body[] = []
  let selectorCalls = 0
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body
    if (JSON.stringify(body.system).includes('检索选择器')) {
      selectorCalls++
      return new Response(textSse('lesson-alpha'))
    }
    requests.push(body)
    // 每轮前两步调工具、第三步收尾；第二轮换命令，躲开跨轮同命令的死循环熔断
    if (requests.length % 3 === 0) return new Response(textSse('完成'))
    return new Response(toolSse(requests.length > 3 ? ' -a; alphactl' : '; alphactl'))
  }) as unknown as typeof fetch
  const globalPath = join(dir, 'settings.json')
  await writeFile(
    globalPath,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      providers: {
        p: {
          protocol: 'anthropic-messages',
          baseUrl: 'https://example.invalid',
          apiKey: 'k',
          models: { m: { contextWindow: 100_000 } },
        },
      },
      memory: { idleSummarizeDelayMs: 0 },
      recall: { mode: 'on' },
    }),
    'utf8',
  )
  return { dir, globalPath, impl, requests, selectorCalls: () => selectorCalls }
}

describe('session e2e：任务也跑 recall', () => {
  it.each([
    ['人工开的任务', { userTouched: true }],
    ['agent 派的任务', { parent: '' }],
  ] as const)('%s：选择器与动作联想都注入；重开原位贴回、前缀守卫不报', async (_label, opts) => {
    const { dir, globalPath, impl, requests, selectorCalls } = await setup()
    openStore(dir).close() // 建库：createTask 要先有主干
    const task = scopeOf(createTask(dir, 'T', opts))
    const open = () => getSession(dir, { globalPath, skipLock: true, fetchImpl: impl, task })
    const errors: unknown[] = []
    const first = await open()
    for await (const ev of first.send('改一下 alpha')) if (ev.type === 'error') errors.push(ev)
    await first.close()
    expect(selectorCalls()).toBe(1)
    expect(requests).toHaveLength(3)
    expect(recallIndex(requests[0]!)).toBe(-1)
    const at = recallIndex(requests[1]!)
    expect(at).toBe(requests[1]!.messages.length - 1)
    expect(requests[1]!.messages[at]!.content.map((c) => c.text ?? '').join('')).toBe(
      `${RECALL}lesson lesson-alpha — 改 alpha 前必读\n${RECALL}lesson lesson-ctl — 跑 alphactl 前必读（触及: alphactl）`,
    )
    const second = await open()
    for await (const ev of second.send('再看看')) if (ev.type === 'error') errors.push(ev)
    await second.close()
    expect(requests.length).toBeGreaterThan(3) // 前提：第二轮真发了请求
    expect(recallIndex(requests[3]!)).toBe(at)
    expect(errors).toEqual([])
    const trunk = openStore(dir)
    expect(trunk.asyncCues().size).toBe(0) // 主任务视图里没有任务的注入
    trunk.close()
  })
})
