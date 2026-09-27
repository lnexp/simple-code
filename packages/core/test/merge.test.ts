import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Summary } from '../src/loop/assemble.ts'
import {
  buildMergeRequest,
  buildSummaryRequest,
  pickMergeGroup,
  renderMergeInput,
} from '../src/loop/summarize.ts'
import { MEMORY_RELATIVE, openStore, type Store } from '../src/session/store.ts'
import { forkTask, scopeOf } from '../src/session/task.ts'

/**
 * 3b-2 的两段式验收之一：**纯逻辑**（挑合并组、渲染、请求）和 **store 层**
 * （合并落库、生效、崩溃修复）。端到端在 merge-e2e.test.ts。
 *
 * 每条都对应提案 §5.4 的验收项，对照着看。
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-merge-'))
  dirs.push(dir)
  return dir
}

describe('挑合并组', () => {
  const s = (over: Partial<Summary> = {}): Summary => ({
    owner: over.owner ?? null,
    id: over.id ?? 1,
    level: over.level ?? 0,
    name: over.name ?? '',
    coversFrom: over.coversFrom ?? 1,
    coversTo: over.coversTo ?? 1,
    text: over.text ?? '某轮做了什么',
    status: over.status ?? 'ready',
    inContext: over.inContext ?? true,
    supersededBy: over.supersededBy ?? null,
    head: over.head ?? null,
    archivePath: over.archivePath ?? null,
  })

  it('同层攒够 mergeFactor 条、连续、都生效 → 返回这组', () => {
    const group = pickMergeGroup(
      [
        s({ id: 1, coversFrom: 1, coversTo: 1 }),
        s({ id: 2, coversFrom: 2, coversTo: 2 }),
        s({ id: 3, coversFrom: 3, coversTo: 3 }),
      ],
      3,
    )
    expect(group?.members.map((m) => m.id)).toEqual([1, 2, 3])
    expect(group?.level).toBe(0)
  })

  it('**差一条都不合**——攒够才合是缓存语义，不是空间语义', () => {
    expect(pickMergeGroup([s({ id: 1 }), s({ id: 2 })], 3)).toBeNull()
  })

  it('**连续 5 条、扇出 2 → 只吃最老的 2 条**，不是把整段吞掉', () => {
    // 原来是 `run.slice()`，整段全吃：真库里 25 条连续 L0 被一次合成一行
    // 关键词，25 份写好的叶子描述一次性从 context 里消失。**积压越多吞得
    // 越狠**，方向正好反了——后台摘要攒了多少，跟扇出该是多少没有关系。
    //
    // 现在合并由「索引区超配额」触发（`mergeWhileDue`），一次合不完就再合
    // 一轮，所以扇出可以是个常数
    const five = [1, 2, 3, 4, 5].map((i) => s({ id: i, coversFrom: i, coversTo: i }))
    expect(pickMergeGroup(five, 2)?.members.map((m) => m.id)).toEqual([1, 2])
    // 前提：这 5 条确实是连续可合的一段，不然上面测的是「只有 2 条能合」
    expect(pickMergeGroup(five, 5)?.members.map((m) => m.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('**covers 有洞不合**——洞里的 turn 会被 L1 吞掉，历史凭空消失', () => {
    // 1、2、4：中间缺 3。这种状态正常流程到不了（卸载从最老开始、生效的
    // L0 是前缀），但实现不能默默依赖它——校验断了就不合这批
    const group = [
      s({ id: 1, coversFrom: 1, coversTo: 1 }),
      s({ id: 2, coversFrom: 2, coversTo: 2 }),
      s({ id: 4, coversFrom: 4, coversTo: 4 }),
    ]
    expect(pickMergeGroup(group, 3)).toBeNull()
  })

  it('洞后面那段要是自己攒够了，合后面那段', () => {
    const group = [
      s({ id: 1, coversFrom: 1, coversTo: 1 }),
      s({ id: 3, coversFrom: 3, coversTo: 3 }),
      s({ id: 4, coversFrom: 4, coversTo: 4 }),
      s({ id: 5, coversFrom: 5, coversTo: 5 }),
    ]
    // 1 和 3 之间有洞（缺 2），但 3-4-5 连续且够 3 条
    expect(pickMergeGroup(group, 3)?.members.map((m) => m.id)).toEqual([3, 4, 5])
  })

  it('**纯死缝可跨**：fork 预留尾巴零内容零摘要 → 跨缝成组', () => {
    // task-v3：对话 fork 时跳过整段预留号段，任务关闭后没用完的尾巴
    // 谁也不会再写——不跨的话每 fork 一次索引地板永久抬一行
    const group = pickMergeGroup(
      [
        s({ id: 1, level: 1, coversFrom: 100, coversTo: 200 }),
        s({ id: 2, level: 1, coversFrom: 50100, coversTo: 50200 }),
      ],
      2,
      // 缝 (200, 50100) 里零消息零外主 steps
      () => false,
    )
    expect(group?.members.map((m) => m.id)).toEqual([1, 2])
  })

  it('**缝里有摘要不跨**：缝内被别的行罩着的历史会被新节点吞掉', () => {
    // 场景：缝里躺着别的层/别的链的摘要（它罩的消息行可能已被
    // applyPendingMerges 整删，只查消息会误判成空缝）——跨过去后新节点
    // 的 covers 罩住它，coversActive 把它收掉，它的内容没进新节点的 text
    const group = pickMergeGroup(
      [
        s({ id: 1, level: 0, coversFrom: 100, coversTo: 200 }),
        s({ id: 9, level: 1, coversFrom: 300, coversTo: 400 }),
        s({ id: 2, level: 0, coversFrom: 500, coversTo: 600 }),
        s({ id: 3, level: 0, coversFrom: 700, coversTo: 800 }),
      ],
      2,
      () => false,
    )
    // L0 层 1 和 2 之间的缝 (200, 500) 里有 id 9 的 covers [300,400] →
    // 不可跨。1 凑不够两条，从 2 重新数：2、3 相邻成组
    expect(group?.members.map((m) => m.id)).toEqual([2, 3])
  })

  it('**罩着缝两侧的上层节点放行**：它跟缝相交但不会被新节点罩住（2026-09-25 索引区悬空根因）', () => {
    // 真库现场：L2 大节点（covers 1–663613）罩住老区所有 fork 空缝——
    // 按旧判据「缝里有任何行」全判不可跨，金字塔永久碎着。它一端伸出
    // 合并组跨度外（coversFrom=50 < 首成员 100），新节点罩不住它 → 放行
    const group = pickMergeGroup(
      [
        s({ id: 1, level: 1, coversFrom: 100, coversTo: 200 }),
        s({ id: 9, level: 2, coversFrom: 50, coversTo: 60000 }),
        s({ id: 2, level: 1, coversFrom: 50100, coversTo: 50200 }),
      ],
      2,
      () => false,
    )
    expect(group?.members.map((m) => m.id)).toEqual([1, 2])
  })

  it('**跨缝的行完整落在合并组跨度内 → 仍拒**：新节点会整个罩住它', () => {
    // 行 [150, 50150] 跟缝 (200, 50100) 相交、跨过缝两侧，但首尾都落在
    // 合并组跨度 [100, 50200] 里——新节点会罩住它，收掉它的历史。放行
    // 上层节点的口径收窄到这里为止，不是放开「跨过缝就算罩不住」
    const group = pickMergeGroup(
      [
        s({ id: 1, level: 1, coversFrom: 100, coversTo: 200 }),
        s({ id: 9, level: 2, coversFrom: 150, coversTo: 50150 }),
        s({ id: 2, level: 1, coversFrom: 50100, coversTo: 50200 }),
      ],
      2,
      () => false,
    )
    expect(group).toBeNull()
  })

  it('**缝里有消息或活任务 steps 不跨**（谓词为真 = 有内容痕迹）', () => {
    const group = pickMergeGroup(
      [
        s({ id: 1, level: 1, coversFrom: 100, coversTo: 200 }),
        s({ id: 2, level: 1, coversFrom: 50100, coversTo: 50200 }),
      ],
      2,
      () => true,
    )
    expect(group).toBeNull()
  })

  it('store.gapHasContent：可见消息、活任务 steps、纯死缝三种口径', async () => {
    const dir = await workspace()
    const main = openStore(dir)
    main.save([{ role: 'user', parts: [{ type: 'text', text: '主干' }] }])
    const step = main.withTurns(main.load())[0]?.stepId ?? 0
    // 可见消息：盖着消息的 step 两侧 → true
    expect(main.gapHasContent(step - 1, step + 1)).toBe(true)
    // 纯死缝：远离一切内容的号段 → false
    expect(main.gapHasContent(500000, 600000)).toBe(false)

    // 活任务：fork 出的任务在预留段里写 step（对话视角看不见消息，
    // 但 steps 行在库里）→ 对话的 gapHasContent 必须报 true
    const m = forkTask(dir, '跨缝保险')
    const task = openStore(dir, { task: scopeOf(m) })
    task.save([{ role: 'user', parts: [{ type: 'text', text: '任务里干活' }] }])
    const taskStep = task.withTurns(task.load())[0]?.stepId ?? 0
    expect(taskStep).toBeGreaterThan(0)
    expect(main.gapHasContent(taskStep - 1, taskStep + 1)).toBe(true)
    main.close()
    task.close()
  })

  it('没生效的、没 ready 的、已被合并过的不算数', () => {
    expect(
      pickMergeGroup(
        [
          s({ id: 1, coversFrom: 1, inContext: false }),
          s({ id: 2, coversFrom: 2, status: 'pending' }),
          s({ id: 3, coversFrom: 3, supersededBy: 99 }),
        ],
        3,
      ),
    ).toBeNull()
  })

  it('多层都够时从最老的层开始——低层是更新的历史，先合远的', () => {
    const group = pickMergeGroup(
      [
        s({ id: 1, level: 0, coversFrom: 1, coversTo: 1 }),
        s({ id: 2, level: 0, coversFrom: 2, coversTo: 2 }),
        s({ id: 3, level: 1, coversFrom: 10, coversTo: 19 }),
        s({ id: 4, level: 1, coversFrom: 20, coversTo: 29 }),
      ],
      2,
    )
    expect(group?.level).toBe(0)
  })
})

describe('渲染与请求', () => {
  it('输入带 step 范围和归档路径——上层节点要记住原文去哪找', () => {
    const text = renderMergeInput([
      {
        id: 1,
        owner: null,
        level: 0,
        coversFrom: 3,
        coversTo: 3,
        name: '',
        text: '改了 a.ts',
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: '.simple-code/turns/turn-000003.jsonl',
      },
      {
        id: 2,
        owner: null,
        level: 0,
        coversFrom: 4,
        coversTo: 4,
        name: '',
        text: '跑了测试',
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: '.simple-code/turns/turn-000004.jsonl',
      },
    ])
    // **step 不是 turn**：covers 从「摘要单位改成段」那次起就是 step id 了。
    // 标成 turn 的话模型会把 step 号当 turn 号写进路由行，照着去
    // `turns/turn-00xxxx.jsonl` 找会扑空——不报错，只是找不到
    expect(text).toContain('[step 3-3]')
    expect(text).not.toContain('[turn ')
    expect(text).toContain('turn-000003.jsonl')
    expect(text).toContain('改了 a.ts')
  })

  it('**合并要的是路由行，不是又一层摘要**', () => {
    const base = {
      model: 'm',
      maxTokens: 100,
      thinking: 'disabled',
      effort: 'high',
      reasoningDisplay: 'omitted',
    } as const
    const request = buildMergeRequest('输入文本', base)

    expect(request.tools).toEqual([])
    // 路由行的契约：给关键词、明确排斥完整句子。少了后半句模型会写出
    // 「这段历史进行了多项重构」——读着顺，但定位不到任何一段（§1.3 的退化）
    expect(request.system).toContain('关键词')
    expect(request.system).toContain('不要完整句子')
    // **对照组**：跟 L0 是两份指令。共用一份的话上层会去写四段正文，
    // 也就是「摘要的摘要」，正是 §3.2 要避免的那件事
    expect(request.system).not.toBe(buildSummaryRequest('输入文本', base).system)
  })
})

describe('store：合并落库（只写库）', () => {
  const draft = (
    over: Partial<Parameters<Store['addSummary']>[0]> = {},
  ): Parameters<Store['addSummary']>[0] => ({
    level: 0,
    coversFrom: 1,
    coversTo: 1,
    name: '',
    text: '摘要文本',
    status: 'ready',
    inContext: true,
    supersededBy: null,
    head: '开头',
    archivePath: '.simple-code/turns/turn-000001.jsonl',
    ...over,
  })

  it('父行写入 + 成员 superseded_by 指过去，成员 in_context 原样不动', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const ids = [1, 2, 3].map((t) => store.addSummary(draft({ coversFrom: t, coversTo: t })))

    const parentId = store.recordMerge(
      draft({ level: 1, coversFrom: 1, coversTo: 3, text: 'L1 文本', inContext: false }),
      ids,
    )

    const all = store.summaries()
    // 成员：被指了父，但开关没动——§9.1「合并只写库，context 一个字节不动」
    for (const id of ids) {
      expect(all.find((s) => s.id === id)?.supersededBy).toBe(parentId)
      expect(all.find((s) => s.id === id)?.inContext).toBe(true)
    }
    const parent = all.find((s) => s.id === parentId)
    expect(parent?.level).toBe(1)
    expect(parent?.inContext).toBe(false)
    store.close()
  })

  it('**等宽互罩双 L1 不死锁**：同范围两条都在场 → 留 id 小的，重复那条当场收掉', async () => {
    // 2026-09-24 真机：66889/66891 同范围（612876-612983）双 L1 都在场——
    // 互为 root，off 把双双翻 0 后 roots 循环又把双双翻回 1，谁也收不掉谁
    // （12:28:49 前缀断裂里那对重复摘要一直僵在场内的根因）。修复：roots
    // 取极大根，等宽时留 id 小的
    const dir = await workspace()
    const store = openStore(dir)
    const row = (level: number, coversFrom: number, coversTo: number, inContext: boolean) => ({
      level,
      coversFrom,
      coversTo,
      name: '',
      text: '摘要',
      status: 'ready' as const,
      inContext,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    store.addSummary(row(0, 1, 1, true))
    store.addSummary(row(0, 2, 2, true))
    const a = store.addSummary(row(1, 1, 2, true))
    const b = store.addSummary(row(1, 1, 2, true))
    expect(a).toBeLessThan(b)

    const dropped = store.applyMerges()
    const after = store.summaries()
    const at = (id: number) => after.find((s) => s.id === id)?.inContext
    expect(at(a)).toBe(true) // 留下的那条
    expect(at(b)).toBe(false) // 重复的那条——修复前它被 roots 循环翻回 1
    expect(dropped.size).toBeGreaterThan(0)
    store.close()
  })

  it('**嵌套的候选根出局**：L2 已进场且罩着在场的 L1 → L1 不再当根保自己，整棵收进 L2', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const row = (level: number, coversFrom: number, coversTo: number, inContext: boolean) => ({
      level,
      coversFrom,
      coversTo,
      name: '',
      text: '摘要',
      status: 'ready' as const,
      inContext,
      supersededBy: null,
      head: null,
      archivePath: null,
    })
    store.addSummary(row(0, 1, 1, true)) // L1 的成员（也是 L1 当候选根的依据）
    const l1 = store.addSummary(row(1, 1, 2, true))
    const l2 = store.addSummary(row(2, 1, 3, true))

    store.applyMerges()
    const after = store.summaries()
    const at = (id: number) => after.find((s) => s.id === id)?.inContext
    expect(at(l1)).toBe(false) // 被罩住的候选根不再保自己
    expect(at(l2)).toBe(true)
    store.close()
  })
})

describe('store：生效', () => {
  const draft = (
    over: Partial<Parameters<Store['addSummary']>[0]> = {},
  ): Parameters<Store['addSummary']>[0] => ({
    level: 0,
    coversFrom: 1,
    coversTo: 1,
    name: '',
    text: '摘要文本',
    status: 'ready',
    inContext: true,
    supersededBy: null,
    head: '开头',
    archivePath: '.simple-code/turns/turn-000001.jsonl',
    ...over,
  })

  it('子孙 → 0、链根 → 1，返回被换出的 turn 集合', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const ids = [1, 2, 3].map((t) => store.addSummary(draft({ coversFrom: t, coversTo: t })))
    const parentId = store.recordMerge(
      draft({ level: 1, coversFrom: 1, coversTo: 3, inContext: false }),
      ids,
    )

    const dropped = store.applyMerges()

    expect(dropped).toEqual(new Set([1, 2, 3]))
    const all = store.summaries()
    for (const id of ids) expect(all.find((s) => s.id === id)?.inContext).toBe(false)
    expect(all.find((s) => s.id === parentId)?.inContext).toBe(true)
    store.close()
  })

  it('没有待生效的合并 → 空集，什么也不动', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const id = store.addSummary(draft())
    expect(store.applyMerges()).toEqual(new Set())
    expect(store.summaries().find((s) => s.id === id)?.inContext).toBe(true)
    store.close()
  })

  it('**级联的根直接吃掉整棵子树**：L2 生效时 L1/L0 一起关', async () => {
    // L0×2 → L1a；再 L0×2 → L1b；L1a+L1b → L2。全并好之后一次 apply：
    // 最终 context 里只剩 L2 一条
    const dir = await workspace()
    const store = openStore(dir)
    const l0a = [1, 2].map((t) => store.addSummary(draft({ coversFrom: t, coversTo: t })))
    const l1a = store.recordMerge(
      draft({ level: 1, coversFrom: 1, coversTo: 2, inContext: false }),
      l0a,
    )
    const l0b = [3, 4].map((t) => store.addSummary(draft({ coversFrom: t, coversTo: t })))
    const l1b = store.recordMerge(
      draft({ level: 1, coversFrom: 3, coversTo: 4, inContext: false }),
      l0b,
    )
    const l2 = store.recordMerge(
      draft({ level: 2, coversFrom: 1, coversTo: 4, inContext: false }),
      [l1a, l1b],
    )

    const dropped = store.applyMerges()

    expect(dropped).toEqual(new Set([1, 2, 3, 4]))
    const inCtx = store.summaries().filter((s) => s.inContext)
    expect(inCtx.map((s) => s.id)).toEqual([l2])
    store.close()
  })

  it('**L0 债压着时不误伤**：apply 只换有链根的范围，别的不动', async () => {
    const dir = await workspace()
    const store = openStore(dir)
    const ids = [1, 2].map((t) => store.addSummary(draft({ coversFrom: t, coversTo: t })))
    store.recordMerge(draft({ level: 1, coversFrom: 1, coversTo: 2, inContext: false }), ids)
    const orphan = store.addSummary(draft({ coversFrom: 5, coversTo: 5 })) // 不在合并范围里

    store.applyMerges()

    expect(store.summaries().find((s) => s.id === orphan)?.inContext).toBe(true)
    store.close()
  })

  it('**已进场的链根也收**：activateBacklog 先翻 L1 进场、成员还压着 → apply 当场收掉，重开库不再动', async () => {
    // 2026-09-24 真机事故链：压缩点上 activateBacklog（activateSummary 只翻
    // 自己）把 L1 翻进场，紧跟的 applyMerges 只认「还没进场」的 root——L1
    // 已进场就跳过，成员留在场内与 L1 重叠。这个脏态留到 reload 被
    // repairAppliedChains 收掉，首请求前缀在中段被改写，两个目录双双
    // PrefixBrokenError。修复：root 判据不要求 !inContext，重叠在同一个
    // 压缩点内收掉——重开库（repairAppliedChains）从此无事可做
    const dir = await workspace()
    let store = openStore(dir)
    // 三个真 step（activateSummary 认 steps.unloaded，假号过不了它的门）
    store.save([
      { role: 'user', parts: [{ type: 'text', text: '第一轮' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '答一' }] },
      { role: 'user', parts: [{ type: 'text', text: '第二轮' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '答二' }] },
      { role: 'user', parts: [{ type: 'text', text: '第三轮' }] },
      { role: 'assistant', parts: [{ type: 'text', text: '答三' }] },
    ])
    store.unload([0, 1, 2, 3, 4, 5])
    const steps = [...store.unloadedSteps()].sort((a, b) => a - b)
    expect(steps.length).toBeGreaterThanOrEqual(3) // save 的切步不保证 3 段，取前 3 个真 step 即可
    // 三段 L0 在场（真实路径：卸载时 activateSummary 翻进来的，这里直接造终态）
    const ids = steps.slice(0, 3).map((t) =>
      store.addSummary({
        level: 0,
        coversFrom: t,
        coversTo: t,
        name: '',
        text: '摘要',
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: '开头',
        archivePath: '.simple-code/turns/turn-000001.jsonl',
      }),
    )
    const parentId = store.recordMerge(
      {
        level: 1,
        coversFrom: steps[0]!,
        coversTo: steps[2]!,
        name: '',
        text: 'L1',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: null,
        archivePath: null,
      },
      ids,
    )

    // 压缩点的第一步：activateBacklog 把 L1 翻进场（成员 superseded，查不到
    // 自己，只会命中 L1）
    expect(store.activateSummary(steps[0]!)).toBe(true)
    const overlapped = store.summaries()
    // 事故现场：L1 与成员同时在场
    expect(overlapped.find((s) => s.id === parentId)?.inContext).toBe(true)
    expect(overlapped.find((s) => s.id === ids[0])?.inContext).toBe(true)

    // 压缩点的第二步：apply 必须当场收掉成员（修复前成员留 1）
    const dropped = store.applyMerges()
    expect(dropped).toEqual(new Set(steps.slice(0, 3)))
    const after = store.summaries()
    for (const id of ids) expect(after.find((s) => s.id === id)?.inContext).toBe(false)
    expect(after.find((s) => s.id === parentId)?.inContext).toBe(true)
    store.close()

    // reload 等价物：重开库（repairAppliedChains 在 openStore 里跑）——
    // 修复后无事可做，在场集合一个字节不动
    store = openStore(dir)
    const reopened = store.summaries()
    for (const s of after) {
      expect(reopened.find((x) => x.id === s.id)?.inContext).toBe(s.inContext)
    }
    store.close()
  })
})

describe('store：崩溃恢复（提案 §5.3）', () => {
  it('脏库「父生效了、子孙也还生效」→ 重开库自动修复', async () => {
    // 正常流程到不了这个状态（apply 是一个事务），这条测的是防御：
    // 手工造出脏库，验证 openStore 的 repairAppliedChains 以链为准压回子孙
    const dir = await workspace()
    let store = openStore(dir)
    const ids = [1, 2].map((t) =>
      store.addSummary({
        level: 0,
        coversFrom: t,
        coversTo: t,
        name: '',
        text: '摘要',
        status: 'ready',
        inContext: true,
        supersededBy: null,
        head: null,
        archivePath: null,
      }),
    )
    const parentId = store.recordMerge(
      {
        level: 1,
        coversFrom: 1,
        coversTo: 2,
        name: '',
        text: 'L1',
        status: 'ready',
        inContext: false,
        supersededBy: null,
        head: null,
        archivePath: null,
      },
      ids,
    )
    // 手工把父行掰成已生效，模拟「事务写了一半崩了」。store 是闭包拿不到
    // 内部 db，直接开库文件改——测试本来就站在「库被外部弄脏」的视角
    store.close()
    const db = new DatabaseSync(join(dir, MEMORY_RELATIVE, 'state.db'))
    db.exec(`UPDATE summaries SET in_context = 1 WHERE id = ${parentId}`)
    db.close()

    store = openStore(dir) // 重启触发修复
    const all = store.summaries()
    for (const id of ids) {
      // 子孙被压回 0——同一段历史不能在 context 里出现两次
      expect(all.find((s) => s.id === id)?.inContext).toBe(false)
    }
    expect(all.find((s) => s.id === parentId)?.inContext).toBe(true)
    store.close()
  })
})
