import type { AgentEvent, Message } from '@simple-code/core'
import { describe, expect, it } from 'vitest'
import {
  type ChatView,
  emptyView,
  finishTurn,
  fmtMs,
  fmtTok,
  groupItems,
  hydrateItems,
  reduce,
  type SingleItem,
  splitTurns,
} from '../webview/events.ts'

/**
 * 事件流 → 界面模型。**这一层的 bug 全都不抛异常，只是内容错**——
 * 气泡该清空时没清（两次回答拼在一起）、不该清时清了（前半段丢失）。
 * 所以它必须是纯函数，能脱离 DOM 喂事件序列断言结果（CLAUDE.md §4.3）。
 *
 * React 组件不测，逻辑全在这里。
 */

const feed = (...agentEvs: AgentEvent[]): ChatView =>
  agentEvs.reduce<ChatView>((view, agentEv) => reduce(view, agentEv, Date.now()), emptyView())

/** 最后一条 assistant 气泡的文本 */
const lastText = (view: ChatView): string => {
  const bubble = view.items.filter((i) => i.kind === 'assistant').at(-1)
  return bubble?.kind === 'assistant' ? bubble.text : ''
}

const says = (text: string): AgentEvent[] => [
  { type: 'text_start' },
  { type: 'text_delta', text },
  { type: 'text_end' },
]

describe('文本气泡', () => {
  it('delta 累加成一条', () => {
    const view = feed(
      { type: 'text_start' },
      { type: 'text_delta', text: '你' },
      { type: 'text_delta', text: '好' },
    )
    expect(lastText(view)).toBe('你好')
  })

  it('两段文本之间隔着工具调用时，分成两条气泡', () => {
    // 不分的话，工具输出会显示在错误的位置——在两段回答中间的那句
    // 会跑到最后去
    const view = feed(
      ...says('先看看目录'),
      { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', id: 't1', output: 'a.ts', exitCode: 0 },
      ...says('有一个文件'),
    )
    const assistants = view.items.filter((i) => i.kind === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(view.items.map((i) => i.kind)).toEqual(['assistant', 'tool', 'assistant'])
  })
})

describe('restart 和 truncated 必须区别对待', () => {
  // 这两个是最容易搞混的一对，搞混了不报错：
  // restart 不清 → 同一段文本重复两遍；truncated 清了 → 前半段凭空消失

  it('**restart 清空当前气泡**——请求重发了，之前吐的作废', () => {
    const view = feed(...says('前半句被打断'), { type: 'restart' }, ...says('重新来过'))
    expect(lastText(view)).toBe('重新来过')
    // 对照：作废的那段不能留在别处
    expect(JSON.stringify(view.items)).not.toContain('前半句被打断')
  })

  it('**truncated 不清空**——是续写，前面的仍然有效', () => {
    const view = feed(
      { type: 'text_start' },
      { type: 'text_delta', text: '第一段' },
      { type: 'truncated', attempt: 1, limit: 100 },
      { type: 'text_delta', text: '续上的第二段' },
    )
    expect(lastText(view)).toBe('第一段续上的第二段')
  })
})

describe('工具调用', () => {
  it('input_delta 攒到 tool_call 才算一条完整调用', () => {
    // 攒的过程中就建条目的话，界面上会先闪出一条参数残缺的记录
    const partial = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_input_delta', id: 't1', partial: '{"comm' },
    )
    expect(partial.items.filter((i) => i.kind === 'tool')).toHaveLength(1)
    const tool = partial.items.find((i) => i.kind === 'tool')
    expect(tool?.kind === 'tool' && tool.command).toBe('') // 还没攒完，没有命令

    const done = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls -la' } },
    )
    const ready = done.items.find((i) => i.kind === 'tool')
    expect(ready?.kind === 'tool' && ready.command).toBe('ls -la')
  })

  it('result 落到 id 对应的那一条上，不是最后一条', () => {
    // 并行工具调用时（协议层允许），按顺序落会把输出配错命令——
    // 界面上看起来「执行 ls 输出了 cat 的内容」
    const view = feed(
      { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_call', id: 't2', name: 'bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 't1', output: '目录列表', exitCode: 0 },
    )
    const tools = view.items.filter((i) => i.kind === 'tool')
    expect(tools[0]?.kind === 'tool' && tools[0].output).toBe('目录列表')
    expect(tools[1]?.kind === 'tool' && tools[1].output).toBe('')
  })

  it('非 0 退出标记成失败', () => {
    const view = feed(
      { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'false' } },
      { type: 'tool_result', id: 't1', output: '', exitCode: 1 },
    )
    const tool = view.items.find((i) => i.kind === 'tool')
    expect(tool?.kind === 'tool' && tool.failed).toBe(true)
  })

  // startedAt/endedAt 是墙钟（Date.now()），断言只看「有没有」不看值——
  // 同一段事件流两次 reduce 时间戳必然不同（events.ts 头注释）
  it('endedAt 未定义 = 还在跑（运行中 spinner / 完成行靠它分流）', () => {
    const started = feed({ type: 'tool_input_start', id: 't1', name: 'bash' })
    const pendingTool = started.items.find((i) => i.kind === 'tool')
    expect(pendingTool?.kind === 'tool' && pendingTool.endedAt).toBeUndefined()
    expect(pendingTool?.kind === 'tool' && typeof pendingTool.startedAt).toBe('number')

    const done = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_result', id: 't1', output: 'ok', exitCode: 0 },
    )
    const doneTool = done.items.find((i) => i.kind === 'tool')
    expect(doneTool?.kind === 'tool' && typeof doneTool.endedAt).toBe('number')
  })

  it('tool_error 也记 endedAt——报错和正常结束一样要离开「运行中」态', () => {
    const view = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_error', id: 't1', message: '超时' },
    )
    const tool = view.items.find((i) => i.kind === 'tool')
    expect(tool?.kind === 'tool' && typeof tool.endedAt).toBe('number')
    expect(tool?.kind === 'tool' && tool.failed).toBe(true)
  })
})

describe('unloaded', () => {
  it('**加一条归档提示，已有消息不变形**', () => {
    // events.ts:「原文没丢」——UI 不提示的话，用户翻上去看到自己的消息
    // 变成半截，像是数据被弄坏了
    const view = feed(...says('早期的回答'), {
      type: 'unloaded',
      count: 37,
      estimated: 36769,
      reason: 'budget',
      sinceMs: null,
    })
    expect(view.items.some((i) => i.kind === 'notice' && i.text.includes('37'))).toBe(true)
    // 已有的气泡一个字没变
    expect(lastText(view)).toBe('早期的回答')
  })

  it('**stale 触发不说「接近上限」**——预算没超，喊上限是误导（实测 raw 14% 也喊过）', () => {
    const view = feed({ type: 'unloaded', count: 13, estimated: 32674, reason: 'stale', sinceMs: 11 * 60_000 })
    const notice = view.items.find((i) => i.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.text.includes('缓存已过期')).toBe(true)
    expect(notice?.kind === 'notice' && notice.text.includes('接近上限')).toBe(false)
    // 带实际间隔自证（2026-09-20）：到没到 TTL 文案自己说话
    expect(notice?.kind === 'notice' && notice.text.includes('距上次响应 11 分钟')).toBe(true)
  })

  it('**force 触发说「超出上限」**——连保底区都卸了，跟「接近」是两回事', () => {
    const view = feed({ type: 'unloaded', count: 5, estimated: 0, reason: 'force', sinceMs: null })
    const notice = view.items.find((i) => i.kind === 'notice')
    expect(notice?.kind === 'notice' && notice.text.includes('超出模型上限')).toBe(true)
  })
})

describe('思考块', () => {
  it('单独成条，不混进回答里', () => {
    const view = feed(
      { type: 'reasoning_start' },
      { type: 'reasoning_delta', text: '让我想想' },
      { type: 'reasoning_end' },
      ...says('答案是 42'),
    )
    expect(view.items.map((i) => i.kind)).toEqual(['reasoning', 'assistant'])
    expect(lastText(view)).toBe('答案是 42') // 思考没混进来
  })
})

describe('用量', () => {
  it('lastTiming 两个事件各补一半：timing 给时延、step_finish 给 in/out', () => {
    // 上下文占用不能用累计值——那是「一共发了多少」，不是「现在占了多少」。
    // 用错的话跑几轮就显示超过 100%（render.ts 里踩过同样的坑）
    const usage = (input: number) => ({
      inputTokens: input,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    })
    // contextTokens 故意和 usage 里的数**对不上**：它是 core 报的「下一轮要
    // 发多少」（含新增估算），不是这一步的 input。取值写成 usage 的话，
    // 有人改回 `totalInput(usage)` 这条用例照样绿
    const view = feed(
      { type: 'request_timing', ttftMs: 800, totalMs: 4200 },
      { type: 'step_finish', usage: usage(100), contextTokens: 7000 },
      { type: 'step_finish', usage: usage(150), contextTokens: 9000 },
    )
    expect(view.contextTokens).toBe(9000) // 最后一步报的数，不是累加、也不是 usage
    expect(view.lastTiming).toEqual({ ttftMs: 800, totalMs: 4200, inputTokens: 150, outputTokens: 10 })
  })

  it('乱序宽容：step_finish 先到（比如测试或回放缺 timing）也建得起骨架', () => {
    const usage = (input: number) => ({
      inputTokens: input,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    })
    const view = feed({ type: 'step_finish', usage: usage(100), contextTokens: 7000 })
    expect(view.lastTiming).toEqual({ ttftMs: 0, totalMs: 0, inputTokens: 100, outputTokens: 10 })
  })
})

describe('fmtMs / fmtTok', () => {
  it('fmtMs：<1s 用 ms；≥1s 一位小数去尾零', () => {
    expect(fmtMs(843)).toBe('843ms')
    expect(fmtMs(1200)).toBe('1.2s')
    expect(fmtMs(1000)).toBe('1s')
    expect(fmtMs(8400)).toBe('8.4s')
  })

  it('fmtTok：<1000 原样；之后 k 一位小数去尾零', () => {
    expect(fmtTok(850)).toBe('850')
    expect(fmtTok(45200)).toBe('45.2k')
    expect(fmtTok(96000)).toBe('96k')
    expect(fmtTok(1000)).toBe('1k')
    // 上下文面板的分区数是估算（带 .5/.75）× usage 校准系数，<1000 时曾原样
    // 显示成 315.77238625893915（2026-09-30 实测）
    expect(fmtTok(315.77238625893915)).toBe('316')
    expect(fmtTok(838.5)).toBe('839')
    expect(fmtTok(999.6)).toBe('1k') // 先取整再分档，不出「1000」
  })
})

describe('用户消息', () => {
  it('pushUser 进列表，后续 assistant 排在它后面', () => {
    let view = emptyView()
    view = { ...view, items: [...view.items, { kind: 'user', text: '你好' }] }
    view = says('你也好').reduce<ChatView>((v, e) => reduce(v, e, Date.now()), view)
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant'])
  })
})

describe('活动组分组（groupItems）', () => {
  const tool = (id: string): AgentEvent => ({ type: 'tool_input_start', id, name: 'bash' })

  it('连续的 reasoning/tool 归一组，user/assistant/notice 自成块', () => {
    const view = feed(
      { type: 'text_start' }, // assistant 空
      { type: 'text_end' },
      { type: 'reasoning_start' },
      tool('t1'),
      tool('t2'),
      { type: 'text_start' },
    )
    const shapes = groupItems(view.items).map((b) =>
      b.kind === 'activity' ? `activity(${b.items.length})` : b.item.kind,
    )
    // assistant(空) → [reasoning+t1+t2] → assistant
    expect(shapes).toEqual(['assistant', 'activity(3)', 'assistant'])
  })

  it('两个活动组被 assistant 正文隔开时不合并', () => {
    // 中间的文本块是「回答接棒」的信号——组要在它出现时收起，合并了就没了
    const view = feed(
      { type: 'reasoning_start' },
      tool('t1'),
      { type: 'text_start' },
      { type: 'reasoning_start' },
      tool('t2'),
    )
    expect(groupItems(view.items)).toHaveLength(3)
  })

  it('纯工具轮没有前后文本，也是一个组', () => {
    const view = feed(tool('t1'), tool('t2'))
    const [only] = groupItems(view.items)
    expect(only?.kind === 'activity' && only.items).toHaveLength(2)
  })
})

describe('thinking 块墙钟', () => {
  it('reasoning_end 记 endedAt；没 end 就没有（运行中）', () => {
    const running = feed({ type: 'reasoning_start' })
    const r1 = running.items.at(-1)
    expect(r1?.kind === 'reasoning' && r1.endedAt).toBeUndefined()

    const done = feed({ type: 'reasoning_start' }, { type: 'reasoning_end' })
    const r2 = done.items.at(-1)
    expect(r2?.kind === 'reasoning' && typeof r2.endedAt).toBe('number')
  })

  it('紧挨着的两块思考并成一行：文字空行相接，时长从第一块开始、到第二块结束', () => {
    // Opus 5.5 在工具调用前另发一个 progress update 的 thinking 块（真机
    // 某项目消息 2782582：英文思考 + 中文进度两段），分开画就是
    // 一次调用两行「已思考」
    const reduceAt = (v: ChatView, e: AgentEvent, t: number) => reduce(v, e, t)
    let view = emptyView()
    view = reduceAt(view, { type: 'reasoning_start' }, 1000)
    view = reduceAt(view, { type: 'reasoning_delta', text: "I'm noticing" }, 1100)
    view = reduceAt(view, { type: 'reasoning_end' }, 18000)
    view = reduceAt(view, { type: 'reasoning_start' }, 18010)
    const mid = view.items.at(-1)
    // 第二块在流：合并行回到「思考中」
    expect(mid?.kind === 'reasoning' && mid.endedAt).toBeUndefined()
    view = reduceAt(view, { type: 'reasoning_delta', text: '继续核对几项' }, 18100)
    view = reduceAt(view, { type: 'reasoning_end' }, 18400)
    expect(view.items).toEqual([
      { kind: 'reasoning', text: "I'm noticing\n\n继续核对几项", startedAt: 1000, endedAt: 18400 },
    ])
  })

  it('被工具隔开的思考不合并', () => {
    const view = feed(
      { type: 'reasoning_start' },
      { type: 'reasoning_end' },
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'reasoning_start' }, // 第二块，还没 end
    )
    const items = view.items.filter((i) => i.kind === 'reasoning')
    expect(items).toHaveLength(2)
    const [first, second] = items
    expect(first?.kind === 'reasoning' && typeof first.endedAt).toBe('number')
    expect(second?.kind === 'reasoning' && second.endedAt).toBeUndefined()
  })
})

/**
 * 页脚的计时。**这几条错了都不抛异常，只是数字不对**——耗时显示成上一轮
 * 加这一轮的总和、时间戳记到了工具行上导致页脚不出现。数字看着像那么回事，
 * 不对照根本发现不了。
 */
describe('一轮结束的计时', () => {
  /** 先手工放一条用户消息 + 起点，模拟 App.send 做的事 */
  const started = (view: ChatView, at: number): ChatView => ({
    ...view,
    items: [...view.items, { kind: 'user', text: '问题' }],
    turnStartedAt: at,
  })

  // 这里曾有一条「reduce 不认 finish」的守卫测试。**现在由编译器守卫**：
  // AgentEvent 里的 finish 已经删掉（core/src/events.ts 有原委），想接回去
  // 的人在 tsc 那一关就过不了，比测试更早也更硬

  it('完成时刻记到最后一条 assistant 上', () => {
    const view = finishTurn(
      started(feed({ type: 'text_start' }, { type: 'text_delta', text: '答' }), Date.now() - 500),
    )
    const bubble = view.items.filter((i) => i.kind === 'assistant').at(-1)
    expect(bubble?.kind === 'assistant' && typeof bubble.finishedAt).toBe('number')
    expect(bubble?.kind === 'assistant' && bubble.elapsedMs).toBeGreaterThanOrEqual(500)
  })

  it('**以工具结尾时不记**——不能把时间戳写进工具行', () => {
    // 用户中断时很常见。硬记到"最后一条 item"上的话，工具行上多出两个
    // 无意义字段，而页脚仍然不出现（它只认 assistant）
    const view = finishTurn(
      started(feed({ type: 'tool_input_start', id: 't1', name: 'bash' }), Date.now()),
    )
    const tool = view.items.find((i) => i.kind === 'tool')
    expect(tool).toBeDefined()
    expect(JSON.stringify(tool)).not.toContain('finishedAt')
    expect(view.turnStartedAt).toBeNull() // 起点仍然要清掉
  })

  it('**起点用完置空**——第二轮的耗时不能把第一轮算进去', () => {
    const first = finishTurn(started(feed({ type: 'text_start' }), Date.now() - 10_000))
    expect(first.turnStartedAt).toBeNull()

    // 第二轮只跑了很短时间。不置空的话这里会得到 10 秒开外
    const second = finishTurn(
      reduce(started(first, Date.now()), { type: 'text_start' }, Date.now()),
    )
    const bubble = second.items.filter((i) => i.kind === 'assistant').at(-1)
    expect(bubble?.kind === 'assistant' && bubble.elapsedMs).toBeLessThan(1000)
  })

  it('没有起点时不给耗时，而不是编一个', () => {
    // turnStartedAt 为 null（比如面板刚打开就收到事件）。给 0 或者拿
    // finishedAt 当差值都会显示一个假数字
    const view = finishTurn(feed({ type: 'text_start' }))
    const bubble = view.items.filter((i) => i.kind === 'assistant').at(-1)
    expect(bubble?.kind === 'assistant' && bubble.finishedAt).toBeDefined()
    expect(bubble?.kind === 'assistant' && bubble.elapsedMs).toBeUndefined()
  })

  it('**model 记在轮上**——结束时刻传什么就是什么，后续轮次不改写前轮', () => {
    const first = finishTurn(feed({ type: 'text_start' }), false, 'p/alpha')
    const bubble1 = first.items.filter((i) => i.kind === 'assistant').at(-1)
    expect(bubble1?.kind === 'assistant' && bubble1.model).toBe('p/alpha')

    // 第二轮换了模型。第一轮的标注必须原样——页脚显示的是"这句是谁说的"
    const second = finishTurn(reduce(first, { type: 'text_start' }, Date.now()), false, 'p/beta')
    const bubbles = second.items.filter((i) => i.kind === 'assistant')
    expect(bubbles[0]?.kind === 'assistant' && bubbles[0].model).toBe('p/alpha')
    expect(bubbles[1]?.kind === 'assistant' && bubbles[1].model).toBe('p/beta')
  })
})

/**
 * 类型层断言，没有运行时行为。
 *
 * `SingleItem` 的定义一旦退回成 `Exclude<ChatItem, 'tool' | 'reasoning'>`
 * （拿字符串字面量去排除对象类型），它什么都排除不掉、等于 `ChatItem`，
 * 而**没有任何运行时症状**——渲染层照收 tool/reasoning，只是 switch 落空
 * 渲出空白。这条断言让那种写法在 tsc 就红
 */
type NoActivityInSingle =
  Extract<SingleItem, { kind: 'tool' | 'reasoning' }> extends never
    ? true
    : 'SingleItem 没能排除掉 tool/reasoning'
const _assertSingleExcludesActivity: NoActivityInSingle = true
void _assertSingleExcludesActivity

// ------------------------------------------------------------ 历史回放

describe('历史回放（hydrateItems）', () => {
  const msgs = (...m: Message[]): Message[] => m

  it('带 turnId/meta/elapsedMs 的行：每轮尾部 assistant 挂页脚，model 取尾段', () => {
    const rows = [
      {
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: '问一' }],
        turnId: 1,
        meta: { model: 'p/old-model', effort: 'high' },
        elapsedMs: 4321,
      },
      {
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: '答一' }],
        turnId: 1,
        meta: { model: 'p/old-model', effort: 'high' },
        elapsedMs: 4321,
        finishedAt: 1789028417569,
      },
      {
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: '问二' }],
        turnId: 2,
        meta: { model: 'p/new-model', effort: null },
        elapsedMs: null, // 轮没跑完：不补页脚
      },
      {
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: '答二' }],
        turnId: 2,
        meta: { model: 'p/new-model', effort: null },
        elapsedMs: null,
      },
    ]
    const items = hydrateItems(rows)
    const footers = items
      .filter((i) => i.kind === 'assistant')
      .map((i) => (i.kind === 'assistant' ? [i.model, i.elapsedMs, i.finishedAt] : []))
    // 轮 1：当时的模型 + 当时的耗时（历史事实，之后换模型不改写）
    // finishedAt 是 App.tsx 的页脚渲染开关，缺了整个页脚不显示（reload 后
    // 历史轮全没页脚的坑）
    expect(footers[0]).toEqual(['old-model', 4321, 1789028417569])
    // 轮 2：没跑完（elapsedMs null），不编页脚
    expect(footers[1]).toEqual([undefined, undefined, undefined])
  })

  it('一条消息里相邻的两段思考回放成一行，与实时流同口径', () => {
    const items = hydrateItems(
      msgs({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: "I'm noticing", encrypted: 's1' },
          { type: 'reasoning', text: '继续核对几项', encrypted: 's2' },
          { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } },
          { type: 'reasoning', text: '看完了', encrypted: 's3' },
        ],
      }),
    )
    expect(items.filter((i) => i.kind === 'reasoning').map((i) => (i.kind === 'reasoning' ? i.text : ''))).toEqual([
      "I'm noticing\n\n继续核对几项",
      '看完了',
    ])
  })

  it('user/assistant/text 各成一个气泡，图片随 user 气泡', () => {
    const items = hydrateItems(
      msgs(
        {
          role: 'user',
          parts: [
            { type: 'text', text: '看图' },
            { type: 'image', data: 'xx', mimeType: 'image/png' },
          ],
        },
        { role: 'assistant', parts: [{ type: 'text', text: '好的' }] },
      ),
    )
    expect(items).toEqual([
      { kind: 'user', text: '看图', images: [{ data: 'xx', mimeType: 'image/png' }] },
      { kind: 'assistant', text: '好的' },
    ])
  })

  it('模型切换告知回放成分割线：不是用户气泡，文案剥掉〔系统〕和给 agent 看的末句（2026-10-17 用户定样式）', () => {
    const items = hydrateItems(
      msgs(
        { role: 'user', parts: [{ type: 'text', text: '第一轮' }] },
        { role: 'assistant', parts: [{ type: 'text', text: '答' }] },
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: '〔系统〕模型已从 alpha/a-small 切换到 beta/b-one。此前的回复由上一个模型生成。',
            },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: '第二轮' }] },
      ),
    )
    expect(items).toEqual([
      { kind: 'user', text: '第一轮' },
      { kind: 'assistant', text: '答' },
      { kind: 'divider', text: '模型已从 alpha/a-small 切换到 beta/b-one' },
      { kind: 'user', text: '第二轮' },
    ])
  })

  it('〔系统〕开头但不是切换告知的（用户自己打的），照常是用户气泡', () => {
    const items = hydrateItems(msgs({ role: 'user', parts: [{ type: 'text', text: '〔系统〕这几个字是我打的' }] }))
    expect(items).toEqual([{ kind: 'user', text: '〔系统〕这几个字是我打的' }])
  })

  it('模型名里带「。」或「 切换到 」以外的字符也解析对（provider/name 允许含 /）', () => {
    const items = hydrateItems(
      msgs({
        role: 'user',
        parts: [{ type: 'text', text: '〔系统〕模型已从 a/org/m-1 切换到 modelbest/claude-opus-5-5。此前的回复由上一个模型生成。' }],
      }),
    )
    expect(items).toEqual([{ kind: 'divider', text: '模型已从 a/org/m-1 切换到 modelbest/claude-opus-5-5' }])
  })

  it('tool_call 和 tool_result 跨消息按 id 配对成一条工具条目', () => {
    const items = hydrateItems(
      msgs(
        {
          role: 'assistant',
          parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: { command: 'ls' } }],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', toolCallId: 't1', output: 'a\nb', isError: false }],
        },
      ),
    )
    expect(items).toEqual([
      { kind: 'tool', id: 't1', name: 'bash', desc: '', command: 'ls', output: 'a\nb', failed: false },
    ])
  })

  it('孤儿 tool_result（配对的 call 不在页内）也渲染，命令留空', () => {
    const items = hydrateItems(
      msgs({
        role: 'tool',
        parts: [{ type: 'tool_result', toolCallId: 't9', output: 'x', isError: true }],
      }),
    )
    expect(items).toEqual([
      { kind: 'tool', id: 't9', name: 'bash', desc: '', command: '', output: 'x', failed: true },
    ])
  })

  it('reasoning part 映射成 reasoning 条目，没有墙钟（历史态）', () => {
    const items = hydrateItems(
      msgs({
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '想一想' },
          { type: 'text', text: '答案' },
        ],
      }),
    )
    expect(items).toEqual([
      { kind: 'reasoning', text: '想一想' },
      { kind: 'assistant', text: '答案' },
    ])
    expect(items[0] !== undefined && 'startedAt' in items[0]).toBe(false)
  })

  it('卸载存根整条跳过（全文在上方历史分页里，渲染头部会重复）', () => {
    const items = hydrateItems(
      msgs(
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: 'cat a.py 的开头部分\n[已卸载，完整内容见 .simple-code/memory/turns/0042.jsonl]',
            },
          ],
        },
        { role: 'assistant', parts: [{ type: 'text', text: '正常回答' }] },
        {
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'ls -la\n# [已卸载，完整内容见 .simple-code/memory/turns/0042.jsonl]',
            },
          ],
        },
      ),
    )
    // 第一、三条是存根（文本版 / shell 版标记），只有中间的留下来
    expect(items).toEqual([{ kind: 'assistant', text: '正常回答' }])
  })

  it('tool 条目任意一侧是存根，整条丢弃', () => {
    const items = hydrateItems(
      msgs(
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: 't1',
              name: 'bash',
              input: {
                command:
                  'git log --oneline | head -3\n# [已卸载，完整内容见 .simple-code/memory/turns/0042.jsonl]',
              },
            },
          ],
        },
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              toolCallId: 't1',
              output:
                'abc123 修了个 bug\n[已卸载，完整内容见 .simple-code/memory/turns/0042.jsonl]',
              isError: false,
            },
          ],
        },
      ),
    )
    expect(items).toEqual([]) // call 和 result 都是存根 → 整条没了
  })
  it('空消息数组和空 parts 不炸、返回空', () => {
    expect(hydrateItems([])).toEqual([])
    expect(hydrateItems(msgs({ role: 'assistant', parts: [] }))).toEqual([])
  })

  it('tool_result 带缩略图（toHydrateRows 转换后的 string[]）→ ChatItem.images；原图 ImagePart[] 不显示', () => {
    const THUMB = 'data:image/jpeg;base64,xx==' // 256px 缩略图 data URL（core 侧缩好）
    const rows = [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 't1',
            tool: 'view_image',
            input: { path: '/tmp/shot.png' },
          } as const,
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: 't1',
            output: '[视觉转述] 一张图',
            isError: false,
            images: [THUMB],
          } as const,
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: 't2',
            output: '[视觉转述] 另一张',
            isError: false,
            // fold 路径直传的原图 ImagePart[]——webview 不显示（无缩略）
            images: [{ type: 'image', data: 'huge-original-b64', mimeType: 'image/png' }],
          } as const,
        ],
      },
    ] as const
    const items = hydrateItems(rows as never) as Extract<import('../webview/events.ts').ChatItem, { kind: 'tool' }>[]
    const t1 = items.find((i) => i.id === 't1')
    expect(t1?.images).toEqual([THUMB])
    const t2 = items.find((i) => i.id === 't2')
    expect(t2?.images).toBeUndefined()
  })
})

describe('第三层折叠（splitTurns）', () => {
  const tool = (id: string): AgentEvent => ({ type: 'tool_input_start', id, name: 'bash' })
  /** 折出来的形状：`process(工具数)` 或块的种类 */
  const shape = (view: ChatView, foldLast = true): string[] =>
    splitTurns(groupItems(view.items), foldLast).map((s) =>
      s.kind === 'process'
        ? `process(${s.tools})`
        : s.block.kind === 'activity'
          ? `activity(${s.block.items.length})`
          : s.block.item.kind,
    )

  const asked = (view: ChatView): ChatView => ({
    ...view,
    items: [{ kind: 'user', text: '问题' }, ...view.items],
  })

  it('正常结束：过程全折，只留最终回答', () => {
    // 截图里那个形状：说明 → 操作 → 说明 → 操作 → 最终回答
    const view = asked(
      feed(
        ...says('先看一下'),
        tool('t1'),
        ...says('再跑一个'),
        tool('t2'),
        tool('t3'),
        ...says('结论是'),
      ),
    )
    expect(shape(view)).toEqual(['user', 'process(3)', 'assistant'])
  })

  it('**报错时那条 notice 留在外面**——错误绝不能被折进去', () => {
    const view = asked(feed(tool('t1'), { type: 'error', message: '网关挂了', retryable: false }))
    expect(shape(view)).toEqual(['user', 'process(1)', 'notice'])
    // 不可重试的错也给「继续」：用户可能改完配置再接着做（渠道未启用）
    expect(view.items.at(-1)).toMatchObject({ kind: 'notice', resumable: true })
  })

  it('报错 notice 带 kind 与 resumable——UI 据此标色、停稳后给「继续」按钮（不论可否重试：自动重试已在 core 做完）', () => {
    const view = asked(
      feed(tool('t1'), {
        type: 'error',
        message: '渠道 500：upstream panic',
        retryable: true,
        kind: 'server',
      }),
    )
    expect(view.items.at(-1)).toEqual({
      kind: 'notice',
      text: '渠道 500：upstream panic',
      resumable: true,
      errorKind: 'server',
    })
  })

  it('中断在命令中间：保留区只剩「已中断」那行', () => {
    const view = finishTurn(asked(feed(...says('我先看看'), tool('t1'))), true)
    expect(shape(view)).toEqual(['user', 'process(1)', 'notice'])
    expect(view.items.at(-1)).toEqual({ kind: 'notice', text: '已中断', resumable: true })
  })

  it('中断在回答中间：那半截回答留在外面——用户正在读它', () => {
    const view = finishTurn(asked(feed(tool('t1'), ...says('答到一半'))), true)
    expect(shape(view)).toEqual(['user', 'process(1)', 'assistant', 'notice'])
  })

  it('**对照：跑着的那一轮不折**，过程就是用户此刻要看的东西', () => {
    const view = asked(feed(...says('先看一下'), tool('t1'), ...says('再说')))
    expect(shape(view, false)).toEqual(['user', 'assistant', 'activity(1)', 'assistant'])
  })

  it('多轮各折各的，不会把上一轮的回答折进这一轮', () => {
    const first = asked(feed(tool('t1'), ...says('第一轮的答案')))
    const view: ChatView = {
      ...first,
      items: [...first.items, { kind: 'user', text: '第二个问题' }, ...feed(tool('t2')).items],
    }
    expect(shape(view)).toEqual(['user', 'process(1)', 'assistant', 'user', 'process(1)'])
  })

  it('历史从半轮开始（分页截断，第一块不是 user）也要能折', () => {
    // 往上翻的历史最需要折，而它的开头几乎不可能正好是一条 user 消息
    const view = feed(tool('t1'), ...says('答案'))
    expect(shape(view)).toEqual(['process(1)', 'assistant'])
  })

  it('没有过程可折时不出折叠头——纯聊天那一轮别凭空多一行', () => {
    expect(shape(asked(feed(...says('好的'))))).toEqual(['user', 'assistant'])
  })

  it('**thinking 不算操作数**——「操作」是工具调用，不是想了几次', () => {
    const view = asked(feed({ type: 'reasoning_start' }, tool('t1'), ...says('答案')))
    // 组里有 2 个 ActivityItem（1 思考 + 1 工具），折叠头只报 1
    expect(shape(view)).toEqual(['user', 'process(1)', 'assistant'])
  })

  it('耗时取整轮的 elapsedMs；回放的历史没有就不显示', () => {
    const live = finishTurn(
      { ...asked(feed(tool('t1'), ...says('答'))), turnStartedAt: Date.now() - 800 },
      false,
    )
    const section = splitTurns(groupItems(live.items), true).find((s) => s.kind === 'process')
    expect(section?.kind === 'process' && section.elapsedMs).toBeGreaterThanOrEqual(800)

    // 对照：回放的历史（hydrateItems 不带时间戳）
    const replayed = asked(feed(tool('t1'), ...says('答')))
    const cold = splitTurns(groupItems(replayed.items), true).find((s) => s.kind === 'process')
    expect(cold?.kind === 'process' && cold.elapsedMs).toBeUndefined()
  })
})

describe('中断要留下痕迹', () => {
  it('interrupted → 追加「已中断」', () => {
    const view = finishTurn(feed({ type: 'text_start' }, { type: 'text_delta', text: '答' }), true)
    expect(view.items.at(-1)).toEqual({ kind: 'notice', text: '已中断', resumable: true })
  })

  it('**对照：正常结束不追加**，别给每一轮都盖个中断章', () => {
    const view = finishTurn(feed({ type: 'text_start' }, { type: 'text_delta', text: '答' }))
    expect(view.items.some((i) => i.kind === 'notice')).toBe(false)
  })

  it('一条 assistant 都没有时也要留下痕迹', () => {
    // 中断在第一个命令上：没有能挂页脚的消息，finishTurn 原来直接 return，
    // 于是这一轮在界面上一个字都没有——第三层折叠一收就是「什么都没发生」
    const view = finishTurn(feed({ type: 'tool_input_start', id: 't1', name: 'bash' }), true)
    expect(view.items.at(-1)).toEqual({ kind: 'notice', text: '已中断', resumable: true })
  })
})

describe('bash 入参 desc → 工具条标题位（2026-09-28）', () => {
  it('tool_call 带 desc 时存进视图态，缺省留空不猜', () => {
    const view = feed(
      { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'npx vitest run', desc: '跑全量测试' } },
      { type: 'tool_call', id: 't2', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_call', id: 't3', name: 'bash', input: { command: 'ls', desc: 42 } },
    )
    const tools = view.items.filter((i) => i.kind === 'tool') as { desc: string; command: string }[]
    expect(tools.map((t) => t.desc)).toEqual(['跑全量测试', '', ''])
    expect(tools.map((t) => t.command)).toEqual(['npx vitest run', 'ls', 'ls'])
  })

  type Tool = { desc: string; command: string; rawInput?: string }
  const toolOf = (view: ReturnType<typeof feed>, id = 't1') =>
    view.items.find((i) => i.kind === 'tool' && i.id === id) as Tool

  // glm 照官方 Bash 工具的参数名写 description（真实项目入参）
  const glmInput = { command: 'grep -rn "writeChunk" knowledge-server/src/test/ | head -4', description: '定位 writeChunk 所在测试文件', timeout: 15 }

  it('description 当 desc 用：tool_call、流式、历史回放三条路都认；desc 优先', () => {
    const call = feed({ type: 'tool_call', id: 't1', name: 'bash', input: glmInput })
    expect(toolOf(call).desc).toBe('定位 writeChunk 所在测试文件')
    const both = feed({ type: 'tool_call', id: 't1', name: 'bash', input: { ...glmInput, desc: '短的' } })
    expect(toolOf(both).desc).toBe('短的')

    const streamed = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_input_delta', id: 't1', partial: '{"command": "grep -rn \\"writeChunk\\" x", "description": "定位 writeChunk' },
      { type: 'tool_input_delta', id: 't1', partial: ' 所在测试文件", "timeout' },
    )
    expect(toolOf(streamed).desc).toBe('定位 writeChunk 所在测试文件')

    const items = hydrateItems([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'bash', input: glmInput }] },
    ])
    expect(items.find((i) => i.kind === 'tool')).toMatchObject({ desc: '定位 writeChunk 所在测试文件' })
  })

  it('流式：desc 字符串闭合即显示，不等 tool_call；命令仍留空', () => {
    const start = { type: 'tool_input_start', id: 't1', name: 'bash' } as const
    const d = (partial: string) => ({ type: 'tool_input_delta', id: 't1', partial }) as const
    const half = feed(start, d('{"desc": "跑全'))
    expect(toolOf(half).desc).toBe('')
    const done = feed(start, d('{"desc": "跑全'), d('量测试", "comm'), d('and": "npx vitest run --reporter'))
    expect(toolOf(done).desc).toBe('跑全量测试')
    expect(toolOf(done).command).toBe('')
    // 抠到就丢中间态，后面的长命令片段不再攒
    expect(toolOf(done).rawInput).toBeUndefined()
  })

  it('流式：转义字符按 JSON 解码；tool_call 用完整入参覆盖', () => {
    const view = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_input_delta', id: 't1', partial: '{"desc":"看 \\"a\\" 文件","command":"cat a"}' },
    )
    expect(toolOf(view).desc).toBe('看 "a" 文件')
    const final = feed(
      { type: 'tool_input_start', id: 't1', name: 'bash' },
      { type: 'tool_input_delta', id: 't1', partial: '{"desc":"旧"' },
      { type: 'tool_call', id: 't1', name: 'bash', input: { desc: '新', command: 'cat a' } },
    )
    expect(toolOf(final)).toMatchObject({ desc: '新', command: 'cat a' })
    expect(toolOf(final).rawInput).toBeUndefined()
  })

  it('流式：非 bash 工具不攒片段', () => {
    const view = feed(
      { type: 'tool_input_start', id: 't1', name: 'view_image' },
      { type: 'tool_input_delta', id: 't1', partial: '{"desc":"x","path":"a.png"}' },
    )
    expect(toolOf(view)).toMatchObject({ desc: '' })
    expect(toolOf(view).rawInput).toBeUndefined()
  })
})

describe('模型切换分割线（实时，model_switch 事件）', () => {
  it('流首事件把分割线插到本轮 user 气泡前——与回放位置一致', () => {
    // App 先本地 append 了 user 气泡，然后 model_switch 作为流首事件到达
    let view: ChatView = {
      ...emptyView(),
      items: [
        { kind: 'user', text: '第一轮' },
        { kind: 'assistant', text: '答' },
        { kind: 'user', text: '第二轮' },
      ],
    }
    view = reduce(view, { type: 'model_switch', from: 'alpha/a-small', to: 'beta/b-one' }, Date.now())
    view = reduce(view, { type: 'text_start' }, Date.now())
    view = reduce(view, { type: 'text_delta', text: '新模型的回答' }, Date.now())
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'divider', 'user', 'assistant'])
    expect(view.items[2]).toEqual({ kind: 'divider', text: '模型已从 alpha/a-small 切换到 beta/b-one' })
  })

  it('上一轮的过程被折叠时，分割线留在外面不被折进去', () => {
    let view: ChatView = {
      ...emptyView(),
      items: [{ kind: 'user', text: '第一轮' }],
    }
    view = reduce(view, { type: 'tool_input_start', id: 't1', name: 'bash' }, Date.now())
    view = reduce(view, { type: 'text_start' }, Date.now())
    view = reduce(view, { type: 'text_delta', text: '结论' }, Date.now())
    view = { ...view, items: [...view.items, { kind: 'user', text: '第二轮' }] }
    view = reduce(view, { type: 'model_switch', from: 'alpha/a-small', to: 'beta/b-one' }, Date.now())
    const shape = splitTurns(groupItems(view.items), true).map((s) =>
      s.kind === 'process' ? 'process' : s.block.kind === 'activity' ? 'activity' : s.block.item.kind,
    )
    expect(shape).toEqual(['user', 'process', 'assistant', 'divider', 'user'])
  })
})
