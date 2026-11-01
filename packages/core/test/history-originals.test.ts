import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'
import { openDb } from '../src/session/db.ts'
import { restoreHistoryOriginals } from '../src/session/history-originals.ts'
import type { LiveMessage } from '../src/loop/assemble.ts'

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
