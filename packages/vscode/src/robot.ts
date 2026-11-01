import { homedir } from 'node:os'
import { join } from 'node:path'
import { logRun } from '@simple-code/core'
import * as vscode from 'vscode'
import type { ChatPanel } from './panel.ts'
import { startRobotClient } from './robot-client.ts'
import { createRobotFeed } from './robot-feed.ts'

/**
 * 桌面机器人的接线（docs/proposals/desktop-robot.md）。逻辑在 robot-feed.ts
 * （状态生成）、robot-client.ts（socket）与 router.ts（允许/跳转），这里只把
 * vscode 的窗口焦点、面板显隐、命令接上去。
 */

/** 机器人插件（D8，2026-10-31 用户定名）。只发 mac 版（§8） */
export const ROBOT_EXTENSION_ID = 'lnexp.simplecode-robot'

/** 机器人回窗口时打开的路径（§5.5）：VS Code 只按「工作区文件相同」或「单文件夹
 *  窗口的文件夹相同」找已开窗口，工作区里的子文件夹不算。未保存的多根工作区
 *  （untitled:）没有可打开的路径，给 null，机器人只激活应用 */
const windowPath = (): string | null => {
  const ws = vscode.workspace.workspaceFile
  if (ws !== undefined) return ws.scheme === 'file' ? ws.fsPath : null
  const folders = vscode.workspace.workspaceFolders ?? []
  return folders.length === 1 ? (folders[0]?.uri.fsPath ?? null) : null
}

/** 用哪个应用打开（VS Code / Insiders / Cursor 各回各的）：appRoot 是 <应用>.app/Contents/Resources/app */
const appPath = (): string | null =>
  vscode.env.appRoot.match(/^(.*\.app)\/Contents\/Resources\/app$/)?.[1] ?? null

export function startRobot(
  panel: ChatPanel,
  opts: { version: string; focusCommand: string },
): vscode.Disposable {
  // Remote-SSH：SC 跑在远端，连不到本机的机器人（§5.5）
  if (process.platform !== 'darwin' || vscode.env.remoteName !== undefined)
    return { dispose: () => {} }
  const feed = createRobotFeed()
  const client = startRobotClient({
    sockPath: join(homedir(), '.simple-code/run/robot.sock'),
    hello: () => ({
      type: 'hello',
      protocol: 1,
      pid: process.pid,
      version: opts.version,
      appPath: appPath(),
      windowPath: windowPath(),
      windowName: vscode.workspace.name ?? 'VS Code',
    }),
    onMessage: (msg, reply) => {
      if (msg.type === 'allow') {
        const ok = panel.robotAllow(msg.key)
        logRun({ ev: 'robot_allow', toolCallId: msg.key, ok })
        reply({ type: 'ack', ref: msg.ref, ok, ...(ok ? {} : { reason: '卡已处理' }) })
      } else if (msg.type === 'dismiss') {
        feed.dismiss(msg.key)
        refresh()
      } else {
        void focus(msg.folder, msg.task)
      }
    },
    log: (ev) => logRun(ev),
  })

  /** 窗口已由机器人拉到前台；这里展开面板、切目录、选任务 */
  const focus = async (folder: string | null, task: string | null): Promise<void> => {
    try {
      await vscode.commands.executeCommand(opts.focusCommand)
      if (folder !== null) panel.robotFocus(folder, task)
    } catch (e) {
      logRun({ ev: 'robot_focus_failed', error: e instanceof Error ? e.message : String(e) })
    }
  }

  const refresh = (): void => {
    const showing = panel.robotShowing()
    client.send(
      feed.build(panel.robotFolders(), {
        focused: vscode.window.state.focused,
        panelVisible: panel.panelVisible(),
        folder: showing.folder,
        task: showing.task,
      }),
    )
  }

  panel.onRobotChange = refresh
  const sub = vscode.window.onDidChangeWindowState(refresh)
  refresh()
  return {
    dispose: () => {
      panel.onRobotChange = undefined
      sub.dispose()
      client.dispose()
    },
  }
}

/** 「SimpleCode: 安装桌面机器人」（D7，只在 mac 的命令面板出现）：走 VS Code 自己的
 *  安装，网络与代理用它的；SC 不托管安装包 */
export async function installRobot(): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      'workbench.extensions.installExtension',
      ROBOT_EXTENSION_ID,
    )
  } catch (e) {
    void vscode.window.showErrorMessage(
      `安装桌面机器人失败：${e instanceof Error ? e.message : String(e)}。也可以在扩展面板搜索 ${ROBOT_EXTENSION_ID}，或用「从 VSIX 安装」装下载好的包。`,
    )
  }
}
