/**
 * 索引行的长度上限（2026-09-29 拍板，note summary-line-cap-400）。
 *
 * **所有层同一个上限**：L0 的描述、L1…LN 的合并产物，都是冷/温区里的「一行
 * 目录」（summaries.text）。层越高覆盖越长，字数却不涨——每合并一次，10 条
 * 最多 4000 字压成 ≤400 字，信息必然越合越少。热区正文（叶子 md，assemble
 * 的 BODY_MAX_CHARS）是另一档分辨率，不归这里管。
 *
 * 起因：9-28 跨层兜底合并时，摘要模型（deepseek-v4-flash）对「把半个月写成
 * 一行」的指令两极摆动——L4–L7 听话写一行（输出/输入 6%–16%），L8/L9 干脆
 * 逐条照抄（89%/96%，L9 6984 字 45 行）。提示词管不住，所以代码兜底：
 *
 *   超长 → 把字数告诉模型重写一次 → 还超 → 按行/按「·」截断，**一定落库**
 *
 * 最后一步不判失败：判失败 = 这组永远合不上 = 索引永远降不下来，比截掉尾巴
 * 几个关键词糟得多（截掉的东西下层叶子里都还在）。
 */
import type { Summary } from './assemble.ts'

export const INDEX_LINE_MAX_CHARS = 400

/**
 * 截到上限以内。优先在最后一个换行处断（多行时丢整行主题，不留半行），
 * 单行时在最后一个词/句边界处断：「·」（丢整个关键词，· 本身不留）或
 * 「。；！？」（丢整句，标点留着），取两类里靠后的那个；都找不到才硬切。
 * 句号类是给 L0 描述用的——那是散文不是关键词目录，只认「·」会一路退到
 * 硬切，切在半个词上（2026-09-29 真库 77424：结尾「C 观」）
 */
export function clampIndexLine(text: string, max = INDEX_LINE_MAX_CHARS): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) return cut.slice(0, nl).trimEnd()
  const dot = cut.lastIndexOf('·')
  const stop = Math.max(...[...'。；！？'].map((mark) => cut.lastIndexOf(mark)))
  if (stop > 0 && stop > dot) return cut.slice(0, stop + 1)
  if (dot > 0) return cut.slice(0, dot).trimEnd()
  return cut
}

/** 重写请求里追加的那句话：给出实际字数，模型才知道要砍多少 */
export function capFeedback(length: number, max = INDEX_LINE_MAX_CHARS): string {
  return (
    `你写了 ${length} 字，超过 ${max} 字的上限。重写一遍，总长不超过 ${max} 字：` +
    '主题相近的并成一行，次要的关键词删掉，不要逐条照抄输入。只输出结果。'
  )
}

/**
 * 超长时重写一次，再兜底截断。重写结果不比原来短（模型又抄了一遍）就用
 * 原来那份截——截谁都一样截，至少别多花一次的结果还更差。
 * 重写抛错（网络等）同样退回截断：上限是硬约束，重试只是争取更好的内容
 */
export async function fitIndexLine(
  text: string,
  rewrite: (feedback: string) => Promise<string>,
  max = INDEX_LINE_MAX_CHARS,
): Promise<string> {
  if (text.length <= max) return text
  const again = await rewrite(capFeedback(text.length, max)).catch(() => '')
  const better = again !== '' && again.length < text.length ? again : text
  return clampIndexLine(better, max)
}

/**
 * 稳态索引里超长的内部节点——装机前合出来的（L9 那种），要单条重写一次。
 * 只挑 L1+：L0 的描述在生成时就过了上限；老库里超长的 L0 是早期格式的
 * 遗留（2096 条里 11 条），且 L0 带叶子正文，重写它牵扯热区，不值当
 */
export function oversizedNodes(index: Summary[], max = INDEX_LINE_MAX_CHARS): Summary[] {
  return index.filter((s) => s.level >= 1 && s.text.length > max)
}
