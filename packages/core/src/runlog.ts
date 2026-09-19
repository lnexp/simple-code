/**
 * 运行日志：`~/.simple-code/logs/YYYY-MM-DD.jsonl`，按天一文件。
 *
 * **为什么放用户目录而不是项目 `.simple-code/`**：它记录的是「这个安装
 * 上发生过什么」——LLM 请求成败、重试、审批、工具失败——跨项目，跟着
 * 用户走（与 `~/.simple-code/skills/` 同一约定）。
 *
 * **只记元数据不记内容**：不落请求 body、不落响应文本、不落对话。一行
 * 一个 JSON，人能直接 cat，grep 也能吃。
 *
 * **日志失败绝不影响主流程**：所有写盘异常吞掉。观测手段自己把宿主拖死
 * 就本末倒置了。代价是路径坏了只有静默——但这类问题「日志文件没出现」
 * 本身就是信号。
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 天数。运行日志只服务「最近的异常排查」，历史对话自己有 turns/*.jsonl */
const RETAIN_DAYS = 14

/**
 * 文件名按 **UTC** 切天，跟行内 `at`（`toISOString()`）同一把尺子。
 *
 * 原来用 `getFullYear/getMonth/getDate`（本地时区），和内容对不上：东八区
 * 早上 7:30 的事件会写进 `2026-09-18.jsonl`，而那行的 `at` 是
 * `2026-09-17T23:30Z`——文件名说 18 号、内容说 17 号。读日志的人（含 agent）
 * 很容易把 UTC 时刻当本地读，2026-09-18 定位缓存过期问题时就先被带偏了
 * 一轮：把 `13:08Z` 当成下午 1 点，得出「隔了 8 小时」的错误结论，而 8 小时
 * 恰好是时区差。
 *
 * 代价是切天点落在本地时间早上 8 点，人按「今天」找当天日志会横跨两个文件
 * ——但日志首先是给程序和 grep 用的，口径一致比人肉方便更重要。
 */
const fileName = (d = new Date()): string => `${d.toISOString().slice(0, 10)}.jsonl`

const isDateLog = (name: string): boolean => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)

/** 返回写往哪个目录的 logRun；dir 显式传入主要给测试，生产走默认 */
export function logRunTo(dir: string): (ev: Record<string, unknown>) => void {
  let purged = false
  /** 串行链：写盘严格排队。不排的话连发两行，第二行的 appendFile 会在
   *  第一行的 mkdir 完成前撞 ENOENT——fire-and-forget 把它吞掉，日志
   *  无声丢行（全量测试抓的：单跑过、并发挂） */
  let chain: Promise<void> = Promise.resolve()
  const write = (ev: Record<string, unknown>): void => {
    // 时钟只读一次，`at` 和文件名共用：分两次读的话，写盘排在串行链里，
    // 跨 UTC 午夜的那一瞬 at 记前一天、文件名却算成后一天，这一行就落错了
    // 文件。真机上概率极低，但正是「文件名与内容对不上」的另一个来源
    const now = new Date()
    const line =
      JSON.stringify({
        at: now.toISOString(),
        pid: process.pid,
        ...ev,
      }) + '\n'

    // 懒初始化：第一次真正写日志时才建目录、清旧文件——不写日志的短命
    // 进程（一次性脚本、纯测试）不碰用户目录
    if (!purged) {
      purged = true
      chain = chain
        .then(() => mkdir(dir, { recursive: true }))
        .then(() => purgeOld(dir))
        .catch(() => {})
    }
    chain = chain.then(() => appendFile(join(dir, fileName(now)), line, 'utf8')).catch(() => {})
  }
  return write
}

/** 默认实例：~/.simple-code/logs/。模块加载时不建目录（见上） */
export const logRun = logRunTo(join(homedir(), '.simple-code', 'logs'))

async function purgeOld(dir: string): Promise<void> {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 3600_000
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!isDateLog(name)) continue // 只动自己命名规则的文件，别碰用户手放的
    // 带 Z：文件名现在是 UTC 日期，不带 Z 会按本地时区解析，切天点差一个时区
    const day = Date.parse(`${name.slice(0, 10)}T00:00:00Z`)
    if (Number.isFinite(day) && day < cutoff) await unlink(join(dir, name)).catch(() => {})
  }
}

/** 测试与探测用：算出来会写哪个文件（不写盘） */
export const runLogPath = (): string => join(homedir(), '.simple-code', 'logs', fileName())
