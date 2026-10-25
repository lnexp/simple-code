import { utimesSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleContext, type LiveMessage } from '../src/loop/assemble.ts'
import {
  buildSelectorRequest,
  loadSelectorCandidates,
  parseKeywords,
  parseSelection,
  previousReply,
  readInContext,
  renderSelection,
  SELECTOR_CONTEXT_CHARS,
  SELECTOR_TOP_K,
  type SelectorCandidate,
} from '../src/session/selector.ts'
import { openStore } from '../src/session/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-selector-'))
  dirs.push(dir)
  return dir
}

const writeLesson = (root: string, name: string, description: string) =>
  writeFile(
    join(root, '.simple-code', 'lessons', `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  )

describe('候选加载', () => {
  it('四库全量，常驻的也算（拍板②）；作废 note 不进', async () => {
    const root = await workspace()
    for (const d of ['notes', 'events', 'lessons'])
      await mkdir(join(root, '.simple-code', d), { recursive: true })
    // 21 条 note / 31 条 event：超过常驻索引条数，cue 时代只进最老的一条
    for (let i = 0; i < 21; i++)
      await writeFile(
        join(root, '.simple-code', 'notes', `n${i}.md`),
        `---\nname: n${i}\ndescription: 描述${i}\ncreated: 2026-09-25T00:${String(i).padStart(2, '0')}:00Z\n---\n\n正文`,
      )
    await writeFile(
      join(root, '.simple-code', 'notes', 'sup.md'),
      `---\nname: sup\ndescription: 被推翻的\ncreated: 2026-09-26T00:00:00Z\nstatus: superseded\n---\n\n正文`,
    )
    for (let i = 0; i < 31; i++)
      await writeFile(
        join(root, '.simple-code', 'events', `e${i}.md`),
        `---\nname: e${i}\ndescription: 事件${i}\ncreated: 2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z\n---\n\n# e${i} — 事件${i}\n`,
      )
    await writeLesson(root, 'env-pair', '改 env 白名单要成对改注入')
    await mkdir(join(root, '.simple-code', 'skills', 'demo-skill'), { recursive: true })
    await writeFile(
      join(root, '.simple-code', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: 演示\n---\n\n正文',
    )
    const candidates = loadSelectorCandidates(root)
    const of = (kind: string) => candidates.filter((c) => c.kind === kind).map((c) => c.name)
    expect(of('skill')).toContain('demo-skill')
    // listSkills 尾行「可选组件（未随包）…」不是 skill
    expect(of('skill').filter((n) => n.includes('可选组件'))).toEqual([])
    expect(of('note')).toHaveLength(21)
    expect(of('note')).not.toContain('sup')
    expect(of('event')).toHaveLength(31)
    // 每类诞生时间旧→新：新条目落节末，前缀不动
    expect(of('event').slice(0, 3)).toEqual(['e0', 'e1', 'e2'])
    expect(of('event').at(-1)).toBe('e30')
    expect(candidates.find((c) => c.name === 'env-pair')).toEqual({
      kind: 'lesson',
      name: 'env-pair',
      text: '改 env 白名单要成对改注入',
    })
  })
  it('时间衰减：超半年的 note/lesson/event 不进候选（memory-time-decay ②）', async () => {
    const root = await workspace()
    for (const d of ['notes', 'events', 'lessons'])
      await mkdir(join(root, '.simple-code', d), { recursive: true })
    await writeFile(
      join(root, '.simple-code', 'notes', 'old-note.md'),
      '---\nname: old-note\ndescription: 旧结论\ncreated: 2020-01-01 00:00:00\n---\n\n正文',
    )
    await writeFile(
      join(root, '.simple-code', 'events', 'old-ev.md'),
      '---\nname: old-ev\ndescription: 旧事件\ncreated: 2020-01-01 00:00:00\n---\n\n# old-ev — 旧事件\n',
    )
    await writeLesson(root, 'old-lesson', '旧教训')
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(root, '.simple-code', 'lessons', 'old-lesson.md'), old, old)
    const names = loadSelectorCandidates(root).map((c) => c.name)
    expect(names).not.toContain('old-note')
    expect(names).not.toContain('old-ev')
    expect(names).not.toContain('old-lesson')
  })
})

describe('请求与解析', () => {
  const candidates: SelectorCandidate[] = [
    { kind: 'lesson', name: 'env-pair', text: '改 env 白名单要成对改注入' },
    { kind: 'note', name: 'prefix-guard', text: '只有压缩点能改写前缀' },
    { kind: 'event', name: 'prefix-guard', text: '同名的事件档案' },
    { kind: 'skill', name: 'deploy', text: '装机' },
    { kind: 'note', name: 'extra', text: '第四条' },
  ]

  it('两条消息：索引（分节，skill/event 只给名字）在前、交互在后；上一条回复只留末尾', () => {
    const previous = `开头不要${'x'.repeat(SELECTOR_CONTEXT_CHARS)}`
    const req = buildSelectorRequest(
      candidates,
      { user: '可以，开始实现吧', previous },
      {
        model: 's',
        maxTokens: 100,
        thinking: 'disabled',
        effort: 'none',
        reasoningDisplay: 'omitted',
      },
    )
    expect(req.messages.map((m) => m.role)).toEqual(['user', 'user'])
    const index = (req.messages[0]?.parts[0] as { text: string }).text
    const text = (req.messages[1]?.parts[0] as { text: string }).text
    expect(index).toBe(
      '【lesson 教训】\nenv-pair — 改 env 白名单要成对改注入\n\n【note 结论】\nprefix-guard — 只有压缩点能改写前缀\nextra — 第四条\n\n【skill 技能】\ndeploy\n\n【event 事件档案】\nprefix-guard',
    )
    expect(text.indexOf('【用户新消息】\n可以，开始实现吧')).toBeGreaterThan(
      text.indexOf('【上一条助手回复（末尾）】'),
    )
    expect(text).not.toContain('开头不要')
    expect(req.tools).toEqual([])
    // 没有上一条回复（会话第一轮）：不出空段
    const first = buildSelectorRequest(candidates, { user: 'hi', previous: '' }, req)
    expect((first.messages[1]?.parts[0] as { text: string }).text).toBe('【用户新消息】\nhi')
  })

  it('解析：容忍列表符号/编号/反引号/类别词；编造的丢；去重；截到 K', () => {
    expect(parseSelection('无', candidates)).toEqual([])
    expect(parseSelection('不存在的名字\nenv-pairs', candidates)).toEqual([])
    const picked = parseSelection(
      '- `env-pair`\n2. note prefix-guard\nenv-pair\n* deploy\nextra',
      candidates,
    )
    expect(picked.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'lesson:env-pair',
      'note:prefix-guard',
      'skill:deploy',
    ])
    expect(picked).toHaveLength(SELECTOR_TOP_K)
    // 同名跨库：带了类别词就按类别认
    expect(parseSelection('event prefix-guard', candidates)[0]?.kind).toBe('event')
  })

  it('关键词：剥行、中英分隔符、留空、截长——关键词撞索引名时不被当成选择', () => {
    const plain = parseKeywords('无\n关键词: quuxworthy, cacheTtl、session_close')
    expect(plain.keywords).toEqual(['quuxworthy', 'cacheTtl', 'session_close'])
    expect(plain.body).toBe('无\n')
    // 留空：诚实出空
    expect(parseKeywords('无\n关键词: ').keywords).toEqual([])
    expect(parseKeywords('无').keywords).toEqual([]) // 没有该行 = 空
    // 关键词恰好等于索引名：关键词行剥掉后不把它当成选择（名字行只算一次）
    const { body, keywords } = parseKeywords('env-pair\n关键词: env-pair')
    expect(keywords).toEqual(['env-pair'])
    expect(parseSelection(body, candidates)).toHaveLength(1)
    // 容忍**关键词**、中文冒号、顿号句尾
    expect(parseKeywords('**关键词**：部署、发布。').keywords).toEqual(['部署', '发布'])
    // 过短碎片丢、去重、截到 8
    expect(parseKeywords('关键词: a, 好, 好, k1, k2, k3, k4, k5, k6, k7, k8, k9').keywords).toEqual(
      ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'],
    )
  })

  it('成品行带〔recall·async〕标记，与 n-gram 的〔recall〕区分', () => {
    expect(renderSelection([candidates[0]!])).toEqual([
      '〔recall·async〕lesson env-pair — 改 env 白名单要成对改注入',
    ])
  })

  it('上一条回复：取最后一条有文字的 assistant——被打断的轮以纯 tool_call 收尾（10-12 评测 t16629/t16646）', () => {
    expect(
      previousReply([
        { role: 'assistant', parts: [{ type: 'text', text: '更早的' }] },
        { role: 'user', parts: [{ type: 'text', text: '问' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '想' },
            { type: 'text', text: '方案：先抓包' },
            { type: 'tool_call', id: 'a', name: 'bash', input: {} },
          ],
        },
        { role: 'tool', parts: [{ type: 'tool_result', id: 'a', output: 'ok' }] },
        { role: 'assistant', parts: [{ type: 'tool_call', id: 'b', name: 'bash', input: {} }] },
        { role: 'user', parts: [{ type: 'text', text: '这次我执行了' }] },
      ] as never),
    ).toBe('方案：先抓包')
    expect(previousReply([{ role: 'user', parts: [{ type: 'text', text: '第一句' }] }])).toBe('')
  })

  it('在场已 read 的条目：认四类 bin 的 read，不认 search/非 bash', () => {
    const call = (name: string, command: string) =>
      ({
        role: 'assistant',
        parts: [{ type: 'tool_call', id: command, name, input: { command } }],
      }) as never
    const got = readInContext([
      call('bash', '"$SIMPLE_CODE_NOTE" read recall-llm-selector-pending | grep -n x'),
      call(
        'bash',
        'cd x && "$SIMPLE_CODE_LESSON" read env-pair; "${SIMPLE_CODE_EVENT}" read cue-zero',
      ),
      call('bash', '"$SIMPLE_CODE_NOTE" search prefix-guard'),
      call('view_image', '"$SIMPLE_CODE_SKILL" read deploy'),
    ])
    expect(got).toEqual(
      new Set(['note:recall-llm-selector-pending', 'lesson:env-pair', 'event:cue-zero']),
    )
  })
})

describe('装配渲染（纯函数）', () => {
  const live = (
    stepId: number,
    role: 'user' | 'assistant' | 'tool',
    text: string,
  ): LiveMessage => ({
    message: { role, parts: [{ type: 'text', text }] },
    turnId: 1,
    stepId,
  })
  const cue = new Map([[2, { after: 2, lines: ['〔recall·async〕lesson x — y'] }]])
  const texts = (out: ReturnType<typeof assembleContext>) =>
    out.map((m) => `${m.role}:${(m.parts[0] as { text: string }).text}`)

  it('插在该 step 第 after 条之后，另起一条 user 消息', () => {
    const out = assembleContext(
      [
        live(1, 'user', '问'),
        live(2, 'assistant', '调工具'),
        live(2, 'tool', '结果'),
        live(3, 'assistant', '答'),
      ],
      [],
      new Map(),
      new Map(),
      cue,
    )
    expect(texts(out)).toEqual([
      'user:问',
      'assistant:调工具',
      'tool:结果',
      'user:〔recall·async〕lesson x — y',
      'assistant:答',
    ])
  })

  it('同 step 之后再并进消息（续接轮的新 user）：注入位置不漂', () => {
    const out = assembleContext(
      [live(2, 'assistant', '调工具'), live(2, 'tool', '结果'), live(2, 'user', '继续')],
      [],
      new Map(),
      new Map(),
      cue,
    )
    expect(texts(out)).toEqual([
      'assistant:调工具',
      'tool:结果',
      'user:〔recall·async〕lesson x — y',
      'user:继续',
    ])
  })

  it('锚定的消息不在了（块短于 after）：不渲染', () => {
    const out = assembleContext([live(2, 'assistant', '调工具')], [], new Map(), new Map(), cue)
    expect(texts(out)).toEqual(['assistant:调工具'])
  })
})

describe('落库（store）', () => {
  it('saveAsyncCue → asyncCues；一轮一条，重写无效', async () => {
    const store = openStore(await workspace())
    store.saveAsyncCue(7, { stepId: 30, after: 2, lines: ['行A'], names: ['lesson:a'] })
    store.saveAsyncCue(7, { stepId: 31, after: 1, lines: ['行B'], names: ['lesson:b'] })
    expect([...store.asyncCues()]).toEqual([[30, { after: 2, lines: ['行A'] }]])
    store.close()
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

describe('session e2e：异步注入', () => {
  type Body = {
    system?: unknown
    messages: { role: string; content: { type: string; text?: string }[] }[]
  }
  const recallIndex = (body: Body) =>
    body.messages.findIndex((m) =>
      m.content.some((c) => c.type === 'text' && c.text?.startsWith('〔recall·async〕')),
    )

  const setup = async () => {
    const { getSession } = await import('../src/session/session.ts')
    const { readFixture } = await import('./helpers.ts')
    const dir = await workspace()
    await mkdir(join(dir, '.simple-code', 'lessons'), { recursive: true })
    await writeLesson(dir, 'lesson-alpha', '改 alpha 前必读')
    const toolSse = new TextDecoder().decode(await readFixture('anthropic-messages.tool-call.sse'))
    const main: Body[] = []
    let selectorCalls = 0
    const impl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body
      if (JSON.stringify(body.system).includes('检索选择器')) {
        selectorCalls++
        return new Response(textSse('lesson-alpha'))
      }
      main.push(body)
      // 每轮：前两步调工具，第三步收尾。第二轮起换成 ls -a：同一个 ls 跨轮
      // 连续三次会被死循环熔断（按历史判，重开会话也算）
      const tool =
        main.length > 3
          ? toolSse.replace('"partial_json":"s\\"}"', '"partial_json":"s -a\\"}"')
          : toolSse
      return new Response(main.length % 3 === 0 ? textSse('完成') : tool)
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
    const open = () => getSession(dir, { globalPath, skipLock: true, fetchImpl: impl })
    return { open, main, selectorCalls: () => selectorCalls }
  }

  it('step 1 不注入；step 2 注入在工具结果之后；step 3 原位不动；前缀守卫不报', async () => {
    const { open, main, selectorCalls } = await setup()
    const session = await open()
    const events: { type: string; message?: string }[] = []
    for await (const ev of session.send('改一下 alpha'))
      events.push(ev as { type: string; message?: string })
    await session.close()
    expect(selectorCalls()).toBe(1)
    expect(main).toHaveLength(3)
    expect(recallIndex(main[0]!)).toBe(-1) // 模型还没动手
    const at = recallIndex(main[1]!)
    expect(at).toBe(main[1]!.messages.length - 1) // 末尾追加
    expect(main[1]!.messages[at - 1]?.content.some((c) => c.type === 'tool_result')).toBe(true)
    expect(recallIndex(main[2]!)).toBe(at) // 下一步原位
    expect(JSON.stringify(main[2]!.messages[at])).toContain(
      '〔recall·async〕lesson lesson-alpha — 改 alpha 前必读',
    )
    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('会话重建后从 async_cues 贴回原位（不贴回 = 下一请求 PrefixBroken）', async () => {
    const { open, main } = await setup()
    const first = await open()
    for await (const _ of first.send('改一下 alpha')) void _
    await first.close()
    const at = recallIndex(main[2]!)
    expect(at).toBeGreaterThan(0) // 前提：第一轮真注入了（否则下面的「相等」是 -1 === -1）
    const second = await open()
    const events: { type: string }[] = []
    for await (const ev of second.send('再看看')) events.push(ev as { type: string })
    await second.close()
    expect(recallIndex(main[3]!)).toBe(at)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('上一轮注入还在场：同名不再注入（10-12 同 3 条连续 4 轮）', async () => {
    const { open, main, selectorCalls } = await setup()
    // 两轮之间重开：fixture 每步都是同一个 ls，同会话第二轮会被死循环熔断；
    // 重开也顺带验证「已注入」是从库里读回的，不是内存状态
    for (const text of ['改一下 alpha', '再改改 alpha']) {
      const session = await open()
      for await (const _ of session.send(text)) void _
      await session.close()
    }
    expect(selectorCalls()).toBe(2) // 前提：第二轮也选了 lesson-alpha
    expect(main.length).toBeGreaterThanOrEqual(5) // 前提：第二轮有 step 2（注入点）
    const count = (body: Body) =>
      body.messages.filter((m) =>
        m.content.some((c) => c.type === 'text' && c.text?.startsWith('〔recall·async〕')),
      ).length
    expect(count(main[2]!)).toBe(1)
    expect(count(main.at(-1)!)).toBe(1) // 只有第一轮那条
  })
})
