/**
 * steps 号段（task-trunk，docs/proposals/task-trunk.md 规则 1–5）。
 *
 * 主任务与任务一样：每个会话只在自己 open 的段里给 step 取号，一轮的 step 全
 * 在同一段——段只在轮开始时切（规则 3）。为什么要分段：摘要合并靠「同一会话
 * 的 step 号成块连续」，号若全局自增交错，相邻两条摘要之间永远夹着别人的
 * step，`chainable` 第③条让它一直合不了（规则 1）。
 *
 * 段的一生：open（在写）→ full（主人切走，等摘要把段内 step 全覆盖）→ merged
 * （合回主干：主干拷它的摘要，别的会话在自己的压缩点拉它，`pullable`）。关闭
 * 任务 = 它的段立即 merged + closed；closed 的段比别人当前段号高时，别人下一轮
 * 开始就切段（`segmentForTurn`），让它落到自己当前段之下、变成可拉；真正拉进来
 * 等自己下一个压缩点（run.ts unloadIfNeeded，d75b463：拉段不单独触发压缩）。
 * 只对 closed 提前切：普通段满合回若也触发切段，两个会话会互相切出新段、来回拉。
 *
 * owner 键：主任务 ''，任务 'task-xxx'，主干 'trunk'（只出现在 segment_pulls 与
 * summaries.owner）。summaries/messages 的 owner 列主任务是 NULL（task-v3 遗产），
 * 换算见 `rowOwner`。本文件不开事务（Db 的事务不可嵌套），由调用方包。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logRun } from '../runlog.ts'
import type { Db } from './db.ts'

/** 段的预留宽度。号不占存储——但要 ≥ SEGMENT_FULL_STEPS + maxIterations
 *  + 余量（2026-11-01 拍板 10000：最坏落点 999+5000=5999，再留一倍余量），
 *  否则一轮跑满 maxIterations 会写出段 */
export const SEGMENT_WIDTH = 10_000
/** 段用满的 step 数（2026-10-29 按推荐定：主任务每天 298–1071 step，约一天合回一次） */
export const SEGMENT_FULL_STEPS = 1000
/** 主干的 owner 键：一套压好的摘要，没有轮、没有请求（规则 10） */
export const TRUNK = 'trunk'

export type SegmentRow = {
  id: number
  owner: string
  floor: number
  ceil: number
  state: 'open' | 'full' | 'merged'
  closed: number
}

const COLS = `id, owner, step_floor AS floor, step_ceil AS ceil, state, closed`

/** owner 键 → summaries/messages 的 owner 列值（主任务是 NULL） */
const rowOwner = (key: string): string | null => (key === '' ? null : key)

const num = (db: Db, sql: string, ...p: (string | number | null)[]): number =>
  db.all<{ n: number | null }>(sql, ...p)[0]?.n ?? 0

export function currentSegment(db: Db, key: string): SegmentRow | null {
  return (
    db.all<SegmentRow>(
      `SELECT ${COLS} FROM segments WHERE owner = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
      key,
    )[0] ?? null
  )
}

/** 段内已用 step 数（「用满」的尺子）。messages 不能当尺子：每次存盘整份重插、重新占号 */
function usedSteps(db: Db, seg: SegmentRow): number {
  return num(db, `SELECT COUNT(*) AS n FROM steps WHERE id > ? AND id <= ?`, seg.floor, seg.ceil)
}

/** 新段落在全库已占用的最高号之上：已有 step、已开的段、老库的自增序列，三者取大 */
export function openSegment(db: Db, key: string, folder: string): SegmentRow {
  const top = Math.max(
    num(db, `SELECT MAX(id) AS n FROM steps`),
    num(db, `SELECT MAX(step_ceil) AS n FROM segments`),
    num(db, `SELECT seq AS n FROM sqlite_sequence WHERE name = 'steps'`),
  )
  db.run(
    `INSERT INTO segments(owner, step_floor, step_ceil, state, opened_at) VALUES(?, ?, ?, 'open', ?)`,
    key,
    top,
    top + SEGMENT_WIDTH,
    new Date().toISOString(),
  )
  const id = num(db, `SELECT last_insert_rowid() AS n`)
  logRun({
    ev: 'segment_open',
    folder,
    owner: key,
    segment: id,
    floor: top,
    ceil: top + SEGMENT_WIDTH,
  })
  return { id, owner: key, floor: top, ceil: top + SEGMENT_WIDTH, state: 'open', closed: 0 }
}

/** 有没有已关闭、已合回、号比 seg 高、key 还没拉过的段——有就该提前切段去拉 */
function closedAbove(db: Db, key: string, seg: SegmentRow): boolean {
  return (
    db.all(
      `SELECT 1 AS x FROM segments g
       WHERE g.state = 'merged' AND g.closed = 1 AND g.owner <> ? AND g.step_floor >= ?
         AND NOT EXISTS (SELECT 1 FROM segment_pulls p WHERE p.owner = ? AND p.segment_id = g.id)
       LIMIT 1`,
      key,
      seg.ceil,
      key,
    ).length > 0
  )
}

/**
 * 轮开始时定这一轮用哪段（规则 3：只在轮与轮之间切段）。当前段用满，或有
 * 关掉的任务的段在上方等着拉，就把当前段标 full、开新段。
 */
export function segmentForTurn(db: Db, key: string, folder: string): SegmentRow {
  const seg = currentSegment(db, key)
  if (seg !== null) {
    const used = usedSteps(db, seg)
    const reason =
      used >= SEGMENT_FULL_STEPS ? 'full' : closedAbove(db, key, seg) ? 'pull_closed' : null
    if (reason === null) return seg
    db.run(`UPDATE segments SET state = 'full' WHERE id = ?`, seg.id)
    logRun({ ev: 'segment_full', folder, owner: key, segment: seg.id, used, reason })
  }
  return openSegment(db, key, folder)
}

/** 段内有自己消息、却没被自己 ready 摘要覆盖的 step 数。0 = 可以合回（规则 4） */
function uncoveredSteps(db: Db, seg: SegmentRow): number {
  const owner = rowOwner(seg.owner)
  const steps = db
    .all<{ id: number }>(
      `SELECT s.id FROM steps s WHERE s.id > ? AND s.id <= ?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.step_id = s.id AND m.owner IS ?)
       ORDER BY s.id`,
      seg.floor,
      seg.ceil,
      owner,
    )
    .map((r) => r.id)
  if (steps.length === 0) return 0
  const covers = db.all<{ f: number; t: number }>(
    `SELECT covers_from AS f, covers_to AS t FROM summaries
     WHERE owner IS ? AND status = 'ready' AND covers_to > ? AND covers_from <= ?
     ORDER BY covers_from`,
    owner,
    seg.floor,
    seg.ceil,
  )
  // 双指针扫：steps 与区间都按起点升序，区间可能重叠（各层都在）
  let missing = 0
  let i = 0
  let reach = -Infinity
  for (const id of steps) {
    while (i < covers.length && (covers[i]?.f ?? Infinity) <= id) {
      reach = Math.max(reach, covers[i]?.t ?? -Infinity)
      i++
    }
    if (reach < id) missing++
  }
  return missing
}

/** full 且已被摘要覆盖的段标 merged，返回这次合回的（主干接着拷它们） */
export function mergeReadySegments(db: Db, folder: string): SegmentRow[] {
  const out: SegmentRow[] = []
  for (const seg of db.all<SegmentRow>(`SELECT ${COLS} FROM segments WHERE state = 'full'`)) {
    if (uncoveredSteps(db, seg) > 0) continue
    db.run(
      `UPDATE segments SET state = 'merged', merged_at = ? WHERE id = ?`,
      new Date().toISOString(),
      seg.id,
    )
    logRun({
      ev: 'segment_merge',
      folder,
      owner: seg.owner,
      segment: seg.id,
      floor: seg.floor,
      ceil: seg.ceil,
    })
    out.push({ ...seg, state: 'merged' })
  }
  return out
}

/** 关闭任务：它的段全部即刻合回并标 closed（摘要已由关闭流程排空，欠账照样收尾） */
export function closeSegments(db: Db, key: string, folder: string): void {
  for (const seg of db.all<SegmentRow>(
    `SELECT ${COLS} FROM segments WHERE owner = ? AND state <> 'merged'`,
    key,
  )) {
    const left = uncoveredSteps(db, seg)
    db.run(
      `UPDATE segments SET state = 'merged', closed = 1, merged_at = ? WHERE id = ?`,
      new Date().toISOString(),
      seg.id,
    )
    logRun({
      ev: 'segment_merge',
      folder,
      owner: key,
      segment: seg.id,
      floor: seg.floor,
      ceil: seg.ceil,
      closed: true,
      uncovered: left,
    })
  }
}

/**
 * key 可以拉的段：已合回、不是自己的、还没拉过、号比 `below` 低（规则 5：
 * 拉进号更高的段，自己之后的新消息会排到它前面，每个请求都在中间插入）。
 * 主干传 Infinity（没有请求前缀要保护）
 */
export function pullableSegments(db: Db, key: string, below: number): SegmentRow[] {
  return db.all<SegmentRow>(
    `SELECT ${COLS} FROM segments g
     WHERE g.state = 'merged' AND g.owner <> ? AND g.step_ceil <= ?
       AND NOT EXISTS (SELECT 1 FROM segment_pulls p WHERE p.owner = ? AND p.segment_id = g.id)
     ORDER BY g.step_floor`,
    key,
    below,
    key,
  )
}

/** 段里每条摘要行原样写进来要补的头部与路径（store.ts headOfStep） */
type HeadOf = (stepId: number) => { text: string; archivePath: string }

type SumRow = {
  id: number
  level: number
  covers_from: number
  covers_to: number
  text: string
  superseded_by: number | null
  head: string | null
  archive_path: string | null
  name: string | null
}

/**
 * 把一段的摘要拷给 target（规则 5 拉段 / 规则 10 主干收段），记一行 pull。
 *
 * 拷的是这段自己的摘要（owner = 段主人、covers 落在段内）的**链根**：段内
 * 没被收编、或被跨段父行收编（父行不在段内，不拷）的行。只拷链根：它们已是
 * 这段最压缩的表述，下层成员只是历史结构；拷全量每段多几百行、对上下文无用。
 * 链根一律 in_context=1——拉段只发生在压缩点（前缀可改写），主干没有请求。
 * 源行可能还没进过场（段尾几轮在主人上下文里仍是原文），head/路径为空的现补
 */
export function copySegmentRoots(
  db: Db,
  seg: SegmentRow,
  target: string,
  headOf: HeadOf,
  folder: string,
): number {
  const rows = db.all<SumRow>(
    `SELECT id, level, covers_from, covers_to, text, superseded_by, head, archive_path, name FROM summaries
     WHERE owner IS ? AND status = 'ready' AND covers_from > ? AND covers_to <= ?
     ORDER BY covers_from, level`,
    rowOwner(seg.owner),
    seg.floor,
    seg.ceil,
  )
  const ids = new Set(rows.map((r) => r.id))
  const roots = rows.filter((r) => r.superseded_by === null || !ids.has(r.superseded_by))
  for (const r of roots) {
    const head = r.head === null || r.archive_path === null ? headOf(r.covers_from) : null
    db.run(
      `INSERT INTO summaries(level, covers_from, covers_to, text, status, in_context,
                             superseded_by, head, archive_path, name, owner)
       VALUES(?, ?, ?, ?, 'ready', 1, NULL, ?, ?, ?, ?)`,
      r.level,
      r.covers_from,
      r.covers_to,
      r.text,
      r.head ?? head?.text ?? null,
      r.archive_path ?? head?.archivePath ?? null,
      r.name,
      rowOwner(target),
    )
  }
  markPulled(db, target, seg.id)
  logRun({
    ev: 'segment_pull',
    folder,
    owner: target,
    segment: seg.id,
    from: seg.owner,
    rows: roots.length,
  })
  return roots.length
}

export function markPulled(db: Db, key: string, segmentId: number): void {
  db.run(
    `INSERT INTO segment_pulls(owner, segment_id, pulled_at) VALUES(?, ?, ?) ON CONFLICT DO NOTHING`,
    key,
    segmentId,
    new Date().toISOString(),
  )
}

const LEGACY_MARK = 'task-trunk-segments'

/** 老任务（task-v3 fork 的）manifest 里的 steps 号段。只读这两个字段，不 import
 *  task.ts——它依赖 store.ts，store.ts 又要调这里的迁移 */
function legacyTaskRanges(root: string): { owner: string; floor: number; ceil: number }[] {
  const dir = join(root, '.simple-code', 'tasks')
  if (!existsSync(dir)) return []
  const out: { owner: string; floor: number; ceil: number }[] = []
  for (const n of readdirSync(dir)) {
    if (!n.endsWith('.json')) continue
    try {
      const m = JSON.parse(readFileSync(join(dir, n), 'utf8')) as {
        owner?: unknown
        stepFloor?: unknown
        stepCeil?: unknown
      }
      if (
        typeof m.owner === 'string' &&
        typeof m.stepFloor === 'number' &&
        typeof m.stepCeil === 'number'
      )
        out.push({ owner: m.owner, floor: m.stepFloor, ceil: m.stepCeil })
    } catch {
      /* 坏 manifest：跳过（listTaskManifests 同款） */
    }
  }
  return out.sort((a, b) => a.floor - b.floor)
}

/**
 * 老库一次性登记段（task-trunk.md「旧数据迁移」）。幂等：migrations 记标记。
 *
 * - 开着的老任务：manifest 的 (stepFloor, stepCeil] 登记为它的 open 段。
 * - 主任务：其余号按老任务的段切开，各登记一段；最高那段留 open（续接轮
 *   还要在里面接着写），下一轮开始按用量切走，其余 full，摘要覆盖后合回。
 * - 老任务 fork 时已复制了主任务那时的上下文：号低于它的主任务段记为它
 *   「已拉」，否则合回后它会再拉一份重复的。
 * - 搜索索引：老的全局游标 last_step_id 摊到各段；老任务的段在全局游标下
 *   面一直收不进来（task-v3 靠关闭时补），删掉它已有的行、从段头重收。
 *
 * 登记前整库 `VACUUM INTO` 备份一份到 memory/state.db.pre-task-trunk（一次性；
 * 迁移只加段表与标记，备份是给「新机制跑出问题要回到 task-v3」留的退路）
 */
export function registerLegacySegments(db: Db, root: string): void {
  if (db.all(`SELECT 1 AS x FROM migrations WHERE name = ?`, LEGACY_MARK).length > 0) return
  // 只跑一次、跑在建会话的路上（含整库备份）：成败与耗时记一行——首次
  // reload 卡住、会话建不起来时从 runlog 查
  const t0 = Date.now()
  try {
    const done = migrateLegacy(db, root)
    logRun({ ev: 'segment_migrate', folder: root, ms: Date.now() - t0, ...done })
  } catch (error) {
    logRun({ ev: 'segment_migrate', folder: root, ms: Date.now() - t0, error: String(error) })
    throw error
  }
}

function migrateLegacy(
  db: Db,
  root: string,
): { top: number; legacyTasks: number; backupMs: number | null; segments: number } {
  const top = Math.max(
    num(db, `SELECT MAX(id) AS n FROM steps`),
    num(db, `SELECT seq AS n FROM sqlite_sequence WHERE name = 'steps'`),
  )
  const tasks = legacyTaskRanges(root)
  const backup = join(root, '.simple-code', 'memory', 'state.db.pre-task-trunk')
  // null = 没备份（空库，或备份已在）
  let backupMs: number | null = null
  if ((top > 0 || tasks.length > 0) && !existsSync(backup)) {
    const b0 = Date.now()
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
    backupMs = Date.now() - b0
  }
  const at = new Date().toISOString()
  const meta = (k: string): number | null => {
    const v = db.all<{ v: string }>(`SELECT v FROM search_fts_meta WHERE k = ?`, k)[0]?.v
    return v === undefined ? null : Number(v)
  }
  db.transaction(() => {
    // 已经有段 = 不是老库（新库上先开了任务、后开会话），只补标记
    const hasSegments = num(db, `SELECT COUNT(*) AS n FROM segments`) > 0
    if (!hasSegments && (top > 0 || tasks.length > 0)) {
      const lastStep = meta('last_step_id') ?? 0
      const lastRowid = meta('last_rowid')
      const insert = (owner: string, floor: number, ceil: number, state: string): number => {
        const inSeg = lastStep > floor && lastStep <= ceil
        db.run(
          `INSERT INTO segments(owner, step_floor, step_ceil, state, opened_at, indexed_step, indexed_rowid)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          owner,
          floor,
          ceil,
          state,
          at,
          Math.min(Math.max(lastStep, floor), ceil),
          inSeg ? lastRowid : null,
        )
        return num(db, `SELECT last_insert_rowid() AS n`)
      }
      const mainSegs: { id: number; ceil: number }[] = []
      let start = 0
      for (const t of tasks) {
        if (
          t.floor > start &&
          num(db, `SELECT COUNT(*) AS n FROM steps WHERE id > ? AND id <= ?`, start, t.floor) > 0
        )
          mainSegs.push({ id: insert('', start, t.floor, 'full'), ceil: t.floor })
        start = Math.max(start, t.ceil)
      }
      insert('', start, Math.max(top, start) + SEGMENT_WIDTH, 'open')
      for (const t of tasks) {
        const turns = db
          .all<{ id: number }>(`SELECT id FROM turns WHERE owner = ?`, t.owner)
          .map((r) => r.id)
        if (turns.length > 0)
          db.run(
            `DELETE FROM search_fts WHERE turn_no IN (${turns.map(() => '?').join(',')})`,
            ...turns,
          )
        const id = insert(t.owner, t.floor, t.ceil, 'open')
        db.run(
          `UPDATE segments SET indexed_step = step_floor, indexed_rowid = NULL WHERE id = ?`,
          id,
        )
        for (const m of mainSegs) if (m.ceil <= t.floor) markPulled(db, t.owner, m.id)
      }
    }
    db.run(`INSERT INTO migrations(name, ran_at) VALUES(?, ?)`, LEGACY_MARK, at)
  })
  return {
    top,
    legacyTasks: tasks.length,
    backupMs,
    segments: num(db, `SELECT COUNT(*) AS n FROM segments`),
  }
}
