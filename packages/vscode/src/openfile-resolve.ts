/**
 * openFile 兜底解析：模型给的相对路径常不是「根相对」而是包片段
 * （domain/entity/X.java 真身在 src/main/java/.../domain/entity/）。
 * 拼工作区根打不开时，按 basename 收集项目内候选，尾部段连续匹配评分
 * 取最优。纯函数，panel.ts 接 vscode.workspace.findFiles 喂候选
 */

/** 候选 p 的尾部能和 relSegs 连续对齐几段（0=只有 basename 命中） */
export function suffixSegments(candidate: string, relSegs: string[]): number {
  const candSegs = candidate.split('/')
  let i = relSegs.length - 1
  let j = candSegs.length - 1
  let n = 0
  // basename 已由调用方保证相等，从倒数第二段起对齐
  while (i > 0 && j > 0 && relSegs[i - 1] === candSegs[j - 1]) {
    n++
    i--
    j--
  }
  return n
}

/** 候选里选最优：尾部对齐段最多者；并列取路径短者（同构包里浅的更可能是主源） */
export function bestCandidate(relSegs: string[], candidates: string[]): string | null {
  if (candidates.length === 0) return null
  let best = candidates[0] as string
  let bestScore = -1
  for (const c of candidates) {
    const s = suffixSegments(c, relSegs) * 1000 - c.split('/').length
    if (s > bestScore) {
      best = c
      bestScore = s
    }
  }
  return best
}
