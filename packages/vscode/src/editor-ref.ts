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
 * 活动标签不是文本编辑器时（2026-11-11 用户要图片也能加）：扩展的 custom
 * editor、notebook 标签有 uri——本地文件就只带路径，同 Explorer 拖入图片
 * （dropPaths.ts：图片不内联，模型用 view_image 看）。
 * diff（original/modified）、webview、终端没有 uri，不给。按字段认不按类：
 * 这里不 import vscode。
 *
 * 真机实测（2026-11-20，VS Code 1.144）：**内置图片预览的 input 是
 * undefined**——ext host 的 _initInput switch 认不出的 editor 一律
 * undefined，内置 ImagePreview/Markdown 预览没接入序列化。这类标签只剩
 * label（文件名，无路径），走 fileNameFromLabel + findFiles 兜底（panel.ts）
 */
export function tabRef(input: unknown): ActiveEditor | null {
  if (typeof input !== 'object' || input === null || !('uri' in input)) return null
  const uri = input.uri as { scheme?: unknown; fsPath?: unknown }
  return uri.scheme === 'file' && typeof uri.fsPath === 'string' ? { path: uri.fsPath } : null
}

/**
 * tab 的 label 像「纯文件名」（内置图片预览只给这个）才值得 findFiles 兜底。
 * 认定标准：无路径分隔符、有点分隔的 1-8 位字母数字扩展名、点不在开头
 * （「设置」「输出」这类面板名、带「 — 预览」后缀的都不认）
 */
export function fileNameFromLabel(label: string): string | null {
  if (label.includes('/') || label.includes('\\')) return null
  const i = label.lastIndexOf('.')
  return i > 0 && /^[A-Za-z0-9]{1,8}$/.test(label.slice(i + 1)) ? label : null
}

/** findFiles 的 include 是 glob：文件名里的 * ? [ ] 转成字符类，按字面匹配 */
export function globEscape(name: string): string {
  return name.replace(/[*?[\]]/g, (ch) => (ch === ']' ? '[]]' : `[${ch}]`))
}
