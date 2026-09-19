import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * **`node:sqlite` 的调用只出现在这个文件里。** 上层拿到的是 `Db` 接口。
 *
 * 这不是为了"将来可能换实现"的灵活性（CLAUDE.md §2），是为了兑现一条具体的
 * 换回条件：design.md §9.8 原本选的是 better-sqlite3，我们改用内置模块，
 * 理由是省掉 native module（第 5 步 vsce 打包要按 平台×ABI 出多份 vsix）。
 * 但 `node:sqlite` 要 Node ≥ 22.5 且 API 标着 experimental——
 *
 * **第 5 步如果发现目标编辑器的 Node < 22.5，或这个 API 破坏性变更了，
 * 换回 better-sqlite3。改动范围就是这个文件。** 没有这层隔离，"改一个文件"
 * 是空话。
 *
 * 2026-08-26 目标编辑器定为 Cursor，**换回条件不成立**：在它的扩展宿主运行时
 * 里（`ELECTRON_RUN_AS_NODE=1`，Cursor 3.14.7 / Electron 40.10.3 /
 * Node 24.15.0）跑通了 WAL 和 BEGIN/COMMIT。之前只测过命令行的 node 二进制，
 * 那和扩展宿主是两个运行时。VS Code 官方稳定版仍未测（本机没装）。
 */
export type Db = {
  exec(sql: string): void
  /** 无返回值的写。参数按位置绑定 */
  run(sql: string, ...params: SqlValue[]): void
  all<T>(sql: string, ...params: SqlValue[]): T[]
  /** 整体成功或整体不发生。§9.8 的「生效是一个事务」靠它 */
  transaction(body: () => void): void
  close(): void
}

export type SqlValue = string | number | null

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)

  // WAL：崩溃一致性的前提。默认的 rollback journal 在 kill -9 时也能恢复，
  // 但 WAL 下读不阻塞写——第 3 步后台摘要要一边读一边写
  db.exec('PRAGMA journal_mode = WAL')
  // NORMAL 而不是 FULL：FULL 每次 commit 都 fsync，我们每条消息一次事务，
  // 那会把每轮对话变成几十次 fsync。WAL + NORMAL 下丢的最多是最后几次
  // commit，且**不会损坏数据库**——我们能承受丢最后一条消息，不能承受库坏
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params)
    },
    all: <T>(sql: string, ...params: SqlValue[]): T[] =>
      db.prepare(sql).all(...params) as unknown as T[],
    transaction: (body) => {
      db.exec('BEGIN')
      try {
        body()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    close: () => db.close(),
  }
}

/** 只读连接：CLI 侧查 FTS 用（memory search 的 tryFtsTurns）。
 * 绝不开写——写路径只有宿主进程（save 尾部的 syncSearchIndex），
 * CLI 抢写会和宿主撞 SQLITE_BUSY。库不存在/被锁由调用方 catch 回退。 */
export function openDbReadOnly(path: string): Db {
  const db = new DatabaseSync(path, { readOnly: true })
  return {
    exec: (sql) => db.exec(sql),
    run: () => {
      throw new Error('只读连接不许写')
    },
    all: <T>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as unknown as T[],
    transaction: () => {
      throw new Error('只读连接不许写')
    },
    close: () => db.close(),
  }
}
