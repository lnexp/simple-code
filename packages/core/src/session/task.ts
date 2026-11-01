/**
 * 任务生命周期核心（task-trunk，docs/proposals/task-trunk.md；前身 task-v3）。
 *
 * 同一个库里的 owner 分治：turns/messages/summaries 的 owner 列 = 'task-xxx'
 * 是任务的行（主任务是 NULL）。任务与主任务平等——step 号都在各自的段里取
 * （segments.ts），段满或关闭即合回，别的会话在压缩点拉合回段的摘要：
 *
 *   开    = 一个事务：开一段 + 复制主干在场摘要（不调模型）+ manifest
 *   存活  = owner-scoped session 写同一个库（store.ts 的 TaskScope）
 *   关闭  = live→unloaded → 摘要排空 → 段即刻合回（行的 owner 不变）
 *
 * 不再复制 live 行（每任务约 1MB）、不再占 reserved 锚、不再跳 sequence，
 * 也不要求主任务静止：开/关都只写自己的行和 segments 表。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { openDb, type Db, type SqlValue } from './db.ts'
import { MEMORY_RELATIVE } from './store.ts'
import { copyMarker, type TaskScope } from './store.ts'
import { MIGRATIONS, SCHEMA } from './schema.sql.ts'
import { closeSegments, markPulled, registerLegacySegments, TRUNK } from './segments.ts'

/** task.ts 的写库函数自己开裸连接——不走 openStore（那是会话的事）。
 * 连接要自带 schema：库通常已存在（对话先建），但「先派活后说话」的
 * 全新文件夹不该在开任务时就炸 */
const openTaskDb = (root: string): Db => {
  const db = openDb(join(root, MEMORY_RELATIVE, 'state.db'))
  db.exec(SCHEMA)
  for (const sql of MIGRATIONS) {
    try {
      db.run(sql)
    } catch (error) {
      if (!String(error).includes('duplicate column')) throw error
    }
  }
  // 老库先登记段（幂等）：开任务要在已有段之上开新段
  registerLegacySegments(db, root)
  return db
}

export type TaskManifest = {
  owner: string
  name: string
  createdAt: string
  /** 回调的登记者 owner（主任务 ''），完成回调回给它（task-trunk 规则 12）。只有 agent
   *  派的任务有；用户开的、老 manifest 没有 */
  parent?: string
  /** 完成回调：pending = 派出那一轮结束时还要回调一次；done = 已回调。老 manifest 没有 = 不回调 */
  callback?: 'pending' | 'done'
  /**
   * 只输名称开的空任务（规则 13）：还没发过第一条消息。第一条消息前拼任务框架句、
   * reload 恢复时不补回调（没有「派出那一轮」可被打断）；第一轮开跑时去掉
   */
  awaitingFirstMessage?: true
  /**
   * task-v3 遗产：升级时还开着的老任务才有。forkTurn = 继承上界（owner IS NULL 且
   * id ≤ forkTurn 的轮对它可见），stepFloor = 继承段的 step 上界。其余号段字段
   * 只在迁移时读（segments.ts registerLegacySegments）
   */
  forkTurn?: number
  stepFloor?: number
  stepCeil?: number
}

const OWNER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/**
 * 6 位随机 = 36^6 ≈ 22 亿，一天 100 个任务一年撞一次的概率约 26%——撞上就把老任务
 * 按 owner 存的轮与摘要混进新任务。用过的跳过：在开（manifest 在）或说过话（turns
 * 有行；段和自己的摘要都要先有轮）。关了且没说过话的号，复制来的摘要与拉段记录
 * 关闭时已删，复用无害
 */
const newOwnerId = (taken: (id: string) => boolean): string => {
  for (;;) {
    let id = 'task-'
    for (let i = 0; i < 6; i++) {
      id += OWNER_ALPHABET[Math.floor(Math.random() * OWNER_ALPHABET.length)]
    }
    if (!taken(id)) return id
  }
}

const tasksDir = (root: string): string => join(root, '.simple-code', 'tasks')
const manifestPath = (root: string, owner: string): string => join(tasksDir(root), `${owner}.json`)

export function readTaskManifest(root: string, owner: string): TaskManifest {
  return JSON.parse(readFileSync(manifestPath(root, owner), 'utf8')) as TaskManifest
}

/** reload 恢复扫描：manifest 即真相——有文件 = 任务活着 */
export function listTaskManifests(root: string): TaskManifest[] {
  const dir = tasksDir(root)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return [] // 目录不存在 = 从未开过任务
  }
  const out: TaskManifest[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')) as TaskManifest)
    } catch {
      /* 坏 manifest：跳过——不删（用户数据），不开（开不了） */
    }
  }
  return out
}

export const scopeOf = (m: TaskManifest): TaskScope => ({
  owner: m.owner,
  forkTurn: m.forkTurn ?? 0,
  inheritCeil: m.forkTurn ? (m.stepFloor ?? 0) : 0,
})

export function writeTaskManifest(root: string, m: TaskManifest): void {
  mkdirSync(tasksDir(root), { recursive: true })
  writeFileSync(manifestPath(root, m.owner), JSON.stringify(m, null, 2))
}

/** 回调消息的头（webview 回放按它认出这一行，events.ts 有同款正则） */
export const TASK_RESULT_HEAD = '〔任务结果〕'

/** 回调插进登记者上下文的原文：头一行「任务名 · 状态」，其后是派出那一轮最后
 *  一条回复，不截断——登记者看不到别人没合回的内容，不给原文就拿不到结果 */
export const taskResultText = (task: string, status: string, reply: string): string =>
  `${TASK_RESULT_HEAD}${task} · ${status}\n${reply === '' ? '（没有回复文本）' : reply}`

/** 给登记者（owner 键：主任务 ''）投一条回调。登记者在下一个安全点取走
 *  （store.takeTaskResults） */
export function postTaskResult(root: string, owner: string, text: string): void {
  const db = openTaskDb(root)
  try {
    db.run(`INSERT INTO task_results(owner, text, created_at) VALUES(?, ?, ?)`, owner, text, new Date().toISOString())
  } finally {
    db.close()
  }
}

/** 任务最后一条有文字的回复（reload 打断了派出那一轮、恢复时补回调用）。没有 = '' */
export function lastTaskReply(root: string, owner: string): string {
  const db = openTaskDb(root)
  try {
    for (const { c } of db.all<{ c: string }>(
      `SELECT content_json AS c FROM messages WHERE owner = ? AND role = 'assistant' ORDER BY id DESC LIMIT 50`,
      owner,
    )) {
      const parts = (JSON.parse(c) as { parts: { type: string; text?: string }[] }).parts
      const text = parts.map((p) => (p.type === 'text' ? (p.text ?? '') : '')).join('')
      if (text !== '') return text
    }
    return ''
  } finally {
    db.close()
  }
}

/**
 * 开任务（规则 7）。一个事务：把主干在场的摘要复制成自己的 + 记下主干拉过的段
 * （那些经历已在副本里，不再拉）。不调模型、不碰任何会话的行，任何时刻都能开。
 *
 * **不开段**：段等第一轮开始时开（store beginTurn → segmentForTurn）。只输名称的
 * 空任务可能隔很久才发第一条消息（规则 13），段若此刻就开，「open 却零 step」的段
 * 会被别人的摘要合并链跨过、之后才写进内容，被 applyMerges 当嵌套根误收（复审
 * 2026-10-30）。之间主干新合回的段，第一个请求按 firstPull 拉（run.ts）。
 * manifest 落盘在事务外——崩溃窗口的语义是「库里有摘要副本没 manifest」：无人读，无害
 */
export function createTask(
  root: string,
  name: string,
  opts: { parent?: string; awaitingFirstMessage?: boolean } = {},
): TaskManifest {
  const db = openTaskDb(root)
  try {
    const m: TaskManifest = {
      owner: newOwnerId(
        (id) =>
          existsSync(manifestPath(root, id)) ||
          db.all(`SELECT 1 AS x FROM turns WHERE owner = ? LIMIT 1`, id).length > 0,
      ),
      name,
      createdAt: new Date().toISOString(),
      ...(opts.parent !== undefined ? { parent: opts.parent, callback: 'pending' as const } : {}),
      ...(opts.awaitingFirstMessage === true ? { awaitingFirstMessage: true as const } : {}),
    }
    db.transaction(() => {
      db.run(
        `INSERT INTO summaries(level, covers_from, covers_to, text, status, in_context,
                               superseded_by, head, archive_path, name, owner)
         SELECT level, covers_from, covers_to, text, 'ready', 1, NULL, head, archive_path, name, ?
         FROM summaries WHERE owner = ? AND in_context = 1 AND status = 'ready'
         ORDER BY covers_from, level`,
        m.owner,
        TRUNK,
      )
      for (const { id } of db.all<{ id: number }>(`SELECT segment_id AS id FROM segment_pulls WHERE owner = ?`, TRUNK))
        markPulled(db, m.owner, id)
    })
    writeTaskManifest(root, m)
    return m
  } finally {
    db.close()
  }
}
/**
 * 关闭第一步：任务的 live 尾巴翻成 unloaded——数据即刻成为历史。
 * 之后任务的摘要器还能继续摘它（段选择不要求 live）
 */
/**
 * 返回翻成 unloaded 的行数（task_close 对账用）。
 *
 * 同时补 `steps.unloaded = 1`：任务自己的 step 在原文全卸后应立即标记。
 * `activateSummary` 要求段头 step 满足 `unloaded = 1` 才进场，否则摘要停在
 * `in_context=0`，主任务看不到这段经历（2026-10-22 反思任务 task-5s3lud 的 4 份摘要）。
 * 开库时 `reconcileStepUnloaded` 会补，但主任务库一直开着就漏了。
 */
export function flipTaskLive(root: string, owner: string): number {
  const db = openTaskDb(root)
  try {
    const own = `turn_id IN (SELECT id FROM turns WHERE owner = ?)`
    const flipped = db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM messages WHERE state = 'live' AND ${own}`, owner)[0]?.c ?? 0
    db.transaction(() => {
      db.run(
        `UPDATE messages SET state = 'unloaded'
         WHERE state = 'live' AND ${own}`,
        owner,
      )
      // 判据与 reconcileStepUnloaded 同源：该 step 有消息、且没有任何 live 消息
      // （任务复制行不算，owner 对不上）
      db.run(
        `UPDATE steps SET unloaded = 1
         WHERE unloaded = 0
           AND EXISTS (SELECT 1 FROM messages m WHERE m.step_id = steps.id)
           AND NOT EXISTS (
             SELECT 1 FROM messages m WHERE m.step_id = steps.id AND m.state = 'live'
               AND m.owner IS (SELECT t.owner FROM turns t WHERE t.id = m.turn_id)
           )
           AND id IN (SELECT st.id FROM steps st
                      JOIN turns t ON st.turn_id = t.id
                      WHERE t.owner = ?)`,
        owner,
      )
    })
    return flipped
  } finally {
    db.close()
  }
}

/**
 * 关闭末步（规则 8）：任务的段即刻合回（行的 owner 不变，合回状态记在段表），
 * 别的会话下一轮切段、在压缩点拉它的摘要（segments.ts closedAbove）。
 * covers 不落在自己任何一段内的摘要行删掉：开场复制的主干摘要、拉进来的别段
 * 摘要、自己跨着它们合出的行——别人只按段拉段内的行（copySegmentRoots），
 * 这些行合回后再没人读，不删每个任务留约 250 行（task-trunk 复审）。
 * task-v3 老任务另清掉 fork 时复制的继承上下文（消息副本 + covers 继承段的
 * 私有摘要）——那是它窗口里的脚手架，不是经历
 */
/** finalizeTask 各步改动行数——task_close 对账用 */
export type FinalizeCounts = {
  sumDeleted: number
  msgDeleted: number
  segments: number
}

export function finalizeTask(root: string, owner: string): FinalizeCounts {
  const db = openTaskDb(root)
  const count = (sql: string, ...p: SqlValue[]): number => db.all<{ c: number }>(`SELECT COUNT(*) AS c ${sql}`, ...p)[0]?.c ?? 0
  const counts: FinalizeCounts = { sumDeleted: 0, msgDeleted: 0, segments: 0 }
  try {
    const legacy = scopeOf(readTaskManifest(root, owner))
    db.transaction(() => {
      if (legacy.forkTurn > 0) {
        const ceil = legacy.inheritCeil
        db.run(
          `UPDATE summaries SET superseded_by = NULL
           WHERE superseded_by IN (SELECT id FROM summaries WHERE owner = ? AND covers_from <= ?)
             AND NOT (owner = ? AND covers_from <= ?)`,
          owner,
          ceil,
          owner,
          ceil,
        )
        counts.sumDeleted = count(`FROM summaries WHERE owner = ? AND covers_from <= ?`, owner, ceil)
        db.run(`DELETE FROM summaries WHERE owner = ? AND covers_from <= ?`, owner, ceil)
        counts.msgDeleted = count(`FROM messages WHERE owner = ? AND turn_id NOT IN (SELECT id FROM turns WHERE owner = ?)`, owner, owner)
        db.run(`DELETE FROM messages WHERE owner = ? AND turn_id NOT IN (SELECT id FROM turns WHERE owner = ?)`, owner, owner)
        db.run(`DELETE FROM migrations WHERE name = ?`, copyMarker(owner))
      }
      // 段内行被跨段父行收编的先解开（superseded_by 有外键）；它们在
      // copySegmentRoots 眼里本就是链根，拉到的内容不变
      const outside = `SELECT x.id FROM summaries x WHERE x.owner = ? AND NOT EXISTS (
        SELECT 1 FROM segments g WHERE g.owner = x.owner
          AND x.covers_from > g.step_floor AND x.covers_to <= g.step_ceil)`
      db.run(
        `UPDATE summaries SET superseded_by = NULL
         WHERE superseded_by IN (${outside}) AND id NOT IN (${outside})`,
        owner,
        owner,
      )
      counts.sumDeleted += count(`FROM summaries WHERE id IN (${outside})`, owner)
      db.run(`DELETE FROM summaries WHERE id IN (${outside})`, owner)
      counts.segments = count(`FROM segments WHERE owner = ? AND state <> 'merged'`, owner)
      closeSegments(db, owner, root)
      // 关了不再拉段。开场从主干复制的拉段记录 ≈ 已合回段数、每任务一份，不删
      // 就随天数平方涨（一天 100 任务一年约 13 亿行、98GB）
      db.run(`DELETE FROM segment_pulls WHERE owner = ?`, owner)
    })
  } finally {
    db.close()
  }
  rmSync(manifestPath(root, owner), { force: true })
  return counts
}
