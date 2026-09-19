import { describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import {
  assembleContext,
  hotSummaryIds,
  type LiveMessage,
  type Summary,
} from '../src/loop/assemble.ts'

const says = (role: Message['role'], text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})

/** live 消息，按 turn 归属 */
const at = (turnId: number, role: Message['role'], text: string): LiveMessage => ({
  turnId,
  stepId: turnId,
  message: says(role, text),
})

const summary = (
  over: Partial<Summary> & Pick<Summary, 'id' | 'coversFrom' | 'coversTo'>,
): Summary => ({
  level: 0,
  name: '',
  text: `摘要 ${over.id}`,
  status: 'ready',
  inContext: true,
  supersededBy: null,
  head: null,
  archivePath: null,
  ...over,
})

/** 结果里每条消息的文本，好做顺序断言 */
const texts = (messages: Message[]): string[] =>
  messages.map((msg) => msg.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join(''))

describe('context 拼装', () => {
  it('没有摘要时原样返回 live 消息', async () => {
    const live = [at(1, 'user', '一'), at(1, 'assistant', '二'), at(2, 'user', '三')]

    expect(assembleContext(live, [])).toEqual(live.map((e) => e.message))
  })

  it('对照组：有摘要但 inContext=false 时也原样返回', () => {
    // §9.1 的核心：合并写进库但不生效期间，context 必须一个字节不变。
    // 没有这条的话，「只要有摘要行就替换」的实现也能让下面全绿
    const live = [at(1, 'user', '一'), at(2, 'user', '二')]
    const pending = summary({ id: 1, coversFrom: 1, coversTo: 1, inContext: false })

    expect(assembleContext(live, [pending])).toEqual(live.map((e) => e.message))
  })

  it('被覆盖的 turn 换成摘要，其余 live 消息不动', () => {
    const live = [at(1, 'user', '老问题'), at(1, 'assistant', '老回答'), at(2, 'user', '新问题')]
    const s = summary({ id: 7, coversFrom: 1, coversTo: 1, text: '聊过老话题' })

    const out = texts(assembleContext(live, [s]))

    expect(out).toHaveLength(2)
    expect(out[0]).toContain('聊过老话题')
    expect(out[1]).toBe('新问题') // 没被覆盖的原样
  })

  it('一条摘要覆盖多个 turn 时只出现一次', () => {
    // 每个 turn 发一遍的话，10 个 turn 的 L1 摘要会在 context 里重复 10 次——
    // 那不但浪费窗口，还让模型以为这件事被强调了 10 遍
    const live = [at(1, 'user', '一'), at(2, 'user', '二'), at(3, 'user', '三')]
    const s = summary({ id: 1, coversFrom: 1, coversTo: 2, text: '前两轮' })

    const out = texts(assembleContext(live, [s]))

    expect(out).toHaveLength(2)
    expect(out.filter((t) => t.includes('前两轮'))).toHaveLength(1)
    expect(out[1]).toBe('三')
  })

  it('整个 turn 的 live 消息都没了，摘要仍在正确位置', () => {
    // 卸载会把消息标成 unloaded，live 里就没了。「遍历 live 消息、遇到被覆盖的
    // 就替换」那种写法在这里会**整条摘要漏发**——而且不报错，只是历史里
    // 凭空少一段
    const live = [at(3, 'user', '第三轮'), at(4, 'user', '第四轮')]
    const s = summary({ id: 1, coversFrom: 1, coversTo: 2, text: '前两轮的事' })

    const out = texts(assembleContext(live, [s]))

    expect(out).toHaveLength(3)
    expect(out[0]).toContain('前两轮的事') // 排在最前，不是被追加到末尾
    expect(out[1]).toBe('第三轮')
  })

  it('多条摘要按 turn 顺序排列', () => {
    const live = [at(5, 'user', '第五轮')]
    const older = summary({ id: 1, coversFrom: 1, coversTo: 2, text: '最早' })
    const newer = summary({ id: 2, coversFrom: 3, coversTo: 4, text: '稍晚' })

    // 故意乱序传入：顺序该由 coversFrom 决定，不是由数组顺序决定
    const out = texts(assembleContext(live, [newer, older]))

    expect(out).toHaveLength(3)
    expect(out[0]).toContain('最早')
    expect(out[1]).toContain('稍晚')
    expect(out[2]).toBe('第五轮')
  })

  it('摘要是 user 消息，且带标记不会被当成用户指令', () => {
    // 裸文本的话模型会把摘要当成最新指令去执行
    const s = summary({ id: 1, coversFrom: 1, coversTo: 1, text: '做过某事' })

    const [msg] = assembleContext([at(2, 'user', '现在')], [s])

    expect(msg?.role).toBe('user')
    expect(texts([msg as Message])[0]).toMatch(/^<历史摘要/)
  })

  it('同一个 turn 里的多条消息保持原顺序', () => {
    // 分组时用 Map 攒，攒错的话 tool_call 和 tool_result 会被拆散顺序，
    // 那是下一轮 400
    const live = [
      at(1, 'user', 'a'),
      at(1, 'assistant', 'b'),
      at(1, 'tool', 'c'),
      at(1, 'assistant', 'd'),
    ]

    expect(texts(assembleContext(live, []))).toEqual(['a', 'b', 'c', 'd'])
    // 有不相关的摘要时也一样
    const other = summary({ id: 1, coversFrom: 9, coversTo: 9 })
    expect(texts(assembleContext(live, [other]))).toContain('b')
  })

  it('live 为空、只有摘要时不崩', () => {
    const s = summary({ id: 1, coversFrom: 1, coversTo: 3, text: '全部历史' })

    expect(texts(assembleContext([], [s]))[0]).toContain('全部历史')
  })
})

describe('分辨率梯度：热区展开正文，其余只给键', () => {
  /** n 条已生效的 L0，covers 依次是 1-1, 2-2, … */
  const many = (n: number): Summary[] =>
    Array.from({ length: n }, (_, i) => summary({ id: i + 1, coversFrom: i + 1, coversTo: i + 1 }))

  it('**攒满一批才降级**——每轮降一个的话 ③ 每轮都变，缓存永远只到 ②', () => {
    // §4.7 硬约束一。③ 按时间排序，降级动的是最前面那几条，它后面的 KV 缓存
    // 全部失效。所以热区条数在 hotLeaves 和 hotLeaves+batch-1 之间来回，
    // **不是恒等于 hotLeaves**——恒等于它正是那个每轮破缓存的实现
    const opts = { hotLeaves: 2, batch: 10 }
    const size = (n: number) => hotSummaryIds(many(n), opts).size

    // 攒的过程中一条都不降：11 条里 11 条都是热的
    expect(size(2)).toBe(2)
    expect(size(11)).toBe(11)
    // 第 12 条到了，一次降 10 条
    expect(size(12)).toBe(2)
    expect(size(13)).toBe(3)
  })

  it('**降的是最老的那批，留下的是最新的**', () => {
    // 反过来的话「最近几轮记得更细」变成「最早几轮记得更细」，不报错，
    // 只是模型对刚发生的事反而更模糊
    const hot = hotSummaryIds(many(12), { hotLeaves: 2, batch: 10 })
    expect([...hot].sort((a, b) => a - b)).toEqual([11, 12])
  })

  it('**乱序传进来也按 covers 排**——热区靠顺序定义，顺序错了降级点就随机了', () => {
    const shuffled = [...many(12)].reverse()
    expect([...hotSummaryIds(shuffled, { hotLeaves: 2, batch: 10 })].sort((a, b) => a - b)).toEqual(
      [11, 12],
    )
  })

  it('对照：上层摘要不算热区——它本来就是一行路由', () => {
    const rows = [...many(3), summary({ id: 99, coversFrom: 1, coversTo: 3, level: 1 })]
    expect(hotSummaryIds(rows, { hotLeaves: 2, batch: 10 }).has(99)).toBe(false)
  })

  it('对照：没生效的不算热区', () => {
    const rows = [summary({ id: 1, coversFrom: 1, coversTo: 1, inContext: false })]
    expect(hotSummaryIds(rows, { hotLeaves: 2, batch: 10 }).size).toBe(0)
  })

  it('**热区那条带正文，温区那条只有键**', () => {
    const rows = many(2)
    const bodies = new Map([[2, '## 用户要求\n翻历史']])
    const out = texts(assembleContext([], rows, bodies))

    expect(out[1]).toContain('## 用户要求') // 热的展开了
    expect(out[0]).not.toContain('## 用户要求') // 温的没有
    expect(out[0]).toContain('摘要 1') // 但键还在，不是消失了
  })

  it('**对照：叶子文件缺失时退回温区渲染，不是空洞**', () => {
    // C 步的降级路径（模型没按格式输出就不写叶子）落在这里。这条历史必须
    // 仍然以键的形态出现，否则「模型没听格式」会变成「那一轮从 context 里消失」
    const out = texts(assembleContext([], many(1), new Map()))
    expect(out[0]).toContain('摘要 1')
  })
})

describe('温区那一行：标题 + 描述', () => {
  const one = (over: Partial<Summary>) =>
    texts(
      assembleContext([], [summary({ id: 1, coversFrom: 1, coversTo: 1, ...over })], new Map()),
    )[0] ?? ''

  it('**有标题时标题在前**——温区一屏几十条，扫标题比扫整句描述快', () => {
    const line = one({ name: '缓存过期触发压缩', text: '给 modelSpec 加 cacheTtlMs，默认 3h' })
    expect(line).toContain('缓存过期触发压缩')
    expect(line).toContain('给 modelSpec 加 cacheTtlMs')
    // 同一行，不是两行两个标签：温区一条才 70 来 token，多一个标签就吃掉 5%
    expect(line.split('\n').filter((l) => l.includes('缓存过期触发压缩'))).toHaveLength(1)
    expect(line).not.toContain('标题：')
  })

  it('**对照：没有标题时不留空分隔符**', () => {
    // 本地 L0（太短的 step 不调模型）和内部节点都没有标题，空串是常态而
    // 不是异常。渲染成「——描述」的话模型会以为前面丢了什么东西
    const line = one({ name: '', text: '只有描述' })
    expect(line).toContain('摘要：只有描述')
    expect(line).not.toContain('——')
  })
})

describe('分辨率梯度：冷不能比温还贵', () => {
  const leafPaths = (n: number) =>
    Array.from({ length: n }, (_, i) => `.simple-code/memory/summaries/turn-0000${i}-s00010${i}.md`)

  it('**内部节点的路径清单折成范围**——十行枚举正是折叠该消掉的东西', () => {
    const paths = leafPaths(10)
    const node = summary({
      id: 1,
      coversFrom: 1,
      coversTo: 100,
      level: 1,
      archivePath: paths.join('\n'),
    })
    const line = texts(assembleContext([], [node], new Map()))[0] ?? ''

    // 先证前提：不折的话这十行确实是大头（实测占冷节点 65-68%）
    expect(paths.join('\n').length).toBeGreaterThan(400)

    expect(line).toContain(paths[0]) // 首尾还在，模型 ls 得到中间的
    expect(line).toContain(paths[9])
    expect(line).toContain('共 10 个')
    expect(line).not.toContain(paths[5]) // 中间的枚举没了
    expect(line.split('\n').filter((l) => l.includes('summaries/'))).toHaveLength(1)
  })

  it('**对照：单条路径原样不动**——温区那一档一个字都不该变', () => {
    const only = '.simple-code/memory/summaries/turn-000017-s000135.md'
    const leaf = summary({ id: 1, coversFrom: 1, coversTo: 1, archivePath: only })

    expect(texts(assembleContext([], [leaf], new Map()))[0]).toContain(`详情：${only}`)
  })
})

describe('热区正文的安全阀', () => {
  const withBody = (body: string) =>
    texts(
      assembleContext([], [summary({ id: 1, coversFrom: 1, coversTo: 1 })], new Map([[1, body]])),
    )[0] ?? ''

  it('**跑飞的正文被截断**——一条 9k 字符的叶子能占掉索引区 41%', () => {
    const runaway = '跑'.repeat(9_356)
    const line = withBody(runaway)

    expect(runaway.length).toBeGreaterThan(1_200) // 前提：确实超了
    expect(line.length).toBeLessThan(1_500)
    expect(line).toContain('正文过长已截断')
  })

  it('**对照：p99 长度的正文一个字不动**——这是安全阀不是压缩手段', () => {
    // 74 个真实叶子实测 p99=1,035 字符。这条线误伤了的话，正常热区会被
    // 悄悄削成半截，而症状只是「模型对刚发生的事记得不全」，不报错
    const normal = '正'.repeat(1_035)
    const line = withBody(normal)

    expect(line).toContain(normal)
    expect(line).not.toContain('正文过长已截断')
  })
})
