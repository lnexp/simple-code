import { SELECTION_TEXT_LIMIT } from '../src/editor-ref.ts'
import type { ActiveEditor } from '../src/protocol.ts'
import { toDisplayPath } from './dropPaths.ts'

/**
 * 底栏「当前文件」按钮（2026-11-10 方案 1，原型与拍板见 note
 * vscode-explorer-drag-webview）：默认不带，点一下把编辑器当前文件/选区加进
 * 附件行——和 Explorer 拖进来的路径同一行。有选区带行号和原文，没选区只带路径。
 *
 * 附件行仍是 string[]：选区附件是「标签\n代码块」一整段，chip 只显示首行
 * （attachLabel），发送时原样拼进消息（composeWithAttachments 不用改）。
 */

const rangeOf = (ed: ActiveEditor): string =>
  ed.start === undefined ? '' : ed.start === ed.end ? `:${ed.start}` : `:${ed.start}-${ed.end}`

/** 附件标签：项目内相对路径 + 行号（单行 :12，多行 :5-9） */
export function refLabel(ed: ActiveEditor, root: string): string {
  return toDisplayPath(ed.path, root) + rangeOf(ed)
}

/** 发出去的附件：有原文 = 标签 + 代码块；没有 = 只有标签 */
export function refBlock(ed: ActiveEditor, root: string): string {
  const label = refLabel(ed, root)
  if (ed.text === undefined) return label
  // 围栏比原文里最长的一串反引号多一个：选中的是 markdown 时不会提前闭合
  const longest = Math.max(0, ...(ed.text.match(/`+/g) ?? []).map((s) => s.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const lang = /\.(\w+)$/.exec(ed.path)?.[1] ?? ''
  return `${label}\n${fence}${lang}\n${ed.text}\n${fence}`
}

/** 附件 chip 显示的那一行：选区附件只显示标签，不显示原文 */
export const attachLabel = (a: string): string => a.split('\n', 1)[0] ?? a

function describe(ed: ActiveEditor, label: string): string {
  if (ed.start === undefined) return `${label}（整个文件，只带路径）`
  const n = (ed.end ?? ed.start) - ed.start + 1
  return ed.text === undefined
    ? `${label}（${n} 行，超过 ${SELECTION_TEXT_LIMIT} 行只带路径和行号）`
    : `${label}（${n} 行原文）`
}

export function CurrentFileButton({
  editor,
  root,
  attached,
  onAdd,
}: {
  /** null = 当前不是文件（设置页、没开编辑器）：不渲染 */
  editor: ActiveEditor | null
  root: string
  attached: readonly string[]
  onAdd: (attachment: string) => void
}) {
  if (editor === null) return null
  const label = refLabel(editor, root)
  const added = attached.some((a) => attachLabel(a) === label)
  const name = editor.path.replace(/\\/g, '/').split('/').pop()
  return (
    <button
      type="button"
      className={`usage-ctx cur-file${added ? ' is-added' : ''}`}
      title={`${added ? '已在附件里' : '点一下加进附件'}：${describe(editor, label)}`}
      onClick={() => {
        if (!added) onAdd(refBlock(editor, root))
      }}
    >
      {/* 文件图标而不是加号（2026-11-11 用户选）：底栏邻居（上下文环、记忆）
          都是「东西」的图标，加号是动作、细得像文字「+」；动作写在悬停提示里 */}
      <i className={`codicon codicon-${added ? 'check' : 'file'}`} aria-hidden="true" />
      <span className="cf-label">{name + rangeOf(editor)}</span>
    </button>
  )
}
