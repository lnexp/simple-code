import { join } from 'node:path'
import * as vscode from 'vscode'
import { ensureShims, type ShimEntry } from '@simple-code/core'
import { startLspBridge } from './lsp-bridge.ts'
import { ChatPanel } from './panel.ts'

/**
 * 全部 bin 名（→ dist 里同名 .js）。DOC 例外：只读的文档，不是可执行。
 * LSP（lsp-bridge.ts）：bin POST 到本机桥，桥调宿主现成的
 * execute*Provider——审批侧 "$SIMPLE_CODE_*" 自家 bin 规则 0 天然放行
 * （LSP 只读、固定语义，非 APPLY_PATCH 那种内容决定路径的例外）
 */
const BINS = [
  'WEBFETCH', 'WEBSEARCH', 'MCP', 'APPLY_PATCH', 'MEMORY', 'LESSON',
  'NOTE', 'EVENT', 'SKILL', 'LSP',
] as const

/**
 * 工具变量接线（web-tools §10 的同路注入）：bash 工具经白名单透传给
 * 子进程，模型用法 `"$SIMPLE_CODE_WEBFETCH" <url>`。放 process.env 而
 * 不是塞进 bash 配置——core 不认识扩展路径，环境变量是宿主注入的干净通道。
 *
 * 默认直指 dist 里的 bin（shebang 找系统 node）；shim 写得进
 * （~/.simple-code/bin/，宿主内置 Node 跑，见 core shims.ts 头注释）
 * 就改指 shim——没装 node 的机器工具照用。探测约 150ms，一次性启动成本。
 */
async function wireBins(): Promise<void> {
  const kebab = (name: string) => name.toLowerCase().replaceAll('_', '-')
  const entries: ShimEntry[] = [
    ...BINS.map((name) => ({
      name,
      bin: `sc-${kebab(name)}`,
      script: join(__dirname, `${kebab(name)}.js`),
    })),
    // sc：终端入口（~/.simple-code/bin/sc）+ 父 agent 派子 agent 的一次性
    // CLI（"$SIMPLE_CODE_SC" --root <项目根> -q "任务"，headless 审批恒拒绝）
    { name: 'SC', bin: 'sc', script: join(__dirname, 'sc.js') },
  ]
  let resolved: Record<string, string>
  try {
    resolved = await ensureShims(entries)
  } catch {
    // bin 目录写不进（只读 HOME 之类）——回落直指脚本
    resolved = Object.fromEntries(entries.map(({ name, script }) => [name, script]))
  }
  for (const { name } of entries) {
    process.env[`SIMPLE_CODE_${name}`] = resolved[name]
  }
  // 教程（self.md）：同 CLI 侧 run.ts injectLocalTools，指向 dist 拷贝
  process.env.SIMPLE_CODE_DOC = join(__dirname, 'self.md')
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await wireBins()
  const lspServer = startLspBridge()

  // 双注册互斥的开关，两个条件取或，任一命中走活动栏兜底：
  // ① 引擎 < 1.106（secondarySidebar 正式可用的下限，CC 同款判定）
  // ② Cursor——它拒绝第三方副栏容器的静态注册（reserved for agent UI），
  //   副栏 view 无家可归。只抄 ① 会把副栏视图藏过头：Cursor 报 3.x 恒
  //   判「支持」，但容器照样被拒，两个入口同时消失（4cc6a13 的实测教训）
  // onStartupFinished 保证这条在用户点图标前跑完——不然 when 卡在
  // 错误值上，入口要等第二次刷新
  const [major = 0, minor = 0] = vscode.version.split('.').map(Number)
  const engineTooOld = !(major > 1 || (major === 1 && minor >= 106))
  void vscode.commands.executeCommand(
    'setContext',
    'simpleCode.noSecondarySidebar',
    engineTooOld || vscode.env.uriScheme === 'cursor',
  )

  const panel = new ChatPanel(context.extensionUri, context.workspaceState)
  context.subscriptions.push(
    // 桥跟着扩展走：停用即关，端口随 env 消失，bin 侧明确报不可达
    { dispose: () => lspServer.close() },
    ...ChatPanel.viewTypes.map((viewType) =>
      vscode.window.registerWebviewViewProvider(viewType, panel, {
      // 面板切走再切回来时不重建 webview。没有它，用户点一下别的活动栏图标
      // 再回来就是空白 + 重新初始化，正在跑的对话看起来「消失」了
        webviewOptions: { retainContextWhenHidden: true },
      })),
    panel,
    // 多根工作区：文件夹增删时路由层要清失效 bridge / 回落 active（design.md §7）
    vscode.workspace.onDidChangeWorkspaceFolders(() => panel.setFolders()),
  )
}

/**
 * **不在 activate 里建 session。** `getSession` 要拿文件锁、开 SQLite，
 * 激活阶段做这些会拖慢编辑器启动，而用户可能根本不打开面板。**打开面板**
 * 时才建（bridge.ts 的 ready → warmUp）——模型选择器要在第一条消息之前就
 * 能用，所以边界从「第一次发消息」挪到了「打开面板」，惰性的理由不受影响。
 *
 * deactivate 这里不做事，清理靠 `context.subscriptions` 里的 `panel`——
 * VS Code 停用扩展时会 dispose 掉 subscriptions 里的每一项。
 *
 * 本来想写「webview 的 onDidDispose 会先触发所以这里不用管」，**但那是推断，
 * 查文档没查到保证**。所以清理挂在 subscriptions 上（这个是文档写明的），
 * 并且让 `bridge.dispose()` 幂等——两条路都触发时 close 两次也不出事。
 */
export function deactivate(): void {}
