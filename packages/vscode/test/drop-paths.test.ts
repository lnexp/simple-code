// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  composeWithAttachments,
  type DropData,
  hasOsFileDrag,
  isExplorerDrag,
  parseExplorerPaths,
  toDisplayPath,
} from '../webview/dropPaths.ts'

/** 鸭子类型的 fake：types + payload + files 数。getData 对未知类型返回空 */
const dt = (types: string[], data: Record<string, string> = {}, fileCount = 0): DropData => ({
  files: { length: fileCount },
  types,
  getData: (t) => data[t] ?? '',
})

describe('isExplorerDrag / hasOsFileDrag', () => {
  it('vnd.code.tree.explorer → Explorer 拖', () => {
    expect(isExplorerDrag(dt(['application/vnd.code.tree.explorer', 'text/uri-list']))).toBe(true)
  })

  it('codefiles（旧版私有类型）也算', () => {
    expect(isExplorerDrag(dt(['codefiles']))).toBe(true)
    expect(isExplorerDrag(dt(['CodeFiles']))).toBe(true)
  })

  it('有真 File 对象（OS 拖）→ 不是 Explorer，且 hasOsFileDrag 认出来', () => {
    const os = dt(['Files', 'text/uri-list'], {}, 2)
    expect(isExplorerDrag(os)).toBe(false)
    expect(hasOsFileDrag(os)).toBe(true)
  })

  it('只有通用类型（text/uri-list / text/plain）不算——OS 拖也带它们', () => {
    expect(isExplorerDrag(dt(['text/uri-list', 'text/plain']))).toBe(false)
  })

  it('null / files 缺失安全', () => {
    expect(isExplorerDrag(null)).toBe(false)
    expect(hasOsFileDrag(null)).toBe(false)
  })
})

describe('parseExplorerPaths', () => {
  it('CodeFiles JSON：深挖字符串叶子里的路径', () => {
    const payload = JSON.stringify([
      { path: '/Users/x/a.ts', kind: 'file' },
      { path: '/Users/x/b.ts' },
    ])
    expect(parseExplorerPaths(dt(['codefiles'], { codefiles: payload }))).toEqual([
      '/Users/x/a.ts',
      '/Users/x/b.ts',
    ])
  })

  it('uri-list：file:// URI 解码成路径', () => {
    const d = dt(['text/uri-list'], { 'text/uri-list': 'file:///Users/x/a%20b.ts' })
    expect(parseExplorerPaths(d)).toEqual(['/Users/x/a b.ts'])
  })

  it('text/plain 多行裸路径逐行提取', () => {
    const d = dt(['text/plain'], { 'text/plain': '/a/b.ts\n/c/d.ts\n说明文字' })
    expect(parseExplorerPaths(d)).toEqual(['/a/b.ts', '/c/d.ts'])
  })

  it('同一 payload 在多个类型里重复 → 去重', () => {
    const d = dt(['codefiles', 'text/uri-list'], {
      codefiles: '"/a/b.ts"',
      'text/uri-list': '/a/b.ts',
    })
    expect(parseExplorerPaths(d)).toEqual(['/a/b.ts'])
  })

  it('相对路径、多行文档、垃圾不收', () => {
    const d = dt(['codefiles'], { codefiles: 'src/a.ts\n这是一段说明\nnot a path' })
    expect(parseExplorerPaths(d)).toEqual([])
  })

  it('getData 会 throw 的类型被 guard，不中断扫描', () => {
    const d = dt(['codefiles', 'text/uri-list'], {})
    Object.defineProperty(d, 'getData', {
      value: (t: string) => {
        if (t === 'codefiles') throw new Error('dragover read')
        return '/a/b.ts'
      },
    })
    expect(parseExplorerPaths(d)).toEqual(['/a/b.ts'])
  })
})

// ↓ 2026-09-09 Cursor 实测 dump 原样回放（用户从 Explorer 拖一个文件，
// debug 版从真实 dataTransfer 抓下来的 types/payload）。判据或三遍扫描
// 改坏任何一环，这条先红。
describe('Cursor 实测数据回放', () => {
  const CURSOR_TYPES = [
    'text/plain',
    'text/uri-list',
    'resourceurls',
    'codefiles',
    'codeeditors',
    'application/vnd.code.uri-list',
  ]
  const PATH = '/Users/dev/Code/simple-code/packages/core/src/events.ts'
  const PAYLOADS: Record<string, string> = {
    'text/plain': PATH,
    'text/uri-list': `file://${PATH}`,
    resourceurls: JSON.stringify([`file://${PATH}`]),
    codefiles: JSON.stringify([PATH]),
    codeeditors: JSON.stringify([
      { resource: { $mid: 1, fsPath: PATH, external: `file://${PATH}` } },
    ]),
    'application/vnd.code.uri-list': `file://${PATH}`,
  }
  const cursorDrop = {
    files: { length: 0 },
    types: CURSOR_TYPES,
    getData: (ty: string) => PAYLOADS[ty] ?? '',
  }

  it('判据认出 Explorer 拖（codefiles 小写命中，无 vnd.code.tree*）', () => {
    expect(isExplorerDrag(cursorDrop)).toBe(true)
  })

  it('解析出唯一的绝对路径，无重复', () => {
    expect(parseExplorerPaths(cursorDrop)).toEqual([PATH])
  })

  it('只有 uri-list 私有类型（tab 拖场景）也认 + 解析得出', () => {
    const tabDrag = {
      files: { length: 0 },
      types: ['text/uri-list', 'application/vnd.code.uri-list'],
      getData: (ty: string) => (ty === 'application/vnd.code.uri-list' ? `file://${PATH}` : ''),
    }
    expect(isExplorerDrag(tabDrag)).toBe(true)
    expect(parseExplorerPaths(tabDrag)).toEqual([PATH])
  })
})

// ↓ 2026-09-09 第三轮实测：Cursor 的 dragenter/dragover/drop 全程 types 都
// 只有这三个私有类型（VS Code 的 codefiles/text/plain 全程缺席，第一轮
// debug 版抓到的 6 types 未能复现）。判据和三遍扫描必须吃这套数据。
describe('Cursor 三类型实测回放', () => {
  const PATH = '/Users/dev/Code/simple-code/packages/core/src/events.ts'
  const TYPES = ['resourceurls', 'codeeditors', 'application/vnd.code.uri-list']
  const PAYLOADS: Record<string, string> = {
    resourceurls: JSON.stringify([`file://${PATH}`]),
    codeeditors: JSON.stringify([
      { resource: { $mid: 1, fsPath: PATH, external: `file://${PATH}`, path: PATH } },
    ]),
    'application/vnd.code.uri-list': `file://${PATH}`,
  }
  const dt = {
    files: { length: 0 },
    types: TYPES,
    getData: (ty: string) => PAYLOADS[ty] ?? '',
  }

  it('判据认出（无 codefiles、无 tree*，全靠 Cursor 三类型）', () => {
    expect(isExplorerDrag(dt)).toBe(true)
  })

  it('三种 payload 各自都能挖出路径，去重后恰一条', () => {
    expect(parseExplorerPaths(dt)).toEqual([PATH])
  })

  it('单靠 resourceurls 也能解析（万一其他类型缺席）', () => {
    const only: typeof dt = { ...dt, types: ['resourceurls'] }
    expect(parseExplorerPaths(only)).toEqual([PATH])
  })
})

describe('toDisplayPath', () => {
  const root = '/Users/x/proj'

  it('项目内 → 相对', () => {
    expect(toDisplayPath('/Users/x/proj/src/a.ts', root)).toBe('src/a.ts')
  })

  it('项目外 → 绝对原样', () => {
    expect(toDisplayPath('/etc/hosts', root)).toBe('/etc/hosts')
  })

  it('正好是根 → .', () => {
    expect(toDisplayPath('/Users/x/proj', root)).toBe('.')
  })

  it('root 带尾斜杠 / 反斜杠归一（Windows 兜底）', () => {
    expect(toDisplayPath('C:\\proj\\a.ts', 'C:\\proj\\')).toBe('a.ts')
  })

  it('root 未知（空串）→ 原样绝对路径', () => {
    expect(toDisplayPath('/Users/x/proj/a.ts', '')).toBe('/Users/x/proj/a.ts')
  })
})

// composeWithAttachments（2026-09-12 方案 A：气泡在输入框，发送时展开回纯文本）
describe('composeWithAttachments', () => {
  it('附件在前空行隔开正文', () => {
    expect(composeWithAttachments('看下这个', ['a.ts', 'b.ts'])).toBe('a.ts\nb.ts\n\n看下这个')
  })
  it('只有附件时不留尾随空行', () => {
    expect(composeWithAttachments('', ['a.ts'])).toBe('a.ts')
  })
  it('没有附件时原样返回', () => {
    expect(composeWithAttachments('纯文本', [])).toBe('纯文本')
  })
})
