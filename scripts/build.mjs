// 把 CLI 和 VS Code 扩展各自打成单文件。
//
// 为什么需要它：源码是靠 `--experimental-strip-types` 裸跑 `.ts` 的，
// 这条路只在命令行成立——扩展宿主不认，它只加载 JS。
//
// CLI 的网络 bin 在 package.json 里仍指向 `src/*.ts`，不改成 dist——
// 「core 能直接跑、不必等构建」是这个项目分包的目的（design.md §3）。
// dist 是给分发和扩展用的（sc 走 $SIMPLE_CODE_SC / ~/.simple-code/bin/sc），
// 不是开发入口。

import { copyFile, readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

// esm bundle 里 CJS 依赖的 require('child_process')（core 经 MCP SDK →
// cross-spawn 引入）没有 require 可用——垫一个 createRequire，esbuild 的
// __require shim 检测到全局 require 就走它。__dirname 同理：photon 用
// path.join(__dirname, 'photon_rs_bg.wasm') 定位 wasm，垫成 bundle 所在
// 目录（dist/），与下面的 wasm 拷贝目标一致
const ESM_REQUIRE_BANNER = {
  js: "import { createRequire as __scCr } from 'node:module'; import { fileURLToPath as __scFu } from 'node:url'; const require = __scCr(import.meta.url); const __dirname = __scFu(new URL('.', import.meta.url));",
}

/**
 * 三个产物，三套参数。每一条 external / format / define 都对应一种
 * 「配错了不报错，只是运行时坏掉」的情况，改之前先读注释。
 */
const TARGETS = [
  // 两个网络 bin（web-tools §10）：与 cli 同参数。esbuild 保留 shebang 并
  // 加执行位，vscode dist 和 cli dist 各一份——前者是 bash 工具经
  // $SIMPLE_CODE_WEBFETCH 调用的目标，后者给 CLI 的注入用
  {
    name: 'webfetch-bin',
    entry: 'packages/cli/src/webfetch-bin.ts',
    outfile: 'packages/cli/dist/webfetch.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'websearch-bin',
    entry: 'packages/cli/src/websearch-bin.ts',
    outfile: 'packages/cli/dist/websearch.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    // MCP over bash（mcp.md）："$SIMPLE_CODE_MCP" <server> <tool> '<json>'
    name: 'mcp-bin',
    entry: 'packages/cli/src/mcp-bin.ts',
    outfile: 'packages/cli/dist/mcp.js',
    options: {
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: ESM_REQUIRE_BANNER,
    },
  },
  {
    // sc —— agent 一次性 CLI（notes/sc-a-form-and-subagent-dissolved.md）
    name: 'sc-bin',
    entry: 'packages/cli/src/sc-bin.ts',
    outfile: 'packages/cli/dist/sc.js',
    // banner 垫 require/__dirname：REPL 跑 core 全量，photon（图片缩放）是
    // CJS + __dirname 定位 wasm，没有这两个就 ReferenceError
    options: { platform: 'node', format: 'esm', target: 'node22', banner: ESM_REQUIRE_BANNER },
  },
  {
    name: 'apply-patch-bin',
    entry: 'packages/cli/src/apply-patch-bin.ts',
    outfile: 'packages/cli/dist/apply-patch.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    // LSP 查询薄壳（lsp-bridge.ts 是宿主侧的桥）：POST 到 127.0.0.1
    // 桥端口（env SIMPLE_CODE_LSP_PORT），语言服务只在 VS Code 宿主里
    name: 'lsp-bin',
    entry: 'packages/cli/src/lsp-bin.ts',
    outfile: 'packages/cli/dist/lsp.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'memory-bin',
    entry: 'packages/cli/src/memory-bin.ts',
    outfile: 'packages/cli/dist/memory.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'lesson-bin',
    entry: 'packages/cli/src/lesson-bin.ts',
    outfile: 'packages/cli/dist/lesson.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'note-bin',
    entry: 'packages/cli/src/note-bin.ts',
    outfile: 'packages/cli/dist/note.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'event-bin',
    entry: 'packages/cli/src/event-bin.ts',
    outfile: 'packages/cli/dist/event.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'skill-bin',
    entry: 'packages/cli/src/skill-bin.ts',
    outfile: 'packages/cli/dist/skill.js',
    options: { platform: 'node', format: 'esm', target: 'node22' },
  },
  {
    name: 'extension',
    entry: 'packages/vscode/src/extension.ts',
    // **`.cjs` 不是 `.js`。** packages/vscode/package.json 有 "type": "module"
    // （源码是 ESM，测试要靠它），而那个字段对 dist 里的产物同样生效——扩展
    // 宿主加载 .js 时会按 ESM 解析这份 CJS 产物，报
    // 「This file is being treated as an ES module」，扩展直接激活失败。
    // 踩过：装进 Cursor 后点开面板一直转圈，日志里才看得到原因
    outfile: 'packages/vscode/dist/extension.cjs',
    options: {
      platform: 'node',
      // **cjs，不是 esm。** 扩展宿主用 require() 加载 package.json 的 main。
      // ESM 扩展要 VS Code 1.94+ 且有坑，我们的基线是 1.85
      format: 'cjs',
      // vscode 模块由宿主注入，磁盘上不存在——不 external 的话打包直接失败
      external: ['vscode'],
      // Cursor 是 Electron 40 / Node 24，但按基线 1.85 对应的 Node 18 打更保险
      target: 'node18',
      // **web-tree-sitter 强制走 cjs 入口。** 它的 ESM 版在 node 下靠
      // createRequire(import.meta.url) 建 require，cjs bundle 里
      // import.meta.url 被 esbuild shim 成 undefined → createRequire 炸
      // （ERR_INVALID_ARG_VALUE: filename）。alias 到 .cjs 文件绕开
      // exports 的 import 条件。cli 是 esm 产物、import.meta.url 真实，
      // 不需要
      alias: {
        'web-tree-sitter': `${root}packages/core/node_modules/web-tree-sitter/tree-sitter.cjs`,
      },
    },
  },
  {
    name: 'webview',
    entry: 'packages/vscode/webview/main.tsx',
    outfile: 'packages/vscode/dist/webview.js',
    options: {
      // **browser，不是 node。** 写成 node 的话 esbuild 会把 node 内置模块
      // 当成可用的，误引用时不报错，到浏览器里才炸
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      // 不用在每个 .tsx 顶部写 import React
      jsx: 'automatic',
      // 这里一度显式写了 `define: {'process.env.NODE_ENV': '"production"'}`，
      // 理由是「不写的话 React 的 process.env 引用会留在产物里，webview 没有
      // process 会白屏」。**变异检验发现去掉它产物一模一样**——platform:
      // 'browser' 已经自带这个 define 了。多余的一行，删
      minify: true,
    },
  },
]

for (const target of TARGETS) {
  await build({
    entryPoints: [`${root}${target.entry}`],
    outfile: `${root}${target.outfile}`,
    bundle: true,
    // 出错时栈指回 .ts。产物是几百 KB 的单文件，没有它只能看到
    // 「main.js:8137」，等于没有栈
    sourcemap: true,
    ...target.options,
    // core index 一导出 MCP SDK（cross-spawn 是 CJS，require('child_process')），
    // **所有** node+esm 产物都受累——不垫 createRequire 的话运行时才炸
    // （装机版 apply_patch 全军覆没过一次）。统一在这里处理，别在单个
    // target 里手写。webview 是 browser，没有 require，不适用
    ...(target.options.format === 'esm' && target.options.platform === 'node'
      ? { banner: ESM_REQUIRE_BANNER }
      : {}),
  })
  console.log(`built ${target.outfile}`)
}

/**
 * webview.js 内容 hash 进文件名。
 *
 * **Cursor 的 webview 对外链 `<script>` 缓存极顽固**：`?v=<mtime>` 的 query 会被
 * 它忽略，实测连 `Cmd+Q` 完全退出重开都还读旧 JS——表现为「改了代码、装了机、
 * 什么都没变」。CSS 是内联进 HTML 的、每次 resolve 重新生成，所以 CSS 改动生效、
 * JS 改动不生效，两者错位最难查。只有**文件名本身**变才绕得开缓存。
 *
 * 产出 `webview.<hash>.js`，并把当前文件名写进 `webview.current`；panel 读
 * `webview.current` 拿到带 hash 的名字去加载。
 */
{
  const dir = `${root}packages/vscode/dist`
  const buf = await readFile(`${dir}/webview.js`)
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10)
  const named = `webview.${hash}.js`
  // 先清历史 hash 文件，否则每次 build 攒一个、vsce 全打包进去，越滚越大
  for (const f of await readdir(dir)) {
    if (/^webview\.[0-9a-f]{10}\.js$/.test(f) && f !== named) await unlink(`${dir}/${f}`)
  }
  await writeFile(`${dir}/${named}`, buf)
  await writeFile(`${dir}/webview.current`, named)
  console.log(`webview content-hashed -> ${named}`)
}

// CLI 入口的 shebang 由 esbuild 原样保留，执行位也是它自己加的——
// 这里一度有行 chmod 0o755，变异检验时发现去掉它权限一模一样，是多余的

/**
 * codicon 字体拷进 dist。
 *
 * **必须和 codicon.css 同目录**：那份 css 里是 `url("./codicon.ttf?<hash>")`
 * 的相对引用。分开放的话 css 加载成功、字体 404，图标全渲染成空白方框——
 * 不报错，只是图标位置空着。
 *
 * 不能直接引 node_modules：vsce 打包时 --no-dependencies 不会把它带进 vsix
 * （带上则整个依赖树都进去，几十 MB）。拷到 dist 是唯一进得了包的路径。
 */
for (const file of ['codicon.css', 'codicon.ttf']) {
  await copyFile(
    `${root}packages/vscode/node_modules/@vscode/codicons/dist/${file}`,
    `${root}packages/vscode/dist/${file}`,
  )
}
console.log('copied codicon.css + codicon.ttf')

// photon 的 wasm 同理（web-tools §8 阶段 6）：photon_rs.js 被 bundle 后
// `__dirname` 指向 dist（CJS 天然如此；ESM 靠 banner 垫），wasm 必须在
// dist/ 下它才找得到。两份 dist 各拷——sc.js 也是人用的入口，图片消息
// 会走 resizer
await copyFile(
  `${root}packages/core/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`,
  `${root}packages/vscode/dist/photon_rs_bg.wasm`,
)
await copyFile(
  `${root}packages/core/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm`,
  `${root}packages/cli/dist/photon_rs_bg.wasm`,
)
console.log('copied photon_rs_bg.wasm (vscode dist + cli dist)')

// 自我运行手册（self.md）：源在 docs/（人维护），打进两份 dist——
// $SIMPLE_CODE_DOC 由两侧宿主（extension.ts / run.ts）注入，agent 在
// 任何目录下都能查自己怎么运作（教程，见 docs/self.md 头注）
for (const pkg of ['vscode', 'cli']) {
  await copyFile(`${root}docs/self.md`, `${root}packages/${pkg}/dist/self.md`)
}
console.log('copied self.md (vscode dist + cli dist)')

// README / LICENSE 拷进 packages/vscode/（2026-09-19 发布收尾）：vsce 从
// manifest 所在目录打包，够不着仓库根目录——不拷的话 vsix 里没有这两份，
// marketplace 页面正文是空的、许可信息缺失。只有 vscode 侧要：cli 不打包。
// 拷贝件是构建产物（根目录那份是唯一权威版本），.gitignore 掉防漂移
await copyFile(`${root}README.md`, `${root}packages/vscode/README.md`)
await copyFile(`${root}LICENSE`, `${root}packages/vscode/LICENSE`)
console.log('copied README.md + LICENSE (vscode package root)')

// 两个网络 bin 拷进 vscode/dist（.vscodeignore 没排除 dist，vsce 会带上；
// extension.cjs 的 activate 注入的 $SIMPLE_CODE_* 指向这里）
// 新增 bin 记得登记这里——构建（TARGETS）只是产出，不拷进 vscode/dist
// vsce 就带不上，$SIMPLE_CODE_* 指向空文件静默失败（event.js 漏过一次）
for (const bin of ['webfetch.js', 'websearch.js', 'mcp.js', 'apply-patch.js', 'memory.js', 'lesson.js', 'note.js', 'skill.js', 'sc.js', 'lsp.js', 'event.js']) {
  await copyFile(`${root}packages/cli/dist/${bin}`, `${root}packages/vscode/dist/${bin}`)
}
console.log('copied webfetch.js + websearch.js')

// tree-sitter wasm（审批 AST 层，shell-ast.ts）：bundle 后 bundleDir()
// 在 dist/，两个 wasm 都要在。CLI 的 dist 也各拷一份——esm 单文件产物
// 同样找不到 node_modules（分发给没装依赖的用户）
for (const [pkg, file] of [
  ['web-tree-sitter', 'tree-sitter.wasm'],
  ['tree-sitter-bash', 'tree-sitter-bash.wasm'],
]) {
  const src = `${root}packages/core/node_modules/${pkg}/${file}`
  await copyFile(src, `${root}packages/vscode/dist/${file}`)
  await copyFile(src, `${root}packages/cli/dist/${file}`)
}
console.log('copied tree-sitter wasm x2 (vscode + cli dist)')
