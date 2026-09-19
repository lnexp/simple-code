import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ImageInput, StreamEvent, Tool, Usage } from '../src/index.ts'
import type { Request } from '../src/llm/types.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { userParts } from '../src/loop/run.ts'
import { getSession } from '../src/session/session.ts'

/**
 * 图片输入（UI 粘贴 → send(text, images)）的门控与组装。
 *
 * 门控是 §726 的判据在跑：images 配错发出去 400，消息留在 context 里，
 * 之后每轮都 400，loop 卡死——所以**必须**在本地把不支持的路拦掉。
 */

const CONFIG = {
  provider: 'alpha',
  model: 'a-vision',
  providers: {
    alpha: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://alpha.invalid',
      apiKey: '${ALPHA_KEY}',
      models: {
        'a-vision': { contextWindow: 100_000, capabilities: { images: true } },
        'a-blind': { contextWindow: 100_000 },
      },
    },
  },
}

const ENV = { ALPHA_KEY: 'sk-1' }

const usage = (): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
})

const says = (text: string): StreamEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
  { type: 'finish', reason: 'stop', usage: usage() },
]

const fakeTool = (): Tool => ({
  name: 'bash',
  definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
  execute: async () => ({ output: 'ok', exitCode: 0, isError: false }),
})

// 真实 1×1 PNG——发送侧 resizer 会解码校验，垃圾 base64 会换占位符，
// 那是 resizer.test.ts 测的事；这里测的是门控与组装，用限内真图原样过
const IMG = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimeType: 'image/png',
}

const open = async (rounds: StreamEvent[][] = []) => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-img-'))
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  const seen: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[seen.length] ?? []
    seen.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  const session = await getSession(dir, {
    globalPath,
    env: ENV,
    tools: [fakeTool()],
    stream,
    skipLock: true,
    ephemeral: true,
  })
  return { session, seen, dir }
}

const drain = async (iter: AsyncIterable<unknown>) => {
  for await (const _ of iter) {
    // 只要跑完
  }
}

describe('图片输入', () => {
  it('userParts：text 在前图在后', () => {
    const parts = userParts('看这张', [IMG])
    expect(parts[0]).toEqual({ type: 'text', text: '看这张' })
    expect(parts[1]).toEqual({ type: 'image', ...IMG })
    // 不带图时不落 key——exactOptionalPropertyTypes 下的序列化约定
    expect('images' in (userParts('纯文本')[0] ?? {})).toBe(false)
  })

  it('未开启 capabilities.images 的模型：send 带图抛错，且消息不进历史', async () => {
    const { session } = await open([says('一'), says('二')])
    session.setModel({ provider: 'alpha', model: 'a-blind' })
    // send 是普通函数：门控在调用时就抛，不是第一次迭代时（lazy 的写法
    // rejects 接不到——表达式在 drain 前就炸了）
    expect(() => session.send('看这张', [IMG])).toThrow(/capabilities.images/)
    // 关键：被拒的输入不能留在历史里——那正是门控存在的理由（§726）
    expect(session.messages().some((m) => m.parts.some((p) => p.type === 'image'))).toBe(false)
    await session.close()
  })

  it('开启的模型：图随 user 消息进请求', async () => {
    const { session, seen } = await open([says('收到')])
    await drain(session.send('看这张', [IMG]))
    const user = seen[0]?.messages.find((m) => m.role === 'user')
    expect(user?.parts).toEqual([
      { type: 'text', text: '看这张' },
      { type: 'image', ...IMG },
    ])
    await session.close()
  })

  it('换到不支持的模型：请求侧降级成占位文本，历史里的原图不被烧掉', async () => {
    // 这是 2026-09-07 的坑：降级曾在 normalize（落库路径）里做，persist() 把
    // 占位文本存回 store，原图永久丢失。修复后降级只在 assembleForRequest
    // 出口做，库里永远是原图——切回支持的模型图自动回来
    const { session, seen } = await open([says('收到'), says('再看一眼'), says('回来了')])
    await drain(session.send('看这张', [IMG]))

    session.setModel({ provider: 'alpha', model: 'a-blind' })
    await drain(session.send('这个模型看不了图'))
    const blind = seen[1]?.messages.find(
      (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === '看这张'),
    )
    // 请求侧：图变成了占位文本（防 400，模型知道这里原本有东西）
    expect(blind?.parts[1]).toMatchObject({ type: 'text' })
    expect((blind?.parts[1] as { text?: string }).text).toContain('不支持图片')
    // 库侧：历史里的 ImagePart 还在——「历史可以降分辨率不能丢」
    const stored = session.messages().find(
      (m) => m.parts.some((p) => p.type === 'text' && p.text === '看这张'),
    )
    expect(stored?.parts[1]).toMatchObject({ type: 'image', data: IMG.data })

    // 切回支持的模型，下一轮请求里图回来了（降级不是一次性的烧毁）
    session.setModel({ provider: 'alpha', model: 'a-vision' })
    await drain(session.send('再看一眼'))
    const restored = seen[2]?.messages.find(
      (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === '看这张'),
    )
    expect(restored?.parts[1]).toMatchObject({ type: 'image', data: IMG.data })
    await session.close()
  })

  it('tool_result 带图 + 换到不支持的模型：请求里图变 output 占位行，库里原图保留', async () => {
    // 洞①回归：ToolResultPart.images 是字段不是 part，strip 曾整个漏掉，
    // 图原样进请求 → 非视觉模型 400 且每轮都 400
    const toolWithImage: Tool = {
      name: 'bash',
      definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
      execute: async () => ({
        output: '图片 image/png，10 字节',
        exitCode: 0,
        isError: false,
        images: [IMG],
      }),
    }
    const dir = await mkdtemp(join(tmpdir(), 'sc-img-tool-'))
    await writeFile(join(dir, 'global-settings.json'), JSON.stringify(CONFIG), 'utf8')
    const seen: Request[] = []
    const stream: LoopDeps['stream'] = (request) => {
      seen.push(structuredClone(request))
      return (async function* () {
        yield* seen.length === 1
          ? [
              { type: 'tool_input_start', id: 't1', name: 'bash' },
              { type: 'tool_input_end', id: 't1', name: 'bash', input: { command: 'ls' } },
              { type: 'finish', reason: 'tool-calls', usage: usage() },
            ]
          : says('看不到图但知道有')
      })()
    }
    const session = await getSession(dir, {
      globalPath: join(dir, 'global-settings.json'),
      env: ENV,
      tools: [toolWithImage],
      stream,
      skipLock: true,
      ephemeral: true,
    })
    await drain(session.send('抓这张图'))
    // 前提：tool_result 确实带了图（真实进过库）
    expect(
      session.messages().some((m) => m.parts.some((p) => p.type === 'tool_result' && p.images?.length)),
    ).toBe(true)

    session.setModel({ provider: 'alpha', model: 'a-blind' })
    await drain(session.send('换个模型再看'))
    const sent = seen[2]?.messages.flatMap((m) => m.parts).find(
      (p) => p.type === 'tool_result',
    ) as { images?: unknown } | undefined
    expect(sent?.images).toBeUndefined()
    expect((sent as { output: string } | undefined)?.output).toContain('图片已省略')
    // 库里原图还在
    const stored = session
      .messages()
      .flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result')
    expect((stored as { images?: ImageInput[] } | undefined)?.images?.[0]?.data).toBe(IMG.data)
    await session.close()
  })

  it('排队路径：running 中 send 的带图输入，下一轮原样落进消息', async () => {
    // 第一轮用 tool_call 拖住 loop，第二轮回答——这样第二条输入走 tasks 队列
    const { session, seen } = await open([
      [
        { type: 'tool_input_start', id: 't1', name: 'bash' },
        { type: 'tool_input_end', id: 't1', name: 'bash', input: { command: 'ls' } },
        { type: 'finish', reason: 'tool-calls', usage: usage() },
      ],
      says('都看到了'),
    ])
    const first = session.send('第一句')
    await drain(session.send('这张也看', [IMG])) // running 中 → 入队
    await drain(first)
    // tool_result 也住在 user 消息里，findLast(user) 会命中它——按文本找
    const queued = seen[1]?.messages.findLast(
      (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === '这张也看'),
    )
    expect(queued?.parts).toEqual([
      { type: 'text', text: '这张也看' },
      { type: 'image', ...IMG },
    ])
    await session.close()
  })

  it('非视觉模型 + visionModel：贴图不抛错，请求里图换成转述，库里原图保留且跨 send 只转述一次', async () => {
    // 用户贴图与 view_image 的转述通道对齐（同一次不一致修复）：view_image
    // 的图早就能走 visionRelay 转述，贴图此前在 send 门控被硬拒。现在门控
    // 放宽为「不支持图且没配 visionModel 才拒」，转述在 runLoop 发送前做、
    // 结果按图 data 缓存在 session 级
    const visionConfig = {
      ...CONFIG,
      providers: {
        alpha: {
          ...CONFIG.providers.alpha,
          models: {
            ...CONFIG.providers.alpha.models,
            'b-vision': { contextWindow: 100_000, capabilities: { images: true } },
          },
        },
      },
      visionModel: { provider: 'alpha', model: 'b-vision' },
    }
    const dir = await mkdtemp(join(tmpdir(), 'sc-img-relay-'))
    await writeFile(join(dir, 'global-settings.json'), JSON.stringify(visionConfig), 'utf8')
    const seen: Request[] = []
    const stream: LoopDeps['stream'] = (request) => {
      seen.push(structuredClone(request))
      return (async function* () {
        yield* says('知道了')
      })()
    }
    // relay 走全局 fetch（makeVisionRelay 的 sendRequest 不经 deps.stream）
    const relayBodies: { model?: string }[] = []
    vi.stubGlobal('fetch', (async (_url: unknown, init?: { body?: string }) => {
      relayBodies.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(
        [
          'event: message_start',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"图里是一个红方块"}}',
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
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch)
    try {
      const session = await getSession(dir, {
        globalPath: join(dir, 'global-settings.json'),
        env: ENV,
        tools: [fakeTool()],
        stream,
        skipLock: true,
        ephemeral: true,
      })
      session.setModel({ provider: 'alpha', model: 'a-blind' })
      // 门控放宽的核心断言：此前这里直接 throw
      await drain(session.send('看这张', [IMG]))
      // 转述确实走的 visionModel，且只调了一次
      expect(relayBodies).toHaveLength(1)
      expect(relayBodies[0]?.model).toBe('b-vision')
      // 请求侧：image part 换成了转述文本
      const user = seen[0]?.messages.find((m) => m.role === 'user')
      expect((user?.parts[1] as { text?: string }).text).toContain('[视觉转述] 图里是一个红方块')
      expect(user?.parts.some((p) => p.type === 'image')).toBe(false)
      // 库侧：原图保留——切回视觉模型图自动回来
      const stored = session.messages().find((m) => m.parts.some((p) => p.type === 'image'))
      expect(stored?.parts.some((p) => p.type === 'image' && p.data === IMG.data)).toBe(true)

      // 下一条消息：session 级缓存生效，不再重复转述，历史里的转述还在
      await drain(session.send('再说一遍'))
      expect(relayBodies).toHaveLength(1)
      const again = seen[1]?.messages.find((m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === '看这张'))
      expect((again?.parts[1] as { text?: string }).text).toContain('红方块')
      await session.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
