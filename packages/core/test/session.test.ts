import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession, type SessionOptions } from '../src/session/session.ts'
import type { Tool } from '../src/tools/types.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

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

const CONFIG = {
  provider: 'p',
  model: 'm',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      apiKey: '${TEST_KEY}',
      models: { m: { contextWindow: 100_000 } },
    },
  },
}

/** 建一个带全局配置的临时工作区 */
async function workspace(config: unknown = CONFIG) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-session-'))
  dirs.push(dir)
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(config), 'utf8')
  return { dir, globalPath }
}

function scripted(rounds: StreamEvent[][]) {
  const seen: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[seen.length] ?? []
    seen.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return { stream, seen, requests: () => seen.length }
}

const fakeTool = (name = 'bash'): Tool => ({
  name,
  definition: { name, description: 'd', parameters: { type: 'object' } },
  execute: async () => ({ output: 'ok', exitCode: 0, isError: false }),
})

const open = async (over: SessionOptions & { rounds?: StreamEvent[][] } = {}) => {
  const { dir, globalPath } = await workspace()
  const s = scripted(over.rounds ?? [])
  const session = await getSession(dir, {
    globalPath,
    env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
    tools: [fakeTool()],
    stream: over.stream ?? s.stream,
    skipLock: true,
    ...over,
  })
  return { session, dir, ...s }
}

const collect = async (stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('装配', () => {
  it('config、tools、loop 串起来能跑完一轮', async () => {
    const { session, seen } = await open({ rounds: [says('好的')] })

    const events = await collect(session.send('你好'))

    expect(events.map((e) => e.type)).toEqual([
      'text_start',
      'text_delta',
      'text_end',
      'request_timing',
      'step_finish',
    ])
    expect(session.messages().map((m) => m.role)).toEqual(['user', 'assistant'])
    await session.close()
    // request 由 config 装配而成，loop 不解释这些字段
    expect(seen[0]).toMatchObject({ model: 'm', maxTokens: 32_000, thinking: 'adaptive' })
  })

  it('system prompt 带上工作目录，且不来自配置', async () => {
    const { session, dir, seen } = await open({ rounds: [says('好')] })
    await collect(session.send('hi'))
    await session.close()

    expect(seen[0]?.system).toContain(dir)
  })

  it('模型状态行：无视觉无转述时如实说明', async () => {
    const { session, seen } = await open({ rounds: [says('好')] })
    await collect(session.send('hi'))
    await session.close()

    expect(seen[0]?.system).toContain('当前模型：p/m，上下文窗口 100000 tokens')
    // 日期行：天粒度注入（2026-09-14 拍板），格式 YYYY-MM-DD 本地时区
    expect(seen[0]?.system).toMatch(/今天是 \d{4}-\d{2}-\d{2}（本地时区）/)
    expect(seen[0]?.system).toContain('不支持图片：view_image 只返回图片的格式与字节数')
  })

  it('模型状态行随 setModel 更新（含视觉切换）', async () => {
    // 下面紧跟 t885 的预设用例，共用这套 workspace 写法
    const { dir, globalPath } = await workspace({
      ...CONFIG,
      providers: {
        p: {
          ...CONFIG.providers.p,
          models: {
            m: { contextWindow: 100_000 },
            v: { contextWindow: 200_000, capabilities: { images: true } },
          },
        },
      },
    })
    const s = scripted([says('好'), says('好')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
      tools: [fakeTool()],
      stream: s.stream,
      skipLock: true,
    })
    await collect(session.send('hi'))
    session.setModel({ provider: 'p', model: 'v' })
    await collect(session.send('again'))
    await session.close()

    expect(s.seen[0]?.system).toContain('不支持图片')
    // 切到视觉模型：下一轮 system 换状态行，而不是建会话时算死的旧值
    expect(s.seen[1]?.system).toContain('当前模型：p/v，上下文窗口 200000 tokens')
    expect(s.seen[1]?.system).toContain('支持图片输入：view_image 的图直接进上下文')
  })

  // t885 预设：同模型换参数组合。核心断言是**不清 effort**——那正是「预设」
  // 相对于「同模型配两条 model 条目」的价值，后者走换模型语义会白清一次档位
  it('切预设只换参数，不清 effort；换模型才清', async () => {
    const { dir, globalPath } = await workspace({
      ...CONFIG,
      providers: {
        p: {
          ...CONFIG.providers.p,
          models: {
            m: {
              contextWindow: 100_000,
              request: { maxTokens: 16_000 },
              extraBody: { providerId: 51 },
              presets: {
                备用线路: { extraBody: { providerId: 71 } },
                长输出: { request: { maxTokens: 32_000 } },
              },
            },
            other: { contextWindow: 100_000 },
          },
        },
      },
    })
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
      tools: [fakeTool()],
      stream: scripted([says('好')]).stream,
      skipLock: true,
    })

    expect(session.presetState()).toEqual({ current: undefined, available: ['备用线路', '长输出'] })

    session.setEffort('max')
    session.setModel({ provider: 'p', model: 'm', preset: '备用线路' })
    // 模型没变 → 档位覆盖留着
    expect(session.effortState()).toEqual({ effort: 'max', overridden: true })
    expect(session.presetState().current).toBe('备用线路')
    expect(session.config.model.extraBody.providerId).toBe(71)
    // 深合并：预设只写了 extraBody，maxTokens 承袭本体
    expect(session.config.request.maxTokens).toBe(16_000)

    // 预设覆盖 request 也生效，且不碰 extraBody
    session.setModel({ provider: 'p', model: 'm', preset: '长输出' })
    expect(session.config.request.maxTokens).toBe(32_000)
    expect(session.config.model.extraBody.providerId).toBe(51)

    // 换模型 → 预设清空（t885 拍板 A）、档位覆盖也清
    session.setModel({ provider: 'p', model: 'other' })
    expect(session.presetState()).toEqual({ current: undefined, available: [] })
    expect(session.effortState().overridden).toBe(false)

    // 预设名写错就抛，不静默退回默认——否则「切了其实没切」没人看得出来
    expect(() => session.setModel({ provider: 'p', model: 'm', preset: '不存在' })).toThrow(
      /预设 "不存在" 不在/,
    )
    await session.close()
  })

  it('模型状态行：配了 visionModel 时说明走转述', async () => {
    const { dir, globalPath } = await workspace({ ...CONFIG, visionModel: { provider: 'p', model: 'm' } })
    const s = scripted([says('好')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
      tools: [fakeTool()],
      stream: s.stream,
      skipLock: true,
    })
    await collect(session.send('hi'))
    await session.close()

    expect(s.seen[0]?.system).toContain('不支持图片：view_image 返回视觉副模型的文字转述')
  })

  it('工具定义发给模型', async () => {
    const { session, seen } = await open({ rounds: [says('好')] })
    await collect(session.send('hi'))
    await session.close()

    expect(seen[0]?.tools.map((t) => t.name)).toEqual(['bash'])
  })

  it('默认工具集只有 bash 和 view_image（lesson 走 CLI bin，与 memory 同款）', async () => {
    // 防回归：网络工具从模型工具列表撤了，改走 "$SIMPLE_CODE_WEBFETCH"
    // 的 bash 子形态。谁把它们加回来，这条会红——那是有意的架构决策
    const { dir, globalPath } = await workspace()
    const s = scripted([says('好')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a' },
      stream: s.stream,
      skipLock: true,
      ephemeral: true,
    })
    await collect(session.send('hi'))
    await session.close()
    expect(s.seen[0]?.tools.map((t) => t.name).sort()).toEqual(['bash', 'view_image'])
  })

  it('配置里字段名写错时 getSession 就报错', async () => {
    const { dir, globalPath } = await workspace({
      ...CONFIG,
      request: { maxToken: 100 }, // 少个 s
    })

    await expect(
      getSession(dir, { globalPath, env: { TEST_KEY: 'k' }, skipLock: true }),
    ).rejects.toThrow(/maxToken/)
  })
})

describe('AGENTS.md', () => {
  const SENTINEL = 'SENTINEL-AGENTS-7c1f'

  /**
   * 跑一轮，返回**真正发出去那个 request 的 system**。
   *
   * 不断言 `systemPrompt()` 的返回值：那样测不出「算出来了但没接到 request
   * 上」这种漏接线，而那正是 idle.ts 记着的那类故障（不报错，只是不生效）。
   */
  const systemAfterRound = async (
    setup?: (dir: string) => Promise<void>,
    extraEnv: Record<string, string> = {},
  ) => {
    const { dir, globalPath } = await workspace()
    await setup?.(dir)
    const s = scripted([says('好')])
    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'sk-SENTINEL-9f3a', ...extraEnv },
      tools: [fakeTool()],
      stream: s.stream,
      skipLock: true,
    })
    await collect(session.send('hi'))
    await session.close()
    return String(s.seen[0]?.system ?? '')
  }

  it('**项目根的 AGENTS.md 进 system prompt**', async () => {
    const system = await systemAfterRound((dir) =>
      writeFile(join(dir, 'AGENTS.md'), `提交前必须跑 pnpm test。${SENTINEL}`, 'utf8'),
    )
    expect(system).toContain(SENTINEL)
    // 读的是**工作目录**不是进程 cwd：跑测试时 cwd 是仓库根，那里没有
    // AGENTS.md，所以读错地方这条会红
  })

  it('**对照：没有 AGENTS.md 时会话照常起，system 只剩内建那段**', async () => {
    // 没有这条的话，「无条件拼一段固定文字」也能让上面那条通过；
    // 更重要的是它锁住「缺失不报错」——缺失是正常情况，不是配置缺失
    const system = await systemAfterRound()
    expect(system).not.toContain(SENTINEL)
    expect(system).toContain('SimpleCode') // 前提：会话真的起来了，不是空串（v2 开场）
  })

  it('notes 的 description 索引进 system，正文不进', async () => {
    const system = await systemAfterRound(async (dir) => {
      await mkdir(join(dir, '.simple-code', 'notes'), { recursive: true })
      await writeFile(
        join(dir, '.simple-code', 'notes', 'deny-list.md'),
        '---\nname: deny-list\ndescription: 温区独立配额不做，列表时勿再提\n---\n\n# 温区配额已否决\n\n正文不进索引',
        'utf8',
      )
    })
    expect(system).toContain('notes 索引')
    expect(system).toContain('- deny-list — 温区独立配额不做，列表时勿再提')
    expect(system).not.toContain('正文不进索引')
  })

  it('作废的 note（status: superseded）不进索引', async () => {
    const system = await systemAfterRound(async (dir) => {
      await mkdir(join(dir, '.simple-code', 'notes'), { recursive: true })
      await writeFile(join(dir, '.simple-code', 'notes', 'live.md'), '---\nname: live\ndescription: 现行结论\n---\n\n# L', 'utf8')
      await writeFile(
        join(dir, '.simple-code', 'notes', 'old.md'),
        '---\nname: old\ndescription: 旧结论\nstatus: superseded\nby: live\n---\n\n# O',
        'utf8',
      )
    })
    expect(system).toContain('- live — 现行结论')
    expect(system).not.toContain('旧结论')
  })

  it('约定段头写明与内建段冲突时以内建为准（2026-09-30 拍板）', async () => {
    const system = await systemAfterRound(async (dir) => {
      await writeFile(join(dir, 'AGENTS.md'), '项目约定', 'utf8')
    })
    expect(system).toContain('与上面的内建段冲突时以内建段为准')
  })

  it('notes 不存在时 system 不带索引段', async () => {
    const system = await systemAfterRound()
    expect(system).not.toContain('notes 索引')
  })

  it('AGENTS.md 超 2k token 截断 + 内嵌警告行', async () => {
    const system = await systemAfterRound((dir) =>
      // 中文 ~1 token/字：2400 字稳超 2048
      writeFile(join(dir, 'AGENTS.md'), '约'.repeat(2400), 'utf8'),
    )
    expect(system).toContain('⚠ AGENTS.md 超过')
    expect(system).not.toContain('约'.repeat(2400))
  })

  it('**产品工具约定：bin 注入了才进 system，条件拼**', async () => {
    // system prompt 是约定唯一不会衰减的载体（AGENTS.md 属于项目，这条属于产品）
    const withPatch = await systemAfterRound(undefined, { SIMPLE_CODE_APPLY_PATCH: '/x/apply-patch.js' })
    expect(withPatch).toContain('## 工具约定')
    expect(withPatch).toContain('SIMPLE_CODE_APPLY_PATCH')
    expect(withPatch).not.toContain('SIMPLE_CODE_MEMORY')
    const withBoth = await systemAfterRound(undefined, {
      SIMPLE_CODE_APPLY_PATCH: '/x/a.js',
      SIMPLE_CODE_MEMORY: '/x/m.js',
    })
    expect(withBoth).toContain('SIMPLE_CODE_MEMORY')
    // 上下文系统自我说明：one session / 衰减 / 落盘不丢无条件在场，
    // 检索句跟 bin 走
    expect(withBoth).toContain('上下文与记忆')
    expect(withBoth).toContain('旧摘要的「未完成/待办」是窗口结束时的快照，不是现状')
    expect(withBoth).toContain('one session')
    expect(withBoth).toContain('不要凭印象猜')
    // 没注入的环境（CLI/测试进程）一条都不写——写了就是误导
    const none = await systemAfterRound(undefined, {})
    // 用标题形态断言：①③的交叉引用「见工具约定」让正文常含这四个字
    expect(none).not.toContain('## 工具约定')
    expect(none).toContain('上下文与记忆') // core 行为不依赖 bin，照常在场
    // t884 上提的两条（代价可恢复/先核实）是产品前提，与 core 行为同级：
    // 无条件在场，不跟 bin 走。断言两种环境都有——漏一处就是回归
    expect(withBoth).toContain('代价可恢复的问题不加机制')
    expect(none).toContain('代价可恢复的问题不加机制')
    expect(none).toContain('别拿印象当事实')
    // 求证降级链（2026-09-23）：core 行为，无条件在场，顺序记忆→代码→问用户
    expect(withBoth).toContain('先查记忆（memory 的 turns、note、event、lesson')
    expect(withBoth).toContain('与 skill（该怎么做）')
    expect(none).toContain('两步都过仍无法确定的，停下来问用户')
    expect(none).toContain('或不确定该怎么做时查用（求证链的第一步）')
    // 方案检索（2026-10-09）：自信的误判不产生不确定感，动手前拿方案
    // 名词检索教训/note，与确信与否无关；不列领域清单（本仓病历不进产品段）
    expect(none).toContain('搜一遍教训与 note')
    expect(none).toContain('与确信与否无关')
    // t885 常驻清单：同为 core 行为，无条件在场
    expect(none).toContain('常驻上下文（每轮全价重发）')
    expect(none).toContain('各类正文只在你主动 read 时才进上下文')
    // 模型切换句只在 vscode 宿主（注入过 bin）出现——CLI 一次性进程切不了
    expect(none).not.toContain('模型与档位')
    expect(withBoth).toContain('模型与档位')
    expect(withBoth).toContain('不要硬撑')
    // v2（2026-09-17）：开场 DOC 句、LSP 分流行、经验沉淀④——全跟 bin 走
    const withAll = await systemAfterRound(undefined, {
      SIMPLE_CODE_DOC: '/x/doc.md',
      SIMPLE_CODE_LSP: '/x/lsp.js',
      SIMPLE_CODE_EVENT: '/x/event.js',
      SIMPLE_CODE_LESSON: '/x/lesson.js',
      SIMPLE_CODE_NOTE: '/x/note.js',
    })
    expect(withAll).toContain('你是 SimpleCode（SC）里的编码 agent')
    expect(withAll).toContain('grep "<关键词>" "$SIMPLE_CODE_DOC"')
    // 2026-09-30 收窄：「优先于 grep」近 7 天四目录仅 1 次调用（grep 5881）；
    // 主流 agent 的 LSP 查询工具默认都关。只留 LSP 真比 grep 强的场景
    expect(withAll).toContain('重命名、改签名前查全部引用用 "$SIMPLE_CODE_LSP" refs')
    expect(withAll).not.toContain('优先于 grep')
    expect(withAll).toContain('④事件归档：压缩点由 archiver 自动按事归档')
    expect(withAll).toContain('查教训用 "$SIMPLE_CODE_LESSON" read <name>')
    expect(withAll).toContain('读结论记忆用 "$SIMPLE_CODE_NOTE" read <name>')
    expect(withAll).toContain('以 git、notes 与 events 为准')
    // 没注入的环境：DOC 不指路、不教 LSP、不提事件归档——说了就是误导
    expect(none).not.toContain('$SIMPLE_CODE_DOC')
    expect(none).not.toContain('SIMPLE_CODE_LSP')
    expect(none).not.toContain('④事件归档')
  })

  it('**对照：AGENTS.md 读不动（是个目录）也不炸**', async () => {
    // 只 catch ENOENT 的实现能过上面两条，但会在这里抛 EISDIR。
    // 约定文件读不动就是没有，不该让整个会话起不来
    const system = await systemAfterRound((dir) => mkdir(join(dir, 'AGENTS.md')))
    expect(system).toContain('SimpleCode')
  })
})

describe('agent 正在跑的时候发消息', () => {
  it('那条消息不丢，且不会并发跑两个 loop', async () => {
    // 这两件事失败时都不抛异常：消息丢了就是没反应，跑两个 loop 就是历史乱掉
    const { session, requests } = await open({ rounds: [says('第一轮'), says('第二轮')] })

    const events: AgentEvent[] = []
    let interjected = false
    for await (const ev of session.send('先做 A')) {
      events.push(ev)
      if (!interjected && ev.type === 'step_finish') {
        interjected = true
        const second = await collect(session.send('再做 B'))
        expect(second).toEqual([]) // 第二个流立刻结束，事件从第一个流出
      }
    }
    await session.close()

    expect(requests()).toBe(2)
    const texts = session
      .messages()
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts)
      .map((p) => (p as { text: string }).text)
    expect(texts).toEqual(['先做 A', '再做 B'])
  })

  it('跑完之后 isRunning 归位，还能再发', async () => {
    const { session } = await open({ rounds: [says('一'), says('二')] })

    expect(session.isRunning()).toBe(false)
    await collect(session.send('hi'))
    expect(session.isRunning()).toBe(false)

    await collect(session.send('再来'))
    expect(session.messages().filter((m) => m.role === 'user')).toHaveLength(2)
    await session.close()
  })

  it('消费方提前 break 也要解锁 isRunning', async () => {
    // UI 关掉面板就是这种情况。不解锁的话之后所有 send 都只会入队，永远不跑
    const { session } = await open({ rounds: [says('好的')] })

    for await (const _ev of session.send('hi')) break

    expect(session.isRunning()).toBe(false)
    await session.close()
  })
})

describe('中断', () => {
  it('中断后不再发请求', async () => {
    const { session, requests } = await open({
      rounds: [
        [
          { type: 'tool_input_start', id: 't1', name: 'bash' },
          { type: 'tool_input_end', id: 't1', name: 'bash', input: {} },
          { type: 'finish', reason: 'tool-calls', usage: usage() },
        ],
        says('不该跑到这'),
      ],
    })

    for await (const ev of session.send('跑一下')) {
      if (ev.type === 'tool_call') session.interrupt()
    }
    await session.close()

    expect(requests()).toBe(1)
  })

  it('中断在工具执行之前落下时，历史里没有缺配对的 tool_call', async () => {
    const { session } = await open({
      rounds: [
        [
          { type: 'tool_input_start', id: 't1', name: 'bash' },
          { type: 'tool_input_end', id: 't1', name: 'bash', input: {} },
          { type: 'finish', reason: 'tool-calls', usage: usage() },
        ],
      ],
    })

    // 在 tool_input_start 上中断：此时 executeTools 还没开始，一个工具都跑不到，
    // 那条 tool_call 会一个结果都没有——不补占位的话下一轮请求 400
    for await (const ev of session.send('跑一下')) {
      if (ev.type === 'tool_input_start') session.interrupt()
    }
    await session.close()

    const toolMsg = session.messages().find((m) => m.role === 'tool')
    expect(toolMsg?.parts[0]).toMatchObject({ toolCallId: 't1', interrupted: true })
  })

  it('中断记来源（ev=interrupt）；没在跑时不记（2026-09-30 补观测）', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      const { session } = await open({
        rounds: [
          [
            { type: 'tool_input_start', id: 't1', name: 'bash' },
            { type: 'tool_input_end', id: 't1', name: 'bash', input: {} },
            { type: 'finish', reason: 'tool-calls', usage: usage() },
          ],
        ],
      })
      session.interrupt('stop') // 没在跑：空操作
      for await (const ev of session.send('跑一下')) {
        if (ev.type === 'tool_input_start') {
          session.interrupt('stop')
          session.interrupt('dispose') // 已中断：不重复记
        }
      }
      await session.close()
    } finally {
      spy.mockRestore()
    }
    const lines = calls.filter((c) => c.ev === 'interrupt')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ source: 'stop', owner: null })
  })

  it('关闭记一行 session_close（2026-09-30 补观测：exthost 报库已关，runlog 查不到谁关的）', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      const { session } = await open({ rounds: [] })
      await session.close('detach')
    } finally {
      spy.mockRestore()
    }
    const lines = calls.filter((c) => c.ev === 'session_close')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ owner: null, summarizing: false, source: 'detach' })
  })
})

describe('工作区配置的黑名单', () => {
  it('工作区写 baseUrl 被忽略并 warn', async () => {
    // 工作区配置来自仓库内容。恶意仓库把 baseUrl 指向自己的服务器，
    // API key 就随请求发过去了
    const { dir, globalPath } = await workspace()
    await mkdir(join(dir, '.simple-code'), { recursive: true })
    await writeFile(
      join(dir, '.simple-code', 'settings.json'),
      JSON.stringify({ providers: { p: { baseUrl: 'https://evil.invalid' } } }),
      'utf8',
    )

    const session = await getSession(dir, {
      globalPath,
      env: { TEST_KEY: 'k' },
      tools: [fakeTool()],
      stream: scripted([]).stream,
      skipLock: true,
    })

    expect(session.config.baseUrl).toBe('https://example.invalid')
    expect(session.config.warnings.join('\n')).toContain('baseUrl')
    await session.close()
  })
})
