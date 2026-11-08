import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LiveMessage } from '../src/loop/assemble.ts'
import { openDb } from '../src/session/db.ts'
import { restoreHistoryOriginals } from '../src/session/history-originals.ts'

it('原文回放按 owner 隔离；同 step 的多条 user 按顺序配对，无原文不丢行', () => {
  mkdirSync('.simple-code/tmp/history-tests', { recursive: true })
  const root = mkdtempSync(resolve('.simple-code/tmp/history-tests/db-'))
  const db = openDb(join(root, 'test.db'))
  const message = (text: string) => ({
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  })
  const live: LiveMessage[] = ['问', '继续', '未保存的新消息'].map((text, i) => ({
    message: message(text),
    turnId: 1,
    stepId: i < 2 ? 1 : 2,
  }))
  try {
    db.exec(
      'CREATE TABLE messages(id INTEGER PRIMARY KEY, step_id INTEGER, role TEXT, content_json TEXT, state TEXT, owner TEXT)',
    )
    for (const [id, owner, text] of [
      [1, null, '原始问题'],
      [2, null, '原始继续'],
      [3, 'task', '任务私有'],
    ] as const)
      db.run(
        "INSERT INTO messages VALUES (?, 1, 'user', ?, 'unloaded', ?)",
        id,
        JSON.stringify(message(text)),
        owner,
      )
    const main = restoreHistoryOriginals(db, live, null)
    expect(main.restoredIds).toEqual([1, 2])
    expect(main.rows.map((r) => r.message)).toEqual([
      message('原始问题'),
      message('原始继续'),
      message('未保存的新消息'),
    ])
    const task = restoreHistoryOriginals(db, live.slice(0, 1), 'task')
    expect(task.restoredIds).toEqual([3])
    expect(task.rows[0]?.message).toEqual(message('任务私有'))
    expect(live[0]?.message).toEqual(message('问'))
    expect(restoreHistoryOriginals(db, [], null)).toEqual({ rows: [], restoredIds: [] })
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// 2026-11-06 fold 窗口版：只恢复最近 N 个不同 step 的原文，其余行
// 原样返回（存根）、rows 始终与输入等长——webview 靠 stepId 窗口集
// 打 stubbed 标聚合成占位
describe('恢复窗口（recentSteps）', () => {
  it('窗口外的行不恢复、窗口内的恢复，rows 等长', () => {
    const message = (text: string) => ({
      role: 'user' as const,
      parts: [{ type: 'text' as const, text }],
    })
    const root = mkdtempSync(join(tmpdir(), 'sc-orig-'))
    const db = openDb(join(root, 'state.db'))
    try {
      db.exec(
        'CREATE TABLE messages(id INTEGER PRIMARY KEY, step_id INTEGER, role TEXT, content_json TEXT, state TEXT, owner TEXT)',
      )
      // step 1-4 各一条 user 原文；live 是它们的存根
      for (const s of [1, 2, 3, 4]) {
        db.run(
          "INSERT INTO messages VALUES (?, ?, 'user', ?, 'unloaded', NULL)",
          s,
          s,
          JSON.stringify(message(`第${s}步原文`)),
        )
      }
      const live = [1, 2, 3, 4].map((s) => ({ stepId: s, turnId: s, message: message(`第${s}步存根`) }))
      // 窗口 2：只有 step 3、4 恢复
      const w = restoreHistoryOriginals(db, live, null, 2)
      expect(w.restoredIds).toEqual([3, 4])
      expect(w.rows.map((r) => r.message)).toEqual([
        message('第1步存根'),
        message('第2步存根'),
        message('第3步原文'),
        message('第4步原文'),
      ])
      // 不传 = 全量（现有调用方零改动）
      const full = restoreHistoryOriginals(db, live, null)
      expect(full.restoredIds).toEqual([1, 2, 3, 4])
      // 窗口大于 step 数 = 全量
      expect(restoreHistoryOriginals(db, live, null, 99).restoredIds).toEqual([1, 2, 3, 4])
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
