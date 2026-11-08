/**
 * webview 的样式表。从 html.ts 分出来的——那边只剩 HTML 外壳和 CSP 拼装，
 * 两件事各自都还在 300 行以内（CLAUDE.md §2）。
 *
 * **全部用 VS Code 注入的 CSS 变量，不写死颜色。** 这是跟编辑器主题保持一致
 * 的唯一正确做法，换主题自动跟随，不用监听主题切换事件。
 *
 * 直接吃 `--vscode-*` 变量是唯一正确做法，换主题自动跟随，不用监听主题
 * 切换事件。不做运行时生成的 token 系统：那是为了同一份 UI 跑
 * web / Electron / mobile 才需要的；我们只跑 VS Code，直接用更简单也更准。
 */

/** 圆角尺度。xl 用在卡片和行上 */
const RADIUS = { sm: '4px', md: '8px', xl: '12px' }

/**
 * 文字图折行的悬挂缩进：按行首列数（markdown.ts wrapPlainCode 写的 data-i）
 * 一档一条规则。CSP 禁内联 style，只能预生成。40 = markdown.ts MAX_INDENT
 * （不 import：那边会把 marked/DOMPurify 带进扩展侧产物；测试里核对两边一致）
 */
const WRAP_INDENT = Array.from(
  { length: 40 },
  (_, k) => `.markdown pre.wrap .ln[data-i="${k + 1}"] { --i: ${k + 1}ch; }`,
).join('\n')

export const STYLE = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
#root { display: flex; flex-direction: column; height: 100vh; }
/* App 根。原来是 <> 片段（布局由 #root 直接管），lightbox 要挂根级 onClick
   委托需要真实元素——继续把 #root 的 flex column 语义接过来 */
.app { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }
.history-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  padding: 8px 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.history-end {
  text-align: center;
  padding: 8px 0;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.log { flex: 1; overflow-y: auto; padding: 8px; }
.item { margin-bottom: 10px; }

/* ── 用户消息：右对齐蓝色气泡，吸在本轮顶部（.turn-head，timeline.tsx）──
 * 10-28 时间线改版改成过满宽灰色块，10-29 用户：用户问题和代码块「太类似
 * 了」——两者都是满宽灰底圆角框。对比页选了右对齐气泡（U3）：
 * 靠位置和色相区分，不靠灰度深浅 */
.user-row { display: flex; flex-direction: column; align-items: stretch; }
.user-row > .user-images { justify-content: flex-end; }
.user-col { display: flex; flex-direction: column; align-items: flex-end; }
.user {
  max-width: 85%;
  /* 底色取链接色 18%，不用 input-background/panel-border：IntelliJ New UI
   * 这类主题里两者都等于页面底色（#1e1f22），用户消息直接融进页面（10-29
   * 实机截图）。蓝色不和灰色代码块、红色失败撞色 */
  background: color-mix(in srgb, var(--vscode-textLink-foreground) 18%, transparent);
  border-radius: ${RADIUS.xl}; border-bottom-right-radius: ${RADIUS.sm};
  padding: 6px 12px; white-space: pre-wrap; word-break: break-word;
}
/* 长消息折叠（App.tsx UserBubble）：3 行。原来 15 行（24em）；吸顶后
 * 15 行要占掉小半屏，改版原型定的「吸顶三行」。展开后不再吸顶（.turn-head）。
 * 只截断不做渐隐装饰——渐变层在浅色主题下像一块灰雾（用户：「看着有阴影」），
 * 「展开 N 行」按钮本身就是「还有更多」的提示 */
.user.user-clamp {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  /* 下内边距换成同宽透明边框：overflow 只裁到 padding 外沿，留着 padding
   * 时第 4 行的上半截会从气泡底部露出来（10-29 截图）。底色默认铺到边框，
   * 外观不变 */
  padding-bottom: 0; border-bottom: 6px solid transparent;
}
.user-toggle {
  background: none; border: none; padding: 2px 2px 0; font-size: 0.9em;
  color: var(--vscode-textLink-foreground); cursor: pointer;
}
.user-toggle:hover { text-decoration: underline; }
/* **.streaming 故意没有任何样式**，别再给它加 white-space: pre-wrap。
 * C3 之前流式期间是原文直出，那时 pre-wrap 是对的；C3 之后流式也渲染
 * markdown（StreamMarkdown），元素同时挂 .markdown 和 .streaming，于是
 * pre-wrap 作用在了 marked 生成的 HTML 上——块级标签之间的 \\n 本该折叠，
 * 被它渲成真实换行，每个块之间凭空多一行。实测同一段内容流式态 320px、
 * 结束态 155px，翻倍还多，表现为「输出时很散，输出完突然收拢」。
 * line-height 同理：写在这里会以 (0,2,0) 压过 .markdown 的 1.6，
 * 导致流式结束的瞬间整段文字跳一下。
 * 流式尾部的未闭合围栏要 pre-wrap，那个由 .stream-raw 自己负责。 */

/* ── markdown ────────────────────────────────────────────────────────
 * **字号就用 --vscode-font-size，不加放大系数。** 一度乘过 1.08，
 * 实际装到侧边栏里偏大——这个面板跑在几百像素宽的侧边栏里，
 * 宽居中栏适用的字号观感不同。
 * 而且乘系数等于在主题变量上又叠一个魔数，用户把编辑器字号调好了，这里
 * 还要自作主张放大一档 */
.markdown { line-height: 1.6; word-break: break-word; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p { margin: 0 0 0.75em; }
.markdown h1, .markdown h2, .markdown h3,
.markdown h4, .markdown h5, .markdown h6 {
  line-height: 1.3; font-weight: 600;
}
/* 字号和 margin 逐级递减 */
.markdown h1 { font-size: 1.125em; margin: 1em 0 0.5em; }
.markdown h2 { font-size: 1.0625em; margin: 0.875em 0 0.375em; }
.markdown h3 { font-size: 1em; margin: 0.75em 0 0.25em; }
.markdown h4, .markdown h5, .markdown h6 { font-size: 1em; margin: 0.625em 0 0.25em; }
/* 标题按层级递减地染主题强调色（primary 的 100%/90%/80%）。
 * 全用前景色的话，一段话里出现两三个标题时层级读不出来。
 * 与路径链接同用 textLink token 是接受的同色系：标题无下划线，链接有
 * 点线 + hover 背景，形状区分够用（2026-09-09 拍板恢复） */
.markdown h1 { color: var(--vscode-textLink-foreground); }
.markdown h2 { color: color-mix(in srgb, var(--vscode-textLink-foreground) 90%, var(--vscode-foreground)); }
.markdown h3 { color: color-mix(in srgb, var(--vscode-textLink-foreground) 80%, var(--vscode-foreground)); }
/* 整段只有加粗的段落 = 小标题（markdown.ts markBoldHeadings）：模型分节常写
 * 「**验证情况**」而不是 ###，按 h3 的样子显示，不然和加粗开头的正文分不开 */
.markdown p.md-sec {
  margin: 1.1em 0 0.4em; line-height: 1.4;
  color: color-mix(in srgb, var(--vscode-textLink-foreground) 80%, var(--vscode-foreground));
}
.markdown p.md-sec strong { color: inherit; }
/* 回答第一段是结论，比正文亮一档（只限回答，不含过程里的说明）。
 * tab.activeForeground 在深/浅主题里都是「最强的正文色」 */
.item > .assistant.markdown > p:first-child,
.markdown strong {
  color: color-mix(in srgb, var(--vscode-tab-activeForeground, var(--vscode-foreground)) 85%, var(--vscode-foreground));
}
/* 列表：en-dash 而不是圆点，缩进 2em、符号绝对定位在 -1.25em。
 * 圆点在小字号下容易糊成一团 */
.markdown ul, .markdown ol { margin: 0 0 0.75em; padding-left: 2em; }
.markdown ul { list-style: none; }
.markdown ul > li { position: relative; }
.markdown ul > li::before {
  content: "–"; position: absolute; left: -1.25em; color: inherit; opacity: 0.7;
}
.markdown li { margin: 0.15em 0; }
.markdown a { color: var(--vscode-textLink-foreground); }
.markdown a:hover { color: var(--vscode-textLink-activeForeground); }
.markdown strong { font-weight: 600; }
/* 线条与面板边框不用 --vscode-panel-border：IntelliJ IDEA New UI Dark 里它
   等于页面底色 #1e1f22，表格横线、分隔线、引用竖线、工具输出框、上下文
   面板全看不见（2026-10-29 实测）。改用前景色混透明，任何主题都有对比 */
.markdown blockquote {
  margin: 0.5em 0; padding: 0.1em 0.9em;
  border-left: 3px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
  color: var(--vscode-descriptionForeground);
}
.markdown code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.88em;
  /* 正文色 + 前景 12% 底 + 16% 细框（GitHub 式）。10-28 正文色 + 10% 底，
   * 用户看「不够清晰」；改回宿主 textPreformat（暗色默认 #d7ba7d 黄）又嫌
   * 「黄色不好看」。框线补上 10% 底不够的边界。不用蓝（路径链接是蓝）、
   * 不用红（失败是红）。路径仍是链接色（a[data-open-path]） */
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  padding: 0.1em 0.38em; border-radius: ${RADIUS.sm};
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.markdown pre {
  margin: 0.5em 0; padding: 0.7em 0.9em; overflow-x: auto;
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  border-radius: ${RADIUS.xl};
  position: relative;
}
.markdown pre code {
  background: none; box-shadow: none; padding: 0; font-size: 0.87em;
  color: var(--vscode-editor-foreground, var(--vscode-foreground));
}
/* 没标语言的代码块（文字图、目录树、日志）按行折行，续行比本行多缩进
 * 2 格（markdown.ts wrapPlainCode）。标了语言的真代码仍横滚。
 * 首行用负 text-indent 拉回行首，行首空格照常占位；续行停在 缩进+2 格 */
.markdown pre.wrap .ln {
  display: block; min-height: 1.6em; white-space: pre-wrap; overflow-wrap: anywhere;
  --i: 0ch; padding-left: calc(var(--i) + 2ch); text-indent: calc(-1 * var(--i) - 2ch);
}
${WRAP_INDENT}

/* 复制按钮：平时隐身，hover 代码块才现身——markdown 正文里代码块多，
 * 常驻一排按钮是视觉噪音；触屏无 hover，降级为常显（细边框弱化） */
.code-copy {
  position: absolute; top: 4px; right: 4px;
  padding: 1px 7px; font-size: 0.85em; line-height: 1.5;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: ${RADIUS.sm};
  opacity: 0; transition: opacity 0.12s ease-out;
  cursor: pointer;
}
.markdown pre:hover .code-copy { opacity: 1; }
@media (hover: none) { .code-copy { opacity: 0.7; } }

/*
 * 代码块语法高亮配色（2026-09-12 拍板）：GitHub 官方深/浅双主题的 token
 * 色值，按 webview body 的主题 class 切换。**只取 token 色**——.hljs 全局
 * background/foreground 不搬，块底色仍走 --vscode-textCodeBlock-background
 * （跟用户主题）。VS Code 不把主题的 token 色暴露成 CSS 变量，色板固定、
 * 深浅类别跟对，这是能做到的最贴主题的方式。
 */
.markdown .hljs-doctag, .markdown .hljs-keyword, .markdown .hljs-meta .hljs-keyword,
.markdown .hljs-template-tag, .markdown .hljs-template-variable, .markdown .hljs-type,
.markdown .hljs-variable.language_ { color: #d73a49; }
.markdown .hljs-title, .markdown .hljs-title.class_, .markdown .hljs-title.class_.inherited__,
.markdown .hljs-title.function_ { color: #6f42c1; }
.markdown .hljs-attr, .markdown .hljs-attribute, .markdown .hljs-literal, .markdown .hljs-meta,
.markdown .hljs-number, .markdown .hljs-operator, .markdown .hljs-variable,
.markdown .hljs-selector-attr, .markdown .hljs-selector-class, .markdown .hljs-selector-id { color: #005cc5; }
.markdown .hljs-regexp, .markdown .hljs-string, .markdown .hljs-meta .hljs-string { color: #032f62; }
.markdown .hljs-built_in, .markdown .hljs-symbol { color: #e36209; }
.markdown .hljs-comment, .markdown .hljs-code, .markdown .hljs-formula { color: #6a737d; }
.markdown .hljs-name, .markdown .hljs-quote, .markdown .hljs-selector-tag,
.markdown .hljs-selector-pseudo { color: #22863a; }
.markdown .hljs-section { color: #005cc5; font-weight: bold; }
.markdown .hljs-bullet { color: #735c0f; }
.markdown .hljs-addition { color: #22863a; background-color: #f0fff4; }
.markdown .hljs-deletion { color: #b31d28; background-color: #ffeef0; }

/* 深色（含 high-contrast）：同款选择器换 GitHub Dark 色板 */
.vscode-dark .markdown .hljs-doctag, .vscode-dark .markdown .hljs-meta .hljs-keyword,
.vscode-dark .markdown .hljs-keyword, .vscode-dark .markdown .hljs-template-tag,
.vscode-dark .markdown .hljs-template-variable, .vscode-dark .markdown .hljs-type,
.vscode-dark .markdown .hljs-variable.language_ { color: #ff7b72; }
.vscode-dark .markdown .hljs-title, .vscode-dark .markdown .hljs-title.class_,
.vscode-dark .markdown .hljs-title.class_.inherited__,
.vscode-dark .markdown .hljs-title.function_ { color: #d2a8ff; }
.vscode-dark .markdown .hljs-attr, .vscode-dark .markdown .hljs-attribute,
.vscode-dark .markdown .hljs-literal, .vscode-dark .markdown .hljs-meta,
.vscode-dark .markdown .hljs-number, .vscode-dark .markdown .hljs-operator,
.vscode-dark .markdown .hljs-variable, .vscode-dark .markdown .hljs-selector-attr,
.vscode-dark .markdown .hljs-selector-class, .vscode-dark .markdown .hljs-selector-id { color: #79c0ff; }
.vscode-dark .markdown .hljs-regexp, .vscode-dark .markdown .hljs-string,
.vscode-dark .markdown .hljs-meta .hljs-string { color: #a5d6ff; }
.vscode-dark .markdown .hljs-built_in, .vscode-dark .markdown .hljs-symbol { color: #ffa657; }
.vscode-dark .markdown .hljs-comment, .vscode-dark .markdown .hljs-code,
.vscode-dark .markdown .hljs-formula { color: #8b949e; }
.vscode-dark .markdown .hljs-name, .vscode-dark .markdown .hljs-quote,
.vscode-dark .markdown .hljs-selector-tag, .vscode-dark .markdown .hljs-selector-pseudo { color: #7ee787; }
.vscode-dark .markdown .hljs-section { color: #1f6feb; font-weight: bold; }
.vscode-dark .markdown .hljs-bullet { color: #f2cc60; }
.vscode-dark .markdown .hljs-addition { color: #aff5b4; background-color: #033a16; }
.vscode-dark .markdown .hljs-deletion { color: #ffdcd7; background-color: #67060c; }
.markdown table {
  border-collapse: collapse; margin: 0.6em 0; max-width: 100%;
  display: block; overflow-x: auto; /* 宽表横滚，不把面板撑爆 */
}
/* 只留横线：四周格线在窄面板里比内容还显眼 */
.markdown th, .markdown td {
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  padding: 0.4em 1.2em 0.4em 0; text-align: left; vertical-align: top;
}
.markdown th {
  font-weight: 600; font-size: 0.92em; white-space: nowrap;
  color: var(--vscode-descriptionForeground);
}
.markdown tr:last-child td { border-bottom: none; }
/* 窄列里的提交号、文件名不拆成两半 */
.markdown td code { white-space: nowrap; }
.markdown hr {
  border: none; margin: 0.75em 0;
  border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.markdown img { max-width: 100%; }
.notice { color: var(--vscode-descriptionForeground); font-size: 0.9em; font-style: italic; }
/* 模型切换分割线：文字居中，两侧横线 flex:1 吃掉剩余宽度——面板拉宽拉窄自动伸缩。
   文字过长时允许折行（min-width:0），横线最少留 1.5em 看得出是分割线 */
.divider { display: flex; align-items: center; gap: 0.75em; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.divider::before, .divider::after { content: ''; flex: 1 1 1.5em; min-width: 1.5em; border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
.divider > span { flex: 0 1 auto; min-width: 0; text-align: center; overflow-wrap: anywhere; }
/* 任务完成回调：同 notice 的弱化色，一行可展开；正文保留换行 */
.task-result { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.task-result > summary { cursor: pointer; }
.task-result-body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 4px; color: var(--vscode-foreground); }
.notice-error { color: var(--vscode-errorForeground); font-style: normal; display: flex; gap: 0.5em; align-items: baseline; flex-wrap: wrap; }
.notice-kind { font-size: 0.75em; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.8; border: 1px solid currentColor; border-radius: 3px; padding: 0 0.4em; }
/* 「继续」：与审批卡次级按钮同一套（链接色字 + 细边框 + hover 提亮），不用实色块 */
.notice-continue {
  margin-left: auto; cursor: pointer; font-size: 0.85em; font-style: normal; padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  background: transparent; color: var(--vscode-textLink-foreground);
  border-radius: 3px; transition: background 0.12s;
}
.notice-continue:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
.notice-action { display: flex; gap: 0.5em; align-items: baseline; flex-wrap: wrap; }
/* 流式中未闭合围栏的尾部：纯文本态，闭合瞬间切成渲染态 */
.markdown .stream-raw {
  margin: 0.5em 0; padding: 0.7em 0.9em; overflow-x: auto;
  background: var(--vscode-textCodeBlock-background);
  border-radius: ${RADIUS.xl}; border: 1px dashed color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px; white-space: pre-wrap; word-break: break-word;
}

/* ── 工具行─────────────────────────────────────────
 * **扁平行，不是卡片。** 之前每条命令是一张带边框的圆角卡，一轮十几个
 * 命令就是十几个边框叠在一起，视觉噪音盖过了内容。无边框行 + hover background，
 * 靠图标和缩进线组织层级 */
.tool-row { border-radius: ${RADIUS.xl}; }
.tool-head {
  display: flex; align-items: center; gap: 8px; width: calc(100% + 16px);
  height: 24px; margin: 0 -8px; padding: 0 8px;
  border: none; background: none; border-radius: ${RADIUS.md};
  color: var(--vscode-descriptionForeground); text-align: left; cursor: pointer;
  font-family: inherit; font-size: 0.92em;
}
.tool-head:hover, .tool-row[data-open="true"] .tool-head {
  background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground);
}
/* 行首是结果：✓ ✗ 都是灰、跑着转圈。只让正在跑的显眼——工具失败多是
 * agent 自己试错再改（SQL 写错、文件没有、grep 没匹配退出 1），用户
 * 10-29：「工具执行失败不用标记红色，实际上不关注」。失败的红只留给
 * 整轮出错（.notice-error / .fatal） */
.tool-icon {
  flex: none; width: 14px; display: inline-flex; justify-content: center;
  color: var(--vscode-descriptionForeground); opacity: 0.8;
}
.tool-icon .codicon { font-size: 13px; }
.tool-row[data-running="true"] .tool-title { color: var(--vscode-foreground); }
/* 工具的人话名（"Shell 命令"）。它是这一行的主语，其余都是修饰 */
.tool-title { flex: none; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 耗时紧跟图标（10-29 用户：放最右侧注意不到），常显：跑着蓝色跳秒，跑完
 * 灰色定格。定宽 4ch 右对齐 + tabular-nums：说明文字左边对齐、不随位数跳
 * （超过 1 分钟的 "1m 5s" 会撑宽这一格） */
.tool-duration {
  flex: none; min-width: 4ch; text-align: right; color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-variant-numeric: tabular-nums; font-size: 0.92em;
}
/* 命令降为次要：悬停或展开才出现。完整命令展开后在输出区上方看 */
.tool-cmd {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em;
}
.tool-cmd { opacity: 0; transition: opacity 0.12s; }
.tool-head:hover .tool-cmd, .tool-row[data-open="true"] .tool-cmd { opacity: 1; }
.tool-row[data-running="true"] .tool-duration { color: var(--vscode-textLink-foreground); }
/* 失败原因：不用点开就看得到（steps.ts errorLine），灰字不标红 */
.tool-err {
  margin: -2px 0 3px 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em;
  color: var(--vscode-descriptionForeground); opacity: 0.8;
}
/* spinner：一圈转圈的边框，跟编辑器主题色 */
.spinner {
  display: inline-block; width: 11px; height: 11px; border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  border-top-color: var(--vscode-textLink-foreground);
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
/* 输出区：限高滚动（D11）。开合动画用 grid-rows 0fr→1fr——不需要知道
 * 内容实际高度，max-height 技巧会截内容（D14b：CSS transition，不引 motion）。
 * 展开后是一个带边框的框：上面完整命令、下面输出（2026-10-28 改版）。
 * 边框、上下外边距只挂在展开态——收起态 0fr 压不掉它们，会吊一条线 */
.tool-body {
  display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 0.18s ease-out;
  margin-left: 22px;
}
.tool-body[data-open="true"] {
  grid-template-rows: auto;
  margin: 2px 0 8px 22px; overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  border-radius: ${RADIUS.md};
  background: var(--vscode-editor-background);
}
/* 0fr 只约束第一行：view_image/webfetch 带图时 pre 掉到隐式第二行（auto），
 * 收起态文本照样全量漏出（bash 只有 pre 一个子元素所以从没暴露）。无头
 * Chrome 复现截图确认后补的这两行——grid-auto-rows 把隐式行一起管住 */
.tool-body { grid-auto-rows: 0fr; }
/* 展开态是 auto 不是 1fr：fr 是平分的，各行被拉成等高（以最高一行为准），
 * 3 行的命令块会被 50 行的输出撑到一样高，底下大片空白。auto 才是各行
 * 独立按内容自适应（每块自己的 max-height: 46vh 封顶）。代价：fr↔auto
 * 不可插值，开合动画两个方向都没了（transition 静默失效，0.18s 的
 * 过渡变瞬间）——布局正确优先于动画 */
.tool-body[data-open="true"] { grid-auto-rows: auto; }
/**
 * **收起态 padding 必须归零。** 0fr 只压得扁内容，压不掉 grid item 自己的
 * padding——min-height:0 + overflow:hidden 对 padding 都不起作用（padding 不
 * 参与 min-height 的计算，box-sizing 也救不了）。留着 8px 上下内边距的话，
 * 每条折叠的命令下面都吊着一条 16px 的灰带，还漏出半行输出。
 * 实测：带 padding 时 grid-template-rows 解析成 16px 而不是 0px
 */
/* user 消息带的图（粘贴发送的）。链路早就通（hydrateItems 收图、pendingUser
 * 带图），这里只是渲染出来——不然贴过的图无迹可查 */
.user-images {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin: 6px 0; min-height: 0; overflow: hidden;
}
.user-images img {
  width: 96px; height: 96px; object-fit: contain;
  border-radius: 4px; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
}
.tool-images {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0 0 6px 0; min-height: 0; overflow: hidden;
}
.tool-images img {
  width: 96px; height: 96px; object-fit: cover;
  border-radius: ${RADIUS.md}; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
}
.tool-body pre {
  margin: 0; padding: 0; max-height: 46vh; overflow: hidden; min-height: 0;
  font-family: var(--vscode-editor-font-family); font-size: 0.86em;
  color: var(--vscode-descriptionForeground);
  white-space: pre-wrap; word-break: break-word;
}
/* 收起 = 0fr 行高裁掉内容（overflow hidden）；展开才允许滚动 */
.tool-body[data-open="true"] pre { overflow: auto; padding: 7px 10px; }
/* 完整命令块（展开态）：与下方输出之间一条分隔线，限高（长 heredoc 不把
 * 输出挤出视野）。同样只挂展开态 */
.tool-body[data-open="true"] .tool-cmd-full {
  max-height: 8em; color: var(--vscode-editor-foreground, var(--vscode-foreground));
}
.tool-body[data-open="true"] .tool-cmd-full:not(:last-child) {
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.tool-cmd-full::before { content: "$ "; color: var(--vscode-descriptionForeground); }
.tool-body[data-open="true"] .tool-images { padding: 7px 10px 0; }

/* ── thinking 块（只给流式中的那段思考，默认收起一行）──────────────── */
.thinking { margin: 0; }
.thinking-head {
  display: flex; align-items: center; gap: 8px; width: calc(100% + 16px);
  height: 24px; margin: 0 -8px; padding: 0 8px;
  border: none; background: none; border-radius: ${RADIUS.md};
  cursor: pointer; color: var(--vscode-descriptionForeground); text-align: left;
  font-family: inherit; font-size: 0.92em;
}
.thinking-head:hover { background: var(--vscode-list-hoverBackground); }
.thinking-icon { flex: none; width: 14px; display: inline-flex; justify-content: center; }
.thinking-icon .codicon { font-size: 13px; }
.thinking-label { flex: none; font-style: italic; }
.thinking-summary {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0.85;
}
.thinking-wrap {
  display: grid; grid-template-rows: 0fr;
  transition: grid-template-rows 0.18s ease-out;
  margin-left: 8px; padding-left: 12px;
  border-left: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
}
.thinking-wrap[data-open="true"] { grid-template-rows: 1fr; }
/* margin 归零的理由同 .tool-body pre：0fr 压不掉 grid item 的外边距，
 * 收起的 thinking 块下面会吊一条 8px 空带 */
.thinking-body {
  margin: 0; padding: 0;
  overflow: hidden; min-height: 0; /* grid-rows 动画的裁切配合 */
  color: var(--vscode-descriptionForeground);
  font-size: 0.95em;
}
/* thinking 段落：紧凑段距，不吃正文 0.75em */
.thinking-body p { margin-bottom: 0; }
.thinking-wrap[data-open="true"] .thinking-body {
  overflow: auto; max-height: 40vh; margin: 2px 0 6px;
}

/* ── 处理过程（第三层：一轮结束后整段过程收成一行）────────────────
 * 「› 处理过程  ≡ 12 步  ⚒ 39 个操作  ⊗ 1 个失败  ◷ 耗时」+ 右侧操作条，
 * 整行一条淡底圆角条（10-29 对比页用户选 P3）。原来下面一条 panel-border
 * 细线和回答隔开，IntelliJ New UI 这类主题里它等于页面底色、看不见；
 * 底色用前景色混色，不依赖主题面板色。点开是同一条时间线（各步收起） */
.process { margin-bottom: 10px; }
.process-head {
  display: flex; align-items: center; gap: 0; width: 100%;
  padding: 6px 10px; border: none; border-radius: ${RADIUS.md};
  background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
  color: var(--vscode-descriptionForeground); text-align: left; cursor: pointer;
  font-family: inherit; font-size: 0.9em;
}
.process-head:hover { background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent); }
.process-head .codicon { font-size: 14px; margin-right: 6px; }
.process-head > span { flex: none; white-space: nowrap; }
.process-title { color: var(--vscode-foreground); font-weight: 600; }
/* 图标打头的计数项，图标与回答底部那行（.footer-item）同款 */
.process-meta { display: inline-flex; align-items: center; gap: 4px; margin-left: 14px; }
.process-head .process-meta .codicon { font-size: 13px; margin: 0; opacity: 0.8; }
/* 操作条：一格一条命令，步与步之间空一格。窄面板里格子自动变细，
 * 不挤文字（flex-shrink 落在格子上） */
.process-head > .process-strip {
  flex: 0 1 220px; min-width: 40px; margin-left: auto; padding-left: 10px;
  display: flex; justify-content: flex-end; align-items: center; gap: 4px; overflow: hidden;
}
.strip-step { display: flex; gap: 1px; min-width: 0; flex: 0 1 auto; }
.strip-step > i {
  flex: 0 1 3px; min-width: 1px; height: 10px; border-radius: 1px;
  background: var(--vscode-descriptionForeground); opacity: 0.45;
}
.process-body { padding-top: 4px; }

/* ── 一轮与时间线（timeline.tsx，2026-10-28 改版）─────────────────────
 * 用户消息吸在本轮顶部（轮结束、下一轮的消息上来时被顶走）；展开的长消息
 * 和带图的消息不吸——吸住会占掉半屏 */
.turn { position: relative; }
/* 一问一答是一个单元，和上一轮隔开（10-29 用户：「一个 query 一个结果，和
 * 上一个对话应该分离一些」）。线色同 .user 底色的思路，不用 panel-border。
 * 间距 18px 用户看过嫌近（「离上一条回答再远一些」），线上留宽、线下留窄：
 * 线归属下一轮 */
.turn + .turn {
  margin-top: 36px; padding-top: 18px;
  border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.turn-head {
  /* top/margin-top 取 -8px 抵掉 .log 的 8px padding：top:0 吸在内容边上，
   * 上面留一条 8px 缝，滚过去的正文从用户消息头顶露出来（10-29 实测）。
   * padding-top 补回 8px，不吸时位置不变 */
  position: sticky; top: -8px; z-index: 2; margin: -8px -8px 0; padding: 10px 8px 8px;
  background: var(--vscode-sideBar-background);
}
.turn-head:has(.user:not(.user-clamp)), .turn-head:has(.user-images) { position: relative; top: 0; }
.turn-head > .item { margin-bottom: 0; }
/* 用户消息和下面的「处理过程」/时间线/回答拉开（10-29 用户：「用户的
 * query，距离进行中，处理过程距离也要远些」）。加在头外面不加在头的
 * padding 上：吸顶头不变高，不多挡正文。用户看过 10px 嫌「和进行中的距离
 * 还不够」，进行中上下现各 24px（.turn-progress margin + 这里 12px + 头的
 * padding-bottom 8px + .tl padding 4px）*/
.turn-head + * { margin-top: 12px; }
/* 跑着的一轮：头里最后是「进行中」，它是下面步骤的标题，贴近步骤（头的
 * padding-bottom 8 + .tl padding-top 4 = 12px）。用户看过上下各 24px：
 * 「进行中 距离下面的操作是不是太远了」 */
.turn-head + .tl { margin-top: 0; }
.turn-progress {
  margin: 24px 2px 0; font-size: 0.85em; color: var(--vscode-descriptionForeground);
}
.turn-live { color: var(--vscode-textLink-foreground); }
.turn-live::before {
  content: ""; display: inline-block; width: 6px; height: 6px; margin: 0 5px 1px 0;
  border-radius: 50%; background: currentColor;
}

/* 时间线：说明是节点，命令是节点下的一行；层级靠缩进和竖线，不加框和底色 */
.tl { position: relative; padding: 4px 0 8px 20px; }
.tl::before {
  content: ""; position: absolute; left: 6px; top: 12px; bottom: 18px; width: 1px;
  /* panel-border 在 Dark Modern 是 #2b2b2b，压在 #181818 上几乎看不见；
   * 取说明文字色的 30%，深浅主题都和原型的 #3a3a3a 一个观感 */
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 30%, transparent);
}
.tl-step { position: relative; padding-top: 10px; }
.tl-step:first-child { padding-top: 0; }
.tl-node {
  position: absolute; left: -18px; top: 16px; width: 9px; height: 9px; border-radius: 50%;
  border: 1.5px solid var(--vscode-descriptionForeground);
  background: var(--vscode-sideBar-background);
}
.tl-step:first-child .tl-node { top: 6px; }
.tl-step[data-current="true"] .tl-node { border-color: var(--vscode-textLink-foreground); }
/* 呼吸光圈：光圈画在伪元素上，只动 opacity（合成线程跑，不重绘）。直接动
 * box-shadow 的话整轮跑着期间每帧重绘，空闲时主线程也占 8%（trace 实测） */
.tl-step[data-current="true"] .tl-node::after {
  content: ""; position: absolute; inset: -1.5px; border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-textLink-foreground) 25%, transparent);
  animation: tl-pulse 1.6s ease-in-out infinite;
}
@keyframes tl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
.tl-text p { margin-bottom: 0.3em; }
.tl-text > :last-child { margin-bottom: 0; }
.tl-step > .item { margin-bottom: 0; }
.tl-block > .item { margin: 8px 0 0; }
/* 句尾「N 个操作 ›」：点开/收起这一步 */
.tl-count {
  display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; padding: 0 6px;
  height: 18px; vertical-align: 1px; border: none; border-radius: ${RADIUS.sm};
  background: none; color: var(--vscode-descriptionForeground); cursor: pointer;
  font-family: inherit; font-size: 0.85em; white-space: nowrap;
}
.tl-count:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.tl-count .codicon { font-size: 12px; transition: transform 0.15s; }
.tl-count[data-open="true"] .codicon { transform: rotate(90deg); }
.tl-fail { white-space: pre; }
.tl-count-row > .tl-count { margin-left: -6px; }
/* 想完的思考：步骤右上角「思考 N」，悬停才出现；没有说明也没有命令的步骤常显 */
.tl-think {
  position: absolute; right: -4px; top: 10px; opacity: 0; transition: opacity 0.12s;
  padding: 0 6px; border: none; border-radius: ${RADIUS.sm}; cursor: pointer;
  background: var(--vscode-sideBar-background); color: var(--vscode-descriptionForeground);
  font-family: inherit; font-size: 0.8em; line-height: 18px;
  /* 压在说明文字上：左缘一段渐隐，别把字切成半截（340px 窄栏实测） */
  box-shadow: -10px 0 8px var(--vscode-sideBar-background);
}
.tl-step:first-child > .tl-think { top: 0; }
.tl-step:hover > .tl-think, .tl-think:focus-visible { opacity: 1; }
.tl-think[data-bare="true"] { position: static; opacity: 1; margin-left: -6px; }
.tl-think:hover { color: var(--vscode-foreground); }
.tl-thinks {
  margin: 4px 0 2px; padding: 2px 10px; max-height: 180px; overflow: auto;
  border-left: 2px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  color: var(--vscode-descriptionForeground); font-size: 0.9em; font-style: italic;
}
.tl-thinks p { margin-bottom: 0.3em; }
.tl-thinks hr { margin: 0.4em 0; }
.tl-ops { margin-top: 3px; }

/* ── 消息页脚（turn footer）──────────────────
 * 只在一轮结束后出现，且只挂在最后一条 assistant 消息下 */
.footer {
  display: flex; flex-wrap: wrap; align-items: center; gap: 3px 10px;
  margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 0.88em;
}
.footer-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.footer-item .codicon { font-size: 13px; opacity: 0.8; }
.footer-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.footer-time { font-variant-numeric: tabular-nums; }
/* 有「处理过程」那一行的轮，耗时已在那行，底部不重复（10-29 对比页用户选 F1） */
.turn:has(> .process) .footer-elapsed { display: none; }
.footer-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.footer-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border: none; background: none;
  border-radius: ${RADIUS.sm}; color: inherit; cursor: pointer;
}
.footer-btn:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.footer-btn .codicon { font-size: 14px; }
.footer-btn[data-done="true"] { color: var(--vscode-testing-iconPassedForeground); }

/* 发送前的贴图预览：缩略图一排，× 删除。发出去之后 user 气泡里另有渲染 */
.attach {
  display: flex; gap: 6px; flex-wrap: wrap; padding: 4px 2px 6px;
}
.attach-thumb {
  position: relative; width: 56px; height: 56px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 6px; overflow: hidden;
}
.attach-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.attach-thumb button {
  position: absolute; top: 0; right: 0; width: 18px; height: 18px;
  padding: 0; border: none; border-radius: 0 0 0 6px;
  background: color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
  color: var(--vscode-foreground); cursor: pointer; line-height: 1;
  font-size: 13px;
}
.attach-thumb button:hover { background: var(--vscode-inputOption-activeBackground); }

/* 拖入文件的路径气泡（2026-09-12 方案 A）：横向 chip，长路径 ellipsis，
 * 完整路径在 title 悬停可见；× 与图片预览条同构 */
.attach-files {
  display: flex; gap: 6px; flex-wrap: wrap; padding: 4px 2px 6px;
}
.file-chip {
  display: flex; align-items: center; gap: 2px;
  max-width: 260px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 6px;
  background: color-mix(in srgb, var(--vscode-input-background) 60%, transparent);
}
.file-chip-name {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 6px; font-size: 11px;
  font-family: var(--vscode-editor-font-family, monospace);
  direction: rtl; text-align: left;
}
.file-chip button {
  flex: none; width: 18px; height: 18px;
  padding: 0; border: none; border-radius: 0 6px 6px 0;
  background: transparent; color: var(--vscode-foreground);
  cursor: pointer; line-height: 1; font-size: 13px;
}
.file-chip button:hover { background: var(--vscode-inputOption-activeBackground); }

/* 输入框把底栏包在同一个框里（2026-10-29 拍板 B2）：输入和模型/深度/上下文
   是一组东西。框画在 .composer 上，textarea 自己去掉边框和底色；聚焦只认
   textarea——点底栏的下拉不算在打字，框不亮 */
.composer {
  margin: 2px 8px 8px; padding: 6px 8px;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: ${RADIUS.md};
  background: var(--vscode-input-background);
}
.composer:has(textarea:focus) { border-color: var(--vscode-focusBorder); }
.composer textarea {
  width: 100%; resize: none; min-height: 44px;
  font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground);
  background: transparent; border: none; padding: 2px 0;
}
.composer textarea:focus { outline: none; }
.bar { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
/* 右侧组：推理深度 → 模型 → 发送。用 margin-left:auto 而不是给 .bar 加
   justify-content:space-between——左边的 .usage 在没用量时整个不渲染，
   space-between 那时会把右侧组甩到最左边 */
.bar-right { margin-left: auto; display: flex; align-items: center; gap: 4px; min-width: 0; }
.bar button {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: none; padding: 3px 12px; border-radius: ${RADIUS.sm}; cursor: pointer;
}
.bar button:hover { background: var(--vscode-button-hoverBackground); }
.bar button:disabled { opacity: 0.5; cursor: default; }

/* 发送/停止：圆形图标钮。底栏唯一的主动作，实色块留给它一个——
   旁边的次要控件全是扁平文字，主次靠形状而不是靠大小区分。
   停止态换红底：这时点下去是「打断」，和「发出去」是相反的事 */
.bar button.send-btn {
  width: 26px; height: 26px; padding: 0; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
}
.bar button.send-btn .codicon { font-size: 15px; }
/* 自绘纸飞机（App.tsx PlaneIcon）：block 去掉行内元素的基线间隙，
   不然 flex 居中会被那几 px 的下沉带偏 */
.bar button.send-btn svg { display: block; }
.bar button.send-btn.is-stop { background: var(--vscode-charts-red, #f85149); }
.bar button.send-btn.is-stop:hover { background: var(--vscode-charts-red, #f85149); filter: brightness(1.12); }

/* 底栏的次要控件（推理深度 / 模型）。**扁平，没有边框和背景**，
   靠 hover 变化而不是画框来给反馈。
   三个控件各带一个框的话，噪音会盖过右边那个真正要点的发送按钮 */
.ctl-group {
  display: inline-flex; align-items: center; gap: 2px; min-width: 0;
  color: var(--vscode-descriptionForeground);
  border-radius: ${RADIUS.sm}; padding: 0 2px;
}
.ctl-group:hover:not(:has(:disabled)) {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground);
}
/* 推理深度被手动盖过时点亮（muted → 强调色）：
   一眼看出是「我设的」还是「跟着配置走」 */
.ctl-group[data-on="true"] { color: var(--vscode-textLink-foreground); }
.ctl-group .codicon { font-size: 13px; flex-shrink: 0; }
/* 自绘下拉的触发器（menu.tsx）：样式语义同原生的 .ctl，外加 chevron。
   扁平无边框的观感由外层 .ctl-group 给，这里只管行内排布 */
.ctl.trigger {
  display: inline-flex; align-items: center; gap: 4px;
  color: inherit; background: transparent; border: none;
  font-size: 0.9em; font-family: inherit;
  padding: 2px 0; cursor: pointer; min-width: 0;
}
.ctl.trigger:disabled { opacity: 0.5; cursor: default; }
/* 触发器本身是 .bar 里的 <button>：.bar button:hover (0,2,1) 压过 .ctl.trigger
   (0,2,0)，悬停时铺上主按钮蓝、盖住外层 .ctl-group 的工具栏灰，跟审批开关
   悬停颜色不一致（2026-10-08）。这里解掉，hover 反馈只由 .ctl-group 给 */
.bar .ctl.trigger:hover { background: transparent; }
/* 底栏文字统一 0.85em（同 .usage、审批开关）；原来 0.9em 比旁边大一号 */
.bar .ctl.trigger { font-size: 0.85em; }
.trigger .codicon-chevron-down, .trigger .codicon-chevron-up {
  font-size: 12px; opacity: 0.8;
}
.trigger-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-picker .trigger-label { max-width: 12em; } /* 模型名长了截断，别撑爆底栏 */

/* 弹层。锚在 .picker 上、只向上开（触发器在 webview 最底部的输入框底栏，
 * 向下弹出屏）。面板观感：圆角描边 + 当前项打勾 */
.picker { position: relative; }
.menu {
  position: absolute; bottom: calc(100% + 4px); right: 0; z-index: 20;
  min-width: 220px; max-width: 520px; max-height: 50vh; overflow-y: auto;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: ${RADIUS.md};
  padding: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  outline: none; /* 焦点在容器上（tabIndex=-1）；高亮走 data-active，不画系统焦点框 */
}
.menu.drop-down { bottom: auto; top: calc(100% + 4px); }
.menu-head {
  padding: 4px 8px 2px;
  font-size: 0.82em; color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
.menu-item {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 8px; border-radius: ${RADIUS.sm};
  cursor: pointer;
}
.menu-item:hover, .menu-item[data-active='true'] {
  background: var(--vscode-list-hoverBackground);
}
/* 主行 basename / 副行完整路径**纵向**排布。之前横向 flex 塞 label + 长
   路径 sub，路径把 basename 挤到 0 宽、只剩路径尾巴露出来（"ase"）。
   menu-text 占满、min-width:0 让两行各自 ellipsis 右截；check 固定右侧 */
.menu-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.menu-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-sub { color: var(--vscode-descriptionForeground); font-size: 0.88em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-item .codicon-check {
  margin-left: auto; font-size: 13px; visibility: hidden;
}
.menu-item[aria-checked='true'] .codicon-check { visibility: visible; }
/* 耗时统计：空间不够时**它让路**（收缩 + 省略号），把位置留给上下文按钮
   和右侧控件——「还剩多少上下文」比「上一轮花了多久」更需要一直看见 */
.usage {
  color: var(--vscode-descriptionForeground); font-size: 0.85em;
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 窄侧栏先整段让掉耗时统计，再让掉「上下文」「记忆」两个字（只留图标和数字），
   位置留给模型名——不让路时 480px 宽模型名被挤成「gl…」。耗时统计在场时
   右侧组不缩：按比例一起缩哪怕只缩零点几 px，模型名也会出省略号 */
@media (min-width: 635px) { .bar-right { flex-shrink: 0; } }
@media (max-width: 634px) { .usage { display: none; } }
@media (max-width: 520px) { .bar-word { display: none; } }
/* 「上下文 X」：环形水位 + 文字的胶囊钮。**必须压过 .bar button 的实色
   兜底**——只写 background:none 会被那条规则的蓝底盖掉，底栏上就多出
   一个蓝方框（2026-09-18 真栽过，见 simple-code-statusbar-shape 档案）。
   形状语言跟右侧控件一致：扁平、无边框、hover 给底色；实色块只留给发送键 */
.bar button.usage-ctx {
  display: inline-flex; align-items: center; gap: 6px;
  background: none; border: none;
  padding: 2px 7px 2px 3px;
  border-radius: 11px;
  color: var(--vscode-descriptionForeground);
  font: inherit; font-variant-numeric: tabular-nums;
  cursor: pointer;
}
/* 不参与收缩：环 + 数字是个整体，压扁就成了半个环加半个数 */
.bar button.usage-ctx { flex: none; font-size: 0.85em; }
.bar button.usage-ctx:hover {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
}
/* svg 的 block 去掉行内基线下沉，不然 flex 居中会偏几 px（同 send-btn） */
.usage-ring { display: block; flex: none; }
/* 上下文分析面板（方案 A）：底部锚定的小浮层，遮罩轻——它不是模态对话框 */
.ctx-mask {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: flex-end; justify-content: flex-start;
  padding: 0 12px 64px; /* 64px：抬过底栏，面板贴着「上下文 X」上方 */
  background: transparent; /* 只做点外关闭的命中区，不压暗 */
}
.ctx-panel {
  /* **不设 min-width**：侧栏能拖到 300px 以下，固定宽度会横向溢出被裁掉
     右半边（时间戳和占比列首当其冲）。宽度跟着遮罩走、上限 300——范围列
     删除后（2026-09-30）480 宽里标签与数字隔得太远，对行费眼 */
  width: 100%; max-width: 300px; min-width: 0;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  border-radius: ${RADIUS.md};
  background: var(--vscode-editor-background);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  cursor: default;
}
.ctx-panel {
  /* 空闲区的灰：堆叠条的轨道底色，也是列表里「空闲」那行的色点 */
  --ctx-idle: color-mix(in srgb, var(--vscode-foreground) 22%, transparent);
  /* charts 变量只有 6 个彩色（红蓝黄橙绿紫），而分区有 8 个。缺的两个
     由混色补：青 = 绿+蓝（和「未卸载」同族，表示都是原文），
     粉 = 紫+红（避开正红的「报警」语义） */
  --ctx-teal: color-mix(in srgb, var(--vscode-charts-green, #89d185) 55%, var(--vscode-charts-blue, #3794ff));
  --ctx-pink: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 55%, var(--vscode-charts-red, #f14c4c));
}
.ctx-head { margin-bottom: 12px; }
.ctx-title { font-size: 0.95em; font-weight: 600; letter-spacing: 0.02em; }
.ctx-sub {
  font-size: 0.82em; margin-top: 3px;
  color: var(--vscode-descriptionForeground);
}
.ctx-sub b {
  color: var(--vscode-foreground); font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ctx-at { float: right; opacity: 0.75; }
/* 总览堆叠条：各段按真实百分比，剩余露出轨道底色即空闲。gap 会让
   宽度和不等于 100%，所以段之间不留缝——靠颜色本身分隔 */
.ctx-stack {
  display: flex; height: 8px;
  border-radius: 4px; overflow: hidden;
  background: var(--ctx-idle);
  margin-bottom: 12px;
}
.ctx-stack span { display: block; min-width: 1px; }
.ctx-list { display: flex; flex-direction: column; }
/* 行高 25px + hover 底色：和底栏控件同一套反馈语言（扁平 + hover） */
.ctx-row {
  display: flex; align-items: center; gap: 8px;
  height: 25px; padding: 0 4px;
  border-radius: ${RADIUS.sm};
  font-size: 0.86em;
}
.ctx-row:hover { background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
.ctx-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
/* 标签占住中间的伸缩位，把数字列推到右边（2026-09-30 范围列删除前由它占） */
.ctx-label { flex: 1; white-space: nowrap; }
.ctx-num {
  width: 4.2em; text-align: right; white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ctx-pct {
  width: 3.4em; text-align: right;
  color: var(--vscode-descriptionForeground);
  font-variant-numeric: tabular-nums;
}
.ctx-empty { color: var(--vscode-descriptionForeground); font-size: 0.9em; padding: 6px 0; }
/* 手动压缩：标题行右侧的小按钮，扁平 + hover，同 .ctx-row / 底栏控件的反馈语言；
   不用主按钮的实心蓝——面板是看数用的，压缩是偶尔点一下的次要动作 */
.ctx-title-row { display: flex; align-items: center; gap: 8px; }
.ctx-title-row .ctx-title { flex: 1; }
.ctx-compact {
  flex: none; padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  border-radius: ${RADIUS.sm};
  font: inherit; font-size: 0.78em; line-height: 1.5;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}
.ctx-compact:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
}
.ctx-compact:disabled { opacity: 0.5; cursor: default; }
/* 记忆面板（memory-panel.tsx）：双选项并排 + 四元组数字弱化 */
.mem-choice { display: flex; gap: 6px; }
/* 结果 / 运行中提示：只在有话说时出现，可多行（结果 + AGENTS 超限提示） */
.ctx-hint {
  font-size: 0.8em; margin-top: 3px; white-space: pre-line;
  color: var(--vscode-descriptionForeground);
}
/* 点开的原图。data URL 本来就带 mime，浏览器自己渲染；这里只管居中和关闭 */
.lightbox {
  position: fixed; inset: 0; z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
  cursor: zoom-out;
}
.lightbox img {
  max-width: 92vw; max-height: 92vh;
  border-radius: ${RADIUS.md};
  background: var(--vscode-editor-background);
  cursor: default; /* 点图不关（App 里 stopPropagation），只有点空白才关 */
}
.user-images img, .tool-images img, .attach-thumb img { cursor: zoom-in; }
.fatal {
  color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-errorForeground);
  border-radius: ${RADIUS.sm};
  padding: 6px 8px; margin: 8px;
}

/* 空窗口引导（App 的 early return）：没有打开的文件夹——中性提示，
   不是错误（区别于 .fatal 的红色边框） */
.empty-folder {
  margin: auto; /* .app 是 flex 列，auto 居中 */
  max-width: 460px;
  padding: 20px 24px;
  /* panel-border 在 IDEA New UI Dark 里与底色同色（theme-lines 约定），
     用前景色混出可见边 */
  border: 1px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
  border-radius: ${RADIUS.md};
  color: var(--vscode-descriptionForeground);
   font-size: 12px;
   line-height: 1.7;
   text-align: center;
}
.empty-folder-title {
   color: var(--vscode-foreground);
   font-size: 13px;
   font-weight: 600;
   margin-bottom: 8px;
}

/* 路径链接（pathlink）：无 href 的 a。与标题同色系（都源自 textLink
   token，见上方标题规则注释），靠「点线 + hover 背景」形状区分——
   标题没有下划线，链接有，颜色相同也认得出。 */
.user a[data-open-path],
.markdown a[data-open-path] {
  cursor: pointer;
  color: var(--vscode-textLink-foreground);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  transition: background-color 0.12s;
}
.user a[data-open-path]:hover,
.markdown a[data-open-path]:hover {
  color: var(--vscode-textLink-activeForeground);
  background: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
}

/* 行内 code 里的路径链接：code 自带灰底，点线叠在等宽块上很吵（红框
   那样）。去掉下划线只留彩色，hover 再显示——code 底色上一段干净的链接
   色路径，比「下划线穿过背景」清楚得多 */
.markdown code a[data-open-path],
.markdown pre a[data-open-path],
code a[data-open-path] {
  text-decoration: none;
  color: var(--vscode-textLink-foreground);
}
.markdown code a[data-open-path]:hover,
.markdown pre a[data-open-path]:hover,
code a[data-open-path]:hover {
  text-decoration: underline dotted;
  color: var(--vscode-textLink-activeForeground);
}

/* 拖文件悬停时的提示：整个 composer 内框高亮（dropPaths 拖拽落点反馈） */
.composer.dragover {
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}


/* ── 审批（approval.md §4.2）：命令下方挂卡 + footer 开关 ────── */

/* 审批卡挂在触发它的 tool 行下面（activity.tsx ToolRow 内），不再是
   贴在输入框上方的警告条。是流程里「等用户一下」的卡片，不是错误横幅。
   10-29 跟上时间线改版：「处理过程」那一行同款前景淡底圆角，不用
   widget-border / editorWidget-background / input-background——用户主题
   （IDEA New UI Dark）里它们都等于页面底色，卡片、按钮边框、输入框全看不见 */
.approval-card {
  margin: 0 0 8px;
  padding: 10px 12px;
  border-radius: ${RADIUS.md};
  background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
  display: flex; flex-direction: column; gap: 8px;
}
.approval-title {
  font-size: 0.85em; color: var(--vscode-descriptionForeground);
  display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap;
}
.approval-tag {
  color: var(--vscode-charts-orange, #d29922);
  font-weight: 500; letter-spacing: 0.01em;
}
.approval-reason { opacity: 0.8; white-space: pre-line; }
.approval-detail { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
/* 「始终允许将记」的路径：和回答里的行内代码同款（.markdown code），不用宿主黄 */
.approval-detail code {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
  padding: 0 0.38em; border-radius: ${RADIUS.sm};
}
/* 在按钮那一行的最右侧 */
.approval-countdown {
  margin-left: auto; font-size: 0.8em; color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
.approval-countdown[data-urgent='true'] { color: var(--vscode-errorForeground); }
.approval-cmd {
  margin: 0; padding: 6px 8px; border-radius: 3px;
  background: var(--vscode-textCodeBlock-background);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.85em; white-space: pre-wrap; word-break: break-all;
  max-height: 12em; overflow-y: auto;
}
/* 「允许一次」是宿主主按钮色的实心块（最常按的那个），其余灰底；
   拒绝只把字染红 */
.approval-actions { display: flex; gap: 8px; align-items: center; }
.approval-actions button {
  cursor: pointer; font-family: inherit; font-size: 0.85em; padding: 3px 12px;
  border: none; border-radius: ${RADIUS.sm}; transition: background 0.12s;
  background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  color: var(--vscode-foreground);
}
.approval-actions button:hover { background: color-mix(in srgb, var(--vscode-foreground) 14%, transparent); }
.approval-actions button.approval-once {
  background: var(--vscode-button-background); color: var(--vscode-button-foreground, #fff);
}
.approval-actions button.approval-once:hover {
  background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
}
.approval-actions button.approval-deny { color: var(--vscode-errorForeground); }
.approval-feedback {
  /* 拒绝反馈输入框：次要到几乎隐形，placeholder 说清用途，不打扰想
     直接三键答复的用户。框线用前景 14% 内阴影，聚焦换 focusBorder */
  width: 100%; font-family: inherit; font-size: 0.85em;
  padding: 5px 8px; box-sizing: border-box; border: none; border-radius: ${RADIUS.sm};
  background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
  color: var(--vscode-input-foreground, inherit);
}
.approval-feedback:focus { outline: none; box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
/* 选择器必须带 .bar button 前缀：.bar button 的特异性是 (0,1,1)，
   单写 .approval-toggle (0,1,0) 压不过它，写在后面也没用——.usage-ctx
   的 background:none 失效整整一个版本就是这个原因 */
.bar button.approval-toggle {
  /* 次级控件：跟 picker 同行但不抢注意力。关掉时用警示色点亮——
     「现在没守门」必须是扫一眼就能看到的状态 */
  font-size: 0.85em; color: var(--vscode-descriptionForeground);
  /* .bar button 给底栏所有按钮铺了实色主按钮蓝，次要控件必须自己解掉
     ——底栏真正该是实色块的只有发送那一个 */
  background: none; border: none; padding: 3px 5px; border-radius: ${RADIUS.sm};
  display: inline-flex; align-items: center; gap: 4px;
}
.bar button.approval-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15));
  color: var(--vscode-foreground);
}
.bar button.approval-toggle .codicon { font-size: 13px; }

/* 后台残留进程条（输入框上方）。一条命令一行（2026-10-28 拍板 A2）：
   desc 标签（前景色）+ 进程数/启动时刻；× 是唯一动作。原命令只在整行
   title 里（2026-10-29 拍板：行内一行必截断，看不出东西） */
.bg-strip {
  display: flex; flex-direction: column; gap: 2px;
  /* 左 17px = composer 外边距 8 + 边框 1 + 内边距 8：圆点与输入文字对齐 */
  padding: 4px 10px 4px 17px; border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
}
.bg-item {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--vscode-descriptionForeground);
}
.bg-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--vscode-charts-yellow, #cca700);
}
.bg-label {
  flex: 0 1 auto; min-width: 0; color: var(--vscode-foreground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bg-meta { flex: none; margin-left: auto; opacity: 0.8; font-variant-numeric: tabular-nums; }
.bg-kill {
  flex: none; border: none; background: none; cursor: pointer;
  color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1;
  padding: 0 2px;
}
.bg-kill:hover { color: var(--vscode-errorForeground); }

/* 任务条（task-v3，2026-09-23）：切任务 = 切目录同款体感，
   点谁 = 看谁 + 输入给谁。常驻渲染（+ 是开第一个分支的唯一入口），
   紧贴控件区上方。样式 = 目录 tab 同款下划线语言（用户拍板 2026-09-24：
   原来的实心药丸和整个插件的设计风格不一样）。条自己**不加**
   border-bottom：下面紧挨着输入框的框线，再加一条就是两条线（真机
   实测「两个下划线」，2026-09-24 修）。只有当前 tab 有蓝下划线 */
.branch-strip {
  /* 任务不限数（task-trunk）：放不下就换行，不横向溢出 */
  display: flex; flex-wrap: wrap; align-items: stretch; gap: 2px; flex: none;
  padding: 0 6px 0 9px; /* 9 + tab 内边距 8 = 17，与输入文字对齐（同 .bg-strip） */
  font-size: 11px;
}
.branch-tab {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 8px; min-width: 0;
  background: none; border: none; font: inherit; /* <button> 不继承字号，主任务曾是 13.3px */
  border-bottom: 1px solid transparent;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}
.branch-tab:hover { color: var(--vscode-foreground); }
/* 必须写 ='true'：React 把 false 渲染成 data-active="false"，只判属性存在
   会让每个 tab 都算选中 */
.branch-tab[data-active='true'] {
  color: var(--vscode-foreground);
  border-bottom-color: var(--vscode-focusBorder);
}
.branch-open {
  flex: none; border: none; background: none; cursor: pointer; padding: 0;
  color: inherit; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14em;
}
.branch-open:hover { text-decoration: underline; }
.branch-add {
  flex: none; border: none; background: none; cursor: pointer; padding: 2px 8px;
  color: var(--vscode-descriptionForeground); font-size: 11px;
}
.branch-add:hover:not(:disabled) { color: var(--vscode-foreground); }
.branch-add:disabled { opacity: 0.4; cursor: default; }
.branch-draft-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 3px 10px; margin: 2px 8px; border-radius: 4px;
  background: color-mix(in srgb, var(--vscode-charts-blue, #75beff) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #75beff) 45%, transparent);
  color: var(--vscode-foreground); font-size: 11px;
}
.branch-draft-bar button {
  border: none; background: none; cursor: pointer; padding: 0 4px;
  color: var(--vscode-descriptionForeground); font-size: 11px;
}
.branch-draft-bar button:hover { color: var(--vscode-foreground); text-decoration: underline; }
.task-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.task-dot[data-status='running'] { background: var(--vscode-charts-green, #89d185); }
.task-dot[data-status='idle'] { background: var(--vscode-charts-blue, #75beff); }
.task-dot[data-status='error'] { background: var(--vscode-errorForeground, #f48771); }
.task-dot[data-status='closing'] { background: var(--vscode-descriptionForeground, #8b8b8b); }
.task-btn {
  flex: none; border: none; background: none; cursor: pointer; padding: 0 2px;
  color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4;
}
.task-btn:hover { color: var(--vscode-foreground); }
.task-close { font-size: 13px; line-height: 1; } /* × 与进程条的 .bg-kill 同号 */
.task-close:hover { color: var(--vscode-errorForeground, #f48771); }
.branch-tab[data-status='closing'] { opacity: 0.55; }

/* 多根工作区的对话头（design.md §7）：消息列表顶上、fatal 条之下。
   单根不渲染，不占空间 */
.folder-head {
  display: flex; align-items: stretch; flex: none;
  padding: 0 4px 0 6px; border-bottom: 1px solid var(--vscode-editorGroup-border);
}
/* 平铺文件夹 tab（原 FolderPicker 下拉换掉，用户拍板 tab 化）。
   align-items:stretch + 垂直 padding 归零：tab 要撑满行高，自己的
   border-bottom 压住 head 的底线做选中高亮（margin-bottom:-1px 重叠）。
   overflow hidden 防 measure 收敛前一帧闪溢出 */
.folder-tabs { display: flex; align-items: stretch; flex: 1; min-width: 0; overflow: hidden;
  position: relative; /* 影子测量层的定位/裁剪锚点 */ }
.folder-tab {
  flex: none; display: inline-flex; align-items: center; gap: 5px;
  max-width: 11em; min-width: 0;
  padding: 8px 10px; margin-bottom: -1px;
  background: none; border: none;
  border-bottom: 1px solid transparent;
  color: var(--vscode-descriptionForeground); font: inherit;
  white-space: nowrap; cursor: pointer;
}
.folder-tab .tab-label { overflow: hidden; text-overflow: ellipsis; }
/* 影子测量层（controls.tsx）：溢出 tab 的副本，只为测宽不占布局 */
.folder-tab.tab-shadow { position: absolute; visibility: hidden; pointer-events: none; }
.folder-tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
.folder-tab.active {
  color: var(--vscode-foreground);
  border-bottom-color: var(--vscode-focusBorder);
}
/* 跑着的状态点：审批「允许」同款绿，视觉语义统一「这是活的东西」 */
.tab-dot {
  width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--vscode-charts-green, #3fb950);
}
/* 待审批角标：后台文件夹有卡挂着时亮在标签上。卡片本身不跨标签显示
   （怕人在没有对话上下文时误批），角标是唯一的可见信号，所以用审批卡
   同款警示色而不是 tab-dot 的绿——绿是「活着」，这里要的是「等人」 */
.tab-badge {
  flex: none;
  min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 7px;
  font-size: 10px; line-height: 14px; text-align: center;
  background: var(--vscode-charts-orange, #cca700);
  color: var(--vscode-editor-background, #1e1e1e);
}
/* 溢出「»」按钮：复用 Menu 触发器，缩成 tab 同款小方块 */
.folder-overflow { flex: none; }
.folder-overflow .trigger { height: auto; padding: 7px 8px; }
.folder-overflow .trigger-label { max-width: none; }
/* 弹层左对齐触发器 + 按内容撑宽。**根因**：.menu 通用规则是 right:0——右缘
   对齐触发器右缘，而 folder 弹层（8 项最长的 basename 撑到 ~230px）比触发器
   （一个 basename 宽）宽得多，右对齐会把弹层左缘推出视口（实测 left=-61px），
   每项从左被视口裁掉几个字符、只露尾巴（"sample-web-app" → "le-web-app"）。
   folder 在面板左上角，向右展开（left:0）永远在视口内；底栏的 model/effort
   靠右、继续用 right:0 向左展开。无头 Chrome 复刻页验证：-61px → +11px */
.menu.folder-overflow { left: 0; right: auto; width: max-content; max-width: none; }
.menu.folder-overflow .menu-label { overflow: visible; text-overflow: clip; }
/* 后台文件夹审批卡的来源标注 */
.approval-folder {
  font-size: 0.85em; color: var(--vscode-descriptionForeground);
  margin-bottom: 2px;
}

`
