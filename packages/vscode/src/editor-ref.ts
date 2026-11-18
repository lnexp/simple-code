import type { ActiveEditor } from './protocol.ts'

/**
 * 底栏「当前文件」按钮的数据（2026-11-10 方案 1，原型见 note
 * vscode-explorer-drag-webview）：编辑器选区 → 路径 + 整行行号 + 原文。
 * 不 import vscode（panel.ts 只做接线），能直接测。
 */

/** 选区超过这么多行只带路径和行号，不带原文（原型定的 200） */
export const SELECTION_TEXT_LIMIT = 200

/** vscode.Selection 用到的那几个字段（0 起） */
export type SelectionLike = {
  isEmpty: boolean
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export function editorRef(
  path: string,
  sel: SelectionLike,
  lineText: (line: number) => string,
): ActiveEditor {
  if (sel.isEmpty) return { path }
  const start = sel.start.line
  // 拖行号栏/三击选整行时终点落在下一行第 0 列——那一行其实没选
  const end = sel.end.line > start && sel.end.character === 0 ? sel.end.line - 1 : sel.end.line
  const ref: ActiveEditor = { path, start: start + 1, end: end + 1 }
  if (end - start + 1 > SELECTION_TEXT_LIMIT) return ref
  // 整行而不是选中的那几个字：行号标签说的是「这几行」，原文得对得上
  const lines: string[] = []
  for (let i = start; i <= end; i++) lines.push(lineText(i))
  return { ...ref, text: lines.join('\n') }
}

/**
 * 活动标签不是文本编辑器时（2026-11-11 用户要图片也能加）：图片/PDF 预览是
 * TabInputCustom、notebook 是 TabInputNotebook，都有 uri——本地文件就只带路径，
 * 同 Explorer 拖入图片（dropPaths.ts：图片不内联，模型用 view_image 看）。
 * diff（original/modified）、webview、终端没有 uri，不给。按字段认不按类：
 * 这里不 import vscode
 */
export function tabRef(input: unknown): ActiveEditor | null {
  if (typeof input !== 'object' || input === null || !('uri' in input)) return null
  const uri = input.uri as { scheme?: unknown; fsPath?: unknown }
  return uri.scheme === 'file' && typeof uri.fsPath === 'string' ? { path: uri.fsPath } : null
}
