import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureBucketFile, listBucketFiles, resolveBucketFile, turnBucket } from './buckets.ts'

/**
 * 一个 turn 的摘要文件，即索引树的**叶子**（提案 §4.3）。
 *
 * `summaries/000/turn-000087.md`，和 `turns/000/turn-000087.jsonl`（原始归档）成对，
 * 但两者完全不是一回事——归档几十到几百 KB 且不进 context，叶子约 600 字符
 * 且要么整段进 context（热）要么折叠成一行键（冷）。§4.1 有对照表。
 *
 * ## frontmatter 就是这个叶子的「键」
 *
 * `name` + `description` 由摘要模型和正文**一并生成**，内部节点直接读它们拼，
 * 不需要第二次调模型。这是 §3.2「内部节点只路由、不压缩」在实现上的落点：
 * 一个 turn 从原文降到「被内部节点一行盖住」，全程只有一次生成，
 * 所以 §1.3 那种「摘要的摘要的摘要，三层下来什么都不剩」在这里物理上
 * 产生不了。
 */
export type Leaf = {
  turn: number
  /** 短标题，进温区时显示这一行 */
  name: string
  /** 一句话说清这轮干了什么、留下什么没做。内部节点从这里取料 */
  description: string
  /**
   * 覆盖的 step 闭区间，和 `summaries.covers_from/to` 是同两个数。
   *
   * **参与逻辑，不只是给人看的**：`coversFrom` 是文件名的一部分（见 leafName），
   * 一个切了段的 turn 靠它区分几个叶子
   */
  coversFrom: number
  coversTo: number
  /** 四段正文（用户要求 / 实际完成 / 未完成失败 / 涉及文件），热区展开时用 */
  body: string
}

const SUMMARIES = 'summaries'

const pad = (n: number): string => String(n).padStart(6, '0')

/**
 * `turn-000087-s000123.md`——turn 号 + 覆盖的第一个 step。
 *
 * **turn 号不足以做文件名**：超过 `segmentTokens` 的 turn 会切成几段
 * （§4.3，实测 98 个 turn 出 160 个叶子），一个 turn 对应多个叶子，光用 turn
 * 号后写的会**静默覆盖**先写的——丢的是历史，而且不报错。
 *
 * 加的是 `covers_from` 而不是段序号：段序号要数「这是这个 turn 的第几段」，
 * 那是个需要回头查库的状态；step id 天然唯一、天然单调，写的时候手上就有。
 *
 * turn 号仍保留在最前面：和 `turns/000/turn-000087.jsonl` 对得上，人和模型都能
 * 一眼看出这个叶子讲的是哪一轮。
 */
export const leafName = (turn: number, from: number): string => `turn-${pad(turn)}-s${pad(from)}.md`

export const leafPath = (dir: string, turn: number, from: number): string =>
  join(dir, SUMMARIES, turnBucket(turn), leafName(turn, from))

export function formatLeaf(leaf: Leaf): string {
  return [
    '---',
    `name: ${oneLine(leaf.name)}`,
    `turn: ${leaf.turn}`,
    `covers: ${leaf.coversFrom}-${leaf.coversTo}`,
    `description: ${oneLine(leaf.description)}`,
    '---',
    '',
    leaf.body,
  ].join('\n')
}

/**
 * frontmatter 的值压成一行。**换行必须在写的时候消掉，不能指望读的时候容错。**
 *
 * `name` / `description` 是模型生成的，跑偏是常态（见 `parseLeaf`）。实测一条
 * 叶子的 `description` 里裹了整段跑飞的输出，原样写出去之后 frontmatter 摊成
 * **65 行**——后面那 60 行每一行都被当成 `key: value` 解析，`covers` 之类的
 * 真字段随时可能被其中一行同名覆盖掉。
 *
 * 更硬的一条：值里只要有一行正好是 `---`，`lines.indexOf('---', 1)` 就提前
 * 收在那里，frontmatter 和正文的边界整个飘掉。压成一行之后 `---` 不可能
 * 独占一行，这条从结构上消失。
 *
 * **不在 `parseLeaf` 那边补**：读侧只能猜哪一行是续行、哪一行是新字段，猜错
 * 不报错。写侧一次压平，往返就重新是确定的。
 */
const oneLine = (value: string): string => value.replace(/\s*\n\s*/g, ' ')

/**
 * 解析叶子文件。**坏文件返回 null，不抛。**
 *
 * 这些文件是模型生成的，格式跑偏是常态而不是异常；一个坏文件不该让整个
 * 索引树构建炸掉——那会让「历史全都看不见」，比少一个叶子严重得多。
 * 调用方按 null 走「这个 turn 只剩归档路径」的降级路径。
 */
export function parseLeaf(text: string): Leaf | null {
  const lines = text.split('\n')
  if (lines[0] !== '---') return null
  // **从第 1 行往后找第一个 `---`，不是 split('---')。** 正文里出现分隔线
  // （模型很爱写）会让 split 多切出一段，frontmatter 和正文的边界就飘了
  const end = lines.indexOf('---', 1)
  if (end === -1) return null

  const fields = new Map<string, string>()
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':')
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const turn = Number(fields.get('turn'))
  const [from, to] = parseCovers(fields.get('covers'))
  // covers 和 turn 一样是必需的：缺了就不知道这个叶子盖住哪一段，既定位不了
  // 文件名也接不进索引树，留着比丢掉更麻烦
  if (!Number.isInteger(turn) || from === null || to === null) return null

  return {
    turn,
    coversFrom: from,
    coversTo: to,
    name: fields.get('name') ?? '',
    description: fields.get('description') ?? '',
    // 跳过 `---` 后面那个空行。没有空行时 slice 到 end+1 也不会越界
    body: lines.slice(lines[end + 1] === '' ? end + 2 : end + 1).join('\n'),
  }
}

/** `7330-7338` → `[7330, 7338]`。解析不出来返回 `[null, null]` */
function parseCovers(raw: string | undefined): [number | null, number | null] {
  const at = raw?.indexOf('-') ?? -1
  if (raw === undefined || at <= 0) return [null, null]
  const from = Number(raw.slice(0, at))
  const to = Number(raw.slice(at + 1))
  if (!Number.isInteger(from) || !Number.isInteger(to)) return [null, null]
  return [from, to]
}

export function writeLeaf(dir: string, leaf: Leaf): void {
  // ensureBucketFile 顺手建桶目录，这里不用再 mkdir summaries/
  writeFileSync(
    ensureBucketFile(dir, SUMMARIES, leafName(leaf.turn, leaf.coversFrom)),
    formatLeaf(leaf),
    'utf8',
  )
}

/** 读不到或格式坏都返回 null——两种情况调用方的处理一样（走降级） */
export function readLeaf(dir: string, turn: number, from: number): Leaf | null {
  try {
    return parseLeaf(readFileSync(resolveBucketFile(dir, SUMMARIES, leafName(turn, from)), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 按 `coversFrom` 找叶子，**不需要知道 turn 号**。
 *
 * 拼 context 时手上只有 `summaries.covers_from`，turn 号不在那张表里。一次
 * `readdir` 定位、只读命中的那几个——`listLeaves` 会把叶子全读一遍，而热区
 * 只要两三个（§4.4），每轮请求都全读是白花的 IO。
 */
export function readLeavesByCovers(dir: string, froms: number[]): Map<number, Leaf> {
  const out = new Map<number, Leaf>()
  if (froms.length === 0) return out
  const files = listBucketFiles(dir, SUMMARIES, '.md') // 平铺 + 桶两层合并
  for (const from of froms) {
    const suffix = `-s${pad(from)}.md`
    const file = files.find((f) => f.endsWith(suffix))
    if (file === undefined) continue
    try {
      const leaf = parseLeaf(readFileSync(file, 'utf8'))
      if (leaf) out.set(from, leaf)
    } catch {
      // 坏文件跳过，调用方按「没有正文」走温区渲染
    }
  }
  return out
}

/**
 * 已有的叶子，**按 coversFrom 升序**。坏文件跳过——见 `parseLeaf` 的理由。
 *
 * 不按 turn 排：一个 turn 可能切成几段，按 turn 排的话同一个 turn 的几个叶子
 * 内部无序（`Array.sort` 稳定，实际落到 readdir 的顺序上），索引树按它们建
 * 出来的路由就会前后颠倒。covers 是全局单调的，用它没有并列
 */
export function listLeaves(dir: string): Leaf[] {
  return listBucketFiles(dir, SUMMARIES, '.md')
    .flatMap((file) => {
      try {
        const leaf = parseLeaf(readFileSync(file, 'utf8'))
        return leaf ? [leaf] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => a.coversFrom - b.coversFrom)
}
