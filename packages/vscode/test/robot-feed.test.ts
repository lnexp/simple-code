import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../src/protocol.ts'
import {
  canAllowOnRobot,
  createRobotFeed,
  headline,
  type RobotFolderView,
  type RobotTaskView,
  type Sight,
  turnTracker,
} from '../src/robot-feed.ts'

const SC = '/Users/dev/code-a'
const LB = '/Users/dev/code-b'

const card = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  type: 'approval_request',
  expiresAt: Date.parse('2026-10-31T10:20:56Z'),
  id: 1,
  command: 'cd /Users/dev && ls',
  toolCallId: 'toolu_1',
  category: 'external_dir',
  detail: '/Users/dev',
  reason: '要读写项目外路径：/Users/dev',
  ...over,
})

const idle = (
  task: string | null = null,
  lastTurn: RobotTaskView['lastTurn'] = null,
  userTouched = true,
): RobotTaskView => ({
  task,
  running: false,
  startedAt: null,
  lastTurn,
  userTouched,
})

/** 用户在别的应用里（浏览器在前台）：VS Code 没焦点，什么都看不到 */
const away: Sight = { focused: false, panelVisible: true, folder: SC, task: null }
const looking = (folder: string, task: string | null): Sight => ({
  focused: true,
  panelVisible: true,
  folder,
  task,
})

describe('显示规则（§5.1：只显示此刻看不到的）', () => {
  it('VS Code 在前台、面板正看着当前主任务：这张卡 seen；后台目录的卡照样要提醒', () => {
    const feed = createRobotFeed()
    const folders: RobotFolderView[] = [
      { folder: SC, tasks: [idle()], approvals: [card({ toolCallId: 'a' })] },
      {
        folder: LB,
        tasks: [idle(), idle('DAG 运行记录')],
        approvals: [card({ toolCallId: 'b', task: 'DAG 运行记录' })],
      },
    ]
    const s = feed.build(folders, looking(SC, null))
    expect(s.items.map((i) => [i.key, i.seen])).toEqual([
      ['a', true],
      ['b', false],
    ])
    // 对照：同一份状态，用户切到浏览器 → 两张都看不到
    expect(feed.build(folders, away).items.every((i) => !i.seen)).toBe(true)
    // 对照：窗口有焦点但面板收起了，也看不到
    expect(feed.build(folders, { ...looking(SC, null), panelVisible: false }).items[0]?.seen).toBe(
      false,
    )
  })

  it('同目录不同任务不算看到：面板在主任务，分身的卡仍要提醒', () => {
    const feed = createRobotFeed()
    const s = feed.build(
      [
        {
          folder: LB,
          tasks: [idle(), idle('DAG 运行记录')],
          approvals: [card({ task: 'DAG 运行记录' })],
        },
      ],
      looking(LB, null),
    )
    expect(s.items[0]).toMatchObject({ kind: 'approval', task: 'DAG 运行记录', seen: false })
  })
})

describe('完成/出错提醒（§5.3）', () => {
  const done = { at: 1000, end: 'done' as const, text: '## 已完成\n多窗口跳转验证通过。细节如下' }

  it('agent 派、无人参与的任务完成不提醒——结果走〔任务结果〕回主任务（2026-11-06）', () => {
    const feed = createRobotFeed()
    const f = (t: RobotTaskView): RobotFolderView[] => [{ folder: SC, tasks: [t], approvals: [] }]
    // userTouched 缺省 false（agent 派、无人手打过）：done / error 都不产提醒
    expect(feed.build(f(idle('调研某库', done, false)), away).items).toEqual([])
    const err = { at: 1500, end: 'error' as const, text: 'API 529' }
    expect(feed.build(f(idle('调研某库', err, false)), away).items).toEqual([])
    // 同一任务用户手打过一次（userTouched=true）就恢复
    expect(feed.build(f(idle('调研某库', done, true)), away).items).toEqual([
      expect.objectContaining({ kind: 'done' }),
    ])
  })

  it('结束时用户不在：提醒带第一句；回来看到一次后就不再提醒（新一轮结束是新提醒）', () => {
    const feed = createRobotFeed()
    const f = (t: RobotTaskView): RobotFolderView[] => [{ folder: SC, tasks: [t], approvals: [] }]
    const first = feed.build(f(idle(null, done)), away)
    expect(first.items).toEqual([
      expect.objectContaining({
        kind: 'done',
        headline: '已完成',
        key: `${SC}##1000`,
        seen: false,
      }),
    ])
    expect(feed.build(f(idle(null, done)), looking(SC, null)).items).toEqual([])
    // 前提：确实是「看过」让它消失，不是 build 两次就没了——切走后也不回来
    expect(feed.build(f(idle(null, done)), away).items).toEqual([])
    const next = { at: 2000, end: 'error' as const, text: 'API 返回 529 overloaded' }
    expect(feed.build(f(idle(null, next)), away).items).toEqual([
      expect.objectContaining({ kind: 'error', headline: 'API 返回 529 overloaded' }),
    ])
  })

  it('被停止的不提醒；开始新一轮（running）时旧提醒收起', () => {
    const feed = createRobotFeed()
    const stopped = feed.build(
      [{ folder: SC, tasks: [idle(null, { at: 1, end: 'stopped', text: 'x' })], approvals: [] }],
      away,
    )
    expect(stopped.items).toEqual([])
    const running = { ...idle(null, done), running: true, startedAt: 3000 }
    expect(feed.build([{ folder: SC, tasks: [running], approvals: [] }], away).items).toEqual([])
  })

  it('在机器人上关掉（dismiss）后不再出现', () => {
    const feed = createRobotFeed()
    const folders = [{ folder: SC, tasks: [idle(null, done)], approvals: [] }]
    const key = feed.build(folders, away).items[0]?.key ?? ''
    expect(key).not.toBe('')
    feed.dismiss(key)
    expect(feed.build(folders, away).items).toEqual([])
  })
})

describe('总览的任务状态', () => {
  it('等审批 > 在跑 > 上一轮结果；被停止的算空闲', () => {
    const feed = createRobotFeed()
    const s = feed.build(
      [
        {
          folder: LB,
          tasks: [
            {
              task: null,
              running: true,
              startedAt: Date.parse('2026-10-31T10:00:00Z'),
              lastTurn: null,
            },
            idle('DAG 运行记录'),
            idle('A', { at: Date.parse('2026-10-31T09:00:00Z'), end: 'error', text: 'x' }),
            idle('B', { at: 5, end: 'stopped', text: '' }),
          ],
          approvals: [card({ task: 'DAG 运行记录' })],
        },
      ],
      away,
    )
    expect(s.tasks.map((t) => [t.task, t.state, t.since])).toEqual([
      [null, 'running', '2026-10-31T10:00:00.000Z'],
      ['DAG 运行记录', 'waiting', null],
      ['A', 'error', '2026-10-31T09:00:00.000Z'],
      ['B', 'idle', null],
    ])
  })
})

describe('D1：哪些卡只能回窗口处理', () => {
  it('自定义规则（git push）、出网命令只能回窗口；multi 里混着它们也一样', () => {
    expect(canAllowOnRobot({ category: 'external_dir' })).toBe(true)
    expect(canAllowOnRobot({ category: 'ask_rule' })).toBe(false)
    expect(canAllowOnRobot({ category: 'multi', parts: ['external_dir'] })).toBe(true)
    expect(canAllowOnRobot({ category: 'multi', parts: ['external_dir', 'ask_rule'] })).toBe(false)
  })

  it('status 里的卡带 canAllow，命令与原因按日志同一截法截断', () => {
    const feed = createRobotFeed()
    const long = 'x'.repeat(400)
    const s = feed.build(
      [
        {
          folder: SC,
          tasks: [idle()],
          approvals: [card({ category: 'ask_rule', command: long, reason: long })],
        },
      ],
      away,
    )
    expect(s.items[0]).toMatchObject({
      kind: 'approval',
      canAllow: false,
      expiresAt: '2026-10-31T10:20:56.000Z',
    })
    if (s.items[0]?.kind === 'approval') {
      expect(s.items[0].command).toHaveLength(300)
      expect(s.items[0].reason).toHaveLength(200)
    }
  })
})

describe('headline：结论第一句', () => {
  it.each([
    ['多窗口跳转也验证通过了。单开文件夹的窗口同样能回到原窗口。', '多窗口跳转也验证通过了。'],
    ['## 结论\n\n**要你定**：打包方式选哪个？后面是细节', '结论'],
    ['- `git push` 被拦下\n下一行', 'git push 被拦下'],
    ['> 引用开头的一句！后面', '引用开头的一句！'],
    ['', ''],
  ])('%j → %j', (text, want) => {
    expect(headline(text)).toBe(want)
  })

  it('超过 60 字截断加省略号（按字符算，中文不被劈半）', () => {
    const h = headline('啊'.repeat(80))
    expect([...h]).toHaveLength(61)
    expect(h.endsWith('…')).toBe(true)
  })
})

describe('turnTracker：一轮怎么结束的', () => {
  it('取最后一段回答文字；被停止优先', () => {
    const t = turnTracker()
    for (const ev of [
      { type: 'text_start' },
      { type: 'text_delta', text: '先看下代码' },
      { type: 'tool_call', id: '1', name: 'bash', input: {} },
      { type: 'text_start' },
      { type: 'text_delta', text: '改完了。' },
      { type: 'text_delta', text: '测试通过' },
    ] as const)
      t.see(ev)
    expect(t.end(false)).toMatchObject({ end: 'done', text: '改完了。测试通过' })
    expect(t.end(true)).toMatchObject({ end: 'stopped' })
  })

  it('致命错误（之后再没出文字/调工具）记 error，正文是错误原文', () => {
    const t = turnTracker()
    t.see({ type: 'text_start' })
    t.see({ type: 'text_delta', text: '我先查' })
    t.see({ type: 'error', message: 'API 返回 529 overloaded', retryable: true })
    expect(t.end(false)).toMatchObject({ end: 'error', text: 'API 返回 529 overloaded' })
  })

  it('不致命的错误（AGENTS.md 超限提醒后模型接着干活）不算出错', () => {
    const t = turnTracker()
    t.see({ type: 'error', message: 'AGENTS.md 超过 2,048 token 上限', retryable: false })
    // 前提：只到这一步时确实记成了 error，后面的清除才有意义
    expect(t.end(false).end).toBe('error')
    t.see({ type: 'tool_call', id: '1', name: 'bash', input: {} })
    t.see({ type: 'text_start' })
    t.see({ type: 'text_delta', text: '完成。' })
    expect(t.end(false)).toMatchObject({ end: 'done', text: '完成。' })
  })

  it('send 抛出（没跑起来）记 error', () => {
    const t = turnTracker()
    t.fail('拿不到文件锁')
    expect(t.end(false)).toMatchObject({ end: 'error', text: '拿不到文件锁' })
  })
})
