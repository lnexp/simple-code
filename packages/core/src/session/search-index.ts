/**
 * search 的 FTS5 倒排索引（turns 的 step 粒度）。
 *
 * 为什么：`runSearch` 老路径是全量读 turns/*.jsonl 逐 step 子串匹配——
 * turn 数线性涨耗时（306 turns 时 0.14s，10k turns 外推 4-5s，超过
 * 「随手就查」的耐心阈值）。FTS5 把「词 → step」预计算好，查询只翻表。
 *
 * 三层关系：jsonl/db 原文是本体永不动；本表是**从原文可推导**的加速结构，
 * 删了重灌即恢复——所以不参与任何一致性协议，落后了补一次就行。
 *
 * 中文分词：FTS5 自带 tokenizer 都不适合——unicode61 把连续汉字当一个
 * token（搜「卸载」命中不了「卸载机制」），trigram 要求 ≥3 字（「缓存」
 * 搜不到）。解法是经典 bigram 预处理：索引和查询两侧都用 `toFtsText`
 * 把 CJK 连续段切成两字词（「卸载机制」→「卸载 载机 机制」），查询侧
 * 再按 token 顺序组成 phrase——phrase 要求相邻，等价于原文含连续子串，
 * 语义与老的 indexOf 对齐。单字查询（「图」）用前缀匹配（`图*`）兜住。
 *
 * 游标：steps 表的行从不删除（DELETE 只打 messages），所以 last_step_id
 * 是安全的增量游标。宿主在 save 尾部同步；CLI（$SIMPLE_MEMORY search）
 * 只读查询——写路径只有宿主，没有 SQLITE_BUSY 的并发写问题。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseLines, searchable, splitSteps } from '../tools/memory.ts'
import { bucketedRel, resolveBucketFile } from './buckets.ts'
import type { Db } from './db.ts'

const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g
const IS_CJK = /^[\u3400-\u9fff\uf900-\ufaff]$/

/** 文本 → FTS token 串：CJK 段切 bigram，段与段之间保证有分隔（否则
 * unicode61 会把「webview缓存」当一个 token，字母和汉字的边界必须手切） */
export function toFtsText(text: string): string {
  return text.replace(CJK_RUN, (run) => {
    // 滑窗必须重叠（stride 1）：「卸载机制」→ 卸载/载机/机制，query 的
    // phrase 链才接得上。不重叠的 .{2} 分块会漏「载机」，短语查询直接断链
    const grams: string[] = []
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2))
    if (run.length === 1) grams.push(run)
    if (run.length % 2 === 1 && run.length > 1) grams.push(run[run.length - 1] as string)
    return ` ${grams.join(' ')} `
  })
}

/** query → FTS5 MATCH 表达式：空白分 term，term 内 token 组 phrase，
 * term 间 AND。顶层 ` OR `（大写）分组：组间 OR、组内 AND——猜词检索
 * 一次多试几个候选词（「越权 OR 误弹 OR 抢戏」，同一件事当时的用词
 * 不一定记得准）。AND 绑定比 OR 紧，无需括号。token 一律双引号包裹
 * （用户串里的引号先剥掉，防 MATCH 语法错）。返回 null = 查不出东西
 * （空串）。 */
export function matchExpr(query: string): string | null {
  // 先按大写 OR 切组再 toLowerCase——小写 or 保留为普通词，不误伤
  const groups = query.split(/\s+OR\s+/).filter(Boolean)
  const exprs = groups
    .map((group) => {
      const terms = group.toLowerCase().replace(/"/g, '').split(/\s+/).filter(Boolean)
      if (terms.length === 0) return null
      return terms
        .map((term) => {
          const toks = toFtsText(term)
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => (IS_CJK.test(t) ? `${t}*` : t))
          return `"${toks.join(' ')}"`
        })
        .join(' AND ')
    })
    .filter((e): e is string => e !== null)
  if (exprs.length === 0) return null
  return exprs.join(' OR ')
}

const META_LAST_STEP = 'last_step_id'

/** 增量同步：把 > 游标的新 step 聚合进 FTS。宿主 save 尾部调用。 */
export function syncSearchIndex(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS search_fts_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
  const last = Number(
    (
      db.all<{ v: string }>(`SELECT v FROM search_fts_meta WHERE k = ?`, META_LAST_STEP)[0] as
        | { v: string }
        | undefined
    )?.v ?? 0,
  )
  const steps = db.all<{ id: number; turn_id: number }>(
    `SELECT id, turn_id FROM steps WHERE id > ? ORDER BY id`,
    last,
  )
  for (const s of steps) {
    const msgs = db.all<{ content_json: string }>(
      // 排除任务的复制行（同 store.ts NOT_COPY；这里不 import 是为了不跟
      // store 成环）——否则 fork 前的 step 在任务存活期间全量重灌时读成双份
      `SELECT content_json FROM messages WHERE step_id = ?
         AND messages.owner IS (SELECT t.owner FROM turns t WHERE t.id = messages.turn_id) ORDER BY id`,
      s.id,
    )
    if (msgs.length === 0) continue
    const parts: string[] = []
    for (const m of msgs) {
      const line = JSON.parse(m.content_json) as { parts?: unknown[] }
      for (const seg of searchable(line as Parameters<typeof searchable>[0])) parts.push(seg.text)
    }
    const stepNo = (
      db.all<{ c: number }>(
        `SELECT COUNT(*) c FROM steps WHERE turn_id = ? AND id <= ?`,
        s.turn_id,
        s.id,
      )[0] as { c: number }
    ).c
    // 入库前必须过 toFtsText：原文的连续 CJK 在 unicode61 下是一整个 token，
    // 2 字词全断链（「卸载」永远搜不到）。查询侧 matchExpr 做同一变换
    db.run(
      `INSERT INTO search_fts(text, turn_no, step_no) VALUES(?, ?, ?)`,
      toFtsText(parts.join('\n')),
      s.turn_id,
      stepNo,
    )
    db.run(
      `INSERT INTO search_fts_meta(k, v) VALUES(?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      META_LAST_STEP,
      String(s.id),
    )
  }
}

/** 只读查询：MATCH → [(turn_no, step_no)]，按 BM25 相关性排（FTS5 内置
 * bm25()，返回负值、越相关越小；深入讨论过——提词多次的 step——排
 * 在顺带一提的前面）。同分 rowid 兜底，保证排序确定。 */
export function ftsSearch(db: Db, query: string, limit: number): { turn: number; step: number }[] {
  const expr = matchExpr(query)
  if (expr === null) return []
  const rows = db.all<{ turn_no: number; step_no: number }>(
    `SELECT turn_no, step_no FROM search_fts WHERE search_fts MATCH ?
     ORDER BY bm25(search_fts), rowid LIMIT ?`,
    expr,
    limit,
  )
  return rows.map((r) => ({ turn: r.turn_no, step: r.step_no }))
}

/** turn_no → jsonl 归档相对路径（带桶，buckets.ts 是唯一权威；幽灵 turn 的
 * 文件不存在由调用方容忍——命中它就跳过） */
export function archivePath(turnNo: number): string {
  return bucketedRel('turns', `turn-${String(turnNo).padStart(6, '0')}.jsonl`)
}

/** db 只读连接下重放一个 step 的渲染文本（excerpt/ctx 复用文件渲染，
 * 保证和 show 的排版一致）。文件读不了返回 null。 */
export async function renderStepText(
  root: string,
  turnNo: number,
  stepNo: number,
): Promise<string | null> {
  try {
    const steps = splitSteps(
      parseLines(
        await readFile(resolveBucketFile(root, 'turns', basename(archivePath(turnNo))), 'utf8'),
      ),
    )
    const step = steps[stepNo - 1]
    if (!step) return null
    return step
      .map((line) =>
        searchable(line)
          .map((s) => s.text)
          .join(' '),
      )
      .join('\n')
  } catch {
    return null
  }
}

// parseLines/splitSteps/searchable 从 tools/memory.ts 复用——同一份解析
// 才能保证「索引的内容」和「渲染的内容」是同一个形状
