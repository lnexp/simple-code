// @vitest-environment jsdom
// renderMarkdown 里 DOMPurify 要真 DOM。整个文件换环境，别的测试保持 node。
// 用 jsdom 不用 happy-dom：DOMPurify 在 happy-dom 20.x 下会把 h1-h6 当不允许
// 标签剥掉（干净输入也剥，marked 输出本身是对的）——jsdom 是 DOMPurify
// 官方测试套件的环境，不赌其他标签有没有同类问题
import { describe, expect, it } from 'vitest'
import { renderMarkdown, splitOpenFence } from '../webview/markdown.ts'

/**
 * markdown 渲染的两类风险分开测：
 *
 * 1. **渲染对不对**——标题/代码块/表格这些基础形状。错了不致命，只是难看
 * 2. **消毒严不严**——这段 HTML 会进 dangerouslySetInnerHTML，XSS 不通过
 *    其他就都不用谈。输入是模型输出：模型不可信，prompt 注入可以让它吐
 *    任意标记。DOMPurify 的默认配置负责剥，这里钉住几条最经典的攻击面
 */

describe('渲染形状', () => {
  it('标题、列表、行内代码', () => {
    const html = renderMarkdown('# 标题\n\n- 甲\n- 乙\n\n用 `pnpm test` 跑')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<li>甲</li>')
    expect(html).toContain('<code>pnpm test</code>')
  })

  it('围栏代码块', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    // pre 首子节点现在是复制按钮（消毒钩子注入），code 跟在后面
    expect(html).toContain('<pre><button type="button" class="code-copy"')
    // 高亮后 class 是 "hljs language-ts"（2026-09-12 语法高亮）
    expect(html).toContain('<code class="hljs language-ts">')
    // 2026-09-12 高亮后纯文本被 span 打断，断言 token 形态
    expect(html).toContain('<span class="hljs-keyword">const</span> a = <span class="hljs-number">1</span>')
  })

  it('GFM 表格', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>2</td>')
  })

  it('链接带上新开属性', () => {
    const html = renderMarkdown('[文档](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('消毒', () => {
  it('<script> 整段剥掉', () => {
    const html = renderMarkdown('前\n\n<script>alert(1)</script>\n\n后')
    expect(html).toContain('前')
    expect(html).toContain('后')
    expect(html).not.toContain('script')
    expect(html).not.toContain('alert')
  })

  it('事件属性剥掉', () => {
    const html = renderMarkdown('<img src="data:image/png;base64,iVBOR" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).toContain('src="data:image/png;base64,iVBOR"')
  })

  it('javascript: 链接剥掉', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('iframe 不允许', () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe>')
    expect(html).not.toContain('iframe')
  })
})

describe('splitOpenFence（流式围栏隔离，D2b）', () => {
  const split = (md: string) => splitOpenFence(md)

  it('没有围栏 → null（整段正常渲）', () => {
    expect(split('# 标题\n\n正文')).toBeNull()
  })

  it('围栏已闭合 → null', () => {
    expect(split('前文\n```ts\nconst a = 1\n```\n后文')).toBeNull()
  })

  it('未闭合围栏 → settled + raw，围栏行归 raw', () => {
    const parts = split('前文\n```ts\nconst a = 1')
    expect(parts).not.toBeNull()
    expect(parts?.settled).toBe('前文')
    expect(parts?.raw).toBe('```ts\nconst a = 1')
  })

  it('多个围栏：前面闭合的不影响，只隔离最后一个未闭合的', () => {
    const parts = split('```js\na\n```\n中间\n```bash\necho')
    expect(parts?.settled).toBe('```js\na\n```\n中间')
    expect(parts?.raw).toBe('```bash\necho')
  })

  it('波浪围栏也认；围栏内的三反引号是内容不是新栏', () => {
    expect(split('~~~\n未闭合')).toEqual({ settled: '', raw: '~~~\n未闭合' })
    // 开栏更长时闭合栏要 ≥ 开栏长度
    expect(split('````\n```\n```')).not.toBeNull()
  })

  it('代码块内的缩进围栏不算（列表里的代码缩进 4 格出界）', () => {
    expect(split('    ```\n    缩进内容')).toBeNull()
  })
})

// ------------------------------------------------------------ 代码块复制按钮

describe('代码块复制按钮', () => {
  it('每个 pre 里注入一个复制按钮（消毒钩子内注入，无内联处理器）', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```')
    expect(html).toContain('class="code-copy"')
    expect(html).not.toContain('onclick') // CSP + 注入面：不允许任何内联处理器
  })

  it('普通 pre 之外的元素不受影响，链接行为不变', () => {
    const html = renderMarkdown('[x](https://a.example)')
    expect(html).not.toContain('code-copy')
    expect(html).toContain('target="_blank"')
  })
})

describe('路径链接化（pathlink 接进管线）', () => {
  it('正文里的路径变 a[data-open-path]，消毒管线之后执行', () => {
    const html = renderMarkdown('改 packages/core/src/events.ts 那段')
    expect(html).toContain('data-open-path="packages/core/src/events.ts"')
    expect(html).not.toContain('<script')
  })

  it('code 块不链接化（原文语义），行内 code 链接化（agent 引用路径的标准写法）', () => {
    const html = renderMarkdown('`a/b.ts` 段落里\n\n```\ncat d/e.log\n```')
    expect(html).toContain('<code><a data-open-path="a/b.ts">a/b.ts</a></code>')
    expect(html).not.toContain('d/e.log\"')
  })

  it('消毒优先：注入尝试不会被链接化路径复活', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> a/b.ts')
    expect(html).not.toContain('onerror')
    expect(html).toContain('data-open-path="a/b.ts"')
  })
})

// 语法高亮（2026-09-12）：精选语言产 hljs span；未注册语言回落纯文本
describe('renderMarkdown 语法高亮', () => {
  it('ts 代码块：keyword/string 进 span，消毒管线不剥', () => {
    const html = renderMarkdown('```ts\nconst s = "hi"\n```')
    expect(html).toContain('class="hljs language-ts"')
    expect(html).toMatch(/<span class="hljs-keyword">const<\/span>/)
    expect(html).toMatch(/<span class="hljs-string">"hi"<\/span>/)
  })
  it('别名归一：sh 走 bash，py 走 python', () => {
    expect(renderMarkdown('```sh\nls -la\n```')).toContain('language-sh')
    expect(renderMarkdown('```py\nprint(1)\n```')).toContain('language-py')
  })
  it('未注册语言回落 marked 默认（无 hljs span）', () => {
    const html = renderMarkdown('```rust\nlet x = 1;\n```')
    expect(html).not.toContain('hljs')
    expect(html).toContain('let x = 1;')
  })
  it('diff 块：+/- 行分别标 addition/deletion', () => {
    const html = renderMarkdown('```diff\n+新增\n-删除\n```')
    expect(html).toMatch(/hljs-addition/)
    expect(html).toMatch(/hljs-deletion/)
  })
})
