/**
 * search 观测（2026-10-23）：向量检索的重评条件是「看 2~3 周 search miss」，
 * runlog 原先不记 search，到期没有数据。每次 search 记一行：库、查询词、命中数。
 *
 * 同步写、不走 logRun：bin 随后可能直接 process.exit，logRun 的异步串行链
 * 会被截断丢行。写失败吞掉——观测不能让 search 本身失败（同 runlog.ts）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runLogPath } from '@simple-code/core/src/runlog.ts'

export function logSearch(lib: string, folder: string, query: string, hits: number, hidden = 0): void {
  try {
    const path = runLogPath()
    mkdirSync(dirname(path), { recursive: true })
    const ev = { at: new Date().toISOString(), pid: process.pid, ev: 'search', lib, folder, query, hits }
    appendFileSync(path, JSON.stringify(hidden > 0 ? { ...ev, hidden } : ev) + '\n')
  } catch {
    // 见文件头
  }
}

/** 从 note/lesson/skill/event 的 search 渲染文本数命中：「N 条命中：」或
 *  event 的「- name」行；被时间衰减收起的条数取 decayNotice「另有 N 条」 */
export function logSearchText(lib: string, folder: string, query: string, text: string): void {
  const n = /^(\d+) 条命中：/.exec(text)?.[1]
  const hits = n !== undefined ? Number(n) : text.split('\n').filter((l) => l.startsWith('- ')).length
  logSearch(lib, folder, query, hits, Number(/另有 (\d+) 条/.exec(text)?.[1] ?? 0))
}
