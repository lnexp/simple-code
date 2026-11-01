import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Message } from '@simple-code/core'
import { openStore } from '@simple-code/core'
import { getSession } from '../../core/src/session/session.ts'
import { groupItems, hydrateItems, splitTurns } from '../webview/events.ts'
import { buildSteps, stepStats } from '../webview/steps.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const text = (role: 'user' | 'assistant', text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})
const call = (id: string): Message => ({
  role: 'assistant',
  parts: [
    { type: 'reasoning', text: `思考 ${id}` },
    { type: 'tool_call', id, name: 'bash', input: { desc: `命令 ${id}`, command: `echo ${id}` } },
  ],
})
const result = (id: string, output: string): Message => ({
  role: 'tool',
  parts: [{ type: 'tool_result', toolCallId: id, output, isError: false }],
})
const marker = '\n[已卸载，完整内容见 .simple-code/memory/turns/001/turn-001001.jsonl]'

function fixture() {
  mkdirSync('.simple-code/tmp/history-tests', { recursive: true })
  const root = mkdtempSync(resolve('.simple-code/tmp/history-tests/case-'))
  roots.push(root)
  const config = join(root, 'settings.json')
  writeFileSync(
    config,
    JSON.stringify({
      provider: 'p',
      model: 'm',
      providers: {
        p: {
          protocol: 'openai-chat',
          baseUrl: 'https://example.invalid',
          apiKey: 'test',
          models: { m: { contextWindow: 100000 } },
        },
      },
    }),
  )
  const store = openStore(root)
  store.beginTurn({ model: 'p/m', effort: null })
  store.save([text('user', '旧问题'), text('assistant', '旧回答')])
  store.pruneMessages([0, 1])
  store.save([])
  store.beginTurn({ model: 'p/m', effort: null })
  const originals = [
    text('user', '开始'),
    call('a'),
    result('a', '输出 a'),
    call('b'),
    result('b', '输出 b'),
    text('assistant', '完成'),
  ]
  store.save(originals)
  // a 两侧卸载；b 只有输出卸载（本次真库确有这种形态）。
  store.unload([1, 2, 4])
  const stubs = structuredClone(originals)
  stubs[1] = {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: '思考 a' },
      {
        type: 'tool_call',
        id: 'a',
        name: 'bash',
        input: { desc: '命令 a', command: `echo${marker}` },
      },
    ],
  }
  stubs[2] = result('a', `输${marker}`)
  stubs[4] = result('b', `输${marker}`)
  store.markStubs(stubs)
  store.save(stubs)
  store.close()
  return { root, config }
}

it('重开面板恢复夹在思考之间的 bash 原文，分页不重放，模型上下文仍是存根', async () => {
  const { root, config } = fixture()
  const session = await getSession(root, { globalPath: config, skipLock: true })
  try {
    const before = JSON.stringify(session.messages())
    expect(before).toContain('已卸载')
    const items = hydrateItems(session.historyRows())
    const tools = items.filter((i) => i.kind === 'tool')
    expect(tools.map((i) => i.id)).toEqual(['a', 'b'])
    expect(tools.map((i) => i.output)).toEqual(['输出 a', '输出 b'])
    expect(items.map((i) => i.kind)).toEqual([
      'user',
      'reasoning',
      'tool',
      'reasoning',
      'tool',
      'assistant',
    ])
    const folded = splitTurns(groupItems(items), true).find((s) => s.kind === 'process')
    const blocks = folded?.kind === 'process' ? folded.blocks : []
    expect(stepStats(buildSteps(blocks.map((block, at) => ({ block, at })))).tools).toBe(2)
    const page = await session.historyPage(null, 1)
    expect(page.next).not.toBeNull()
    const next = await session.historyPage(page.next, 1)
    const past = hydrateItems([...next.rows, ...page.rows])
    expect(past.filter((i) => i.kind === 'tool')).toHaveLength(0)
    expect(past).toContainEqual({ kind: 'user', text: '旧问题' })
    expect(next.next).toBeNull()
    expect(hydrateItems(session.historyRows())).toEqual(items)
    expect(JSON.stringify(session.messages())).toBe(before)
  } finally {
    await session.close()
  }
  const reopened = await getSession(root, { globalPath: config, skipLock: true })
  try {
    expect(hydrateItems(reopened.historyRows()).filter((i) => i.kind === 'tool')).toHaveLength(2)
    expect(
      hydrateItems((await reopened.historyPage(null, 100)).rows).filter((i) => i.kind === 'tool'),
    ).toHaveLength(0)
  } finally {
    await reopened.close()
  }
})
