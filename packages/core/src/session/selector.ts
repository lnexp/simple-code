/**
 * recall 选择器（docs/proposals/recall-llm-selector.md）：把 lesson/note/
 * skill/event 的索引行和本轮交互交给副模型，让它挑「动手前该先读」的几条。
 * 纯函数 + 读文件；发请求、落库、注入时机在 session.ts / run.ts。
 *
 * ## 为什么不是 n-gram
 *
 * 索引行的词面是机制词（envPassthrough/白名单/成对改），用户问的是口语
 * （「exaApiKey 能用环境变量吗」）——零碰撞（t16757）。这是词面漂移，
 * idf/BM25 调不掉；读得懂语义的选择器才接得住。n-gram 继续管 summary 头
 * （cue.ts），两通道分家不抢名额。
 *
 * ## 选择器可以答「无」
 *
 * 这比「选得准」更重要：大多数轮本就不该浮出任何经验，n-gram 被迫填满
 * K 个名额的噪声（狼来了）从根上没了。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Message, Request } from '../llm/types.ts'
import { loadEvents } from '../tools/events.ts'
import { lessonsDir, parseLessonFrontMatter } from '../tools/lesson.ts'
import { activeNoteCards } from '../tools/note.ts'
import { listSkills } from '../tools/skill.ts'

export type SelectorCandidate = { kind: 'lesson' | 'note' | 'skill' | 'event'; name: string; text: string }

/** 每轮最多浮出几条。可以是 0 */
export const SELECTOR_TOP_K = 3
/** 上一条 assistant 回复取末尾多少字（拍板①：动手轮的用户消息常是「可以，开始吧」） */
export const SELECTOR_CONTEXT_CHARS = 1500

const textOf = (m: Message): string =>
  m.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('\n')
    .trim()

/**
 * 上一轮的收尾回复 = **最后一条有文字的** assistant（拍板①：方案名词在它
 * 里面）。不能只取最后一条 assistant：被打断的轮以纯 tool_call 收尾，取到
 * 空串——10-12 历史评测 t16629「这次我执行了」、t16646「你来帮我配置」
 * 因此只剩一句话可看，两轮都漏选
 */
export function previousReply(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'assistant' && textOf(m) !== '') return textOf(m)
  }
  return ''
}

const READ_CMD = /\$\{?SIMPLE_CODE_(LESSON|NOTE|SKILL|EVENT)\}?"?\s+read\s+([^\s;|&'"]+)/g

/**
 * 在场消息里 bash 已经 read 过的条目（kind:name）——正文就在上下文里，
 * 再注入一次只是重复（2026-10-12：同 3 条 recall note 连续 4 轮注入）
 */
export function readInContext(messages: Message[]): Set<string> {
  const out = new Set<string>()
  for (const m of messages)
    for (const p of m.parts) {
      if (p.type !== 'tool_call' || p.name !== 'bash') continue
      const command = (p.input as { command?: unknown } | null)?.command
      if (typeof command !== 'string') continue
      for (const [, kind, name] of command.matchAll(READ_CMD)) out.add(`${kind!.toLowerCase()}:${name}`)
    }
  return out
}

/**
 * 四库全量，**常驻的也算**（2026-10-12 拍板②）：t16757 的教训名字本来就
 * 在常驻清单里，没被查是因为列着没人看——动手时刻点名提醒，常驻行同样有用。
 * 作废的 note 不进：选中它等于把被推翻的结论递回来
 *
 * 每类内按**诞生时间旧→新**：新条目落在本节末尾，前面的字节不动（副模型
 * 前缀缓存）。不用 note 的 LRU / event 的 updated 序——读一次就挪位置
 */
export function loadSelectorCandidates(root: string): SelectorCandidate[] {
  const out: SelectorCandidate[] = []
  // lesson 走内部读法（readdir + front matter），不走 listLessons 的成品
  // 字符串——那是给人看的，解析它等于把 UI 格式当 API
  const lessons = lessonsDir(root)
  if (existsSync(lessons))
    for (const f of readdirSync(lessons)
      .filter((x) => x.endsWith('.md'))
      .map((x) => ({ x, born: statSync(join(lessons, x)).birthtimeMs }))
      .sort((a, b) => a.born - b.born || a.x.localeCompare(b.x))
      .map((y) => y.x)) {
      const name = f.replace('.md', '')
      const fm = parseLessonFrontMatter(readFileSync(join(lessons, f), 'utf8'))
      out.push({ kind: 'lesson', name, text: fm.description ?? '' })
    }
  const byCreated = (a: { name: string; created?: string | undefined }, b: { name: string; created?: string | undefined }) =>
    (a.created ?? '').localeCompare(b.created ?? '') || a.name.localeCompare(b.name)
  for (const c of activeNoteCards(root)
    .map((n) => ({ ...n, created: n.meta.created }))
    .sort(byCreated))
    out.push({ kind: 'note', name: c.name, text: c.description ?? '' })
  for (const line of listSkills(root)) {
    // 只认「name  [项目|用户]  描述」行（与 searchSkills 同判据）：空库提示
    // 和尾行「可选组件（未随包）…」不是 skill——曾被拆成名为
    // 「可选组件（未随包）：agent-browser」的候选
    const m = line.match(/^(\S+) {2}\[(?:项目|用户)\] {2}(.*)$/)
    if (m) out.push({ kind: 'skill', name: m[1]!, text: m[2]! })
  }
  for (const c of loadEvents(root).sort(byCreated)) out.push({ kind: 'event', name: c.name, text: c.description })
  return out
}

const SELECTOR_SYSTEM = `你是经验库的检索选择器。第一条消息是经验库索引，分四节：
- 【lesson 教训】每行「名字 — 描述」：踩过的坑
- 【note 结论】每行「名字 — 描述」：拍板过的决策和事实
- 【skill 技能】每行只有名字：某类操作的做法手册
- 【event 事件档案】每行只有名字：之前某件事的经过
第二条消息是对话的最新交互（上一条助手回复的末尾 + 用户的新消息）。

任务：挑出与助手接下来要做的事可能相关的条目，最多 ${SELECTOR_TOP_K} 条。没有相关的就只输出一个字「无」。

输出格式：每行一个名字，从索引里原样照抄，不要类别、不要编号、不要解释。
最后再输出一行「关键词: k1, k2, ...」：3~6 个能检索历史摘要库的关键词——具体专名、报错原文、技术名词、任务名（中英文均可），不要「类型/内容/问题」这类到处都有的泛词。用户消息是短确认语（可以/继续/提交吧）时，从上一条回复提取当前任务的主题。完全没有具体工作内容就留空：关键词: 

两个任务独立：经验库没有相关的输出「无」也要给关键词；经验库有相关的也要给关键词。`

const SECTION_HEAD = { lesson: '【lesson 教训】', note: '【note 结论】', skill: '【skill 技能】', event: '【event 事件档案】' } as const

/**
 * 两条 user 消息：索引一条（跨轮稳定前缀，走副模型的 prompt cache）、交互
 * 一条（每轮只有它变）。索引分节，lesson/note 带描述，skill/event 只给名字
 * ——2026-10-12 同 30 轮评测：输入 38.7k→16.2k 字，skill 噪声消失
 * （notes/recall-llm-selector-pending）
 */
export function buildSelectorRequest(
  candidates: SelectorCandidate[],
  query: { user: string; previous: string },
  base: Omit<Request, 'messages' | 'system' | 'tools'>,
): Request {
  const index = (['lesson', 'note', 'skill', 'event'] as const)
    .map((kind) => {
      const lines = candidates
        .filter((c) => c.kind === kind)
        .map((c) => (kind === 'lesson' || kind === 'note' ? `${c.name} — ${c.text.replace(/\s+/g, ' ').trim()}` : c.name))
      return lines.length === 0 ? '' : `${SECTION_HEAD[kind]}\n${lines.join('\n')}`
    })
    .filter(Boolean)
    .join('\n\n')
  const previous =
    query.previous.length > SELECTOR_CONTEXT_CHARS ? `…${query.previous.slice(-SELECTOR_CONTEXT_CHARS)}` : query.previous
  const turn = [previous ? `【上一条助手回复（末尾）】\n${previous}` : '', `【用户新消息】\n${query.user}`]
    .filter(Boolean)
    .join('\n\n')
  return {
    ...base,
    system: SELECTOR_SYSTEM,
    tools: [],
    thinking: 'disabled',
    messages: [index, turn].map((text) => ({ role: 'user' as const, parts: [{ type: 'text' as const, text }] })),
  }
}

/**
 * 模型返回 → 候选。只认索引里真有的名字（编造的丢掉），按出现顺序去重、
 * 截到 K 条。模型不总是听话：容忍列表符号/编号/反引号和顺手带上的类别词，
 * 不容忍改写名字——名字是 read 的入口，错一个字就读不到
 */
export function parseSelection(raw: string, candidates: SelectorCandidate[]): SelectorCandidate[] {
  const out: SelectorCandidate[] = []
  for (const line of raw.split('\n')) {
    const words = line
      .replace(/[`*]/g, ' ')
      .replace(/^\s*(?:[-•]|\d+[.、)])\s*/, '')
      .trim()
      .split(/\s+/)
    const kindWord = words.find((w) => w === 'lesson' || w === 'note' || w === 'skill' || w === 'event')
    for (const word of words) {
      const hit =
        candidates.find((c) => c.name === word && c.kind === kindWord) ?? candidates.find((c) => c.name === word)
      if (hit && !out.includes(hit)) out.push(hit)
    }
  }
  return out.slice(0, SELECTOR_TOP_K)
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/** 成品行。标记与 n-gram 的〔recall〕区分：模型要知道这是轮内后到的、另一种来源 */
export function renderSelection(picked: SelectorCandidate[]): string[] {
  return picked.map((c) => `〔recall·async〕${c.kind} ${c.name} — ${clip(c.text.replace(/\s+/g, ' ').trim(), 80)}`)
}

/** 解析「关键词:」行。body 是剥掉该行后的剩余——关键词可能恰好等于某个
 *  索引名字（如 PrefixBrokenError），不剥掉会混进 parseSelection 被当成选择 */
const KEYWORD_LINE = /^[ \t>*-]*(?:\*\*)?(?:关键词|keywords?)(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/im
export function parseKeywords(raw: string): { body: string; keywords: string[] } {
  const m = raw.match(KEYWORD_LINE)
  if (m === null) return { body: raw, keywords: [] }
  const keywords = m[1]!
    .split(/[,，、;；]+/)
    .map((k) => k.trim().replace(/[。."'，]+$/, ''))
    .filter((k) => k.length >= 2 && k.length <= 40)
  return { body: raw.replace(m[0], ''), keywords: [...new Set(keywords)].slice(0, 8) }
}
