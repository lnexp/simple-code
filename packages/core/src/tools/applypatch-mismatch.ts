/**
 * apply_patch 找不到上下文时的报错：指出第一处不一致在哪（note
 * apply-patch-mismatch-replay）。
 *
 * 只改报错、不改匹配。2026-10-26 回放三个项目 129 次失败：只给首行的旧报错
 * 有 37 次首行其实在文件里（真正对不上的在中间，如 t17121 注释折行连败 6 次）、
 * 26 次是漏抄了中间一行（每行单看都对）；对不上的行里抄错 58、空白/Unicode
 * 标点差异 0——所以不补 CX 的第 4 级标点归一，而是把「哪行、文件里实际是
 * 什么」直接摆出来。CX/OC 的报错是贴整个 chunk，同样不指位置。
 *
 * 比较一律用 trim 相等：与 seekSequence 最宽的一级同口径——这里认作「对上」
 * 的行，匹配时也会认。
 */

const same = (a: string, b: string): boolean => a.trim() === b.trim()

/** 字符二元组 Dice 系数：中英文都适用，差一两个字的长行 > 0.8 */
function similarity(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    const t = s.trim()
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const ga = grams(a)
  const gb = grams(b)
  let total = 0
  let common = 0
  for (const n of ga.values()) total += n
  for (const [g, n] of gb) {
    total += n
    common += Math.min(n, ga.get(g) ?? 0)
  }
  return total === 0 ? 0 : (2 * common) / total
}

/** 文件里与 pattern 连续对上最多行的起点（从首行起算），平手取靠前的 */
function longestPrefix(file: string[], pattern: string[]): { at: number; len: number } {
  let best = { at: -1, len: 0 }
  for (let i = 0; i < file.length; i++) {
    let k = 0
    while (k < pattern.length && i + k < file.length && same(file[i + k]!, pattern[k]!)) k++
    if (k > best.len) best = { at: i, len: k }
  }
  return best
}

const SIMILAR = 0.6

/** 0 起的起点 + 行数 → 「第 3 行」/「第 3–5 行」 */
const span = (at: number, len: number): string => (len === 1 ? `第 ${at + 1} 行` : `第 ${at + 1}–${at + len} 行`)

/**
 * 报错正文（接在「<路径>：」后面）。earlier = 从文件开头能找到这段的位置
 * ——从上一个 chunk 之后却找不到，就是 chunk 顺序写反了。行号 1 起算。
 */
export function describeMismatch(file: string[], pattern: string[], earlier: number | undefined): string {
  const head = '找不到要替换的行——'
  if (earlier !== undefined)
    return `${head}这段在文件第 ${earlier + 1} 行，在上一个 chunk 之前。一个文件的多个 @@ chunk 要按文件里的先后顺序写`
  const { at, len } = longestPrefix(file, pattern)
  // 整段都在却没匹配上：pos 之前的已被 earlier 接走、pos 之后的 seekSequence
  // 会找到——只剩 End of File 锚（只在末尾找）这一种可能
  if (len === pattern.length)
    return `${head}这段在文件${span(at, len)}，但不在文件末尾（*** End of File 要求贴着末尾）`
  if (len > 0) {
    const next = at + len < file.length ? `文件第 ${at + len + 1} 行：「${file[at + len]}」` : '文件到此已结束'
    return `${head}前 ${len} 行对上了文件${span(at, len)}，下一行对不上：\n  补丁：「${pattern[len]}」\n  ${next}`
  }
  const first = pattern[0] ?? ''
  let near = -1
  let score = SIMILAR
  file.forEach((line, i) => {
    const s = similarity(first, line)
    if (s >= score && (near < 0 || s > score)) [near, score] = [i, s]
  })
  if (near >= 0) return `${head}首行「${first}」在文件里找不到；最像的是文件第 ${near + 1} 行：「${file[near]}」`
  return `${head}首行「${first}」在文件里找不到，也没有相近的行——文件可能已改过，先重新读一遍文件再写补丁`
}
