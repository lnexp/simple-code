import { applyEdits, modify, type ParseError, parse } from 'jsonc-parser'
import { asObject } from './settings-edit.ts'

/**
 * 设置页写操作用到的 jsonc 机械细节（从 settings-write.ts 拆出）：
 * 修改格式、模型条目的值形态、删键与删空容器。纯文本进纯文本出。
 */

/** jsonc modify 的通用选项：2 空格缩进，与 README 快速开始一致 */
export const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

/** 一个模型条目的值（新增/编辑共用） */
export const modelBody = (contextWindow: number, images: boolean): Record<string, unknown> => ({
  contextWindow,
  ...(images ? { capabilities: { images: true } } : {}),
})

/** 删一个键。不存在就原样返回——jsonc 对不存在的路径做删除会抛
 *  "Can not delete in empty document"，而「把没有的键删掉」对用户就是
 *  成功（回到默认态），不该报错 */
export function deleteKey(text: string, path: (string | number)[]): string {
  if (!hasAt(text, path)) return text
  return applyEdits(text, modify(text, path, undefined, FMT))
}

function hasAt(text: string, path: (string | number)[]): boolean {
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return false
  let cur: unknown = parsed
  for (const seg of path) {
    cur = asObject(cur)[seg]
    if (cur === undefined) return false
  }
  return true
}

/** 删空了的容器键一并删掉（`"memory": {}`、`"recall": {}`）——留着合法
 *  但碍眼，还会挡住「没写 = 默认」的语义。models 不在此列：必填键 */
export function pruneEmpty(text: string, ...paths: string[][]): string {
  let out = text
  for (const path of paths) out = pruneAt(out, path)
  return out
}

function pruneAt(text: string, path: string[]): string {
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) return text
  let cur: unknown = parsed
  for (const seg of path) {
    cur = asObject(cur)[seg]
    if (cur === undefined) return text
  }
  if (typeof cur !== 'object' || cur === null || Object.keys(asObject(cur)).length > 0) return text
  return applyEdits(text, modify(text, path, undefined, FMT))
}
