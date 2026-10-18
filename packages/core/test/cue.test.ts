import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import { assembleContext, type LiveMessage, type Summary } from '../src/loop/assemble.ts'
import { loadCueCandidates, matchSummaries } from '../src/session/cue.ts'
import { openStore } from '../src/session/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-cue-'))
  dirs.push(dir)
  return dir
}

describe('关键词匹配引擎（2026-10-14 换芯：n-gram → 模型关键词）', () => {
  const candidates = [
    { kind: 'summary', name: 't1', text: 'dev 构建发布验证全绿收口' },
    { kind: 'summary', name: 't2', text: '全角空格归一化修复' },
    { kind: 'summary', name: 't3', text: 'DEV 构建失败排查' },
  ]

  it('子串命中、大小写不敏感；命中多的排前，平手按名字序（确定性）', () => {
    const { names } = matchSummaries(candidates, ['构建', 'dev'], { topK: 3 })
    // t1/t3 各中两个词并列，名字序 t1 前；t2 零命中不出现
    expect(names).toEqual(['t1', 't3'])
  })

  it('行格式：〔recall·async〕标记 + 命中词给证据（报碰撞）', () => {
    const { lines } = matchSummaries(candidates, ['构建'], { topK: 1 })
    expect(lines[0]).toBe('〔recall·async〕summary t1 — dev 构建发布验证全绿收口（命中: 构建）')
  })

  it('空关键词零行：诚实不出行（无相关历史）', () => {
    expect(matchSummaries(candidates, [], { topK: 2 }).lines).toEqual([])
  })

  it('无命中的关键词零行', () => {
    expect(matchSummaries(candidates, ['毫不相干'], { topK: 2 }).lines).toEqual([])
  })

  it('topK 封顶 + excludeNames 去重（占名额的在入场前就排掉）', () => {
    const out = matchSummaries(candidates, ['构建'], { topK: 2 })
    expect(out.names).toEqual(['t1', 't3'])
    const deduped = matchSummaries(candidates, ['构建'], { topK: 2, excludeNames: new Set(out.names) })
    expect(deduped.lines).toEqual([]) // 剩下的 t2 本来就零命中
  })
})

describe('候选加载', () => {
  it('只有 summary，且只进不在场的', () => {
    const summaries: Summary[] = [
      { id: 1, level: 0, coversFrom: 100, coversTo: 110, turnFrom: 10, turnTo: 10, name: '在场段', text: '', status: 'ready', owner: null, inContext: true, supersededBy: null, head: '在场的开头', archivePath: null },
      { id: 2, level: 0, coversFrom: 200, coversTo: 210, turnFrom: 20, turnTo: 20, name: '暗段标题', text: '', status: 'ready', owner: null, inContext: false, supersededBy: null, head: '暗段的开头', archivePath: null },
      // 跨 turn 的写成 t起-止（2026-09-30 起 turn 号；之前是 t<起始 step id>）
      { id: 3, level: 0, coversFrom: 300, coversTo: 390, turnFrom: 30, turnTo: 33, name: '跨段', text: '', status: 'ready', owner: null, inContext: false, supersededBy: null, head: '跨段开头', archivePath: null },
      // 内部节点不进：name 空、head 取自首成员，候选文本是首成员的子集——
      // 与它一起撞中、名字不同去重拦不住（2026-09-30 实测最近 70 轮 15 轮重复）
      { id: 4, level: 1, coversFrom: 200, coversTo: 390, turnFrom: 20, turnTo: 33, name: '', text: '路由行', status: 'ready', owner: null, inContext: false, supersededBy: null, head: '暗段的开头', archivePath: null },
      // 覆盖到在场原文（coversTo ≥ liveFloor）：L0 已写好未进场，原文就在上下文里
      { id: 5, level: 0, coversFrom: 495, coversTo: 505, turnFrom: 50, turnTo: 50, name: '在场原文段', text: '', status: 'ready', owner: null, inContext: false, supersededBy: null, head: '近轮开头', archivePath: null },
    ]
    const candidates = loadCueCandidates(summaries, 500)
    expect(new Set(candidates.map((c) => c.kind))).toEqual(new Set(['summary']))
    const names = candidates.map((c) => c.name)
    // summary：不在场的进、在场的（摘要区已渲染）不进
    expect(names).toContain('t20')
    expect(names).toContain('t30-33')
    expect(names).not.toContain('t20-33')
    expect(names).not.toContain('t10')
    expect(names).not.toContain('t50')
    expect(loadCueCandidates(summaries, null).map((c) => c.name)).toContain('t50')
  })
})

describe('cue 渲染（装配纯函数——cues 表历史行继续渲染）', () => {
  const live = (turnId: number, role: Message['role'], text: string): LiveMessage => ({
    message: { role, parts: [{ type: 'text', text }] },
    turnId,
    stepId: turnId,
  })

  it('cue 行贴在该 turn 的 user 消息尾部；没 cue 的 turn 原样', () => {
    const messages = [live(1, 'user', '问题一'), live(1, 'assistant', '答'), live(2, 'user', '问题二')]
    const cues = new Map([[1, ['〔recall〕note x — 描述（命中: y）']]])
    const out = assembleContext(messages, [], new Map(), cues)
    expect(out[0]).toEqual({
      role: 'user',
      parts: [
        { type: 'text', text: '问题一' },
        { type: 'text', text: '〔recall〕note x — 描述（命中: y）' },
      ],
    })
    expect(out[2]).toEqual({ role: 'user', parts: [{ type: 'text', text: '问题二' }] })
  })

  it('复现性：同一输入两次装配字节一致（prefix-guard 的前提）', () => {
    const messages = [live(1, 'user', '问题'), live(2, 'user', '再来')]
    const cues = new Map<number, readonly string[]>([[1, ['〔recall〕note a — x']]])
    const a = JSON.stringify(assembleContext(messages, [], new Map(), cues))
    const b = JSON.stringify(assembleContext(messages, [], new Map(), cues))
    expect(a).toBe(b)
  })
})

describe('关键词撞摘要（session e2e）', () => {
  type Body = { system?: unknown; messages: { role: string; content: { type: string; text?: string }[] }[] }
  const recallIndex = (body: Body) =>
    body.messages.findIndex((m) => m.content.some((c) => c.type === 'text' && c.text?.startsWith('〔recall·async〕')))

  const setup = async () => {
    const { getSession } = await import('../src/session/session.ts')
    const { readFixture } = await import('./helpers.ts')
    const dir = await workspace()
    await mkdir(join(dir, '.simple-code', 'lessons'), { recursive: true })
    await writeFile(
      join(dir, '.simple-code', 'lessons', 'lesson-alpha.md'),
      '---\nname: lesson-alpha\ndescription: 改 alpha 前必读\n---\n\n# lesson-alpha\n',
      'utf8',
    )
    seedDarkSummary(dir)
    const toolSse = new TextDecoder().decode(await readFixture('anthropic-messages.tool-call.sse'))
    const main: Body[] = []
    let selectorCalls = 0
    const impl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body
      if (JSON.stringify(body.system).includes('检索选择器')) {
        selectorCalls++
        return new Response(textSse('无\n关键词: quuxworthy, 别的'))
      }
      main.push(body)
      // 第二轮起换成 ls -a：同一个 ls 跨轮连续三次会被死循环熔断（按
      // 历史判，重开会话也算）
      const tool = main.length > 3 ? toolSse.replace('"partial_json":"s\\"}"', '"partial_json":"s -a\\"}"') : toolSse
      return new Response(main.length % 3 === 0 ? textSse('完成') : tool)
    }) as unknown as typeof fetch
    const globalPath = join(dir, 'settings.json')
    const base = {
      provider: 'p',
      model: 'm',
      providers: {
        p: { protocol: 'anthropic-messages', baseUrl: 'https://example.invalid', apiKey: 'k', models: { m: { contextWindow: 100_000 } } },
      },
      memory: { idleSummarizeDelayMs: 0 },
    }
    const open = async (mode: 'on' | 'shadow') => {
      await writeFile(globalPath, JSON.stringify({ ...base, recall: { mode } }), 'utf8')
      return getSession(dir, { globalPath, skipLock: true, fetchImpl: impl })
    }
    return { open, main, selectorCalls: () => selectorCalls, dir }
  }

  it('on：关键词撞出暗摘要 step 2 注入、step 3 原位；次轮在场去重不再注入', async () => {
    const { open, main, selectorCalls, dir } = await setup()
    for (const text of ['改一下 alpha', '再改改']) {
      const session = await open('on')
      for await (const _ of session.send(text)) void _
      await session.close()
    }
    expect(selectorCalls()).toBe(2)
    // 第一轮：注入在 step 2 的工具结果之后，step 3 原位
    expect(recallIndex(main[0]!)).toBe(-1)
    const at = recallIndex(main[1]!)
    expect(at).toBeGreaterThan(0)
    expect(JSON.stringify(main[1]!.messages[at])).toContain('〔recall·async〕summary t')
    expect(JSON.stringify(main[1]!.messages[at])).toContain('quuxworthy')
    expect(recallIndex(main[2]!)).toBe(at)
    // 第二轮：上一轮注入的摘要还在场（liveFloor 之后），入场前就被排掉，
    // 关键词又没撞出别的——async_cues 仍只有第一轮那一行（无新注入）。
    // 请求里出现的线索行是第一轮注入的原位回放（前缀不变式），位置不动
    expect(main.slice(3).every((b) => recallIndex(b) === at)).toBe(true)
    const db = new DatabaseSync(join(dir, '.simple-code', 'memory', 'state.db'))
    const rows = db.prepare(`SELECT turn_id FROM async_cues`).all()
    db.close()
    expect(rows).toHaveLength(1)
  })

  it('shadow：选择器不发请求、无注入；cues 表不再写入', async () => {
    const { open, main, selectorCalls, dir } = await setup()
    const session = await open('shadow')
    for await (const _ of session.send('看看 quuxworthy')) void _
    await session.close()
    expect(selectorCalls()).toBe(0)
    for (const body of main) expect(recallIndex(body)).toBe(-1)
    const db = new DatabaseSync(join(dir, '.simple-code', 'memory', 'state.db'))
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM cues`).all() as { n: number }[]
    db.close()
    expect(rows[0]!.n).toBe(0)
  })
})

/** 预先在库里种几条不在场（in_context=0）的 L0 摘要，第一条带独一份的词 */
function seedDarkSummary(dir: string): void {
  const store = openStore(dir)
  // 暗摘要覆盖的原文早已卸载：让 session 新建的 step 从 101 起，否则
  // 1..6 正是在场原文，被 liveFloor 正确排除
  store.close()
  const raw = new DatabaseSync(join(dir, '.simple-code', 'memory', 'state.db'))
  raw.exec(`INSERT INTO sqlite_sequence(name, seq) VALUES('steps', 100)`)
  raw.close()
  const reopened = openStore(dir)
  for (let i = 0; i < 6; i++)
    reopened.addSummary({
      level: 0,
      coversFrom: i + 1,
      coversTo: i + 1,
      name: i === 0 ? 'quuxworthy 独一份线索' : `普通段落${i}`,
      text: '正文',
      status: 'ready',
      inContext: false,
      supersededBy: null,
      head: `开头${i}`,
      archivePath: null,
    })
  reopened.close()
}

const textSse = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const json = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
      controller.enqueue(
        new TextEncoder().encode(
          `event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\nevent: content_block_delta\ndata: ${json}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
        ),
      )
      controller.close()
    },
  })
