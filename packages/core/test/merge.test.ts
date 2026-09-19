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
