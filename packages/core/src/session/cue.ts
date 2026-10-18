/**
 * recall 线索层引擎（docs/proposals/recall.md §3）。纯函数：拿选择器
 * （selector.ts）产出的关键词对摘要头部做子串匹配。落库/装配渲染在
 * store.ts 与 assemble.ts，session.ts 只做接线。
 *
 * ## 词面 n-gram 引擎的退役（2026-10-14）
 *
 * 原引擎（切词 + 频率×半衰期 + TF-IDF/BM25）五条救噪路全部试到头（分词
 * 器 jieba A/B、停用词、多词共现、词稀有度门槛、显著性门槛——见 note
 * recall-cue-noise-idf-bm25），~70% 命中仍是泛词噪声：查询侧是原始窗口
 * 文本，type/在的/之后 这类背景词压不干净。改由模型出关键词（262 轮同台
 * A/B：关键词法 19 胜 2 负 vs cue，工作流短消息「push了，你来构建发布验
 * 证」稳定命中同流程历史段）——查询侧从背景噪声变成任务意图，噪声源头
 * 消失。关键词与选择共用 selector 的一次副模型调用，零新增请求。
 */
import type { Summary } from '../loop/assemble.ts'

/** 候选头部一行：kind 标来源，name 是去重键（read/search 的入口名） */
export type CueCandidate = { kind: string; name: string; text: string }

/**
 * 关键词匹配：子串包含（大小写不敏感）。命中数多的排前，平手按名字序
 * （确定性——同一输入两次装配字节一致是 prefix-guard 的前提）。names 返回
 * 给去重（同一摘要连轮重撞 = 狼来了放大器：线索行常驻到该轮卸载，重复
 * 行每轮都占注意力）。行带命中词——认出靠它（报碰撞给证据）。
 */
export function matchSummaries(
  candidates: CueCandidate[],
  keywords: string[],
  opts: { topK: number; excludeNames?: ReadonlySet<string> },
): { lines: string[]; names: string[] } {
  if (keywords.length === 0 || candidates.length === 0) return { lines: [], names: [] }
  const kws = keywords.map((k) => k.toLowerCase())
  const ranked = candidates
    .filter((c) => !opts.excludeNames?.has(c.name))
    .map((c) => {
      const text = c.text.replace(/\s+/g, ' ').trim()
      const low = text.toLowerCase()
      const hits = kws.filter((k) => low.includes(k))
      return { c, text, hits }
    })
    .filter((x) => x.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length || a.c.name.localeCompare(b.c.name))
    .slice(0, opts.topK)
  return {
    lines: ranked.map((x) => `〔recall·async〕${x.c.kind} ${clip(x.c.name, 40)} — ${clip(x.text, 70)}（命中: ${x.hits.join(', ')}）`),
    names: ranked.map((x) => x.c.name),
  }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/**
 * 候选 = 不在场（in_context=0）的 summary 头部——在场行本来就渲染在摘要区。
 *
 * 只剩 summary（2026-10-12，recall-llm-selector.md §2 拍板的分家）：lesson/
 * note/skill/event 的索引行交给副模型选择器（selector.ts）。摘要头是自然语言
 * 对自然语言，关键词子串匹配正合适
 */
export function loadCueCandidates(summaries: Summary[], liveFloor: number | null): CueCandidate[] {
  const out: CueCandidate[] = []
  // 名字 2026-09-30 前是 t<covers_from step id>，之后是 t<turn>（跨 turn 写
  // t<起>-<止>）：与摘要首行 turn= 同口径，拿去 memory show 就能用
  // 只收 L0（2026-09-30 起）：内部节点 name 空、head 取自首成员，候选文本
  // 是首成员的子集——两条一起撞中、名字不同去重拦不住，白占一个线索位
  // 覆盖到在场原文（coversTo ≥ liveFloor）的不进：近几轮的 L0 早写好、还没
  // 进场所以 in_context=0，原文却就在上下文里——撞中 100% 重复，且近轮与当前
  // 用词最像、专抢名额（2026-10-12 t16867/t16868 实例）
  for (const s of summaries)
    if (!s.inContext && s.level === 0 && (liveFloor === null || s.coversTo < liveFloor)) {
      const t = s.turnFrom === s.turnTo ? `${s.turnFrom ?? '?'}` : `${s.turnFrom ?? '?'}-${s.turnTo ?? '?'}`
      out.push({ kind: 'summary', name: `t${t}`, text: `${s.name} ${s.head ?? ''}` })
    }
  return out
}

/** store 侧加载 turns 文本用：一条消息的可检索文本段（与 memory search 同源） */
export { searchable } from '../tools/memory.ts'
