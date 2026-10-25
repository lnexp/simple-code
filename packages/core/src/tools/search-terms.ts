/** search query 切词与多词命中——四库 search 共用。
 *
 * 语义与 memory search 的「多个候选词用 OR」一致：空白分隔，「 OR 」是候选组
 * 分隔符。此前 note/lesson/skill/event 的 search 是整串 indexOf，agent 把
 * memory 的 OR 用法迁移过来会静默 0 命中（2026-10-19 实测 23 次全落空），
 * 意图式查询也接不住——统一为：任一词命中即候选，命中词数多的排前。 */

/** 切词：小写、去重、去掉「 OR 」分隔符。空 query 返回空表 */
export function splitSearchTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.split(/\s+/)) {
    if (raw === 'OR') continue
    const t = raw.toLowerCase()
    if (t) seen.add(t)
  }
  return [...seen]
}

/** 多词命中信息：命中词数 + 第一个命中词的位置。未命中返回 null */
export interface TermMatch {
  count: number
  at: number
}

export function matchTerms(text: string, terms: string[]): TermMatch | null {
  const lower = text.toLowerCase()
  let count = 0
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i === -1) continue
    count++
    if (at === -1 || i < at) at = i
  }
  return count === 0 ? null : { count, at }
}
