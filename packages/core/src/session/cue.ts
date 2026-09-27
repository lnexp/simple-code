/**
 * recall 线索层引擎（docs/proposals/recall.md §3）。纯函数：切词、
 * 按频率×半衰期给词打分、对候选头部做 TF-IDF 匹配。落库/装配渲染在
 * store.ts 与 assemble.ts，session.ts 只做接线。
 *
 * ## 为什么是公式不是手调规则
 *
 * 多通道分层（专名/症状/主题三路 + 字数阈值）是被这个公式取代的
 * （proposal §8）：idf 自动把「到处都有的词」贬值——「压缩」出现在 300 条
 * 摘要头里 idf≈0.3，独一份的报错原文 idf≈4.4——不需要预先猜哪些词是
 * 噪声，库变了词表变了公式不用改。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { EVENTS_INDEX_LIMIT, loadEvents } from '../tools/events.ts'
import { lessonsDir, parseLessonFrontMatter } from '../tools/lesson.ts'
import { listNoteCards, NOTES_INDEX_LIMIT } from '../tools/note.ts'
import { listSkills } from '../tools/skill.ts'
import { CUE_STOPWORDS } from './cue-stopwords.ts'
import type { Summary } from '../loop/assemble.ts'

/** 候选头部一行：kind 标来源，name 是去重键（read/search 的入口名） */
export type CueCandidate = { kind: string; name: string; text: string }

/**
 * 切词。中文 bigram（与 search-index 的 toFtsText 同款滑动窗——stride 必须
 * 重叠，不重叠会漏「载机」这种跨界词）；ASCII 按驼峰/非字母切（bridgeTask
 * → bridge/task），小写化，<2 的碎片丢弃。纯 Han+ASCII：语料就是这两种。
 */
export function cueTokens(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[A-Za-z]+|\p{Script=Han}+/gu)) {
    const run = m[0]
    if (/\p{Script=Han}/u.test(run)) {
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
      if (run.length === 1) out.push(run)
    } else {
      for (const w of run.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/))
        if (w.length >= 2) out.push(w)
    }
  }
  return out
}

/** 词分：Σ 每次出现 2^(-轮龄/半衰期)。轮龄按**位置**数（最旧=0），不按
 *  turn id 相减——fork 跳号会把 5 轮虚报成 1 万轮（proposal §4 坑①）。
 *  每轮每词只计一次（presence）：一条 grep 结果里出现 50 次的词不该压过
 *  五轮各碰一次的词——频率指「多少轮在碰」，不是「单轮里多密」 */
export function wordScores(turnTexts: string[], halfLife: number): Map<string, number> {
  const out = new Map<string, number>()
  turnTexts.forEach((text, i) => {
    const age = turnTexts.length - 1 - i
    const w = 2 ** (-age / halfLife)
    // 停用词只在查询侧滤（cue-stopwords.ts 头注）：不进 scores 就不进
    // 贡献，候选侧语料照旧——recall 规格「只加查询侧」铁律
    for (const tok of new Set(cueTokens(text)))
      if (!CUE_STOPWORDS.has(tok)) out.set(tok, (out.get(tok) ?? 0) + w)
  })
  return out
}

/**
 * 打分并产出 top-K 线索行。返回 names 给短窗去重（同一记忆连轮重撞 =
 * 狼来了放大器：线索行常驻到该轮卸载，重复行每轮都占注意力）。
 */
export function buildCues(
  candidates: CueCandidate[],
  turnTexts: string[],
  opts: { halfLife: number; topK: number; excludeNames?: ReadonlySet<string> },
): { lines: string[]; names: string[] } {
  const scores = wordScores(turnTexts, opts.halfLife)
  if (scores.size === 0 || candidates.length === 0) return { lines: [], names: [] }
  // idf：出现在越多候选里越不值钱。df=全部时 ln(1)=0，全自动压掉
  const total = candidates.length
  const docFreq = new Map<string, number>()
  for (const c of candidates) {
    const seen = new Set(cueTokens(c.text))
    for (const tok of seen) docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1)
  }
  const ranked = candidates
    .filter((c) => !opts.excludeNames?.has(c.name))
    .map((c) => {
      // 顺手留 top 贡献词——线索行带命中词，认出靠它（报碰撞给证据）
      const contrib = [...new Set(cueTokens(c.text))]
        .map((tok) => ({ tok, v: (scores.get(tok) ?? 0) * Math.log((total + 1) / ((docFreq.get(tok) ?? 0) + 1)) }))
        .filter((x) => x.v > 0)
        .sort((a, b) => b.v - a.v || a.tok.localeCompare(b.tok))
      return { c, score: contrib.reduce((s, x) => s + x.v, 0), hits: contrib.slice(0, 3).map((x) => x.tok) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .slice(0, opts.topK)
  return {
    lines: ranked.map((x) => `〔recall〕${x.c.kind} ${clip(x.c.name, 40)} — ${clip(x.c.text.replace(/\s+/g, ' ').trim(), 70)}（命中: ${x.hits.join(', ')}）`),
    names: ranked.map((x) => x.c.name),
  }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * 五库候选头部（proposal §2）。明区不进：note 索引前 20 条、event 索引前
 * 30 条已在 system prompt 常驻，撞它们是重复劳动；lesson 的名字常驻但
 * symptom/description 是暗的，全进。skill 无常驻索引，全进。memory 的
 * 头部 = 不在场（in_context=0）的 summary 行——在场行本来就渲染在摘要区。
 */
export function loadCueCandidates(root: string, summaries: Summary[]): CueCandidate[] {
  const out: CueCandidate[] = []
  for (const c of listNoteCards(root).slice(NOTES_INDEX_LIMIT))
    out.push({ kind: 'note', name: c.name, text: `${c.name} ${c.description ?? ''}` })
  for (const c of loadEvents(root).slice(EVENTS_INDEX_LIMIT))
    out.push({ kind: 'event', name: c.name, text: `${c.name} ${c.description}` })
  // lesson 走 listLessons 的内部读法（readdir + front matter），不走它的
  // 成品字符串——那是给人看的，解析它等于把 UI 格式当 API
  const lessons = lessonsDir(root)
  if (existsSync(lessons))
    for (const f of readdirSync(lessons).filter((x) => x.endsWith('.md')).sort()) {
      const name = f.replace('.md', '')
      const fm = parseLessonFrontMatter(readFileSync(join(lessons, f), 'utf8'))
      out.push({ kind: 'lesson', name, text: `${name} ${fm.description ?? ''}` })
    }
  for (const line of listSkills(root)) {
    if (line.startsWith('没有已装的 skill')) continue
    const name = line.trim().split(/\s+/)[0]
    if (!name) continue
    out.push({ kind: 'skill', name, text: line })
  }
  for (const s of summaries)
    if (!s.inContext) out.push({ kind: 'summary', name: `t${s.coversFrom}`, text: `${s.name} ${s.head ?? ''}` })
  return out
}

/** store 侧加载 turns 文本用：一条消息的可检索文本段（与 memory search 同源） */
export { searchable } from '../tools/memory.ts'
