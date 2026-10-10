// 摘要/压缩状态的只读不变式检查（2026-09-30，观察期脚本，未进产品）。
//
// 为什么：前缀有 prefix-guard 当场报错，摘要状态没有守卫——历史空洞、
// 孤儿、互罩这些 bug 都是事后手工翻库才发现（4de7729 的 409 步空洞坏了
// 好几天）。先手工跑、观察一两周无误报，再决定要不要搬进压缩点。
//
// 用法：node scripts/check-invariants.mjs <工作区目录>...（缺省当前目录）
// 只读打开 state.db；有违反退出码 1，并列出前几个样本 id。
//
// 口径只看主任务（owner IS NULL）的 I4/I5：任务的私有段在关闭前本就
// 自成一套。设计允许的中间态不算违反（第一版误判过，已排除）：
//   - 尾部空洞：step 已卸、摘要 ready 排队，等下一个压缩点进场（compaction-v2）
//   - 存根：step.unloaded=1 的 live 行是存根，不是原文

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CHECKS = [
  {
    id: 'I1',
    what: '在场摘要互相重叠（同一 owner）',
    sql: `SELECT a.id || '/' || b.id AS s FROM summaries a JOIN summaries b
          ON a.id < b.id AND a.in_context = 1 AND b.in_context = 1
          AND coalesce(a.owner, '') = coalesce(b.owner, '')
          AND a.covers_from <= b.covers_to AND b.covers_from <= a.covers_to`,
  },
  {
    id: 'I2',
    what: '已被顶替却仍在场',
    // 顶替者已在场、被顶替的孩子还在场 = 真孤儿。只排除「顶替者自己还没
    // 进场」的行：合并落库与下一次压缩点之间，孩子在场是设计内暂态
    // （applyPendingMerges 没跑而已，上下文用的还是孩子们，无损）
    sql: `SELECT c.id AS s FROM summaries c
          WHERE c.in_context = 1 AND c.superseded_by IS NOT NULL
          AND EXISTS (SELECT 1 FROM summaries p WHERE p.id = c.superseded_by AND p.in_context = 1)`,
  },
  {
    id: 'I3',
    what: 'superseded_by 指向不存在的行',
    sql: `SELECT id AS s FROM summaries c WHERE superseded_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM summaries p WHERE p.id = c.superseded_by)`,
  },
  {
    id: 'I4',
    what: '中段空洞：已卸 step 无在场摘要覆盖，且低于在场摘要最高 step',
    sql: `SELECT st.id AS s FROM steps st JOIN turns t ON t.id = st.turn_id
          WHERE st.unloaded = 1 AND t.owner IS NULL
          AND st.id < (SELECT coalesce(max(covers_to), 0) FROM summaries WHERE in_context = 1 AND owner IS NULL)
          AND NOT EXISTS (SELECT 1 FROM summaries s WHERE s.in_context = 1 AND s.owner IS NULL
                          AND st.id BETWEEN s.covers_from AND s.covers_to)`,
  },
  {
    id: 'I5',
    what: '双份：未卸的原文 step 同时被在场摘要覆盖',
    sql: `SELECT DISTINCT m.step_id AS s FROM messages m JOIN turns t ON t.id = m.turn_id
          JOIN steps st ON st.id = m.step_id
          WHERE m.state = 'live' AND st.unloaded = 0 AND t.owner IS NULL AND m.owner IS NULL
          AND EXISTS (SELECT 1 FROM summaries s WHERE s.in_context = 1 AND s.owner IS NULL
                      AND m.step_id BETWEEN s.covers_from AND s.covers_to)`,
  },
]

const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [process.cwd()]
let bad = 0
for (const d of dirs) {
  const root = resolve(d)
  const file = join(root, '.simple-code', 'memory', 'state.db')
  if (!existsSync(file)) {
    console.log(`== ${root}：没有 state.db，跳过`)
    continue
  }
  const db = new DatabaseSync(file, { readOnly: true })
  console.log(`== ${root}`)
  for (const c of CHECKS) {
    const t0 = performance.now()
    const rows = db.prepare(c.sql).all()
    const ms = (performance.now() - t0).toFixed(0)
    const mark = rows.length === 0 ? 'ok ' : 'BAD'
    if (rows.length > 0) bad++
    const sample = rows.slice(0, 8).map((r) => r.s).join(', ')
    console.log(`  ${mark} ${c.id} ${c.what}：${rows.length}${sample ? `  [${sample}]` : ''}  (${ms}ms)`)
  }
  // I6 任务残留：库里有 owner 行但 .simple-code/tasks/<owner>.json 不在 = 关闭中断
  const tasksDir = join(root, '.simple-code', 'tasks')
  const manifests = new Set(existsSync(tasksDir) ? readdirSync(tasksDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [])
  const owners = db.prepare(`SELECT DISTINCT owner AS o FROM turns WHERE owner IS NOT NULL
                             UNION SELECT DISTINCT owner FROM messages WHERE owner IS NOT NULL
                             UNION SELECT DISTINCT owner FROM summaries WHERE owner IS NOT NULL`).all().map((r) => r.o)
  const orphan = owners.filter((o) => !manifests.has(o))
  if (orphan.length > 0) bad++
  console.log(`  ${orphan.length === 0 ? 'ok ' : 'BAD'} I6 库里有 owner 行但没有 manifest（任务关闭中断）：${orphan.length}${orphan.length ? `  [${orphan.join(', ')}]` : ''}`)
  db.close()
}
process.exit(bad > 0 ? 1 : 0)
