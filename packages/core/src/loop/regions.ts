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

const REGION_KEYS = ['overhead', 'cold', 'warm', 'hot', 'stub', 'floor', 'live'] as const

/** 七个区之和 = 这份请求的估算输入（输出预留不算）。面板 ctx-panel 的 estimateOf 同口径 */
export const regionsEstimate = (sizes: Partial<Record<keyof RegionSizes, unknown>>): number =>
  REGION_KEYS.reduce((sum, key) => {
    const v = sizes[key]
    return sum + (typeof v === 'number' ? v : 0)
  }, 0)

/**
 * 估算 → 真实的换算系数 = 真实 usage ÷ 估算（2026-09-29 用户拍板：各家模型
 * 切分不同，估算器怎么调都校不准，额度按 usage 校）。压缩的三道额度
 * （保底/存根区/索引）配的是**真实** token，量的却是估算——除以这个系数
 * 才是同一把尺子。实测两个方向都有：opus 中位 1.25（估小了→额度收紧），
 * glm-5.3 中位 0.82–0.86（估大了→放宽），全体 0.78–1.36。
 *
 * 夹在 [0.5, 2]：挡的是渠道报错的 usage（9-28 某渠道实约 10.2 万报
 * 222,924），一次坏数不至于把额度砍掉大半。拿不到 usage 返回 null——调用方
 * 沿用上一个系数
 */
export function usageRatio(estimate: number, real: unknown): number | null {
  if (typeof real !== 'number' || real <= 0 || estimate <= 0) return null
  return Math.min(2, Math.max(0.5, real / estimate))
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
): RegionSizes {
  const sizes: RegionSizes = {
    overhead: overheadTokens(request),
    cold: 0,
    warm: 0,
    hot: 0,
    stub: 0,
    floor: 0,
    live: 0,
  }
  for (const message of request.messages) {
    const tokens = message.parts.reduce((sum, part) => sum + estimateTokens(part), 0)
    if (isSummary(message)) {
      // 冷温热按渲染形态判，判据严格对齐 assemble.ts 的 renderSummary/foldPaths
      // （教训 summary-tier-judge-by-render-form：判据与渲染分家就重蹈覆辙）。
      // 「（共 N 个）」只会出现在内部节点详情行；热区正文以四段标题开头，
      // clampBody 截断不动开头
      const summary = summaryText(message)
      if (/（共 \d+ 个）/.test(summary)) sizes.cold += tokens
      else if (/^## /m.test(summary)) sizes.hot += tokens
      else sizes.warm += tokens
    } else if (message.parts.some(isStubPart)) sizes.stub += tokens
    else if (floor?.has(message)) sizes.floor += tokens
    else sizes.live += tokens
  }
  return sizes
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
