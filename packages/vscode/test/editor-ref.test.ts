import { describe, expect, it } from 'vitest'
import { editorRef, SELECTION_TEXT_LIMIT, type SelectionLike, tabRef } from '../src/editor-ref.ts'

/** 0 起行号 → 「第 N 行」（N 为 1 起），一眼能对上 */
const lineText = (i: number): string => `第 ${i + 1} 行`
const sel = (a: [number, number], b: [number, number]): SelectionLike => ({
  isEmpty: a[0] === b[0] && a[1] === b[1],
  start: { line: a[0], character: a[1] },
  end: { line: b[0], character: b[1] },
})

describe('editorRef：编辑器选区 → 当前文件按钮的数据', () => {
  it('没选区：只给路径，不带行号和原文', () => {
    expect(editorRef('/p/a.ts', sel([3, 2], [3, 2]), lineText)).toEqual({ path: '/p/a.ts' })
  })

  it('选了一行里的几个字：给整行（行号标签说的是这一行）', () => {
    expect(editorRef('/p/a.ts', sel([4, 3], [4, 9]), lineText)).toEqual({
      path: '/p/a.ts',
      start: 5,
      end: 5,
      text: '第 5 行',
    })
  })

  it('拖行号栏选 5-9 行：终点落在第 10 行第 0 列，第 10 行不算', () => {
    const r = editorRef('/p/a.ts', sel([4, 0], [9, 0]), lineText)
    expect(r).toMatchObject({ start: 5, end: 9 })
    expect(r.text?.split('\n')).toEqual(['第 5 行', '第 6 行', '第 7 行', '第 8 行', '第 9 行'])
  })

  it('对照：终点在第 10 行中间，第 10 行算', () => {
    expect(editorRef('/p/a.ts', sel([4, 0], [9, 1]), lineText)).toMatchObject({ start: 5, end: 10 })
  })

  it(`正好 ${SELECTION_TEXT_LIMIT} 行带原文，多一行就只带行号`, () => {
    const at = editorRef('/p/a.ts', sel([0, 0], [SELECTION_TEXT_LIMIT - 1, 4]), lineText)
    expect(at.text?.split('\n')).toHaveLength(SELECTION_TEXT_LIMIT)
    const over = editorRef('/p/a.ts', sel([0, 0], [SELECTION_TEXT_LIMIT, 4]), lineText)
    expect(over).toEqual({ path: '/p/a.ts', start: 1, end: SELECTION_TEXT_LIMIT + 1 })
  })
})

describe('tabRef：非文本标签 → 只带路径', () => {
  const file = (fsPath: string) => ({ scheme: 'file', fsPath })
  it('图片预览（TabInputCustom）、notebook（TabInputNotebook）：有本地文件就给路径', () => {
    expect(tabRef({ uri: file('/p/logo.png'), viewType: 'imagePreview.previewEditor' })).toEqual({
      path: '/p/logo.png',
    })
    expect(tabRef({ uri: file('/p/a.ipynb'), notebookType: 'jupyter-notebook' })).toEqual({
      path: '/p/a.ipynb',
    })
  })
  it('没本地路径的不给：untitled、diff（original/modified）、webview、没有活动标签', () => {
    expect(tabRef({ uri: { scheme: 'untitled', fsPath: 'Untitled-1' } })).toBeNull()
    expect(tabRef({ original: file('/p/a.ts'), modified: file('/p/a.ts') })).toBeNull()
    expect(tabRef({ viewType: 'markdown.preview' })).toBeNull()
    expect(tabRef(undefined)).toBeNull()
  })
})
