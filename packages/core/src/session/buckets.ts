import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * memory 归档的分桶路径规则——**唯一权威**，store/leaf/memory CLI/search-index
 * 都从这里拿路径，不允许各自拼 `turns/turn-xxx.jsonl`。
 *
 * ## 为什么分桶
 *
 * 单目录文件数不影响 agent 的三条访问路径（点读 O(log n)、FTS 查询、
 * db 元数据），先有感的是**人**：Finder、Time Machine、裸 `ls` 刷屏。
 * 实测 readdir 到 10 万级才进百 ms（docs/design.md §14），按当前增速阈值
 * 在数年之后，但规则现在就定死，避免新老格式混着长。
 *
 * ## 规则
 *
 * - `turns/`、`summaries/`：按 turn 号千位分桶。`turn-000312.jsonl` →
 *   `turns/000/`；`turn-001234.jsonl` → `turns/001/`。文件名前缀
 *   `turn-NNNNNN` 里的号就是桶依据，叶子（`turn-000312-s000123.md`）同款。
 * - `raw/`：名字是 `call_<hex>.log` 这类，取**倒数第 6、5 个字符**（去掉
 *   `.log` 后 hex 的尾部两位）做桶。不用前缀：`call_`/`toolu_` 前缀不统一，
 *   而尾部 hex 均匀分布，256 桶足够把 10 万文件压到每桶 ~400。
 *
 * ## 兼容
 *
 * 写侧永远写桶内；读侧 `resolveBucketFile` 先桶后平铺双探测——老库
 * （含没跑过迁移的备份恢复）的平铺文件照样读得到。`openStore` 启动时
 * `migrateToBuckets` 幂等地把平铺老文件挪进桶，之后双探测只剩快路径。
 */

const TURNS = 'turns'
const SUMMARIES = 'summaries'
const RAW = 'raw'

/** turn 号 → 千位桶目录名（3 位零填充，撑到 100 万 turn）。 */
export const turnBucket = (turn: number): string => String(Math.floor(turn / 1000)).padStart(3, '0')

/**
 * 文件名 → 桶目录名。turns/summaries 的文件名以 `turn-NNNNNN` 开头，解析
 * 里面的号；raw 的名字取倒数第 6、5 字符。两种形状都认不出来时归 `000`
 * （宁可挤一个桶，不能因为命名跑偏把文件写丢）。
 */
export function bucketOf(fileName: string): string {
  const m = /^turn-(\d{6})/.exec(fileName)
  if (m) return turnBucket(Number(m[1]))
  if (fileName.length >= 6) return fileName.slice(-6, -4)
  return '000'
}

/** 桶内相对路径（相对 memory 根）：`turns/000/turn-000312.jsonl`。 */
export const bucketedRel = (subdir: string, fileName: string): string =>
  join(subdir, bucketOf(fileName), fileName)

/**
 * **写侧**入口：返回绝对路径并确保桶目录存在。`mkdirSync` 幂等且
 * recursive，每个桶每进程只真建一次，后续调用是几次 stat 的代价。
 */
export function ensureBucketFile(memoryDir: string, subdir: string, fileName: string): string {
  const abs = join(memoryDir, subdir, bucketOf(fileName), fileName)
  mkdirSync(dirname(abs), { recursive: true })
  return abs
}

/**
 * **读侧**入口：先桶后平铺双探测。都不存在时返回平铺形状——让调用方的
 * 「文件不存在」报错里出现模型熟悉的路径，而不是一个它猜不出来的桶路径。
 */
export function resolveBucketFile(memoryDir: string, subdir: string, fileName: string): string {
  const bucketed = join(memoryDir, subdir, bucketOf(fileName), fileName)
  if (existsSync(bucketed)) return bucketed
  return join(memoryDir, subdir, fileName)
}

/**
 * 列目录：平铺层 + 所有桶目录，合并出全部文件（按文件名排序，桶间序即
 * turn 序）。老库没迁移时平铺层有货；迁移后平铺层空，纯桶遍历。
 * 桶名形状：turns/summaries 是 3 位数字（`000`），raw 是 2 位 sanitize
 * 字符（`x1`、`0f`……）——不匹配的不递归，那是人手工放的东西，不掺和。
 */
export function listBucketFiles(memoryDir: string, subdir: string, ext: string): string[] {
  const top = join(memoryDir, subdir)
  if (!existsSync(top)) return []
  const out: string[] = []
  for (const entry of readdirSync(top, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(ext)) out.push(join(top, entry.name))
    else if (entry.isDirectory() && /^(\d{3}|[A-Za-z0-9_-]{2})$/.test(entry.name)) {
      for (const f of readdirSync(join(top, entry.name))) {
        if (f.endsWith(ext)) out.push(join(top, entry.name, f))
      }
    }
  }
  return out.sort((a, b) => basename(a).localeCompare(basename(b)))
}

/**
 * 一次性迁移：把三个子目录平铺层的归档文件挪进各自桶。幂等——目标已
 * 存在视为已迁移（跳过，不覆盖）。返回挪动数，0 表示无事可做。
 *
 * 只在 `openStore` 启动时调用。`renameSync` 原子，中断后重跑即可；
 * 挪完文件后 db 里 `summaries.archive_path` 的老平铺指路牌由调用方重写。
 */
export function migrateToBuckets(memoryDir: string): number {
  // 按子目录 + 扩展名认领，不按名字前缀猜：raw 的 toolCallId 前缀随
  // provider 走（call_/toolu_/…），列不全；而「turns 下的 .jsonl、
  // summaries 下的 .md、raw 下的 .log」就是我们管的全部，手工放的
  // 别的扩展名不碰
  const EXT: Record<string, string> = {
    [TURNS]: '.jsonl',
    [SUMMARIES]: '.md',
    [RAW]: '.log',
  }
  let moved = 0
  for (const subdir of [TURNS, SUMMARIES, RAW]) {
    const top = join(memoryDir, subdir)
    if (!existsSync(top)) continue
    for (const entry of readdirSync(top, { withFileTypes: true })) {
      const ext = EXT[subdir]
      if (ext === undefined || !entry.isFile() || !entry.name.endsWith(ext)) continue
      const from = join(top, entry.name)
      const to = ensureBucketFile(memoryDir, subdir, entry.name)
      if (existsSync(to)) continue
      renameSync(from, to)
      moved++
    }
  }
  return moved
}
