import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import { assembleContext, type LiveMessage, type Summary } from '../src/loop/assemble.ts'
import { buildCues, cueTokens, loadCueCandidates, wordScores } from '../src/session/cue.ts'
import { openStore, type Store } from '../src/session/store.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-cue-'))
  dirs.push(dir)
  return dir
}

describe('cue 引擎', () => {
  it('切词：中文 bigram + 驼峰切分 + 小写', () => {
    expect(cueTokens('压缩点卸载')).toEqual(['压缩', '缩点', '点卸', '卸载'])
    expect(cueTokens('bridgeTask')).toEqual(['bridge', 'task'])
    expect(cueTokens('prefix-guard.ts')).toEqual(['prefix', 'guard', 'ts'])
    expect(cueTokens('A')).toEqual([]) // <2 的碎片丢
  })

  it('词分：新近压旧（半衰期）、每轮每词只计一次', () => {
    const halfLife = 10
    // 衰减：同词碰了 5 轮，最近一轮的权重应高于 5 轮前
    const s1 = wordScores(['bridge', '', '', '', '', 'bridge'], halfLife)
    expect(s1.get('bridge')).toBeCloseTo(2 ** 0 + 2 ** -0.5, 5)
    // presence：一轮里 50 次 ≠ 50 分；五轮各一次 > 一轮一次
    const s2 = wordScores([`${'x '.repeat(25)}bridge ${'bridge '.repeat(25)}`], halfLife)
    expect(s2.get('bridge')).toBe(1)
    const s3 = wordScores(['bridge', 'bridge', 'bridge', 'bridge', 'bridge'], halfLife)
    expect(s3.get('bridge')!).toBeGreaterThan(2)
  })

  it('停用词：英文虚词不当命中——中英语料混杂下 idf 压噪失效的兜底', () => {
    // 2026-09-26 影子实测（turn 16345/16368）：英文写的技能描述靠 the/is/to
    // 顶上 cue 榜——语料以中文为主，英文虚词在语料里「稀有」、idf 反而高。
    // 词表来自 stopwords-iso（cue-stopwords.ts 头注），只滤查询侧。
    const candidates = [
      { kind: 'skill', name: 'officecli-pitch-deck', text: 'officecli-pitch-deck [用户] "Use this skill when the user is building a pitch deck"' },
      { kind: 'lesson', name: 'extension-folder-not-loaded', text: 'extension 装了不加载' },
    ]
    // 用户消息：Remote-SSH 调试，手滑英文虚词 + 真主题词
    const out = buildCues(candidates, ['extension is not loaded, no, for the local machine'], { halfLife: 10, topK: 2 })
    expect(out.names).not.toContain('officecli-pitch-deck') // the/is/no/for 全被滤，零重叠
    expect(out.names).toContain('extension-folder-not-loaded') // extension 保留，真命中
    // 纯虚词消息：一个词分都不产生
    expect(wordScores(['the is to for'], 10).size).toBe(0)
    // 中文停用词同样滤（bigram 形态）
    expect(wordScores(['这个 那个'], 10).has('这个')).toBe(false)
  })

  it('idf 自动压噪：到处都有的词撞不动，独一份的词浮上来', () => {
    const candidates = [
      { kind: 'note', name: 'a', text: '面板 压缩' },
      { kind: 'note', name: 'b', text: '面板 压缩' },
      { kind: 'note', name: 'c', text: '面板 压缩' },
      { kind: 'note', name: 'panel-blank', text: '面板 PrefixBrokenError' },
    ]
    // 「面板」在 3/4 候选里出现 → idf≈ln(5/4) 很小；PrefixBrokenError 只在
    // 1/4 → idf≈ln(5/2)。两者词分相同时，独一份的词必须把 panel-blank 顶上去
    const { lines, names } = buildCues(candidates, ['面板 PrefixBrokenError'], { halfLife: 10, topK: 2 })
    expect(names[0]).toBe('panel-blank')
    expect(lines[0]).toContain('〔recall〕note panel-blank')
    // 带命中词——报碰撞给证据。驼峰切分后是 prefix/broken/error 三个词
    expect(lines[0]).toContain('命中: ')
    expect(lines[0]).toMatch(/prefix/)
  })

  it('topK 封顶 + excludeNames 短窗去重', () => {
    const candidates = [
      { kind: 'note', name: 'a', text: '卸载' },
      { kind: 'note', name: 'b', text: '卸载' },
      { kind: 'note', name: 'c', text: '卸载' },
      { kind: 'note', name: 'd', text: '毫不相关的词' },
    ]
    const out = buildCues(candidates, ['卸载'], { halfLife: 10, topK: 2 })
    expect(out.names).toHaveLength(2)
    const deduped = buildCues(candidates, ['卸载'], { halfLife: 10, topK: 2, excludeNames: new Set(out.names) })
    expect(deduped.lines).toHaveLength(1) // 只剩没被排除的第三条
  })

  it('候选加载：明区不进（note 前 20 / event 前 30），summary 只进不在场的', async () => {
    const root = await workspace()
    await mkdir(join(root, '.simple-code', 'notes'), { recursive: true })
    await mkdir(join(root, '.simple-code', 'events'), { recursive: true })
    // 21 条 note：LRU 序（created 降序）前 20 条是明区，最老的那条是暗的
    for (let i = 0; i < 21; i++) {
      await writeFile(
        join(root, '.simple-code', 'notes', `n${i}.md`),
        `---\nname: n${i}\ndescription: 描述${i}\ncreated: 2026-09-25T00:${String(i).padStart(2, '0')}:00Z\n---\n\n正文`,
      )
    }
    // 31 条 event：updated 降序前 30 条是明区，最老的 e0 是暗的
    for (let i = 0; i < 31; i++)
      await writeFile(
        join(root, '.simple-code', 'events', `e${i}.md`),
        `---\nname: e${i}\ndescription: 事件${i}\ncreated: 2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z\n---\n\n# e${i} — 事件${i}\n`,
      )
    const summaries: Summary[] = [
      { id: 1, level: 0, coversFrom: 100, coversTo: 110, name: '在场段', text: '', status: 'ready', owner: null, inContext: true, supersededBy: null, head: '在场的开头', archivePath: null },
      { id: 2, level: 0, coversFrom: 200, coversTo: 210, name: '暗段标题', text: '', status: 'ready', owner: null, inContext: false, supersededBy: null, head: '暗段的开头', archivePath: null },
    ]
    const candidates = loadCueCandidates(root, summaries)
    const names = candidates.map((c) => c.name)
    expect(names).toContain('n0') // 最老的那条是暗区
    expect(names.filter((n) => /^n\d+$/.test(n))).toEqual(['n0'])
    // events：只有最老的 e0 是暗区
    expect(names.filter((n) => /^e\d+$/.test(n))).toEqual(['e0'])
    // summary：不在场的进、在场的（摘要区已渲染）不进
    expect(names).toContain('t200')
    expect(names).not.toContain('t100')
  })
})

describe('cue 渲染（装配纯函数）', () => {
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
    } as Message)
    expect(out[1]).toEqual({ role: 'assistant', parts: [{ type: 'text', text: '答' }] })
    expect(out[2]).toEqual({ role: 'user', parts: [{ type: 'text', text: '问题二' }] })
    // 对照组：不传 cues 时第一条原样（防「恒贴」实现）
    const plain = assembleContext(messages, [])
    expect(plain[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: '问题一' }] })
  })

  it('一个 turn 只贴一次（插话轮的第二条 user 不重复贴）', () => {
    const messages = [live(1, 'user', '问题'), live(1, 'user', '插话')]
    const cues = new Map([[1, ['〔recall〕note x — 描述']]])
    const out = assembleContext(messages, [], new Map(), cues)
    const cued = out.filter((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('〔recall〕')))
    expect(cued).toHaveLength(1)
  })

  it('复现性：同一输入两次装配字节一致（prefix-guard 的前提）', () => {
    const messages = [live(1, 'user', '问题'), live(2, 'user', '再来')]
    const cues = new Map<number, readonly string[]>([[1, ['〔recall〕note a — x']]])
    const a = JSON.stringify(assembleContext(messages, [], new Map(), cues))
    const b = JSON.stringify(assembleContext(messages, [], new Map(), cues))
    expect(a).toBe(b)
  })
})

describe('cue 落库（store）', () => {
  it('saveCue → cues；ON CONFLICT DO NOTHING——cue 冻结，重写无效', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    store.saveCue(1, ['行A'], ['a'])
    store.saveCue(1, ['行B'], ['b']) // 同 turn 重写：必须是 no-op
    expect(store.cues().get(1)).toEqual(['行A'])
    store.close()
  })

  it('cueTurnTexts：最近 N 轮（含工具命令与输出），旧→新；窗口截断', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    // save 是全量替换 + 轮要 beginTurn 切——跟 session 里的用法一致
    const t1 = store.beginTurn({ model: 'm', effort: null })
    store.save([
      { role: 'user', parts: [{ type: 'text', text: '查一下 bridge.ts' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'sed -n 1p assemble.ts' } }] },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'c1', output: '输出的原文', isError: false }] },
    ])
    const texts = store.cueTurnTexts(30)
    expect(texts).toHaveLength(1) // 一个 turn
    expect(texts[0]).toContain('bridge.ts')
    expect(texts[0]).toContain('assemble.ts')
    expect(texts[0]).toContain('输出的原文')
    // 第二轮进来后窗口=1 只看得到它（对照：窗口截断真生效）
    store.beginTurn({ model: 'm', effort: null })
    store.save([
      { role: 'user', parts: [{ type: 'text', text: '查一下 bridge.ts' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'sed -n 1p assemble.ts' } }] },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'c1', output: '输出的原文', isError: false }] },
      { role: 'user', parts: [{ type: 'text', text: '新的一轮' }] },
    ])
    expect(store.cueTurnTexts(1)).toHaveLength(1)
    expect(store.cueTurnTexts(1)[0]).not.toContain('bridge.ts')
    expect(t1).toBeGreaterThan(0)
    store.close()
  })

  it('recentCuedNames：最近 N 轮内撞过的名字都算，窗口外不算', async () => {
    const dir = await workspace()
    const store: Store = openStore(dir)
    store.beginTurn({ model: 'm', effort: null })
    store.save([{ role: 'user', parts: [{ type: 'text', text: '第一轮' }] }])
    store.beginTurn({ model: 'm', effort: null })
    store.save([{ role: 'user', parts: [{ type: 'text', text: '第一轮' }] }, { role: 'user', parts: [{ type: 'text', text: '第二轮' }] }])
    store.saveCue(1, ['x'], ['old-note'])
    store.saveCue(2, ['y'], ['fresh-note'])
    // 窗口盖住两轮 → 两个都在；只盖最新一轮 → 只有 fresh
    expect(store.recentCuedNames(5)).toEqual(new Set(['old-note', 'fresh-note']))
    expect(store.recentCuedNames(1)).toEqual(new Set(['fresh-note']))
    store.close()
  })
})

describe('recall 影子模式（session e2e）', () => {
  it('send 算 cue 落库但不渲染：暗 note 被撞出，请求里看不见', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const { readFixture } = await import('./helpers.ts')
    const dir = await workspace()
    const globalPath = join(dir, 'settings.json')
    // 21 条 note，最老的（暗区）带着独一份的词
    await mkdir(join(dir, '.simple-code', 'notes'), { recursive: true })
    for (let i = 0; i < 21; i++) {
      const desc = i === 0 ? 'quuxworthy 独一份线索' : `普通描述${i}`
      await writeFile(
        join(dir, '.simple-code', 'notes', `n${i}.md`),
        `---\nname: n${i}\ndescription: ${desc}\ncreated: 2026-09-25T00:${String(i).padStart(2, '0')}:00Z\n---\n\n正文`,
      )
    }
    const bytes = await readFixture('anthropic-messages.tool-call.sse')
    const calls: unknown[] = []
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(bodyOfSse(new TextDecoder().decode(bytes)))
    }) as unknown as typeof fetch
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'p',
        model: 'm',
        providers: {
          p: { protocol: 'anthropic-messages', baseUrl: 'https://example.invalid', apiKey: 'k', models: { m: { contextWindow: 100_000 } } },
        },
        memory: { idleSummarizeDelayMs: 0 },
        // 显式 shadow：断言的是「默认行为」之外的这条路径本身
        recall: { mode: 'shadow' },
      }),
      'utf8',
    )
    const session = await getSession(dir, { globalPath, skipLock: true, fetchImpl: impl })
    const events: unknown[] = []
    for await (const ev of session.send('quuxworthy 是什么')) events.push(ev)
    await session.close()
    // 落库了：cues 表有这一轮的行，行里有暗 note
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, '.simple-code', 'memory', 'state.db'))
    const rows = db.prepare(`SELECT lines FROM cues WHERE owner = ''`).all() as { lines: string }[]
    db.close()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.at(-1)?.lines).toContain('n0')
    // 但没渲染：发出的请求里找不到线索行（shadow 的定义）。不能断言
    // '〔recall〕' 整串——system prompt 里有它的说明文字，会误伤
    const first = JSON.stringify(calls[0])
    expect(first).not.toContain('〔recall〕note n0')
  })

  it('对照组：mode=on 时线索行真的渲染进请求（防「恒空 Map」骗过上一条）', async () => {
    const { getSession } = await import('../src/session/session.ts')
    const { readFixture } = await import('./helpers.ts')
    const dir = await workspace()
    const globalPath = join(dir, 'settings.json')
    await mkdir(join(dir, '.simple-code', 'notes'), { recursive: true })
    for (let i = 0; i < 21; i++) {
      const desc = i === 0 ? 'quuxworthy 独一份线索' : `普通描述${i}`
      await writeFile(
        join(dir, '.simple-code', 'notes', `n${i}.md`),
        `---\nname: n${i}\ndescription: ${desc}\ncreated: 2026-09-25T00:${String(i).padStart(2, '0')}:00Z\n---\n\n正文`,
      )
    }
    const bytes = await readFixture('anthropic-messages.tool-call.sse')
    const calls: unknown[] = []
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(bodyOfSse(new TextDecoder().decode(bytes)))
    }) as unknown as typeof fetch
    await writeFile(
      globalPath,
      JSON.stringify({
        provider: 'p',
        model: 'm',
        providers: {
          p: { protocol: 'anthropic-messages', baseUrl: 'https://example.invalid', apiKey: 'k', models: { m: { contextWindow: 100_000 } } },
        },
        memory: { idleSummarizeDelayMs: 0 },
        recall: { mode: 'on' },
      }),
      'utf8',
    )
    const session = await getSession(dir, { globalPath, skipLock: true, fetchImpl: impl })
    const events: unknown[] = []
    for await (const ev of session.send('quuxworthy 是什么')) events.push(ev)
    await session.close()
    expect(JSON.stringify(calls[0])).toContain('〔recall〕note n0')
  })
})

const bodyOfSse = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
