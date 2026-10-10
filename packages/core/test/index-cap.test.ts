import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clampIndexLine, fitIndexLine, INDEX_LINE_MAX_CHARS } from '../src/loop/index-cap.ts'
import { getSession } from '../src/session/session.ts'
import { openStore } from '../src/session/store.ts'

/**
 * 索引行 400 字上限（2026-09-29，note summary-line-cap-400）。起因是 L8/L9
 * 合并照抄成员（输出/输入 89%/96%），提示词管不住，代码兜底
 */

describe('clampIndexLine：截到上限内，不留半行/半个词', () => {
  it('没超不动', () => {
    expect(clampIndexLine('短：a · b', 400)).toBe('短：a · b')
  })
  it('多行：丢到最后一个完整行', () => {
    const text = `主题一：${'甲'.repeat(10)}\n主题二：${'乙'.repeat(10)}\n主题三：${'丙'.repeat(10)}`
    expect(clampIndexLine(text, 30)).toBe(`主题一：${'甲'.repeat(10)}\n主题二：${'乙'.repeat(10)}`)
  })
  it('单行：丢到最后一个完整关键词', () => {
    expect(clampIndexLine('主题：alpha · beta · gamma · delta', 22)).toBe('主题：alpha · beta')
  })
  it('既无换行也无分隔符：硬切', () => {
    expect(clampIndexLine('x'.repeat(50), 10)).toBe('x'.repeat(10))
  })
  it('散文（L0 描述）：在最后一个句号/分号处断，标点留着', () => {
    const text = '改了提示词。修了并发闸；未决：面板估算偏低，A 校准/B 显示真实值/C 观察'
    expect(clampIndexLine(text, 30)).toBe('改了提示词。修了并发闸；')
  })
  it('「·」和句号都有：取靠后的那个', () => {
    expect(clampIndexLine('主题：甲。乙 · 丙 · 丁丁丁丁丁丁', 12)).toBe('主题：甲。乙 · 丙')
    expect(clampIndexLine('主题：甲 · 乙。丙丙丙丙丙丙丙', 12)).toBe('主题：甲 · 乙。')
  })
})

describe('fitIndexLine：超长重写一次，再兜底截断', () => {
  const long = `${'主题：' + '词 · '.repeat(200)}`
  it('没超不调模型', async () => {
    let called = 0
    expect(await fitIndexLine('短', async () => (called++, '别'))).toBe('短')
    expect(called).toBe(0)
  })
  it('超了：带着实际字数去重写，采用更短的那份', async () => {
    let feedback = ''
    const out = await fitIndexLine(long, async (f) => ((feedback = f), '重写后：a · b'))
    expect(out).toBe('重写后：a · b')
    expect(feedback).toContain(`你写了 ${long.length} 字`)
  })
  it('重写后还超：截断，**一定在上限内**（合并必须能完成）', async () => {
    const out = await fitIndexLine(long, async () => long.slice(0, long.length - 5))
    expect(out.length).toBeLessThanOrEqual(INDEX_LINE_MAX_CHARS)
    expect(out.length).toBeGreaterThan(0)
  })
  it('重写抛错或更长：退回截原来那份', async () => {
    const boom = await fitIndexLine(long, async () => {
      throw new Error('net')
    })
    expect(boom).toBe(clampIndexLine(long))
    const worse = await fitIndexLine(long, async () => long + long)
    expect(worse).toBe(clampIndexLine(long))
  })
})

// ---------------- 端到端：session 的合并路径真的过了上限 ----------------

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const sse = (text: string) =>
  [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
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
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')

/** 按调用次序回话，并记下每次请求的 messages（看重写那次带没带反馈） */
function scriptedFetch(replies: string[]) {
  const bodies: { messages: { content: unknown }[] }[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    const text = replies[bodies.length - 1] ?? replies[replies.length - 1] ?? ''
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse(text)))
          c.close()
        },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

async function seeded(texts: { level: number; text: string }[]) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-index-cap-'))
  dirs.push(dir)
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
          apiKey: '${TEST_KEY}',
          models: { m: { contextWindow: 200_000 } },
        },
      },
      request: { maxTokens: 500 },
      memory: { mergeFactor: 2, idleSummarizeDelayMs: 0 },
    }),
    'utf8',
  )
  const store = openStore(dir)
  texts.forEach(({ level, text }, i) =>
    store.addSummary({
      level,
      coversFrom: i * 10 + 1,
      coversTo: i * 10 + 10,
      name: '',
      text,
      status: 'ready',
      inContext: true,
      supersededBy: null,
      head: null,
      archivePath: null,
    }),
  )
  store.close()
  return { dir, globalPath }
}

const liveRows = (dir: string) => {
  const store = openStore(dir)
  const rows = store.summaries().filter((s) => s.supersededBy === null)
  store.close()
  return rows
}

describe('装机前的超长节点：空闲时单条重写（L9 6984 字那种）', () => {
  it('超长 L1 被同层、同段的短节点罩住，待下个压缩点生效；不超的不动', async () => {
    const huge = `旧 L9：${'照抄的一行 · '.repeat(120)}`
    const { dir, globalPath } = await seeded([
      { level: 9, text: huge },
      { level: 1, text: '短节点：a · b' },
    ])
    const { fetchImpl, bodies } = scriptedFetch(['重写：跨半个月的主题 · 关键词'])
    // 配额很大：不会走普通合并，只有重写这一趟会调模型
    const session = await getSession(dir, { globalPath, env: { TEST_KEY: 'k' }, tools: [], fetchImpl, skipLock: true })
    await session.summarizeIdle()
    await session.close()

    expect(bodies).toHaveLength(1)
    const rows = liveRows(dir)
    const rewritten = rows.find((s) => s.text.startsWith('重写：'))
    expect(rewritten).toMatchObject({ level: 9, coversFrom: 1, coversTo: 10, inContext: false })
    expect(rows.some((s) => s.text === huge)).toBe(false) // 被罩住（superseded）
    expect(rows.some((s) => s.text === '短节点：a · b')).toBe(true)
  })

  it('模型第一次又抄长了：带反馈重写一次；第二次仍超则截断落库，一定 ≤400 字', async () => {
    const huge = `旧节点：${'照抄 · '.repeat(200)}`
    const { dir, globalPath } = await seeded([{ level: 2, text: huge }])
    const stillLong = `又抄：${'词 · '.repeat(150)}` // 比第一次短、仍超上限
    const { fetchImpl, bodies } = scriptedFetch([huge, stillLong])
    const session = await getSession(dir, { globalPath, env: { TEST_KEY: 'k' }, tools: [], fetchImpl, skipLock: true })
    await session.summarizeIdle()
    await session.close()

    expect(bodies).toHaveLength(2)
    expect(JSON.stringify(bodies[1]?.messages)).toContain(`超过 ${INDEX_LINE_MAX_CHARS} 字的上限`)
    const node = liveRows(dir).find((s) => s.level === 2)
    expect(node?.text.length).toBeLessThanOrEqual(INDEX_LINE_MAX_CHARS)
    expect(node?.text.startsWith('又抄：')).toBe(true) // 用了更短的那份
  })
})

describe('L0 的描述同样受上限', () => {
  it('描述超长：只重写描述那一行，正文沿用第一次的', async () => {
    const { dir, globalPath } = await seeded([])
    const store = openStore(dir)
    const t = store.beginTurn({ model: 'p/m', effort: null })
    store.save([
      { role: 'user', parts: [{ type: 'text', text: `问题${'。要足够长才会去调摘要模型'.repeat(30)}` }] },
      { role: 'assistant', parts: [{ type: 'text', text: `回答${'。回答也要够长'.repeat(30)}` }] },
    ])
    store.finishTurn(t, 1, 'done')
    store.close()

    const longDesc = `名称: 长描述\n描述: ${'做了很多事，'.repeat(120)}\n\n## 实际完成\n第一次的正文`
    const { fetchImpl, bodies } = scriptedFetch([longDesc, '描述: 改了 a.ts，测试 3 条过'])
    const session = await getSession(dir, { globalPath, env: { TEST_KEY: 'k' }, tools: [], fetchImpl, skipLock: true })
    for (let i = 0; i < 3; i++) await session.summarizeIdle()
    await session.close()

    expect(JSON.stringify(bodies[1]?.messages)).toContain('只重写「描述」')
    const l0 = liveRows(dir).filter((s) => s.level === 0)
    expect(l0.length).toBeGreaterThan(0)
    expect(l0.every((s) => s.text.length <= INDEX_LINE_MAX_CHARS)).toBe(true)
    expect(l0.map((s) => s.text)).toContain('改了 a.ts，测试 3 条过')
  })
})
