/**
 * 事件档案的存储层（v3 可控式）：`.simple-code/events/` 一事一文件，
 * front matter + H1 + 「## 进展」时间序。
 *
 * 与 notes 的分工：notes 是 agent **主动**写的结论记忆；events 是机制产出
 * 的**活跃战役状态板**——归档由「单次归类判断 + 原子落盘」完成（loop/
 * archiver.ts），模型只产判断（归到哪/一句话进展/可选新描述），写盘全部
 * 走本模块三个原语：createEvent / appendProgress / updateDescription。
 *
 * 为什么在 `.simple-code/` 顶层不在 memory/ 下：memory 装的是上下文机制的
 * 内部状态（会降级/重建/衰减），events 是资产（只增改、跨 session 永续）。
 *
 * 格式双保险：首行 `# name — description`、进展固定节标题——本模块
 * 挂了，裸 grep/head 一条命令也能用。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { localStamp } from './timestamp.ts'

export const eventsDir = (root: string) => join(root, '.simple-code', 'events')

const slug = (name: string) =>
  name.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-\u4e00-\u9fff]/g, '')

export type EventCard = {
  name: string
  /** 一行描述：bin 清单与人工定位用；system prompt 索引只进名称（提案 §6） */
  description: string
  created?: string
  updated?: string
}

/** 手写解析 yaml 头 + 固定节（与 note 的 front matter 同款思路，不引库） */
export function parseEventMeta(text: string): EventCard {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  const out: EventCard = { name: '', description: '' }
  if (!m) {
    // 无 front matter 的残档（手改坏/外部写入）：从首行标题兜底，至少可列出
    // 分隔符要求前后有空白——不然 orphan-event 的连字符被当分隔符吃掉
    const h = text.match(/^#\s+(.+?)\s+[—-]\s+(.*)$/m)
    if (h?.[1]) {
      out.name = h[1].trim()
      out.description = (h[2] ?? '').trim()
    }
    return out
  }
  for (const line of m[1]?.split('\n') ?? []) {
    const name = line.match(/^name:\s*(.+)$/)
    if (name?.[1]) out.name = name[1].trim()
    const desc = line.match(/^description:\s*(.*)$/)
    if (desc?.[1]) out.description = desc[1].trim()
    const created = line.match(/^created:\s*(.+)$/)
    if (created?.[1]) out.created = created[1].trim()
    const updated = line.match(/^updated:\s*(.+)$/)
    if (updated?.[1]) out.updated = updated[1].trim()
  }
  return out
}

/** `## 进展` 等二级节抽取。节缺失返回 undefined（存量旧档的节名不限于进展） */
export function eventSection(text: string, section: string): string | undefined {
  const m = text.match(new RegExp(`^## ${section}\\s*\\n([\\s\\S]*?)(?=^## |\\s*$)`, 'm'))
  return m?.[1]?.trim() === '' ? undefined : m?.[1]?.trim()
}

export function loadEvents(root: string): EventCard[] {
  let files: string[]
  try {
    files = readdirSync(eventsDir(root)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files
    .map((f) => {
      const text = readFileSync(join(eventsDir(root), f), 'utf8')
      const meta = parseEventMeta(text)
      return { ...meta, name: meta.name || f.replace(/\.md$/, '') }
    })
    .sort((a, b) => (b.updated ?? b.created ?? '').localeCompare(a.updated ?? a.created ?? ''))
}

/** bin 的 list：一行式 `name — description`（system prompt 索引只用名称，那边自己拼） */
export function listEvents(root: string): string {
  const cards = loadEvents(root)
  if (cards.length === 0) return '（events 目录为空或不存在——尚无归档）'
  return cards.map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
}

/** 进 system 索引的最大条数。名称一行约 10 token，30 条封顶 ≈ 300 token
 *  常驻（与 notes 的 NOTES_INDEX_LIMIT 同一量级心智） */
export const EVENTS_INDEX_LIMIT = 30


export function searchEvents(root: string, keyword: string): string {
  const kw = keyword.trim()
  if (kw === '') return '用法：event search <关键词>（匹配 name/description；更细的词 read 全文）'
  const hits = loadEvents(root).filter((c) => {
    const hay = `${c.name} ${c.description}`.toLowerCase()
    return hay.includes(kw.toLowerCase())
  })
  if (hits.length === 0) return `没有命中「${kw}」的事件。list 看全量，或换关键词再试`
  return hits.map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n')
}

/** 全文或只看一段（--desc/--refs）。找不到时返回错误文案而非抛——bin 直出 */
export function readEvent(root: string, name: string, section?: 'desc'): string {
  const path = join(eventsDir(root), `${slug(name)}.md`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return `没有 ${slug(name)} 这个事件（文件不存在）。它可能已改名——rename 随战役演化更新 name（2026-09-17 拍板），"$SIMPLE_CODE_EVENT" list 看现名`
  }
  if (section === 'desc') {
    const meta = parseEventMeta(text)
    return `${meta.name}${meta.description ? ` — ${meta.description}` : ''}`
  }
  return text
}

/**
 * 三个写入原语（v3 可控式归档）：模型只产出判断，落盘全部由这里的代码
 * 完成——没有「整文件重写」路径，就没有重写事故（丢信息/塞旧文/格式漂移）。
 * 档案形态随之收窄：front matter + H1 + 「## 进展」时间序。正文大段不再
 * 由机制维护——过程细节在 turns/git，档案是活跃战役的状态板。
 */
export function createEvent(
  root: string,
  input: { name: string; description: string; firstProgress: string; stepRange?: string },
): string {
  const name = slug(input.name)
  if (!name) throw new Error('name 不能为空（kebab-case，如 lsp-bridge）')
  if (!input.description.trim()) throw new Error('description 不能为空（一行，人工定位的门面）')
  if (!input.firstProgress.trim()) throw new Error('首条进展不能为空（空档案没有意义）')
  const description = input.description.replace(/\s+/g, ' ').trim()
  const path = join(eventsDir(root), `${name}.md`)
  if (existsSync(path)) throw new Error(`${name} 已存在——延续它用 appendProgress，别新建`)
  const now = localStamp()
  const text =
    `---\nname: ${name}\ndescription: ${description}\n` +
    `created: ${now}\nupdated: ${now}\n---\n\n` +
    `# ${name} — ${description}\n\n## 进展\n\n${progressLine(root, input.firstProgress, input.stepRange)}\n`
  mkdirSync(eventsDir(root), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return `已新建 ${path}`
}

/** 进展行的「日期 · step」前缀由代码拼——模型只产那一句话，不带元数据 */
const progressLine = (_root: string, sentence: string, stepRange?: string): string => {
  const day = localStamp().slice(0, 10)
  const one = sentence.replace(/\s+/g, ' ').trim().replace(/^[-·*]\s*/, '')
  return `- ${day}${stepRange ? ` · step ${stepRange}` : ''} · ${one}`
}

/** 原子追加一条进展：找「## 进展」段的末尾插一行，其余内容一个字不碰。
 *  段头不存在（手写档）就自动补一个——少一个人工约定 */
export function appendProgress(
  root: string,
  name: string,
  sentence: string,
  stepRange?: string,
): string {
  const path = join(eventsDir(root), `${slug(name)}.md`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return `没有 ${slug(name)} 这个事件。list 看全量`
  }
  if (!sentence.trim()) return '进展内容为空，跳过'
  const line = progressLine(root, sentence, stepRange)
  const lines = text.split('\n')
  const headIdx = lines.findIndex((l) => /^##\s+进展\s*$/.test(l))
  if (headIdx === -1) {
    // 无段头：插在 H1 之后
    const h1 = lines.findIndex((l) => l.startsWith('# '))
    const at = h1 === -1 ? 0 : h1 + 1
    lines.splice(at, 0, '', '## 进展', '', line)
  } else {
    // 段尾 = 下一个二级段头之前，或文件尾
    let end = lines.length
    for (let i = headIdx + 1; i < lines.length; i++) {
      const l = lines[i]
      if (l !== undefined && /^##\s/.test(l)) { end = i; break }
    }
    // 倒着找最后一个非空行，插在它后面
    let insert = end
    const prev = () => lines[insert - 1]
    while (insert > headIdx + 1 && prev()?.trim() === '') insert--
    lines.splice(insert, 0, line)
  }
  const out = lines.join('\n').replace(/^updated:.*$/m, `updated: ${localStamp()}`)
  writeFileSync(path, out, 'utf8')
  return `已追加进展到 ${path}`
}

/** 描述更新只碰两处：front matter 的 description 行和 H1 行 */
export function updateDescription(root: string, name: string, description: string): string {
  const path = join(eventsDir(root), `${slug(name)}.md`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return `没有 ${slug(name)} 这个事件。list 看全量`
  }
  const desc = description.replace(/\s+/g, ' ').trim()
  if (!desc) return '描述为空，跳过'
  const out = text
    .replace(/^description:.*$/m, `description: ${desc}`)
    .replace(/^(# .+?) — .*$/m, `$1 — ${desc}`)
    .replace(/^updated:.*$/m, `updated: ${localStamp()}`)
  writeFileSync(path, out, 'utf8')
  return `已更新 ${slug(name)} 的描述`
}

/**
 * 改名原语（2026-09-17 拍板）：name 与战役实质矛盾时随演化更新。
 * 单一事实源——文件名、front matter 的 name、H1 三处一起改，索引/
 * 匹配锚点/read 入口永远一致。旧名引用的断裂由 read 的「可能已改名」
 * 提示兜底（代价可恢复，不加别名表机制）。updated 同步刷新（LRU 语义：
 * 改名即活跃）。
 */
export function renameEvent(root: string, oldName: string, newName: string): string {
  const dir = eventsDir(root)
  const from = join(dir, `${slug(oldName)}.md`)
  const to = join(dir, `${slug(newName)}.md`)
  let text: string
  try {
    text = readFileSync(from, 'utf8')
  } catch {
    return `没有 ${slug(oldName)} 这个事件。list 看全量`
  }
  if (slug(newName) === '') return '新名为空（slug 化后无字符），跳过'
  if (existsSync(to)) return `已存在 ${slug(newName)}，不覆盖——重名请换一个`
  const out = text
    .replace(/^name:.*$/m, `name: ${slug(newName)}`)
    .replace(/^updated:.*$/m, `updated: ${localStamp()}`)
  writeFileSync(to, out, 'utf8')
  rmSync(from)
  return `已改名 ${slug(oldName)} → ${slug(newName)}`
}

/**
 * system prompt 的**名称**索引：一行一条 name。设计意图（2026-09-17
 * 用户澄清）：索引只承担「有这么个事」的占位——具体什么事、进展到哪
 * 不进上下文，相关时再 read；name 的模糊/老化是接受的代价。条数 LRU
 * 封顶（loadEvents 已按 updated 降序）：与 notes 索引同一哲学——被挤出
 * 的只是常驻提醒，不是记忆（文件不删；archiver 分类器不受此限，老战役
 * 隔月回归仍 append 原档案）。
 */
export function readEventsIndex(root: string): string | null {
  const cards = loadEvents(root)
  if (cards.length === 0) return null
  const lines = cards.slice(0, EVENTS_INDEX_LIMIT).map((c) => `- ${c.name}`)
  if (cards.length > EVENTS_INDEX_LIMIT)
    lines.push(`- ……另有 ${cards.length - EVENTS_INDEX_LIMIT} 条较早事件（"$SIMPLE_CODE_EVENT" list 全量）`)
  return lines.join('\n')
}
