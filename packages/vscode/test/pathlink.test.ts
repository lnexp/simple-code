// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { findPathTokens, linkifyDom } from '../webview/pathlink.ts'

/** 全部用实测口径的样例：中文紧贴、URL 内脏、目录、扩展名缺失 */
const hits = (s: string): string[] => findPathTokens(s).map((t) => s.slice(t.start, t.end))
const tokens = (s: string) =>
  findPathTokens(s).map((t) => ({ path: s.slice(t.start, t.pathEnd), line: t.line }))

describe('findPathTokens 识别口径', () => {
  it('中文文件名链接化（2026-09-11 实案：other-project 的讨论稿点不开）', () => {
    expect(
      hits('详见 /Users/dev/Documents/workspace/other-project/限制型query修复方案_讨论稿.md（约 253 行）'),
    ).toEqual(['/Users/dev/Documents/workspace/other-project/限制型query修复方案_讨论稿.md'])
    expect(hits('见 docs/设计文档/初稿.md 一段')).toEqual(['docs/设计文档/初稿.md'])
  })

  it('CJK 进字素集不误伤普通中文句子', () => {
    expect(hits('普通中文句子，没有路径形态。今天天气不错')).toEqual([])
  })

  it('中文粘在路径两头时切掉（两头必须 ASCII）', () => {
    expect(hits('修改packages/vscode/src/style.ts即可')).toEqual(['packages/vscode/src/style.ts'])
  })

  it('绝对/相对、多 token、中文紧贴（CJK 是边界）', () => {
    expect(hits('看下 packages/core/src/events.ts 和 /tmp/orig.png')).toEqual([
      'packages/core/src/events.ts',
      '/tmp/orig.png',
    ])
    expect(hits('修改packages/vscode/src/style.ts即可')).toEqual(['packages/vscode/src/style.ts'])
    expect(hits('见 docs/design.md 与（packages/core/x.rs）')).toEqual([
      'docs/design.md',
      'packages/core/x.rs',
    ])
  })

  it('末段必须带扩展名——目录/无扩展不链接（vscode.open 目录会弹新窗口）', () => {
    expect(hits('目录 docs 和 docs/ 子树不中')).toEqual([])
    expect(hits('image/png 这种 MIME 不中')).toEqual([])
    expect(hits('版本 1.2.3 不中')).toEqual([])
  })

  it('URL 的内脏不中——前字符是 / 一律拒绝', () => {
    expect(hits('https://a.com/x.ts 里只有完整 URL 才是链接')).toEqual([])
    expect(hits('来源 https://raw.githubusercontent.com/x/y/main/z.md')).toEqual([])
  })

  it('标点边界：逗号顿号分号冒号后面都能起', () => {
    expect(hits('a/b.ts,/x/c.md:;d/e.log')).toEqual(['a/b.ts', '/x/c.md', 'd/e.log'])
  })

  it('末字符是点或连字符时收缩（x.ts-. 不吞尾标点）', () => {
    expect(hits('a/b.ts-.')).toEqual(['a/b.ts'])
    expect(hits('c/d.md…')).toEqual(['c/d.md'])
  })

  it('裸文件名（无 /）不链接——单 token 形态误报面太大', () => {
    expect(hits('提到 .gitignore 和 README.md 时')).toEqual([])
  })

  it('path:line 尾巴捕获行号（grep -n / 报错栈形态）', () => {
    expect(tokens('demo-project-frontend/nginx.conf:112  线上转发')).toEqual([
      { path: 'demo-project-frontend/nginx.conf', line: 112 },
    ])
    // 行号可选：不带行号的路径行为不变
    expect(tokens('见 docs/design.md 一段')).toEqual([{ path: 'docs/design.md', line: undefined }])
    // 版本号仍不中（无路径形态）
    expect(hits('版本 3.14.0 不该中')).toEqual([])
    // 列号尾巴（:12:34）取第一段行号
    expect(tokens('packages/core/a.ts:12:34 列号')).toEqual([
      { path: 'packages/core/a.ts', line: 12 },
    ])
  })
})

describe('linkifyDom（markdown 管线用）', () => {
  const dom = (): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML =
      '<p>看 packages/core/a.ts</p><code>skip/me.ts</code><pre>b/c.rs</pre><pre>报错在 /tmp/x/target.rs:9</pre>'
    linkifyDom(root)
    return root
  }

  it('段落和行内 code 全量链接；pre 只认绝对路径，相对形态原样', () => {
    const root = dom()
    const links = root.querySelectorAll('a[data-open-path]')
    // p 一个 + code 一个（agent 引用路径的标准写法就是反引号）+ pre 里
    // 的绝对路径一个；pre 里的相对形态 b/c.rs 不动（版本号/import 误报面）
    expect(links).toHaveLength(3)
    expect(links[0]?.getAttribute('data-open-path')).toBe('packages/core/a.ts')
    expect(links[1]?.getAttribute('data-open-path')).toBe('skip/me.ts')
    expect(links[1]?.tagName).toBe('A')
    expect(links[2]?.getAttribute('data-open-path')).toBe('/tmp/x/target.rs')
    expect(links[2]?.getAttribute('data-open-line')).toBe('9')
    const pres = root.querySelectorAll('pre')
    expect(pres[0]?.textContent).toBe('b/c.rs')
    expect(pres[0]?.querySelector('a')).toBeNull()
  })

  it('pre 里的绝对路径粘着 CJK 前缀也命中（复制按钮文案粘进路径的实案）', () => {
    const root = document.createElement('div')
    root.innerHTML = '<pre>复制/Users/dev/Code/demo-project/scripts/agent_eval/eval_system_prompt_v2.zh.md</pre>'
    linkifyDom(root)
    const a = root.querySelector('pre a[data-open-path]')
    // 「制」是 CJK 边界，回溯从 / 起匹配；「复制」留在块文本里
    expect(a?.getAttribute('data-open-path')).toBe('/Users/dev/Code/demo-project/scripts/agent_eval/eval_system_prompt_v2.zh.md')
    expect(a?.previousSibling?.textContent).toBe('复制')
  })

  it('产物无 href——点击不会被 openLink 分支抢跑', () => {
    const a = dom().querySelector('a')
    expect(a?.hasAttribute('href')).toBe(false)
  })

  it('已存在的 a 内部不二次链接化', () => {
    const root = document.createElement('div')
    root.innerHTML = '<a href="https://x.com">看 a/b.ts</a>'
    linkifyDom(root)
    expect(root.querySelectorAll('a')).toHaveLength(1)
  })
})
