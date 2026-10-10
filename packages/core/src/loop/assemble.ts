import type { Message } from '../llm/types.ts'
import { estimateTokens } from './tokens.ts'

/**
 * summaries 表的一行（design.md §9.8）。
 *
 * 字段名用 camelCase，跟库里的 snake_case 在 store 层转换——canonical 类型
 * 不该长得像 SQL 结果集（CLAUDE.md §3.2 的同类理由）。
 */
export type Summary = {
  id: number
  /** 0=L0，1=L1，… */
  level: number
  /** 覆盖的 step id 闭区间（实库与 findCovering 的比较口径都是 step；
   * 旧注释「turn id」是过时笔误。卸载/摘要的原子单位都是 step） */
  coversFrom: number
  coversTo: number
  /**
   * covers 两端所在的 turn（读库时从 steps 表带出，不落 summaries 列、不收
   * 写入参——唯一来源是 loadSummaries，内存构造与读回渲染不会分家）。
   * 渲染首行 `turn=` 与 cue 候选名用：模型拿 turn 号能直接 memory show，
   * 全局 step id 什么工具都不收（2026-09-30）。缺省只出现在测试夹具
   */
  turnFrom?: number
  turnTo?: number
  /**
   * 短标题（十来个字），和 `text` 是模型一次生成的两样东西。
   *
   * 温区那一行显示「标题：描述」——标题让模型一眼扫过去就能定位，描述才
   * 说清做了什么。空串是正常的：本地 L0（太短的 step 不调模型）没有标题，
   * 模型没按格式输出时也没有
   */
  name: string
  /** 摘要正文。pending 阶段是占位文本，ready 后换成模型写的真摘要 */
  text: string
  status: SummaryStatus
  /** §9.1 的生效开关。拼 context 只看这个 */
  inContext: boolean
  /** 上层摘要 id，null = 还没被合并 */
  supersededBy: number | null
  /**
   * 这个 turn 原话的开头几十字，卸载时填。null = 还没卸载。
   *
   * **和 text 分开存**，两个写入方不同：text 归后台摘要写，这个归卸载写。
   * 挤一列的话谁后写谁把对方覆盖掉，且不报错
   */
  head: string | null
  /** 原文归档文件（工作区相对路径），卸载时填 */
  archivePath: string | null
  /**
   * 摘要归属（task-v3）：null=对话的，'task-xxx'=任务私有的。组装不读它
   * （可见性在 store 的视角过滤做掉了）；它是给摘要器用的——合并只吃同
   * owner 的连续段，进场（flipSummary）只翻自己 owner 的行
   */
  owner: string | null
}

/**
 * `none` 不落库——没有行就是 none。落库的三态是下面这些。
 *
 * `pending` = 行已建（占位文本已经在 context 里用着了），但还没轮到它生成。
 */
export type SummaryStatus = 'pending' | 'generating' | 'ready'

/** 一条 live 消息和它属于哪个 turn。拼装按 turn 对齐，光有 Message 不够 */
export type LiveMessage = { message: Message; turnId: number; stepId: number }

/**
 * 一条被卸载的消息：原文归档在哪、属于哪个 turn。
 *
 * 放在这个文件而不是 run.ts，是因为 store 要用它——分层是 session → loop，
 * store 从 run.ts 拿类型就成了反向依赖（CLAUDE.md §1.3）
 */
export type UnloadedRef = { archivePath: string; turnId: number; stepId: number }

/**
 * 拼出要发给模型的消息列表：live 消息 + `inContext` 的摘要，按 turn 顺序交织。
 *
 * **这是纯函数，而且有两个调用点**——启动时从库恢复（`store.load`）、每轮发
 * 请求前重新组装（`run.ts`）。两处各写一遍的话，症状是「重启前后模型看到的
 * 历史不一样」：不报错，只是行为漂移，要等到用户抱怨「重开之后它就不记得刚才
 * 说的了」才会被发现。所以拼装只有这一个实现，两处都调它。
 *
 * 被摘要覆盖的 turn，它的 live 消息**不出现**在结果里——那些消息此时在库里是
 * `state='unloaded'`，本来也不该进 context，摘要行顶替它们的位置。
 *
 * 按 turn 走而不是按消息走：一条摘要可能覆盖多个 turn（合并之后），也可能覆盖
 * 的 turn 已经一条 live 消息都不剩。**两种情况在「遍历 turn」的写法下自然成立**，
 * 而「遍历 live 消息、遇到被覆盖的就替换」那种写法要额外处理后一种，
 * 位置还容易插错。
 */
/** 拼装计划的一条：一个 step 段的 live 消息块，或一条摘要行（二选一） */
type PlanEntry =
  | { live: LiveMessage[]; summary?: undefined }
  | { live?: undefined; summary: Summary }

/**
 * 走一遍拼装，产出 live 块与摘要行的交织序列。`assembleContext`（渲染）与
 * `emittedSummaries`（热区窗口的输入）共用这一份遍历——两处各写一遍的话，
 * 「窗口数了谁」和「实际渲染了谁」迟早分家
 */
function planContext(live: LiveMessage[], summaries: Summary[]): PlanEntry[] {
  const active = summaries.filter((summary) => summary.inContext)
  const byStep = groupByStep(live)
  const out: PlanEntry[] = []
  const emitted = new Set<number>()
  for (const stepId of stepOrder(byStep, active)) {
    const covering = findCovering(active, stepId)
    if (!covering) {
      out.push({ live: byStep.get(stepId) ?? [] })
      continue
    }
    // 一条摘要覆盖多个 step 时只发一次，不是每个 step 一遍
    if (emitted.has(covering.id)) continue
    emitted.add(covering.id)
    out.push({ summary: covering })
  }
  return out
}

/**
 * **真正会渲染成消息**的摘要行（按出现顺序、去重）。
 *
 * 热区窗口（`hotSummaryIds`）的输入必须是它，不能是「全部在场行」：
 * 在场但被别的行遮住（同段早位的行先被 `findCovering` 选中）的行不渲染，
 * 却也计入窗口的话，「看不见的状态变化」就能推动「看得见的渲染」——
 * 2026-09-23 真机：开库修复 `repairAppliedChains` 在会话重建时把几条被遮住
 * 的在场行翻成离场，消息一条没变（241→241），在场数却跨过了 `demoteBatch`
 * 的降级线，热区边界跳了一整批，第 23 条摘要从键变正文，前缀守卫拦下
 */
export function emittedSummaries(live: LiveMessage[], summaries: Summary[]): Summary[] {
  const out: Summary[] = []
  for (const entry of planContext(live, summaries)) if (entry.summary) out.push(entry.summary)
  return out
}

export function assembleContext(
  live: LiveMessage[],
  summaries: Summary[],
  /** 热区摘要的叶子正文，按 summary id。没有的按温区渲染（只给键） */
  bodies: ReadonlyMap<number, string> = new Map(),
  /** recall 线索行（cue.ts），turn → 成品行。渲染在此、计算在 send 入口
   *  （relay 同款：库里消息不动，装配期纯函数贴装——重装配字节一致，
   *  prefix-guard 不拦）。turn 卸载后 live 块不再出现，cue 随之自然消失 */
  cues: ReadonlyMap<number, readonly string[]> = new Map(),
): Message[] {
  const cuedTurns = new Set<number>()
  return planContext(live, summaries).flatMap((entry) => {
    if (entry.summary) return [toMessage(entry.summary, bodies.get(entry.summary.id))]
    return (entry.live ?? []).map(({ message, turnId }) => {
      const lines = cues.get(turnId)
      // 一个 turn 只贴一次（插话轮可能有第二条 user 行）；不复制消息对象
      if (message.role !== 'user' || !lines || lines.length === 0 || cuedTurns.has(turnId)) return message
      cuedTurns.add(turnId)
      return { ...message, parts: [...message.parts, { type: 'text', text: lines.join('\n') }] } satisfies Message
    })
  })
}

/**
 * 哪些摘要留在**热区**（展开叶子正文），其余只给键（提案 §4.4 的分辨率梯度）。
 *
 * ## 为什么是「攒满一批才降」而不是「只留最新的 N 条」
 *
 * ③ 索引按时间排序，而降级动的是**最前面**那几条——它后面的 KV 缓存全部失效
 * （§4.7 硬约束一）。每轮降一个的话 ③ 每轮都变，缓存永远只命中到 ②；攒满
 * `batch` 降一批，`batch` 轮里有 `batch - 1` 轮是纯追加。
 *
 * 所以热区条数在 `hotLeaves` 和 `hotLeaves + batch - 1` 之间来回，不是恒等于
 * `hotLeaves`。**这是设计，不是没写完**：恒等于 `hotLeaves` 正是那个每轮
 * 破缓存的实现。
 *
 * 纯计算、不存状态：降级点只由「现在有几条」决定，重启后算出来一样。存一个
 * 「已降到哪」的游标也能做，但那是第二份真相，跟 §1.5 的下标漂移同一类坑。
 */
export function hotSummaryIds(
  summaries: Summary[],
  opts: { hotLeaves: number; batch: number },
): Set<number> {
  // 只有 L0 谈得上热：上层摘要是「一行路由」，它的成员早就降到键以下了。
  // **自己排序**，不指望调用方——「热区是最新那几条」全靠这个顺序，
  // 拿到乱序的话降级点就随机了，而且不报错
  const active = summaries
    .filter((s) => s.inContext && s.level === 0)
    .sort((a, b) => a.coversFrom - b.coversFrom)
  const demoted =
    Math.max(0, Math.floor((active.length - opts.hotLeaves) / opts.batch)) * opts.batch
  return new Set(active.slice(demoted).map((s) => s.id))
}

/** step id 升序。live 里已有的，加上摘要覆盖到但一条 live 都不剩的 */
function stepOrder(byStep: Map<number, LiveMessage[]>, active: Summary[]): number[] {
  const ids = new Set(byStep.keys())
  for (const summary of active) ids.add(summary.coversFrom)
  return [...ids].sort((a, b) => a - b)
}

/**
 * 按 step 分组。**保持原顺序**——live 按 id 排好序传进来，同一个 step 的消息
 * 在数组里是连续的，push 进去就是对的
 */
function groupByStep(live: LiveMessage[]): Map<number, LiveMessage[]> {
  const byStep = new Map<number, LiveMessage[]>()
  for (const entry of live) {
    const bucket = byStep.get(entry.stepId)
    if (bucket) bucket.push(entry)
    else byStep.set(entry.stepId, [entry])
  }
  return byStep
}

const findCovering = (summaries: Summary[], stepId: number): Summary | undefined =>
  summaries.find((summary) => stepId >= summary.coversFrom && stepId <= summary.coversTo)

/**
 * 摘要在 context 里是一条 **user 消息**。
 *
 * 不用 assistant 的理由（**本项目自行推断**）：assistant 消息会被
 * 模型当成「我自己说过的话」，而摘要是系统对历史的转述，第一人称对不上。
 */
/**
 * 摘要消息的开标签。`regions.ts` 靠它把索引区从 live 消息里认出来——
 * 拼出去的是一条普通 user 消息，除了这个标签没有别的标记
 */
export const SUMMARY_TAG = '<历史摘要'

const toMessage = (summary: Summary, body?: string): Message => ({
  role: 'user',
  parts: [{ type: 'text', text: renderSummary(summary, body) }],
})

/**
 * 索引区当前占多少 token。
 *
 * **按「实际会渲染成的样子」算，不另立一套估算**：合并触发（`mergeWhileDue`）
 * 要拿它跟配额比，估算口径和渲染口径一旦分家，就会出现「按估算没超所以不合，
 * 实际发出去早超了」——不报错，只是索引区悄悄吃掉别的区的额度。
 *
 * `members` 由调用方筛好（`indexMembers`）。这里不自己过滤 `inContext`：
 * 合并刚记完账时新节点还没生效、成员还在用着，那一刻的稳态大小要按
 * 「合并生效之后」算，判断口径在 summarize.ts 那边，不在这里。
 */
export function indexTokens(
  members: Summary[],
  bodies: ReadonlyMap<number, string> = new Map(),
): number {
  return members.reduce(
    (sum, s) => sum + estimateTokens({ type: 'text', text: renderSummary(s, bodies.get(s.id)) }),
    0,
  )
}

/**
 * 包一层标记，让模型知道这不是用户刚说的话。
 *
 * 标签沿通行做法（`<conversation-checkpoint>`）——裸文本
 * 的话模型会把摘要当成用户的最新指令去执行。
 *
 * **头部、摘要、路径三样都要有**（提案 §4.1 评审修正二），各自不可替代：
 *
 * - 头部：摘要是模型转述的，措辞会漂；原话前几十字是唯一的原始锚点
 * - 摘要：没有它就退化成 3a 的纯截断，模型判断不了「值不值得展开」。
 *   带上标题（`name`）是因为温区那一档一屏几十条，扫标题比扫整句描述快；
 *   本地 L0 和内部节点没有标题，那时这一行就只有描述，不留空标签
 * - 路径：模型知道该展开却不知道去哪 `cat`，等于原文丢了
 *
 * **路径指的是叶子文件，标签因此从「原文」改成「详情」。** 原来指
 * `turns/*.jsonl`，那是几百 KB 的逐字对话，展开一次等于把刚卸载的全读回来；
 * 叶子是同一段的结构化摘要，几 KB，正是下一档分辨率。逐字原文没丢——叶子
 * frontmatter 里有 `turn:`，顺着能拼出归档文件名。
 *
 * 标签必须跟着改：写「原文」而指着一份摘要，模型会以为 cat 回来的就是全部，
 * 于是不再往下找。**这种错不报错，只是它以为自己看全了。**
 *
 * 三样合成**一条**消息而不是并排三条：并排的话同一段历史在 context 里出现
 * 两次，token 比 3a 还涨。
 *
 * head / archivePath 为空是正常的——摘要已生成但那个 turn 还没被卸载时就是
 * 这样（原文还在 context 里，不需要指路）。
 *
 * **`body` 只有热区那几条才有**（§4.4）：刚冷下来的 turn 展开叶子正文的四段，
 * 老的只留「摘要：」那一行键。两者是同一次生成的产物，降级不重新调模型
 * ——这正是 §1.3 那种逐层衰减在本设计里产生不了的原因。
 */
export function renderSummary(summary: Summary, body?: string): string {
  // 2026-09-30 前首行是 `step=<covers_from>-<covers_to>`（全局 step id）；
  // 之后是 turn 范围——面板范围列同日删除，这一行不再有程序读者
  const turns =
    summary.turnFrom === undefined || summary.turnTo === undefined
      ? '?'
      : `${summary.turnFrom}-${summary.turnTo}`
  const lines = [`${SUMMARY_TAG} turn=${turns}>`]
  if (summary.head) lines.push(`开头：${summary.head}`)
  // **标题和描述同一行**，不是两行。分两行的话每条摘要多一个 `摘要：`/
  // `标题：` 的标签开销，而温区一共才 70 来 token，标签就吃掉 5%
  lines.push(`摘要：${summary.name ? `${summary.name}——` : ''}${summary.text}`)
  if (body) lines.push(clampBody(body))
  if (summary.archivePath) lines.push(`详情：${foldPaths(summary.archivePath)}`)
  lines.push('</历史摘要>')
  return lines.join('\n')
}

/**
 * 内部节点的路径清单折成「首 … 尾（共 N 个）」。
 *
 * 合并时成员路径是全带上的（`session.ts` 的 `recordMerge`，理由是 §9.6 要求
 * L1 记住「原文去哪找」），十个成员就是十行。**实测这十行占掉冷节点 65-68%
 * 的体积**，冷因此比温还贵（221 vs 72 token/条，本该是 ~40），折叠等于没折叠
 * ——分辨率梯度在最该省的那一档反了。
 *
 * 折成范围不丢可检索性：叶子文件名带 `-sNNNNNN`，模型拿开标签上的 step 区间
 * `ls` 一下就定位得到中间那几个。§9.6 给 L1 举的例子本来也是一行范围
 * （「归档：turns-0041-0050.jsonl」），不是十行枚举。
 *
 * 折在渲染侧不在 `recordMerge` 侧：库里留全量路径（将来要做检索还得用它），
 * 而且**存量节点一并治住**——已经落库的那几条改不了了。
 */
function foldPaths(raw: string): string {
  const paths = raw.split('\n')
  const last = paths[paths.length - 1]
  if (paths.length <= 1 || last === undefined) return raw
  return `${paths[0]} … ${last}（共 ${paths.length} 个）`
}

/**
 * 热区正文的硬上限。
 *
 * 摘要模型偶尔会把整段跑飞的输出原样写进正文——实测一条 9,356 字符的叶子，
 * 光它一条就占掉整个索引区的 41%（5,934 token 里的 2,461）。这种跑飞不报错，
 * 只是那一轮的索引区悄悄膨胀十倍。
 *
 * 1,200 的来历：74 个真实叶子实测 p50=138、p99=1,035 字符，**现有的一条都
 * 碰不到这条线**。它是个安全阀不是压缩手段，正常正文一个字不动。
 *
 * 截在读侧不在写侧：磁盘上留全文，模型顺着「详情：」那一行还能 cat 回来
 * （§9.6 的「摘要的职责是保存可检索性，不是保存内容」），而且已经写坏的
 * 叶子不用回头去修。
 */
function clampBody(body: string): string {
  if (body.length <= BODY_MAX_CHARS) return body
  return `${body.slice(0, BODY_MAX_CHARS)}\n…（正文过长已截断，完整内容见下面「详情」指的文件）`
}

const BODY_MAX_CHARS = 1_200
