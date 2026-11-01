import type { ActivityItem, Block, ChatItem, Section } from './events.ts'

/**
 * 时间线的数据层（2026-10-28 活动流改版，原型 .simple-code/tmp/activity-redesign/）。
 *
 * 一轮的过程画成一条时间线：**一段说明是一个节点，说明后面的思考和命令
 * 归在这个节点下**。`groupItems` 给的是「说明块、活动块」交替的平铺序列，
 * 这里把它们配成对。纯函数，开合是 timeline.tsx 里的 React 本地态。
 */

type AssistantItem = Extract<ChatItem, { kind: 'assistant' }>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** 带原下标的块。下标决定「是不是最后一块」（流式、spinner），配对后要带着走 */
export type Entry = { block: Block; at: number }

export type Step = {
  kind: 'step'
  /** 首块下标：React 身份。说明后并进来时不变，开合状态不丢 */
  at: number
  text?: { item: AssistantItem; at: number }
  /** 思考 + 命令，按发生顺序 */
  items: ActivityItem[]
  /** 最后并进来的活动块的下标：判断尾部那条思考是否还在流式 */
  itemsAt?: number
}

/** 时间线上的一行：一个步骤，或不属于步骤的块（notice、模型切换分割线） */
export type Row = Step | { kind: 'block'; block: Block; at: number }

/**
 * 条数口径：**只数工具，不数 thinking**。`ActivityItem = reasoning | tool`，
 * 按 items.length 数的话「2 个操作」可能是 1 次思考 + 1 条命令；外层折叠头
 * 和句尾计数都从这里取，两处才对得上（原 events.ts toolCount 的口径）
 */
const tools = (items: readonly ActivityItem[]): ToolItem[] =>
  items.filter((item): item is ToolItem => item.kind === 'tool')

/**
 * 配对规则：
 * - 说明开新步骤。例外：当前步骤还没有说明、也没有命令（只想了一下）——
 *   说明并进去，那段思考就是它的前奏，不单独占一个节点
 * - 活动块并进当前步骤，当前步骤已有命令时开一个没有说明的新步骤
 * - 其余块（notice/分割线）单独成行，并截断当前步骤
 *
 * 模型的顺序是「想 → 说 → 调命令 → 想 → 说 …」，命令后面那次思考和命令
 * 连着，`groupItems` 已把它们并成一块，于是它挂在上一步——那次思考产出的
 * 正是下一段说明，挂哪边都说得通，原型就是这么挂的，用户看过
 */
export function buildSteps(entries: readonly Entry[]): Row[] {
  const rows: Row[] = []
  let cur: Step | null = null
  for (const { block, at } of entries) {
    if (block.kind === 'activity') {
      if (cur && tools(cur.items).length === 0) {
        cur.items = [...cur.items, ...block.items]
        cur.itemsAt = at
      } else {
        cur = { kind: 'step', at, items: block.items, itemsAt: at }
        rows.push(cur)
      }
    } else if (block.item.kind === 'assistant') {
      const text = { item: block.item, at }
      if (cur && !cur.text && tools(cur.items).length === 0) cur.text = text
      else {
        cur = { kind: 'step', at, text, items: [] }
        rows.push(cur)
      }
    } else {
      cur = null
      rows.push({ kind: 'block', block, at })
    }
  }
  return rows
}

export type Stats = {
  steps: number
  tools: number
  failed: number
  /** 跑完的命令数（还在转圈的不算）——进度行的「已做 N 个操作」 */
  done: number
  /** 操作条：每步一组，每条命令一格，true = 失败 */
  strip: boolean[][]
}

export function stepStats(rows: readonly Row[]): Stats {
  const steps = rows.filter((row): row is Step => row.kind === 'step')
  const all = steps.flatMap((step) => tools(step.items))
  return {
    steps: steps.length,
    tools: all.length,
    failed: all.filter((t) => t.failed).length,
    done: all.filter((t) => !(t.startedAt !== undefined && t.endedAt === undefined)).length,
    strip: steps.map((step) => tools(step.items).map((t) => t.failed)).filter((s) => s.length > 0),
  }
}

/** 一轮 = 开头的 user 块（分页截出来的半轮没有）+ 其后各段 */
export type Turn = { head?: { block: Block; at: number }; body: Section[] }

export function groupTurns(sections: readonly Section[]): Turn[] {
  const turns: Turn[] = []
  for (const section of sections) {
    const isUser =
      section.kind === 'block' &&
      section.block.kind === 'single' &&
      section.block.item.kind === 'user'
    if (isUser) turns.push({ head: { block: section.block, at: section.at }, body: [] })
    else if (turns.length === 0) turns.push({ body: [section] })
    else turns[turns.length - 1]?.body.push(section)
  }
  return turns
}

/**
 * 两轮内容是否相同（timeline.tsx MTurnView 的 memo 判据）。Log 每次渲染都
 * 重建 Block/Section/Turn 外壳，但 ChatItem 引用是稳定的：events.ts 改一条
 * 都是复制数组、只替换那一条（流式追加、工具结果、页脚都这样），从不原地
 * 改。所以逐条比 item 引用，外加下标和耗时这两个不在 item 里的数
 */
export function sameTurn(a: Turn, b: Turn): boolean {
  if (a.head?.at !== b.head?.at) return false
  if (a.head && b.head && !sameBlock(a.head.block, b.head.block)) return false
  return sameList(a.body, b.body, sameSection)
}

const sameList = <T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): boolean =>
  a.length === b.length && a.every((x, i) => eq(x, b[i] as T))

const sameItem = <T>(x: T, y: T): boolean => x === y

const sameBlock = (a: Block, b: Block): boolean =>
  a.kind === 'single'
    ? b.kind === 'single' && a.item === b.item
    : b.kind === 'activity' && sameList(a.items, b.items, sameItem)

const sameSection = (a: Section, b: Section): boolean =>
  a.kind === 'block'
    ? b.kind === 'block' && a.at === b.at && sameBlock(a.block, b.block)
    : b.kind === 'process' && a.elapsedMs === b.elapsedMs && sameList(a.blocks, b.blocks, sameBlock)

/**
 * 失败命令下面那一行：输出里第一条像报错的行。
 * bash 判失败只看退出码（core bash.ts：isError = exitCode !== 0），输出里
 * 未必有报错字样——找不到就照实说，不拿最后一行冒充原因（原型里实测：
 * 一条失败命令的末行是 package.json 的 "format" 脚本）。非 bash 工具的
 * 失败输出本身就是错误说明，取首个非空行
 */
const ERROR_LINE = /error|\berr\b|fail|denied|not found|no such|失败|错误|拒绝|中断|终止|无法/i

export function errorLine(output: string, isBash: boolean): string {
  const lines = output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return (
    lines.find((s) => ERROR_LINE.test(s)) ??
    (isBash ? '退出码非 0，输出里没有报错行' : (lines[0] ?? '没有输出'))
  )
}
