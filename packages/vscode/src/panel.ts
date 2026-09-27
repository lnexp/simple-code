import { forwardBlock, forwardLine, getSession, scopeOf } from '@simple-code/core'
import { existsSync, readFileSync, statSync as fsStatSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import * as vscode from 'vscode'
import { createBridge } from './bridge.ts'
import { renderHtml } from './html.ts'
import { bestCandidate } from './openfile-resolve.ts'
import type { ToHost } from './protocol.ts'
import { createRouter, type Router } from './router.ts'
import { remoteSettingsPath, syncRemoteSettings, type RemoteSyncResult } from './remote.ts'
import { asSavedChoice, EFFORTS } from './saved-choice.ts'

/**
 * 侧边栏面板。**这个文件只做接线**——把 vscode 的对象接到 bridge.ts 上。
 * 逻辑全在 bridge.ts 里，那个不 import vscode，能直接测。
 *
 * 所以这里没什么可测的，也就不测（vscode-impl.md §7）。判断标准：这个文件里
 * 每多一个 if，就该问它能不能挪进 bridge.ts。
 */
export class ChatPanel implements vscode.WebviewViewProvider {
  /**
   * 两个 viewType 同一个 provider：VS Code 走 simpleCode.chat（副栏），
   * Cursor 走 simpleCode.chat.cursor（活动栏）——Cursor 拒第三方副栏容器，
   * 双注册互斥靠 package.json 里 view 的 when（见 $comment）。
   * when 互斥保证 resolveWebviewView 只发生在一侧，同一实例安全
   */
  static readonly viewTypes = ['simpleCode.chat', 'simpleCode.chat.cursor'] as const

  private view: vscode.WebviewView | undefined
  /**
   * **路由器挂在 provider 上，不在 view 上。** 面板关了（onDidDispose）只
   * detachAll——各文件夹 bridge 的事件循环、模型选择状态、历史镜像都活着
   * （后台跑着的轮照常落盘），重开面板从镜像续上。真销毁只有扩展停用
   * （extension.ts 的 subscriptions）。
   *
   * 惰性建：resolveWebviewView 第一次被调时才 create——bridge 本身惰性拿
   * session，提前建没有意义还占状态
   */
  private router: Router | undefined
  /** seed 只该发生一次（第一次 resolveWebviewView）。之后的选择 router 自己存 */
  private folderSeeded = false

  /**
   * Remote-SSH（settings.remote.json 方案）：远端会话读独立配置文件。同步
   * **每个面板实例只跑一次**（session 工厂可能每个文件夹各调一遍，隧道
   * 通不通不会变）；失败也不重试——用户重连/开新窗口自然再试
   */
  private remoteSync: Promise<RemoteSyncResult> | undefined
  private remoteCardShown = false

  /**
   * `state` 是**工作区级**的 Memento（`context.workspaceState`）。选全局还是
   * 工作区的取舍见 bridge.ts 的 `savedModel` 注释——换成 `globalState` 就是
   * 改这一个实参。
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const folder = pickFolder(folderList(), this.state.get(FOLDER_KEY))

    view.webview.options = {
      enableScripts: true,
      // 只允许加载 dist 下的东西。不限制的话整个扩展目录都能被 webview 读到
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    }
    // ****** webview 对同 URI 的资源有缓存**：装机覆盖了 dist/webview.js，
    // URI 不变的话 reload 后读的还是旧 JS——表现为「改了但什么都没变」。
    // 挂上 mtime，内容一变 URI 跟着变，缓存自然失效
    const distUri = (file: string): string => {
      const uri = vscode.Uri.joinPath(this.extensionUri, 'dist', file)
      let v = ''
      try {
        v = `?v=${fsStatSync(uri.fsPath).mtimeMs.toString(36)}`
      } catch {
        /* 文件不存在（打包漏了）时裸 URI，让加载报错可见 */
      }
      return view.webview.asWebviewUri(uri).toString() + v
    }
    // 带内容 hash 的 webview 文件名（build.mjs 写进 webview.current）。文件名变
    // → Cursor 的外链缓存必失效；`?v=` query 它压根忽略，光靠那个不够
    const webviewFile = (() => {
      try {
        return readFileSync(
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.current').fsPath,
          'utf8',
        ).trim()
      } catch {
        return 'webview.js'
      }
    })()

    view.webview.html = renderHtml({
      scriptUri: distUri(webviewFile),
      codiconUri: distUri('codicon.css'),
      cspSource: view.webview.cspSource,
    })

    // **post 走 this.view 而不是闭包里的 view**：bridge 活得比单个 view 长，
    // 面板关了再开，post 必须指向新的 view——闭包捕获旧 view 的话新面板
    // 一片死寂，不报错
    // 多根路由（design.md §7）：每文件夹一个 bridge，本类只提供工厂。
    // 初始 folder 上面的 pickFolder 已经算好（含 saved 回落）
    this.router ??= createRouter({
      post: (msg) => void this.view?.webview.postMessage(msg),
      createBridge: (f, post, onTurnEnd) =>
        createBridge({
          // post 由路由层注入（后台过滤）；这里只接最终出口——view 可能换
          post: (msg) => void post(msg),
          session: async (requestApproval) =>
            getSession(f, { requestApproval, ...(await this.remoteGlobalPath()) }),
          // 任务 session（task-v3）：同一个库同一个 root，owner 域 +
          // skipLock（同进程对话已持锁，第二个 acquireLock 会撞自己）
          taskSession: async (manifest, requestApproval) =>
            getSession(f, {
              task: scopeOf(manifest),
              skipLock: true,
              requestApproval,
              ...(await this.remoteGlobalPath()),
            }),
          // 分支模型选择的持久化（2026-09-22 拍板）：键 = 任务目录本身，
          // 目录删除（合并/丢弃）后键成残留垃圾——Memento 小对象，不追着清
          choiceStore: {
            get: (dir) =>
              asSavedChoice(this.state.get(modelKey(dir)) ?? null),
            set: (dir, choice) => void this.state.update(modelKey(dir), choice),
          },
          openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
          // vscode.open 而不是 showTextDocument：后者只收文本文件，vscode.open
          // 对图片/二进制交给对应的编辑器（PNG 会开内置预览，和 view_image 体验闭环）
          // 拼好的 abs 不存在时兜底：模型给的相对路径常是包片段
          // （domain/entity/X.java 真身 src/main/java/.../domain/entity/），
          // basename 收集候选、尾部段连续对齐评分（openfile-resolve.ts）。
          // 相对路径是按「当前激活 folder」拼的（bridge.ts），多根工作区里
          // 文件可能在其他根——同 folder 没中就全工作区再找一次
          openFile: (abs, line) => {
            // path:line 形态的定位（grep -n / 报错栈）：打开后滚到行。
            // vscode.open 的第三参是 TextDocumentShowOptions，selection
            // 让编辑器滚过去；行号 1-based → Position 0-based
            const open = (p: string) =>
              vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), {
                ...(line !== undefined
                  ? {
                      selection: new vscode.Range(
                        new vscode.Position(Math.max(0, line - 1), 0),
                        new vscode.Position(Math.max(0, line - 1), 0),
                      ),
                    }
                  : {}),
              })
            if (existsSync(abs)) {
              return open(abs)
            }
            const folder = dirname(abs)
            const rel = abs.slice(folder.length + 1)
            return vscode.workspace
              .findFiles(
                `**/${basename(rel)}`,
                '**/{node_modules,.git,dist,out,build,target,.simple-code}/**',
                50,
              )
              .then((uris) => {
                const segs = rel.split('/')
                const paths = uris.map((u) => u.fsPath)
                const hit =
                  bestCandidate(
                    segs,
                    paths.filter((p) => p.startsWith(`${folder}/`)),
                  ) ?? bestCandidate(segs, paths)
                return hit
                  ? open(hit)
                  : undefined
              })
          },
          folder: f,
          onTurnEnd,
          savedChoice: () => asSavedChoice(this.state.get(modelKey(f)) ?? this.state.get(MODEL_KEY)),
          saveChoice: (choice) => void this.state.update(modelKey(f), choice),
          clearChoice: () => void this.state.update(modelKey(f), undefined),
        }),
      folders: () => folderList(),
      saveFolder: (f) => void this.state.update(FOLDER_KEY, f),
    })

    // 上次选的文件夹可能不是 router 的 pick() 默认值（folders[0]）——
    // 首条 ready 之前把 saved 告诉 router：它 spawn 的第一个 bridge 就
    // 用 saved，不会出现「先连 [0] 再跳 saved」的闪换
    if (folder && !this.folderSeeded) {
      this.folderSeeded = true
      this.router.seed(folder)
    }

    view.webview.onDidReceiveMessage((msg: ToHost) => {
      this.router?.handle(msg)
    })

    view.onDidDispose(() => {
      // **只在还是自己的时候才清。** 旧 view 的 dispose 可能在新 view 建好
      // 之后才到，不判断的话会把新的一起关掉
      if (this.view !== view) return
      this.router?.detachAll() // 不 dispose：bridge 与 session 的生命周期见字段注释
      this.view = undefined
    })
  }

  dispose(): void {
    this.router?.dispose()
    for (const w of this.settingsWatchers) w.dispose()
    this.settingsWatchers = []
  }

  /** 文件夹增删（onDidChangeWorkspaceFolders）。转发给路由层：
  // 移出的 bridge dispose，active 失效回落 [0] */
  setFolders(): void {
    this.router?.setFolders()
    this.watchSettings()
  }

  /** settings.json 热重载的监听端：全局一份 + 每个工作区文件夹一份。
   * 变更 → 各活 bridge requestReload（跑着就约到轮结束，空闲直接关——
   * 惰性重建时 loadConfig 重读）。生命周期跟 panel（subscriptions 里），
   * 文件夹增删时 setFolders 顺带重建这份集合 */
  private settingsWatchers: vscode.FileSystemWatcher[] = []

  /**
   * Remote-SSH 的配置前置（settings.remote.json 方案）：远端会话把
   * globalPath 指到独立的 settings.remote.json，建会话前先从本机代理同步
   * 一次。本地会话零变化（返回空对象）。同步失败不拦会话——远端已有旧
   * 文件就用旧的，没有才会在建会话时炸（那时指引卡已经弹过）。失败只弹
   * 一次卡：同一实例里每个文件夹的工厂都会走到这，隧道通不通不会变
   */
  private async remoteGlobalPath(): Promise<{ globalPath?: string }> {
    if (vscode.env.remoteName === undefined) return {}
    this.remoteSync ??= syncRemoteSettings()
    const result = await this.remoteSync
    // 失败不缓存：一次失败后被 ??= 钉死，隧道修好了（弹窗自动添加/手动
    // 补 Host 块）同一个窗口里也永远不重试，只能整窗 reload——实测用户
    // 卡在这。成功的缓存照旧（多文件夹的工厂都走这，省重复拉取）
    if (!result.ok) this.remoteSync = undefined
    if (!result.ok && !this.remoteCardShown) {
      this.remoteCardShown = true
      // 主机名从工作区 authority 拿（ssh-remote+<host>）——跟伴生扩展
      // offerForward 同一来源。刚连上远端还没开文件夹时拿不到 authority，
      // 用 SSH_CONNECTION 第三段（远端地址，sshd 注入）兜底——空窗口恰是
      // 「刚连上」最常见的时候，裸行兜底等于没兜（用户没法直接用）
      const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? ''
      let host = authority.startsWith('ssh-remote+') ? authority.slice('ssh-remote+'.length) : ''
      if (!host) {
        const conn = process.env.SSH_CONNECTION?.split(/\s+/)
        if (conn && conn.length >= 3) host = conn[2] ?? ''
      }
      const block = host ? forwardBlock(host) : `${forwardLine()}\n`
      void vscode.window
        .showInformationMessage(
          'SimpleCode：连不上本机代理（127.0.0.1:15432），配置沿用远端已有的旧文件。' +
            '把复制的配置块粘到本机 ~/.ssh/config 末尾，断开远端连接重连即建隧道。',
          '复制隧道配置块',
        )
        .then((choice) => {
          if (choice === '复制隧道配置块') void vscode.env.clipboard.writeText(block)
        })
    }
    return { globalPath: result.path }
  }
  private watchSettings(): void {
    for (const w of this.settingsWatchers) w.dispose()
    this.settingsWatchers = []
    if (!this.router) return
    const reload = (): void => this.router?.requestReloadAll()
    // 绝对路径进 FileSystemWatcher 会被当 glob：[ ] 等是保留字符，路径
    // 里出现时套字符类转义。home 路径通常没有，但用户名说不准
    const escapeGlob = (p: string): string => p.replace(/[[\]?*]/g, (m) => `[${m}]`)
    const wire = (w: vscode.FileSystemWatcher): void => {
      w.onDidChange(reload)
      w.onDidCreate(reload) // 保存常是 rename（临时文件替换），create/delete 也算
      w.onDidDelete(reload)
      this.settingsWatchers.push(w)
    }
    // Remote-SSH：全局配置实际是 settings.remote.json（本文件扩展全权
    // 拥有，同步时原子替换）——监听它；本地仍监听 settings.json
    const globalName =
      vscode.env.remoteName === undefined ? 'settings.json' : 'settings.remote.json'
    wire(vscode.workspace.createFileSystemWatcher(escapeGlob(join(homedir(), '.simple-code', globalName))))
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      wire(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.simple-code/settings.json')))
    }
  }
}

const MODEL_KEY = 'simpleCode.model'
/** 模型选择按目录分键（2026-09-12）。全局一份时多根互踩：A 目录选的
 * 模型存全局，B 目录 reload 后恢复成 A 的选择——「没选过它但它在回答」
 * 的根因。旧全局键只做一次性兜底读取，新选择永远写分键 */
const modelKey = (folder: string) => `simpleCode.model:${folder}`
/** 多根工作区的上次选择（design.md §7）。失效（被移出工作区）时 pickFolder 回落 [0] */
const FOLDER_KEY = 'simpleCode.folder'


/**
 * Memento 里读回来的东西形状对不上就当没有。`as` 强转会把脏数据带进 core。
 *
 * effort 单独校验成枚举而不是「是字符串就收」：档位是要往请求体里塞的，
 * 塞个乱七八糟的值进去是服务端 400，而且从错误信息里看不出是 storage 脏了
 */
/** workspaceFolders 全列表。路径去尾斜杠：`/a/b` 和 `/a/b/` 会被当成两个
 * 文件夹各建一份记忆。空工作区
 * 时给 home 兜底——core 需要一个真实目录放 .simple-code/，路由层从此
 * 不用管「没有文件夹」这个分支（单根语义） */
function folderList(): string[] {
  const list = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath.replace(/\/+$/, ''))
  if (list && list.length > 0) return list
  return [process.env.HOME ?? process.cwd()]
}

/** 上次选的还在列表里就用它，否则 `[0]`（首次打开 / 上次被移出工作区）。
 * VS Code 的文件夹顺序可以拖动，`[0]` 会变——所以 saved 必须校验存在性
 * 而不是信它 */
function pickFolder(folders: string[], saved: unknown): string {
  return typeof saved === 'string' && folders.includes(saved) ? saved : (folders[0] ?? '')
}
