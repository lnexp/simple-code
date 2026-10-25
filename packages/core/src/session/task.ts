/**
 * 任务生命周期核心（task-v3，docs/proposals/task-v3.md）。
 *
 * v2（fork-merge.ts，已删）把任务做成「拷库 + merge 搬运」；v3 是同一个库里的
 * owner 分治：turns.owner 列是唯一开关——NULL=对话的轮，'task-xxx'=任务的轮。
 * 派生关系全部靠号段表达，不拷任何文件：
 *
 *   fork  = 一个事务：reserved 行顶高 rowid + 三轴 sequence 跳段 + manifest
 *   存活  = owner-scoped session 写同一个库（store.ts 的 TaskScope）
 *   关闭  = live→unloaded → 摘要排空 → owner 还俗 NULL → 补任务 turn 的 FTS 行
 *
 * 语义一句话：对话流私有（live/上下文/摘要按 owner 隔离），记忆共享
 * （归档、FTS、events 不分你我）。任务关闭后它的段就是对话的历史，
 * 压缩管线无差别覆盖——没有合并，没有丢弃，没有 marker。
 */
import { join } from 'node:path'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { openDb, type Db, type SqlValue } from './db.ts'
import { MEMORY_RELATIVE } from './store.ts'
import { reindexTurns } from './search-index.ts'
import { copyMarker, ensureInheritedCopy, type TaskScope } from './store.ts'
import { MIGRATIONS, SCHEMA } from './schema.sql.ts'

/** task.ts 的三个写库函数自己开裸连接——不走 openStore（那是会话的事）。
 * 连接要自带 schema：库通常已存在（对话先建），但「先派活后说话」的
 * 全新文件夹不该在 fork 就炸 */
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
  return db
}

export const TASK_TURN_GAP = 1000
export const TASK_STEP_GAP = 50000
/**
 * 消息轴比其他轴大两个数量级（2026-09-23 用户拍板 3 万 → 300 万）：save 是
 * 全量 DELETE+INSERT（store.ts replaceLive，理由见那里），每存一次盘整份
 * live 重新占一批 id——消耗 ≈ 步数 × 在场消息数，随任务变长越来越快。
 * 真机 task-m06szj：24 条消息、约 1 小时就用掉约 1,940 个号；3 万个号约
 * 一百多步即段满停机。编号不占存储，放大无代价（fork 时主任务 id 跟着
 * 跳 300 万，INTEGER 上限 9e18，不是问题）。只对之后 fork 的任务生效
 */
export const TASK_MSG_GAP = 3_000_000
export const TASK_SUM_GAP = 5000

export type TaskManifest = {
  owner: string
  name: string
  createdAt: string
  /** 继承上界（含）：owner IS NULL 且 id ≤ forkTurn 的轮对任务可见 */
  forkTurn: number
  /** 四轴分配域：turns 是 [forkTurn+1, turnCeil)（reserved 行占 turnCeil），
   *  其余三轴是 (floor, ceil]（floor = fork 时主库该轴 max） */
  turnCeil: number
  stepFloor: number
  stepCeil: number
  msgFloor: number
  msgCeil: number
  sumFloor: number
  sumCeil: number
}

const OWNER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const newOwnerId = (): string => {
  let id = ''
  for (let i = 0; i < 6; i++) {
    id += OWNER_ALPHABET[Math.floor(Math.random() * OWNER_ALPHABET.length)]
  }
  return `task-${id}`
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
  forkTurn: m.forkTurn,
  turnCeil: m.turnCeil,
  stepFloor: m.stepFloor,
  stepCeil: m.stepCeil,
  msgFloor: m.msgFloor,
  msgCeil: m.msgCeil,
  sumFloor: m.sumFloor,
  sumCeil: m.sumCeil,
})

/**
 * 开任务。**调用方保证对话此刻静止**（不在一轮的中间——写的是活库）。
 * 一个事务完成全部写入，无文件拷贝；manifest 落盘在事务外（它不在库里，
 * 崩溃窗口的语义=「写了库没写 manifest」——号段被烧掉、任务不存在，无害）
 */
export function forkTask(root: string, name: string): TaskManifest {
  const db = openTaskDb(root)
  try {
    const maxOf = (t: string): number =>
      db.all<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${t}`)[0]?.m ?? 0
    // 三轴的 floor 要取「全局已占用的最高号」= max(MAX(id), sequence)。只
    // 看 MAX(id) 的话：任务 A 在跑、主任务没写新行时再开 B，MAX(id) 是 A 段
    // 里的行，B 的段就压在 A 的段上——两边分配器各自 +1 撞主键（2026-09-23
    // 检视查出，task.test「连开两个任务」锁住）。A fork 时已把 sequence
    // 顶到 A 段尾，它才是下一个真正空闲的号
    const floorOf = (t: string): number => {
      const seq =
        db.all<{ s: number | null }>(`SELECT seq AS s FROM sqlite_sequence WHERE name = ?`, t)[0]?.s ?? 0
      return Math.max(maxOf(t), seq)
    }
    const forkTurn = maxOf('turns')
    const m: TaskManifest = {
      owner: newOwnerId(),
      name,
      createdAt: new Date().toISOString(),
      forkTurn,
      turnCeil: forkTurn + TASK_TURN_GAP,
      stepFloor: floorOf('steps'),
      stepCeil: 0,
      msgFloor: floorOf('messages'),
      msgCeil: 0,
      sumFloor: floorOf('summaries'),
      sumCeil: 0,
    }
    m.stepCeil = m.stepFloor + TASK_STEP_GAP
    m.msgCeil = m.msgFloor + TASK_MSG_GAP
    m.sumCeil = m.sumFloor + TASK_SUM_GAP
    db.transaction(() => {
      // reserved 行：顶高 turns 的 rowid，对话的下一轮自然落在任务段之上。
      // 它没有内容，任何按内容装配的路径天然跳过（state != 'reserved' 过滤，
      // v2 遗产惯例）
      db.run(
        `INSERT INTO turns(id, started_at, state, owner) VALUES(?, ?, 'reserved', NULL)`,
        m.turnCeil,
        new Date().toISOString(),
      )
      // 三轴跳段：对话的下一个 id 自然落在段尾之上；任务侧 store 用显式
      // id 填段内。MAX 保序——重试/并发下不会把 seq 往回拉
      for (const [tbl, ceil] of [
        ['steps', m.stepCeil],
        ['messages', m.msgCeil],
        ['summaries', m.sumCeil],
      ] as const) {
        // sqlite_sequence 的 name 列没有 UNIQUE 约束，ON CONFLICT 不合法
        // （v2 实测写法）：has-then-update。MAX 保序——重试/并发下不会把
        // seq 往回拉
        const has = db.all(`SELECT 1 AS x FROM sqlite_sequence WHERE name = ?`, tbl).length > 0
        if (has) {
          db.run(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`, ceil, tbl)
        } else {
          db.run(`INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)`, tbl, ceil)
        }
      }
    })
    // 上下文隔离：主任务此刻的上下文复制一份归任务（store.ts
    // ensureInheritedCopy 注释）。放在跳段之后——副本的 id 取任务段
    ensureInheritedCopy(db, scopeOf(m))
    mkdirSync(tasksDir(root), { recursive: true })
    writeFileSync(manifestPath(root, m.owner), JSON.stringify(m, null, 2))
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
 * 关闭末步：owner 还俗 NULL——任务的段从此就是对话的历史，所有可见性
 * 过滤（owner IS NULL）零特殊路径地把它收进来。配额的 reserved 行不动
 * （它本来就是对话侧的路标）。最后只重做任务自己 turn 的 FTS 行：任务段
 * 的低号 step 在存活期间位于增量游标之下，增量同步收不到
 */
/** finalizeTask 各步改动行数——task_close 对账用（关闭后 owner/manifest 都没了，事后无从反推） */
export type FinalizeCounts = {
  sumDeleted: number
  sumPromoted: number
  msgDeleted: number
  msgPromoted: number
  turnsPromoted: number
}

export function finalizeTask(root: string, owner: string): FinalizeCounts {
  const db = openTaskDb(root)
  const count = (sql: string, ...p: SqlValue[]): number => db.all<{ c: number }>(`SELECT COUNT(*) AS c ${sql}`, ...p)[0]?.c ?? 0
  const counts: FinalizeCounts = { sumDeleted: 0, sumPromoted: 0, msgDeleted: 0, msgPromoted: 0, turnsPromoted: 0 }
  try {
    // 摘要账清尾（task-v3）：covers 继承段的私有摘要是任务跑期间的脚手架
    // ——它的内容只服务于任务的窗口，对话的历史由对话自己的摘要器负责，
    // 删。covers 自己段的私有摘要还俗（owner→NULL）：任务的经历从此就是
    // 对话的历史，摘要跟着经历走。判据用 covers_from 对 stepFloor：段
    // 不会跨界（nextSegment 按 turn 切，继承 turn 和自己的 turn 不同段）
    const stepFloor = readTaskManifest(root, owner).stepFloor
    db.transaction(() => {
      // 继承段的摘要（fork 时的副本 + 任务替继承段做的私有摘要）要删；任务
      // 自己段的摘要若被一条跨界的父行收编，先解开，不然外键拦住删除
      db.run(
        `UPDATE summaries SET superseded_by = NULL
         WHERE superseded_by IN (SELECT id FROM summaries WHERE owner = ? AND covers_from <= ?)
           AND NOT (owner = ? AND covers_from <= ?)`,
        owner,
        stepFloor,
        owner,
        stepFloor,
      )
      counts.sumDeleted = count(`FROM summaries WHERE owner = ? AND covers_from <= ?`, owner, stepFloor)
      db.run(`DELETE FROM summaries WHERE owner = ? AND covers_from <= ?`, owner, stepFloor)
      counts.sumPromoted = count(`FROM summaries WHERE owner = ?`, owner)
      db.run(`UPDATE summaries SET owner = NULL WHERE owner = ?`, owner)
      // 消息副本（行归任务、轮归主任务）删掉；任务自己轮的行还俗
      counts.msgDeleted = count(`FROM messages WHERE owner = ? AND turn_id NOT IN (SELECT id FROM turns WHERE owner = ?)`, owner, owner)
      db.run(
        `DELETE FROM messages WHERE owner = ? AND turn_id NOT IN (SELECT id FROM turns WHERE owner = ?)`,
        owner,
        owner,
      )
      counts.msgPromoted = count(`FROM messages WHERE owner = ?`, owner)
      db.run(`UPDATE messages SET owner = NULL WHERE owner = ?`, owner)
      db.run(`DELETE FROM migrations WHERE name = ?`, copyMarker(owner))
      counts.turnsPromoted = count(`FROM turns WHERE owner = ?`, owner)
      const ownTurns = db.all<{ id: number }>(`SELECT id FROM turns WHERE owner = ?`, owner).map((r) => r.id)
      db.run(`UPDATE turns SET owner = NULL WHERE owner = ?`, owner)
      // 合并改写了主任务的前缀（任务的经历摘要从此渲染在主任务上下文里）。
      // 前缀不变式：合法改写只搭压缩的车——合并这一刻主任务会话多半不在手上，
      // 落一张「压缩车票」，主任务下一次请求把它当压缩触发（unloadIfNeeded
      // 的触发条件之一），allowRewrite 在那儿放行。丢弃路径不改主任务上下文，
      // 不需要
      db.run(
        `INSERT INTO migrations (name, ran_at) VALUES ('merge-rewrite-pending', ?)
         ON CONFLICT(name) DO UPDATE SET ran_at = excluded.ran_at`,
        new Date().toISOString(),
      )
      reindexTurns(db, ownTurns)
    })
  } finally {
    db.close()
  }
  rmSync(manifestPath(root, owner), { force: true })
  return counts
}

