import { describe, expect, it } from 'vitest'
import type { Message, Request } from '../src/llm/types.ts'
import { stripImagesWhenUnsupported } from '../src/llm/resizer.ts'
import { regionSizes } from '../src/loop/regions.ts'

/**
 * 四个区的记账（提案 §13）。**这是纯诊断口径**，不参与任何运行时判断——
 * 所以这里测的只有一件事：**每条消息进的是不是它该进的那个区**。
 *
 * 每条都有对照组：分类是按文本形状认的（`<历史摘要` / 卸载标记），
 * 一个「都算进 ④」的实现照样能让「总数对得上」那种断言全绿。
 */

const request = (messages: Message[], over: Partial<Request> = {}): Request => ({
  model: 'm',
  maxTokens: 100,
  thinking: 'disabled',
  effort: 'high',
  reasoningDisplay: 'omitted',
  system: '',
  tools: [],
  messages,
  ...over,
})

const text = (t: string): Message => ({ role: 'user', parts: [{ type: 'text', text: t }] })

const stub = (archive: string): Message => ({
  role: 'tool',
  parts: [
    {
      type: 'tool_result',
      toolCallId: 'c1',
      output: `ls 的前几行\n# [已卸载，完整内容见 ${archive}]`,
      isError: false,
    },
  ],
})

describe('四个区的记账', () => {
  it('摘要进 ②、存根进 ③、其余进 ④', () => {
    const sizes = regionSizes(
      request([
        text('<历史摘要 step=1-10>\n摘要：改了鉴权\n</历史摘要>'),
        stub('.simple-code/memory/turns/turn-000001.jsonl'),
        text('你来继续实现'),
      ]),
    )
    expect(sizes.warm).toBeGreaterThan(0)
    expect(sizes.stub).toBeGreaterThan(0)
    expect(sizes.live).toBeGreaterThan(0)
  })

  it('**对照组：三条内容一样、只有形状不同 → 分到三个区**', () => {
    // 上一条只断言了「三个都非零」，一个「按顺序轮流塞」的实现也能过。
    // 这条钉死的是「决定进哪个区的是形状本身」：把摘要标签去掉、把卸载标记
    // 去掉，同一段文字就整体挪到 ④
    const body = '改了鉴权'
    const asSummary = regionSizes(request([text(`<历史摘要 step=1-10>\n${body}\n</历史摘要>`)]))
    expect(asSummary.warm).toBeGreaterThan(0)
    expect(asSummary.live).toBe(0)

    const asPlain = regionSizes(request([text(`<历史索引 step=1-10>\n${body}\n</历史索引>`)]))
    expect(asPlain.warm).toBe(0)
    expect(asPlain.live).toBeGreaterThan(0)
  })

  it('**存根标记一去掉就回 ④**——认的是标记，不是「这条是 tool_result」', () => {
    const stubbed = regionSizes(request([stub('turns/turn-000001.jsonl')]))
    expect(stubbed.stub).toBeGreaterThan(0)
    expect(stubbed.live).toBe(0)

    const intact: Message = {
      role: 'tool',
      parts: [{ type: 'tool_result', toolCallId: 'c1', output: 'ls 的前几行', isError: false }],
    }
    const whole = regionSizes(request([intact]))
    expect(whole.stub).toBe(0)
    expect(whole.live).toBeGreaterThan(0)
  })

  it('被裁的是 tool_call.command 时也算 ③', () => {
    // 长 heredoc（`cat > x <<EOF`）会被裁在 command 上，而不是输出上（§9.4）。
    // 只认 tool_result 的话，这类整条掉进 ④，看起来像是「卸载没省到东西」
    const call: Message = {
      role: 'assistant',
      parts: [
        {
          type: 'tool_call',
          id: 'c1',
          name: 'bash',
          input: { command: "cat > a.ts <<'EOF'\n# [已卸载，完整内容见 turns/t.jsonl]" },
        },
      ],
    }
    expect(regionSizes(request([call])).stub).toBeGreaterThan(0)
    expect(regionSizes(request([call])).live).toBe(0)
  })

  it('存根消息**整条**进 ③，配对用的那些 part 不摊回 ④', () => {
    const message: Message = {
      role: 'tool',
      parts: [
        stub('turns/t.jsonl').parts[0] as Message['parts'][number],
        { type: 'text', text: '这段没被裁' },
      ],
    }
    expect(regionSizes(request([message])).live).toBe(0)
  })

  it('① 只数 system 和工具定义，跟 messages 无关', () => {
    const tools = [{ name: 'bash', description: '跑命令', parameters: { type: 'object' } }]
    // 空 tools 序列化出来是 `[]`，1 token，不是 0——测的是「有消息也不涨」
    const empty = regionSizes(request([]))
    const withMessages = regionSizes(request([text('一段很长很长的用户消息'.repeat(20))]))
    expect(withMessages.overhead).toBe(empty.overhead)

    const withSystem = regionSizes(request([], { system: '你是一个编码助手' }))
    expect(withSystem.overhead).toBeGreaterThan(empty.overhead)
    expect(regionSizes(request([], { tools })).overhead).toBeGreaterThan(0)
  })

  it('② 拆冷温热：折叠签名=冷、四段正文=热、纯键=温（判据对齐 renderSummary）', () => {
    const cold = regionSizes(
      request([
        text(
          '<历史摘要 step=1-100>\n摘要：早期改造\n详情：turns-000/a.md … turns-000/z.md（共 10 个）\n</历史摘要>',
        ),
      ]),
    )
    expect(cold.cold).toBeGreaterThan(0)
    expect(cold.warm).toBe(0)

    const hot = regionSizes(
      request([
        text(
          '<历史摘要 step=1-10>\n摘要：改了鉴权\n## 用户要求\n做 X\n## 实际完成\n完成了\n</历史摘要>',
        ),
      ]),
    )
    expect(hot.hot).toBeGreaterThan(0)
    expect(hot.warm).toBe(0)

    const warm = regionSizes(
      request([text('<历史摘要 step=1-10>\n摘要：改了鉴权\n</历史摘要>')]),
    )
    expect(warm.warm).toBeGreaterThan(0)
    expect(warm.hot).toBe(0)
    expect(warm.cold).toBe(0)
  })

  it('⑤ 保底区：floor 集合内的消息单列，集合外进 ④', () => {
    const inside = text('保底区内的最近消息')
    const outside = text('保底区外的老消息')
    const sizes = regionSizes(request([outside, inside]), new Set([inside]))
    expect(sizes.floor).toBeGreaterThan(0)
    expect(sizes.live).toBeGreaterThan(0)
    expect(sizes.floor + sizes.live).toBe(
      regionSizes(request([outside, inside])).floor + regionSizes(request([outside, inside])).live,
    )
  })

  it('⑤ 保底区在 strip 之后仍按引用命中（无图消息不得新建对象）', () => {
    // 回归 2026-09-12：caps.images=false 时 stripImagesWhenUnsupported 全量
    // `{...msg}`，出口引用全换、floor 集合整区 miss——面板 floor 恒 0、
    // 11.6k 全堆进「未卸载」。没图的消息必须原引用穿过出口
    const inside = text('保底区内的最近消息')
    const outside = text('保底区外的老消息')
    const stripped = stripImagesWhenUnsupported([outside, inside], { images: false })
    const sizes = regionSizes(request(stripped), new Set([inside]))
    expect(sizes.floor).toBeGreaterThan(0)
    expect(sizes.floor + sizes.live).toBe(
      regionSizes(request([outside, inside]), new Set([inside])).floor +
        regionSizes(request([outside, inside]), new Set([inside])).live,
    )
  })

  it('**工具定义按密集 JSON 估，不按 4 字符/token**', () => {
    // 一样的 JSON 文本，放 tools 里估出来该比放 system 里贵一倍左右——
    // tools 序列化出去就是 `{"name":"…","parameters":{…}}` 这种一堆单字符
    // token 的东西（tokens.ts 的 JSON_CHARS_PER_TOKEN）。按 4 估会低估一半，
    // 而 reservedTokens 的默认值本来就是拍的，用偏低的数去验等于白验
    const tools = [
      { name: 'bash', description: 'run a shell command', parameters: { type: 'object' } },
    ]
    const asTools = regionSizes(request([], { tools })).overhead
    const asSystem = regionSizes(request([], { system: JSON.stringify(tools) })).overhead
    expect(asTools).toBeGreaterThan(asSystem * 1.5)
  })
})

describe('范围列（step 闭区间）', () => {
  const summaryMsg = (from: number, to: number, kind: 'cold' | 'hot' | 'warm'): Message => {
    const body =
      kind === 'cold' ? '详情：x 详情行（共 3 个）' : kind === 'hot' ? '## 标题\n正文' : '开头：x'
    return text(`<历史摘要 step=${from}-${to}>\n${body}\n</历史摘要>`)
  }
  const liveMsg = text('普通消息')
  const floorMsg = text('保底消息')
  const stubMsg = stub('.simple-code/memory/turns/000/turn-000001.jsonl')

  it('摘要范围从渲染首行解析，冷温热各归各', () => {
    const req = request([
      summaryMsg(3, 40, 'cold'),
      summaryMsg(41, 50, 'warm'),
      summaryMsg(51, 51, 'hot'),
    ])
    const r = regionSizes(req)
    expect(r.ranges).toEqual({
      cold: { from: 3, to: 40 },
      warm: { from: 41, to: 50 },
      hot: { from: 51, to: 51 },
      stub: null,
      floor: null,
      live: null,
    })
  })

  it('live 三类从 stepIds 查归属；多条消息取 min–max', () => {
    const req = request([stubMsg, liveMsg, floorMsg])
    const r = regionSizes(req, new Set([floorMsg]), new Map([[stubMsg, 12], [liveMsg, 14], [floorMsg, 15]]))
    expect(r.ranges.stub).toEqual({ from: 12, to: 12 })
    expect(r.ranges.live).toEqual({ from: 14, to: 14 })
    expect(r.ranges.floor).toEqual({ from: 15, to: 15 })
  })

  it('同类多条消息聚合区间；stepIds 缺席时范围空但不炸', () => {
    const a = text('a')
    const b = text('b')
    const r = regionSizes(request([a, b]), undefined, new Map([[a, 7], [b, 3]]))
    expect(r.ranges.live).toEqual({ from: 3, to: 7 })
    expect(regionSizes(request([a])).ranges.live).toBeNull()
  })

  it('摘要首行没有 step= 时不给范围（宁缺毋猜）', () => {
    const s = text('<历史摘要 手写的旧格式>\n开头：x\n</历史摘要>')
    expect(regionSizes(request([s])).ranges.warm).toBeNull()
  })
})
