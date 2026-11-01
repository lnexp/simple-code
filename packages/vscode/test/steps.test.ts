import { describe, expect, it } from 'vitest'
import type { ActivityItem, Block, ChatItem, Section } from '../webview/events.ts'
import {
  buildSteps,
  errorLine,
  groupTurns,
  type Row,
  sameTurn,
  stepStats,
} from '../webview/steps.ts'

/**
 * 时间线的配对规则（纯函数）。渲染契约在 process-group.test.ts。
 * 配错了不报错，只是说明和命令挂错了节点——截图里才看得出来
 */

const tool = (
  id: string,
  extra: Partial<Extract<ChatItem, { kind: 'tool' }>> = {},
): ActivityItem => ({
  kind: 'tool',
  id,
  desc: '',
  name: 'bash',
  command: '',
  output: '',
  failed: false,
  ...extra,
})
const think = (text: string): ActivityItem => ({ kind: 'reasoning', text })
const say = (text: string): Block => ({
  kind: 'single',
  item: { kind: 'assistant', text } as Extract<ChatItem, { kind: 'assistant' }>,
})
const notice = (text: string): Block => ({
  kind: 'single',
  item: { kind: 'notice', text } as Extract<ChatItem, { kind: 'notice' }>,
})
const act = (...items: ActivityItem[]): Block => ({ kind: 'activity', items })

const steps = (...blocks: Block[]): Row[] => buildSteps(blocks.map((block, at) => ({ block, at })))
/** 形状：每步「说明|命令 id 列表」，单块写种类 */
const shape = (rows: Row[]): string[] =>
  rows.map((r) =>
    r.kind === 'block'
      ? r.block.kind === 'single'
        ? r.block.item.kind
        : 'activity'
      : `${r.text?.item.text ?? '-'}|${r.items.map((i) => (i.kind === 'tool' ? i.id : '思')).join(',')}`,
  )

describe('buildSteps：说明配它后面的操作', () => {
  it('说明 → 命令 → 说明 → 命令：两步', () => {
    expect(shape(steps(say('甲'), act(tool('a')), say('乙'), act(tool('b'), tool('c'))))).toEqual([
      '甲|a',
      '乙|b,c',
    ])
  })

  it('开头只想了一下就说话：思考并进第一步，不单独占节点', () => {
    expect(shape(steps(act(think('x')), say('甲'), act(tool('a'))))).toEqual(['甲|思,a'])
  })

  it('开头直接调命令（没有说明）：一个没有说明的步骤', () => {
    expect(shape(steps(act(tool('a')), say('甲'), act(tool('b'))))).toEqual(['-|a', '甲|b'])
  })

  it('命令后面那次思考挂在上一步（groupItems 已把它和命令并成一块）', () => {
    expect(shape(steps(say('甲'), act(tool('a'), think('y')), say('乙')))).toEqual([
      '甲|a,思',
      '乙|',
    ])
  })

  it('notice 单独成行，并截断当前步骤', () => {
    expect(shape(steps(say('甲'), notice('重试'), act(tool('a'))))).toEqual([
      '甲|',
      'notice',
      '-|a',
    ])
  })

  it('步骤的 at 是首块下标：说明后并进来时不变（React 身份，开合状态不丢）', () => {
    const rows = steps(act(think('x')), say('甲'))
    expect(rows[0]?.kind === 'step' && rows[0].at).toBe(0)
  })
})

describe('stepStats', () => {
  it('步数、操作数、失败数、已做数、操作条', () => {
    const rows = steps(
      say('甲'),
      act(tool('a', { failed: true }), think('x'), tool('b')),
      say('乙'),
      act(tool('c', { startedAt: 1 })), // 还在跑：不算「已做」
    )
    expect(stepStats(rows)).toEqual({
      steps: 2,
      tools: 3,
      failed: 1,
      done: 2,
      strip: [[true, false], [false]],
    })
  })
})

describe('groupTurns', () => {
  const block = (b: Block, at: number): Section => ({ kind: 'block', block: b, at })
  const user: Block = {
    kind: 'single',
    item: { kind: 'user', text: '问' } as Extract<ChatItem, { kind: 'user' }>,
  }

  it('按 user 块切轮；分页截出来的半轮没有 head', () => {
    const turns = groupTurns([block(say('半轮'), 0), block(user, 1), block(say('答'), 2)])
    expect(turns.map((t) => [t.head?.at ?? null, t.body.length])).toEqual([
      [null, 1],
      [1, 1],
    ])
  })
})

describe('errorLine', () => {
  it('取第一条像报错的行', () => {
    expect(errorLine('ok\nnpm ERR! missing script\nmore', true)).toBe('npm ERR! missing script')
  })
  it('bash 找不到报错行：照实说', () => {
    expect(errorLine('"format": "biome check --write ."', true)).toBe(
      '退出码非 0，输出里没有报错行',
    )
  })
  it('非 bash 工具：失败输出本身就是说明，取首个非空行', () => {
    expect(errorLine('\n图片太大\n', false)).toBe('图片太大')
  })
  it('用户中断的命令', () => {
    expect(errorLine('partial\n[用户中断，命令已终止]', true)).toBe('[用户中断，命令已终止]')
  })
})

describe('sameTurn：memo 判据', () => {
  // 同一批 item，每次都新建外壳——Log 每次渲染就是这样
  const user = { kind: 'user', text: '问' } as Extract<ChatItem, { kind: 'user' }>
  const answer = { kind: 'assistant', text: '答' } as Extract<ChatItem, { kind: 'assistant' }>
  const t1 = tool('a')
  const build = (over: { answer?: typeof answer; t?: ActivityItem; elapsed?: number } = {}) =>
    groupTurns([
      { kind: 'block', block: { kind: 'single', item: user }, at: 0 },
      {
        kind: 'process',
        blocks: [act(over.t ?? t1)],
        ...(over.elapsed === undefined ? {} : { elapsedMs: over.elapsed }),
      },
      { kind: 'block', block: { kind: 'single', item: over.answer ?? answer }, at: 2 },
    ])[0] as ReturnType<typeof groupTurns>[number]

  it('外壳全新、item 引用不变 → 相同（跳过渲染）', () => {
    expect(sameTurn(build(), build())).toBe(true)
  })
  it('任一条 item 换了（流式追加、工具结果、页脚）→ 不同', () => {
    expect(sameTurn(build(), build({ answer: { ...answer, text: '答。' } }))).toBe(false)
    expect(sameTurn(build(), build({ t: { ...t1, output: 'ok' } as ActivityItem }))).toBe(false)
  })
  it('折叠段耗时变了 → 不同', () => {
    expect(sameTurn(build(), build({ elapsed: 1000 }))).toBe(false)
  })
  it('分页补上了开头的用户消息（半轮变整轮）→ 不同', () => {
    const half = { body: build().body }
    expect(sameTurn(half, build())).toBe(false)
  })
})
