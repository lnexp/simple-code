/**
 * 消息气泡里的路径链接化（2026-09-09 拍板方案 b：输入框保持纯文本，
 * 发送后的消息行里「长得像文件路径」的文字渲染成可点击链接，点击经
 * 宿主 vscode.open 打开）。
 *
 * 识别口径偏保守：**末段必须带扩展名**——目录路径不链接（vscode.open
 * 一个目录会弹新窗口，惊吓大于价值），没扩展名的引用（/etc/hosts 以外
 * 的裸目录）靠复制路径解决。~ 开头不识别（宿主侧展开的麻烦换不来多少
 * 命中，agent 输出的路径以绝对/项目内相对为主）。
 *
 * 两条消费路径：React 受控渲染（user 行的 PathText）和 markdown 管线
 * （DOM walk，App.tsx/markdown.ts），识别逻辑只此一份。
 */

/**
 * 路径字素：文件名里合法、又不至于吞掉空格的那组字符。
 *
 * **含 CJK（\u4e00-\u9fff）**：中文文件名是真实现象（本仓库外的项目里
 * 「限制型query修复方案_讨论稿.md」这种名字点不开链接，排查于 2026-09-11）。
 * 不含的话 `\w` 在「限」处断链，整条路径退化成纯文本。
 *
 * **但两头必须是 ASCII**（`CA`）：CJK 一旦可以出现在路径开头，中文句子
 * 粘着 ASCII 路径会被整段吞掉（「修改packages/x.ts即可」匹配出
 * 「修改packages/x.ts即可」，拼出的路径反而不存在，点了静默失败——
 * 比不链接更坏）。首字符与扩展名限 ASCII 后：中文文件名在**中间/主干**
 * 照常命中，粘在两头的中文被正则回溯切掉。
 * 空格仍然排除——带空格的路径有分词歧义，用复制解决。
 */
// `-` 必须转义：夹在 `+` 和 `\u4e00` 中间会被解析成范围操作符
// （0x2B–0x4E00），实测「初稿」两个字都进不了字符类
const CH = '[\\w@.+\\-\\u4e00-\\u9fff]'
/** ASCII 字素（原 CH）：路径首字符与扩展名的专用约束 */
const CA = '[\\w@.+-]'
/** 末段带扩展名的形态：点前可空（.gitignore），点后 1–9 个字素字符 */
/** 扩展名限 ASCII（CA）：把「.ts即可」这类粘尾中文切掉 */
const EXT = `${CH}*\\.${CA}{1,9}`

/** 尾部行号：grep -n / 编译报错的标准输出形态 path:line。capture 1 = 行号 */
const LN = '(?::(\\d+)(?![\\w.]))?'
const ABS_RE = new RegExp(`/(?:${CH}+/)+${EXT}${LN}`, 'g')
/** 相对路径首段以 ASCII 起：粘头的「修改」类中文由回溯切掉 */
const REL_RE = new RegExp(`${CA}${CH}*/(?:${CH}+/)*${EXT}${LN}`, 'g')

/** 前一个字符得是「词外」的：行首/空白/标点/CJK。'/' 单独拒绝——那是 URL
 * 的内脏。CJK 在边界里是安全的：汉字不属于路径字素，正则天然从它后面起
 * 匹配，「见docs/design.md」这种紧贴引用能中，且没有中段截取的风险 */
const isEdge = (c: string | undefined): boolean =>
  c === undefined || /[\s（(【[{"'`<>,，。：:；;！!？?…\u4e00-\u9fff—-]/.test(c)

export interface PathToken {
  readonly start: number
  /** 路径本体的结束位（不含 :line 尾巴）——data-open-path 用这个，
   * end 含行号（展示范围：`a.ts:112` 整段是链接文本） */
  readonly pathEnd: number
  readonly end: number
  /** path:line 尾巴里的行号（grep -n / 报错栈形态） */
  readonly line?: number
}

/** 找出 text 里所有可链接化的路径片段。两套正则各扫一遍，区间重叠时留先出现的。
 * mode 'abs'（代码块专用）：只认绝对路径——块内是「原文」语义，相对形态
 * 的误报面大（版本号 3.14.0、import 段、URL 内脏）；绝对路径（/Users/…
 * 报错栈、ls 输出）几乎都是真目标 */
export function findPathTokens(text: string, mode: 'all' | 'abs' = 'all'): PathToken[] {
  const hits: PathToken[] = []
  for (const re of mode === 'abs' ? [ABS_RE] : [ABS_RE, REL_RE]) {
    re.lastIndex = 0
    let m = re.exec(text)
    while (m !== null) {
      const start = m.index
      const ln = m[1] === undefined ? undefined : Number(m[1])
      const end = start + m[0].length
      // 尾部约束（正则贪不到的）：路径末字符若是 '.' 或 '-'，缩到合法处
      let e = end
      while (e > start + 1 && /[.-]$/.test(text.slice(start, e))) e--
      if (
        e > start + 1 &&
        isEdge(text[start - 1]) &&
        !hits.some((h) => h.start < e && start < h.end)
      )
        // 有行号时尾巴长 = m[1] 长度 + 1（冒号）
        hits.push({
          start,
          pathEnd: ln === undefined ? e : e - String(ln).length - 1,
          end: e,
          ...(ln === undefined ? {} : { line: ln }),
        })
      m = re.exec(text)
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

/**
 * 就地把 root 里的路径 text 片段换成 <a data-open-path>。
 *
 * 不在 a 内做：a 里已经是链接。
 *
 * pre（代码块）**进入但收窄**：只链接化绝对路径（mode 'abs'）。块内
 * 相对形态误报面大（版本号、import 段、URL 内脏），全放行等于把「原文」
 * 语义打穿；绝对路径误报率低——bash 输出里的报错栈、ls 结果直接可点。
 *
 * 行内 code（<code>）**参与**链接化：agent 引用文件的标准写法就是
 * `path/to/file.ts`（反引号），把 code 排除等于放过大多数该链接的路径
 * （实测：一条回答里的路径几乎全被反引号包住，全部点不动）。code 里
 * 链接化的误报（命令片段如 `node scripts/build.mjs`）点开也是合理目标。
 *
 * 先收集再改——边遍历边改 childNodes 会跳节点。
 */
export function linkifyDom(root: ParentNode): void {
  const texts: { node: Text; mode: 'all' | 'abs' }[] = []
  const walk = (node: Node, inPre: boolean): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE)
        texts.push({ node: child as Text, mode: inPre ? 'abs' : 'all' })
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = (child as Element).tagName
        if (tag !== 'A') walk(child, inPre || tag === 'PRE')
      }
    }
  }
  walk(root, false)
  for (const { node: text, mode } of texts) {
    const tokens = findPathTokens(text.data, mode)
    if (tokens.length === 0) continue
    const frag = document.createDocumentFragment()
    let pos = 0
    for (const tk of tokens) {
      if (tk.start > pos) frag.appendChild(document.createTextNode(text.data.slice(pos, tk.start)))
      const a = document.createElement('a')
      // 不设 href：点击统一走 data-open-path 委托（App.tsx onLogClick），
      // href 会让 onLogClick 的 openLink 分支抢跑
      a.setAttribute('data-open-path', text.data.slice(tk.start, tk.pathEnd))
      // 行号单独存：openFile 的兜底解析（basename findFiles）按路径走，
      // 行号不参与拼接
      if (tk.line !== undefined) a.setAttribute('data-open-line', String(tk.line))
      a.textContent = text.data.slice(tk.start, tk.end)
      frag.appendChild(a)
      pos = tk.end
    }
    if (pos < text.data.length) frag.appendChild(document.createTextNode(text.data.slice(pos)))
    text.parentNode?.replaceChild(frag, text)
  }
}
