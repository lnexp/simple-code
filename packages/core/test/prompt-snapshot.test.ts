import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/events.ts'
import type { Request, Usage } from '../src/llm/types.ts'
import type { StreamEvent } from '../src/loop/retry.ts'
import type { LoopDeps } from '../src/loop/run.ts'
import { getSession, type SessionOptions } from '../src/session/session.ts'
import type { TaskScope } from '../src/session/store.ts'
import { openStore } from '../src/session/store.ts'
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

/** cacheTtlMs 可覆盖：测试「冷」路径把它压到 1ms */
const config = (cacheTtlMs?: number) => ({
  provider: 'p',
  model: 'm',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      apiKey: 'sk-test',
      models: { m: { contextWindow: 100_000, ...(cacheTtlMs ? { cacheTtlMs } : {}) } },
    },
  },
})

const scripted = (rounds: StreamEvent[][]) => {
  const seen: Request[] = []
  const stream: LoopDeps['stream'] = (request) => {
    const round = rounds[seen.length] ?? []
    seen.push(structuredClone(request))
    return (async function* () {
      for (const ev of round) yield ev
    })()
  }
  return { stream, seen }
}

const fakeTool = (): Tool => ({
  name: 'bash',
  definition: { name: 'bash', description: 'd', parameters: { type: 'object' } },
  execute: async () => ({ output: 'ok', exitCode: 0, isError: false }),
})

const collect = async (stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
  const out: AgentEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

/** 建临时工作区：AGENTS.md v1 + 一个旧事件。返回开 session 的参数底座 */
async function workspace(cacheTtlMs?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'sc-snapshot-'))
  dirs.push(dir)
  const globalPath = join(dir, 'global-settings.json')
  await writeFile(globalPath, JSON.stringify(config(cacheTtlMs)), 'utf8')
  await writeFile(join(dir, 'AGENTS.md'), '# 约定 v1', 'utf8')
  await mkdir(join(dir, '.simple-code/events'), { recursive: true })
  await writeFile(
    join(dir, '.simple-code/events/old-event.md'),
    '---\nname: old-event\n---\n正文',
    'utf8',
  )
  const open = async (rounds: StreamEvent[][]) => {
    const s = scripted(rounds)
    const session = await getSession(dir, {
      globalPath,
      tools: [fakeTool()],
      stream: s.stream,
      skipLock: true,
    })
    return { session, ...s }
  }
  return { dir, open }
}

/** 模拟「上一个 session 关掉之后、archiver / 用户改了磁盘」 */
async function touchDisk(dir: string) {
  await writeFile(
    join(dir, '.simple-code/events/new-event.md'),
    '---\nname: new-event\n---\n正文',
    'utf8',
  )
  await writeFile(join(dir, 'AGENTS.md'), '# 约定 v2', 'utf8')
}

describe('system prompt 快照沿用（缓存热不重读）', () => {
  it('goal 与旧 lesson 同进快照；热重建保旧、压缩点更新、超额报错保旧', async () => {
    const w = await workspace()
    const dir = join(w.dir, '.simple-code/notes/goal')
    await mkdir(dir, { recursive: true })
    await mkdir(join(w.dir, '.simple-code/lessons'), { recursive: true })
    await writeFile(join(w.dir, '.simple-code/lessons/legacy.md'), '# 历史教训')
    const body = (target: string) =>
      `---\nstatus: active\ncurrent: true\n---\n## 这件事是什么\n跨请求协作\n## 目标\n${target}\n## 当前范围与边界\n不越权\n## 怎样算达到目标\n实际验证`
    await writeFile(join(dir, 'now.md'), body('目标第一版'))
    const first = await w.open([says('好')])
    await collect(first.session.send('第一轮'))
    expect(first.seen[0]?.system).toContain('目标第一版')
    expect(first.seen[0]?.system).toContain('legacy')
    await first.session.close()
    await writeFile(join(dir, 'now.md'), body('目标第二版'))
    const hot = await w.open([says('好'), says('好'), says('好')])
    await collect(hot.session.send('第二轮'))
    expect(hot.seen[0]?.system).toContain('目标第一版')
    expect(hot.seen[0]?.system).not.toContain('目标第二版')
    expect((await hot.session.compactNow()).ok).toBe(true)
    await collect(hot.session.send('第三轮'))
    expect(hot.seen[1]?.system).toContain('目标第二版')
    await writeFile(join(dir, 'now.md'), body('中'.repeat(5000)))
    const compact = await hot.session.compactNow()
    // 2026-11-03 起超预算降级为截断（note-budget.ts），不再报错保旧
    expect(compact.ok).toBe(true)
    await collect(hot.session.send('第四轮'))
    expect(hot.seen[2]?.system).toContain('已截断')
    expect(hot.seen[2]?.system).not.toContain('中'.repeat(5000))
    await hot.session.close()
  })
  it('缓存热：切目录/重开面板这类重建沿用快照，磁盘上的新事件进不来', async () => {
    const w = await workspace() // cacheTtlMs 默认 3 小时，跑完一轮马上重建必然热
    const s1 = await w.open([says('好的')])
    await collect(s1.session.send('你好'))
    await s1.session.close()

    await touchDisk(w.dir)

    const s2 = await w.open([says('好')])
    await collect(s2.session.send('再'))
    await s2.session.close()

    // 沿用的是旧四段：system prompt 与上一轮字节级同源，前缀缓存保住
    expect(s2.seen[0]?.system).toContain('old-event')
    expect(s2.seen[0]?.system).not.toContain('new-event')
    expect(s2.seen[0]?.system).toContain('约定 v1')
    expect(s2.seen[0]?.system).not.toContain('约定 v2')
  })

  it('任务会话写快照不串进主任务：重建的主任务读自己的快照，system 不在非压缩点变（2026-09-25 翻车回归）', async () => {
    // 现场：task-ws12fr 的 stale 卸载车（任务自己的压缩点，合法）写了
    // 【全文件夹共享的】prompt_snapshot；主任务会话实例随后重建（面板重开
    // /settings 变更），读到被任务换过的快照 → system 在主任务的非压缩点
    // 变了 → PrefixBrokenError。快照必须按 owner 分行，与 prefix_baseline
    // 同款——本测试钉住这个隔离
    const w = await workspace() // cacheTtlMs 默认热：主任务重建必然沿用快照
    const s1 = await w.open([says('好的')])
    await collect(s1.session.send('你好'))
    await s1.session.close()
    const mainSystem = s1.seen[0]?.system

    // 任务域写快照：模拟任务自己的 reloadSystem 在它的压缩点刷新四段。
    // 磁盘四段先变（archiver 落了新事件），任务读到的是新内容
    await touchDisk(w.dir)
    const scope: TaskScope = { owner: 'task-regress', forkTurn: 0, inheritCeil: 0 }
    const taskStore = openStore(w.dir, { task: scope })
    taskStore.writePromptSnapshot({
      agents: '# 约定 v2',
      userAgents: null,
      notes: null,
      events: '- new-event',
      lessons: null,
    })

    // store 级隔离：两个域各读各的
    const mainStore = openStore(w.dir)
    expect(mainStore.readPromptSnapshot()?.events).not.toContain('new-event')
    expect(taskStore.readPromptSnapshot()?.events).toContain('new-event')

    // session 级回归：主任务重建后第一条请求的 system 与上一轮字节级同源
    // ——修复前这里读到任务的快照，system 变了，守卫当场炸
    const s2 = await w.open([says('好')])
    await collect(s2.session.send('再'))
    await s2.session.close()
    expect(s2.seen[0]?.system).toBe(mainSystem)
  })

  it('缓存冷（TTL 过期）：重建不读盘，变化由第一次 send 的 stale 压缩点刷新进来', async () => {
    // 升级前这里测的是「冷了照常重读」——正是 20:40/20:55 两次「system 变了」
    // 的来源：archiver 给事件改个名，冷重建一重读就把索引变化带进 system
    // prompt，改写前缀还轮不到压缩点。现在重建一律沿用快照；TTL 真过期时
    // 第一次 send 的 stale 压缩点（reloadSystem）把变化刷新进来——那是
    // allowRewrite 放行的合法改写，守卫不响
    const w = await workspace(1) // TTL 1ms：睡 5ms 必冷
    const s1 = await w.open([says('好的')])
    await collect(s1.session.send('你好'))
    await s1.session.close()

    await touchDisk(w.dir)
    await new Promise((r) => setTimeout(r, 5))

    const s2 = await w.open([says('好')])
    const evs = await collect(s2.session.send('再'))
    await s2.session.close()

    // 重建没把变化带进来，压缩点把它合法地刷了进来，且守卫一次没响
    expect(s2.seen[0]?.system).toContain('new-event')
    expect(s2.seen[0]?.system).toContain('约定 v2')
    expect(evs.some((e) => e.type === 'error' && e.message.includes('前缀'))).toBe(false)
  })

  it('reloadSystem（卸载触发点）刷新后回写快照：之后的暖重建不会复活旧段', async () => {
    const w = await workspace(1)
    const s = await w.open([says('好的'), says('好')])
    await collect(s.session.send('第一轮'))
    expect(s.seen[0]?.system).toContain('old-event')

    await touchDisk(w.dir)
    await new Promise((r) => setTimeout(r, 5))

    // TTL 1ms → isCacheStale 命中 → unloadIfNeeded 顺路 reloadSystem 重读
    await collect(s.session.send('第二轮'))
    expect(s.seen[1]?.system).toContain('new-event')
    expect(s.seen[1]?.system).toContain('约定 v2')
    await s.session.close()

    // 快照必须跟着刷新——否则下一个热重建会把旧段复活回来
    const store = openStore(w.dir)
    const snap = store.readPromptSnapshot()
    store.close()
    expect(snap?.events).toContain('new-event')
    expect(snap?.events).not.toContain('old-event\n')
    expect(snap?.agents).toContain('约定 v2')
  })

  it('没跑过任何轮（lastRespondedAt 为 null）：快照在也沿用——第一次 send 的压缩点自然会刷新', async () => {
    const w = await workspace()
    const s1 = await w.open([says('好的')]) // 建了 session 但不发
    await s1.session.close()

    await touchDisk(w.dir)

    const s2 = await w.open([says('好')])
    await collect(s2.session.send('你好'))
    await s2.session.close()
    // 建会话时快照已落盘（old-event/v1），没发过也挡重读。注意
    // isCacheStale 对 null 恒 false（从没响应过=没有缓存可过期）——新内容
    // 要等真的压缩点（预算超线 / 响应过再隔 TTL）才由 reloadSystem 刷新
    expect(s2.seen[0]?.system).not.toContain('new-event')
    expect(s2.seen[0]?.system).toContain('old-event')
  })

  it('重载后第一请求的快照改写被豁免（2026-11-06 语义）；进程内改写走 truncation-recovery 覆盖', async () => {
    // 巡检 10-12 三条 break 时，日志行没有 dumpPath，排查得靠读 session.ts
    // 才知道现场落在 prefix-breaks/。修法：dump 先写、logRun 后发带路径。
    // 触发方式与 2026-09-25 回归同款——热重建沿用快照，直接改快照即改 system
    const calls: Record<string, unknown>[] = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    const w = await workspace()
    try {
      const s1 = await w.open([says('好的')])
      await collect(s1.session.send('你好'))
      await s1.session.close()

      // 2026-11-06：重载后第一次的 system 差异已被特判静默重置（dev 装机
      // 13 次真机打断），所以快照改写要在进程内第二次请求时才抓——先发一条
      // 建立状态，再改快照，再发
      const s2 = await w.open([says('好'), says('好')])
      await collect(s2.session.send('先'))
      openStore(w.dir).writePromptSnapshot({
        agents: '# 约定 v2',
        userAgents: null,
        notes: null,
        events: null,
        lessons: null,
      })
      const evs = await collect(s2.session.send('再'))
      await s2.session.close()
      // 2026-11-06 语义变更：重载后第一次的 system 差异静默重置（dev 装机 13 次
      // 真机打断），快照改写在重开 session 的第一请求被豁免、不炸不落现场
      expect(evs.some((e) => e.type === 'error' && e.message.includes('前缀'))).toBe(false)
    } finally {
      spy.mockRestore()
    }

    const rec = calls.find((c) => c.ev === 'prefix_break')
    expect(rec).toBeUndefined()
  })
})

describe('用户级 AGENTS.md（~/.simple-code/AGENTS.md，2026-09-29）', () => {
  /** 用户目录 = globalPath 所在目录，放在项目外的子目录里（真机 ~/.simple-code） */
  async function withUser(userText: string | null, cacheTtlMs?: number) {
    const dir = await mkdtemp(join(tmpdir(), 'sc-user-agents-'))
    dirs.push(dir)
    const project = join(dir, 'proj')
    const home = join(dir, 'home')
    await mkdir(project, { recursive: true })
    await mkdir(home, { recursive: true })
    const globalPath = join(home, 'settings.json')
    await writeFile(globalPath, JSON.stringify(config(cacheTtlMs)), 'utf8')
    await writeFile(join(project, 'AGENTS.md'), '# 项目约定', 'utf8')
    if (userText !== null) await writeFile(join(home, 'AGENTS.md'), userText, 'utf8')
    const open = async (rounds: StreamEvent[][]) => {
      const s = scripted(rounds)
      const session = await getSession(project, {
        globalPath,
        tools: [fakeTool()],
        stream: s.stream,
        skipLock: true,
      })
      return { session, ...s }
    }
    return { project, home, open }
  }

  it.each([1024, 4096])('首次加载两份 AGENTS 各用配置的 %i 额度', async (limit) => {
    const user = `个人开始${'约'.repeat(2400)}个人结束`
    const project = `项目开始${'定'.repeat(2400)}项目结束`
    const w = await withUser(user)
    await writeFile(
      join(w.home, 'settings.json'),
      JSON.stringify({ ...config(), memory: { agentsMaxTokens: limit } }),
    )
    await writeFile(join(w.project, 'AGENTS.md'), project)
    const s = await w.open([says('好')])
    await collect(s.session.send('你好'))
    await s.session.close()
    const system = s.seen[0]!.system!
    if (limit === 4096) {
      expect(system).toContain(user)
      expect(system).toContain(project)
      expect(system).not.toContain('此处已截断')
    } else {
      expect(system).not.toContain('个人结束')
      expect(system).not.toContain('项目结束')
      expect(system).toContain('~/.simple-code/AGENTS.md 超过 1024 token')
      expect(system).toContain('⚠ AGENTS.md 超过 1024 token')
    }
  })

  it('自定义额度在压缩点生效：用户级超额保旧，项目级超过默认值仍能刷新', async () => {
    const w = await withUser('# 个人约定 v1')
    await writeFile(
      join(w.home, 'settings.json'),
      JSON.stringify({ ...config(), memory: { agentsMaxTokens: 4096 } }),
    )
    const s = await w.open([says('好'), says('好')])
    await collect(s.session.send('第一轮'))
    await writeFile(join(w.home, 'AGENTS.md'), `个人超限${'约'.repeat(5000)}`)
    const project = `项目新版${'定'.repeat(2400)}项目结尾`
    await writeFile(join(w.project, 'AGENTS.md'), project)
    const compact = await s.session.compactNow()
    expect(compact.ok).toBe(true)
    expect(compact.ok && compact.errors.join('\n')).toContain('4,096 token 上限')
    await collect(s.session.send('第二轮'))
    await s.session.close()
    expect(s.seen[1]!.system).toContain('# 个人约定 v1')
    expect(s.seen[1]!.system).not.toContain('个人超限')
    expect(s.seen[1]!.system).toContain(project)
  })

  it('两份都进：用户级在前、项目级在后，用户级段声明冲突以项目为准', async () => {
    const w = await withUser('# 个人约定：结论用简体中文')
    const s = await w.open([says('好的')])
    await collect(s.session.send('你好'))
    await s.session.close()
    const system = s.seen[0]?.system ?? ''
    const user = system.indexOf('个人约定：结论用简体中文')
    const proj = system.indexOf('# 项目约定')
    expect(user).toBeGreaterThan(0)
    expect(proj).toBeGreaterThan(user)
    expect(system).toContain('冲突时以项目约定为准')
  })

  it('没有用户级文件 = 没有这一段（可选文件缺失静默跳过）', async () => {
    const w = await withUser(null)
    const s = await w.open([says('好的')])
    await collect(s.session.send('你好'))
    await s.session.close()
    expect(s.seen[0]?.system).not.toContain('用户的个人约定')
    expect(s.seen[0]?.system).toContain('# 项目约定')
  })

  it('用户级超限截断：警告行点名 ~/.simple-code/AGENTS.md（两份各自截断，要知道砍哪份）', async () => {
    const w = await withUser('约'.repeat(2400))
    const s = await w.open([says('好的')])
    await collect(s.session.send('你好'))
    await s.session.close()
    const system = s.seen[0]?.system ?? ''
    expect(system).toContain('⚠ ~/.simple-code/AGENTS.md 超过')
    expect(system).not.toContain('约'.repeat(2400))
    expect(system).not.toContain('⚠ AGENTS.md 超过')
  })

  it('升级前的快照（user_agents 为 NULL）热重建不加段——前缀接得上；压缩点才读进来并回写', async () => {
    const w = await withUser(null) // 默认 TTL 3 小时：马上重建必然热
    const s1 = await w.open([says('好的')])
    await collect(s1.session.send('第一轮'))
    await s1.session.close()
    // 快照已落盘且 userAgents=null，等价于升级前的老库。此时用户才写文件
    await writeFile(join(w.home, 'AGENTS.md'), '# 个人约定 新写的', 'utf8')

    const s2 = await w.open([says('好')])
    await collect(s2.session.send('第二轮'))
    await s2.session.close()
    expect(s2.seen[0]?.system).not.toContain('个人约定 新写的')
    expect(s2.seen[0]?.system).toBe(s1.seen[0]?.system)

    // TTL 改 1ms → 下一轮是 stale 压缩点，reloadSystem 读进来
    await writeFile(join(w.home, 'settings.json'), JSON.stringify(config(1)), 'utf8')
    await new Promise((r) => setTimeout(r, 5))
    const s3 = await w.open([says('嗯')])
    await collect(s3.session.send('第三轮'))
    await s3.session.close()
    expect(s3.seen[0]?.system).toContain('个人约定 新写的')
    const store = openStore(w.project)
    const snap = store.readPromptSnapshot()
    store.close()
    expect(snap?.userAgents).toContain('个人约定 新写的')
  })

  it('热重建沿用快照里的用户级段：磁盘改了也要等压缩点', async () => {
    const w = await withUser('# 个人约定 v1')
    const s1 = await w.open([says('好的')])
    await collect(s1.session.send('第一轮'))
    await s1.session.close()
    await writeFile(join(w.home, 'AGENTS.md'), '# 个人约定 v2', 'utf8')
    const s2 = await w.open([says('好')])
    await collect(s2.session.send('第二轮'))
    await s2.session.close()
    expect(s2.seen[0]?.system).toContain('个人约定 v1')
    expect(s2.seen[0]?.system).not.toContain('个人约定 v2')
  })

  it('各算各的 2048 额度：用户级变大到超限 → 保旧版，提示点名用户级文件，项目级照常刷新', async () => {
    const w = await withUser('# 个人约定 v1', 1)
    const s = await w.open([says('好的'), says('好')])
    await collect(s.session.send('第一轮'))
    await writeFile(
      join(w.home, 'AGENTS.md'),
      `# 个人约定 v2\n${'很长的一句话。'.repeat(2000)}`,
      'utf8',
    )
    await writeFile(join(w.project, 'AGENTS.md'), '# 项目约定 v2', 'utf8')
    await new Promise((r) => setTimeout(r, 5))
    const events = await collect(s.session.send('第二轮'))
    await s.session.close()
    expect(s.seen[1]?.system).toContain('个人约定 v1')
    expect(s.seen[1]?.system).not.toContain('个人约定 v2')
    expect(s.seen[1]?.system).toContain('# 项目约定 v2')
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined
    expect(err?.message).toContain(join(w.home, 'AGENTS.md'))
    expect(err?.message).not.toContain('、AGENTS.md')
  })

  it('用户目录就是项目目录（把 ~/.simple-code 当项目开）：只算项目级，不叠两遍', async () => {
    // 上面 workspace() 的布局正是这样：globalPath 在项目根
    const w = await workspace()
    const s = await w.open([says('好的')])
    await collect(s.session.send('你好'))
    await s.session.close()
    expect(s.seen[0]?.system).not.toContain('用户的个人约定')
    expect(s.seen[0]?.system.split('约定 v1').length).toBe(2)
  })
})
