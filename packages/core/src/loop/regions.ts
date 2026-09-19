import type { Message, Part, Request } from '../llm/types.ts'
import { SUMMARY_TAG } from './assemble.ts'
import { estimateTokens } from './tokens.ts'
import { isStubbed } from './unload.ts'

/**
 * 一次请求里四个区各占多少 token（提案 §11 的分区，§13 的实测口径）。
 *
 * **为什么要记这个**：`indexRatio` / `unloadTargetRatio` / `floorTokens` /
 * `reservedTokens` 四个默认值里，只有前两个有实测依据，而那次实测是把一份
 * 手工抓下来的 `request.json` 拿脚本反推出来的（§13.5 记了两次反推错误）。
 * 每轮记一行，下次调比例就是查文件而不是再抓一次包。
 *
 * ⑤ 保底区不单列：它是 ④ 的一个后缀（最近这么多 token 的原文不动），
 * 从组装出来的消息里分不出边界——真要分得让 `pickOldest` 把落点报上来，
 * 而那个落点每轮都变，记了也没法跟配额比。
 */
export type RegionSizes = {
  /** ① system prompt + 工具定义。它们不在 messages 里，`contextUsage` 数不到 */
  overhead: number
  /** ② 索引区·冷：内部节点（L1+）。判据：详情行的 foldPaths 折叠签名「（共 N 个）」 */
  cold: number
  /** ② 索引区·温：L0 无正文——只有 开头/摘要/详情 行 */
  warm: number
  /** ② 索引区·热：L0 带正文。判据：四段标题（`## `）是 body 的稳定签名 */
  hot: number
  /** ③ 存根：工具 I/O 被裁过的那些消息 */
  stub: number
  /** ⑤ 保底区：floor 集合内的 live 原文（`floorStartIndex` 圈住、卸载不碰的那截） */
  floor: number
  /** ④ 原文：保底区之外的 live 消息 */
  live: number
}

/** step 闭区间。摘要的 covers 与 live 的归属本来就是 step 粒度
 * （findCovering 按 stepId 比较、实库 covers_from 落在 steps 表区间内） */
export type StepRange = { from: number; to: number }

/** 各区覆盖的 step 范围（观测用；null = 该区没有消息或 step 不可知） */
export type RegionRanges = {
  cold: StepRange | null
  warm: StepRange | null
  hot: StepRange | null
  stub: StepRange | null
  floor: StepRange | null
  live: StepRange | null
}

/**
 * 按「实际发出去的那份」量，所以参数是 `Request` 而不是内存历史——
 * 摘要顶替、卸载裁剪都已经发生过了，这里量的是模型真正看到的东西。
 *
 * 分类只能按文本形状认（`SUMMARY_TAG` / `isStubbed`）：到这一步消息已经是
 * 纯 canonical `Message`，`state='unloaded'` 那类库里的标记跟着 store 留在
 * session 层，跨不过来。`isStubbed` 那边同样是按文本判的，两处口径一致。
 */
export function regionSizes(
  request: Request,
  floor?: ReadonlySet<Message>,
  /** live 消息 → stepId。装配是引用传递（floorSet 已依赖此事实），
   * 所以 request 里的 live 消息能查到归属。摘要不用进这张表——
   * covers 直接写在渲染首行 `step=from-to`，按文本解析（同冷温热判据） */
  stepIds?: ReadonlyMap<Message, number>,
): RegionSizes & { ranges: RegionRanges } {
  const sizes: RegionSizes = {
    overhead: overheadTokens(request),
    cold: 0,
    warm: 0,
    hot: 0,
    stub: 0,
    floor: 0,
    live: 0,
  }
  const ranges: RegionRanges = {
    cold: null,
    warm: null,
    hot: null,
    stub: null,
    floor: null,
    live: null,
  }
  /** [from,to] 并进所属区的范围槽 */
  const mergeRange = (key: keyof RegionRanges, from: number, to: number) => {
    const cur = ranges[key]
    ranges[key] = cur ? { from: Math.min(cur.from, from), to: Math.max(cur.to, to) } : { from, to }
  }
  for (const message of request.messages) {
    const tokens = message.parts.reduce((sum, part) => sum + estimateTokens(part), 0)
    if (isSummary(message)) {
      // 冷温热按渲染形态判，判据严格对齐 assemble.ts 的 renderSummary/foldPaths
      // （教训 summary-tier-judge-by-render-form：判据与渲染分家就重蹈覆辙）。
      // 「（共 N 个）」只会出现在内部节点详情行；热区正文以四段标题开头，
      // clampBody 截断不动开头
      const summary = summaryText(message)
      // 渲染首行 `<历史摘要> step=8-20>` 是唯一的 covers 来源（assemble 的
      // toMessage 不带 id）——解析失败就不给范围，宁缺毋猜
      const m = new RegExp(`^${SUMMARY_TAG} step=(\\d+)-(\\d+)>`).exec(summary)
      if (/（共 \d+ 个）/.test(summary)) {
        sizes.cold += tokens
        if (m) mergeRange('cold', Number(m[1]), Number(m[2]))
      } else if (/^## /m.test(summary)) {
        sizes.hot += tokens
        if (m) mergeRange('hot', Number(m[1]), Number(m[2]))
      } else {
        sizes.warm += tokens
        if (m) mergeRange('warm', Number(m[1]), Number(m[2]))
      }
    }
    else {
      const stepId = stepIds?.get(message)
      if (message.parts.some(isStubPart)) {
        sizes.stub += tokens
        if (stepId !== undefined) mergeRange('stub', stepId, stepId)
      } else if (floor?.has(message)) {
        sizes.floor += tokens
        if (stepId !== undefined) mergeRange('floor', stepId, stepId)
      } else {
        sizes.live += tokens
        if (stepId !== undefined) mergeRange('live', stepId, stepId)
      }
    }
  }
  return { ...sizes, ranges }
}

const isSummary = (message: Message): boolean =>
  message.parts[0]?.type === 'text' && message.parts[0].text.startsWith(SUMMARY_TAG)

const summaryText = (message: Message): string =>
  message.parts[0]?.type === 'text' ? message.parts[0].text : ''

/**
 * 一条消息只要有一个 part 被裁过就整条算进 ③。
 *
 * 不按 part 分摊：存根消息里没被裁的那几个 part（`tool_call.name`、配对用的
 * id）本来就是为了让被裁的那部分还能读懂而留着的，摊到 ④ 去会让「卸载省下
 * 多少」看起来比实际好。宁可让 ③ 偏大一点——它本来就是被怀疑没起作用的那个区
 * （§13.4 ③），高估不会让人误以为它有效。
 */
function isStubPart(part: Part): boolean {
  if (part.type === 'tool_result') return isStubbed(part.output)
  if (part.type !== 'tool_call') return false
  const command = (part.input as { command?: unknown } | null)?.command
  return typeof command === 'string' && isStubbed(command)
}

/**
 * 工具定义走 `tool_call` 这个分支不是取巧：它们序列化出去就是密集 JSON，
 * 而那个分支正好是「按 2 字符/token 算」的那一个（见 tokens.ts 的
 * `JSON_CHARS_PER_TOKEN`）。按 4 算会低估一半，而 `reservedTokens` 的默认值
 * 本来就是拍的，用一个已知偏低的数去验它等于白验。
 */
const overheadTokens = (request: Request): number =>
  estimateTokens({ type: 'text', text: request.system }) +
  estimateTokens({ type: 'tool_call', id: '', name: '', input: request.tools })
