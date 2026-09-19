import { describe, expect, it } from 'vitest'
import type { Message, Part } from '../src/llm/types.ts'
import {
  hasPendingToolCalls,
  hasUnansweredUserInput,
  normalizeHistory,
  normalizeWithOrigin,
} from '../src/loop/normalize.ts'

const call = (id: string): Part => ({
  type: 'tool_call',
  id,
  name: 'bash',
  input: { command: 'ls' },
})
const result = (id: string): Part => ({
  type: 'tool_result',
  toolCallId: id,
  output: 'ok',
  isError: false,
})
const text = (t: string): Part => ({ type: 'text', text: t })
const image = (): Part => ({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' })

const assistant = (...parts: Part[]): Message => ({ role: 'assistant', parts })
const user = (...parts: Part[]): Message => ({ role: 'user', parts })
const tool = (...parts: Part[]): Message => ({ role: 'tool', parts })

describe('pass 1：补齐缺失的 tool_result', () => {
  it('末尾未配对的 tool_call 后面补一条 tool 消息', () => {
    const out = normalizeHistory([user(text('跑一下')), assistant(call('a'))])

    expect(out).toHaveLength(3)
    expect(out[2]?.role).toBe('tool')
    expect(out[2]?.parts[0]).toMatchObject({ toolCallId: 'a', isError: true, interrupted: true })
  })

  it('已配对的不动', () => {
    const input = [assistant(call('a')), tool(result('a'))]
    expect(normalizeHistory(input)).toEqual(input)
  })

  it('同一条消息里部分配对时，占位并进下一条 tool 消息且排在真实结果之后', () => {
    // 两个并行 tool_call，只有 a 拿到了结果。新插一条会得到两条连续的 tool 消息
    const out = normalizeHistory([assistant(call('a'), call('b')), tool(result('a'))])

    expect(out).toHaveLength(2)
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1)
    expect(out[1]?.parts.map((p) => (p as { toolCallId: string }).toolCallId)).toEqual(['a', 'b'])
    expect(out[1]?.parts[1]).toMatchObject({ interrupted: true })
  })

  it('用户插的话不会被当成占位的落脚点', () => {
    // tool_result 挂在 user 消息里的版本会把占位并进这条用户输入，
    // 得到一条「文本 + tool_result」的混合消息
    const out = normalizeHistory([assistant(call('a')), user(text('别跑了'))])

    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'user'])
    expect(out[2]?.parts).toEqual([text('别跑了')])
  })

  it('下一条是 assistant 时新插一条 tool，不并进去', () => {
    const out = normalizeHistory([assistant(call('a')), assistant(text('接着说'))])

    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('多个未配对的 tool_call 各补一条占位', () => {
    const out = normalizeHistory([assistant(call('a'), call('b'))])

    expect(out[1]?.parts).toHaveLength(2)
    expect(out[1]?.parts.map((p) => (p as { toolCallId: string }).toolCallId)).toEqual(['a', 'b'])
  })
})

describe('pass 2：删除孤儿 tool_result', () => {
  it('没有对应 tool_call 的 result 被删掉', () => {
    const out = normalizeHistory([user(text('hi')), tool(result('ghost'))])

    expect(out).toHaveLength(1)
    expect(out[0]?.parts).toEqual([text('hi')])
  })

  it('只删孤儿那一个，同消息里配对的留着', () => {
    const out = normalizeHistory(
      [assistant(call('a')), tool(result('a'), result('ghost'))],
    )

    expect(out[1]?.parts.map((p) => (p as { toolCallId: string }).toolCallId)).toEqual(['a'])
  })
})

describe('pass 之间不互相拆台', () => {
  it('pass 1 补出来的占位不会被 pass 2 当成孤儿删掉', () => {
    const out = normalizeHistory([assistant(call('a'))])

    expect(out).toHaveLength(2)
    expect(out[1]?.parts[0]).toMatchObject({ toolCallId: 'a', interrupted: true })
  })
})

describe('图片不归 normalize 管（防回归）', () => {
  // pass 3「不支持时换占位文本」曾在 normalize 里做，产物落库，原图被
  // persist() 烧掉（AGENTS.md「历史不能丢」的反例）。现在挪在
  // resizer.stripImagesWhenUnsupported（组装请求时现换）。这条测试锁住
  // 落库路径永不碰图——红了说明有人把降级又搬回来了
  it('历史里的图片原样穿过 normalize', () => {
    const input = [user(text('看这张图'), image())]
    const out = normalizeHistory(input)
    expect(out[0]?.parts[1]).toEqual(image())
  })
})

describe('hasPendingToolCalls', () => {
  it('normalize 之后一定是 false —— 否则中断后 loop 会空转一轮', () => {
    const raw = [user(text('跑')), assistant(call('a'))]
    expect(hasPendingToolCalls(raw)).toBe(true) // 前提：normalize 前确实有待处理

    expect(hasPendingToolCalls(normalizeHistory(raw))).toBe(false)
  })

  it('判据是「有没有结果」，不是「结果成不成功」', () => {
    const failed: Message[] = [
      assistant(call('a')),
      tool({ type: 'tool_result', toolCallId: 'a', output: 'boom', isError: true }),
    ]
    expect(hasPendingToolCalls(failed)).toBe(false)
  })

  it('刚流完、结果还没执行时是 true', () => {
    expect(hasPendingToolCalls([assistant(text('好的'), call('a'))])).toBe(true)
  })
})

describe('hasUnansweredUserInput', () => {
  it('用户在 agent 跑的时候插话 —— 没有这个判断那条消息会被丢掉', () => {
    const interjected = [
      user(text('跑一下')),
      assistant(call('a')),
      tool(result('a')),
      assistant(text('跑完了')),
      user(text('顺便统计行数')),
    ]
    expect(hasUnansweredUserInput(interjected)).toBe(true)
  })

  it('模型已经回应过最后一条用户输入时是 false', () => {
    const answered = [
      user(text('跑一下')),
      assistant(call('a')),
      tool(result('a')),
      assistant(text('跑完了')),
    ]
    expect(hasUnansweredUserInput(answered)).toBe(false)
  })

  it('中断补的占位不算用户插话 —— 否则 loop 空转一轮', () => {
    // 这条是 tool 角色换来的：占位挂在 user 消息里的话，它就是「最后一条
    // user 消息」且排在 assistant 之后，会被误判成有新输入
    const interrupted = normalizeHistory([user(text('跑')), assistant(call('a'))])

    expect(interrupted.at(-1)?.role).toBe('tool') // 前提：占位确实补上了
    expect(hasUnansweredUserInput(interrupted)).toBe(false)
  })

  it('工具结果本身不算用户插话', () => {
    expect(hasUnansweredUserInput([assistant(call('a')), tool(result('a'))])).toBe(false)
  })
})

// ------------------------------------------------- 归属的来源下标（提案 §1.5）

describe('normalizeWithOrigin：报告每条来自输入的哪个下标', () => {
  it('**补 tool_result 时，插入点之后的下标不漂移**', () => {
    // 病灶：store 的 turnOf/stepOf 纯按下标对齐。pass 1 在中间插一条占位，
    // 之后的全部历史整体错一位——**不报错**，只是某轮归错 turn，要到摘要
    // 按 turn 分组时才炸
    const input = [user(text('跑一下')), assistant(call('a')), user(text('后面这句'))]
    const { messages, origin } = normalizeWithOrigin(input)

    expect(messages).toHaveLength(4) // 前提：真的插进去了，否则测的是空集
    expect(origin).toEqual([0, 1, null, 2])
    // 插入点之后那条仍然指向它在输入里的位置 2，不是被挤成 3
    expect(messages[3]).toEqual(input[2])
  })

  it('**删掉孤儿 result 时，后面的下标同样跟着走**', () => {
    const input = [user(text('一')), tool(result('没人叫过它')), user(text('三'))]
    const { messages, origin } = normalizeWithOrigin(input)

    expect(messages).toHaveLength(2) // 前提：确实删了一条
    expect(origin).toEqual([0, 2])
  })

  it('**对照：什么都不用改时，origin 就是 0..n-1**', () => {
    // 没有这条的话，一个「永远返回全 null」的实现也能让上面两条通过
    const input = [user(text('跑一下')), assistant(call('a')), tool(result('a'))]
    const { origin } = normalizeWithOrigin(input)
    expect(origin).toEqual([0, 1, 2])
  })

  it('**并进已有 tool 消息的占位不算新插入**——那条本来就在输入里', () => {
    // 同一条 assistant 发两个 call、只有一个有结果时，占位并进下一条 tool
    // 消息而不是新插。那条的 origin 必须保持原样，否则它会被当成新消息去
    // 继承前一条的归属，而它自己本来就有正确的归属
    const input = [assistant(call('a'), call('b')), tool(result('a'))]
    const { messages, origin } = normalizeWithOrigin(input)

    expect(messages).toHaveLength(2) // 前提：并进去了，没有新插一条
    expect(messages[1]?.parts).toHaveLength(2) // 真实结果 + 占位
    expect(origin).toEqual([0, 1])
  })
})
