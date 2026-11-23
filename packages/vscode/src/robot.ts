import { readFileSync } from 'node:fs'
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
      // focus 完成立即重算 seen（2026-11-09 真机：点机器人跳回面板后
      // 提醒不清——robot 是 nonactivating 面板、点它不改变窗口焦点，
      // 选中同一任务时 branch 不变，refresh 的既有触发点全不响）
      refresh()
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

  const unsub = panel.onRobotChange(refresh)
  const sub = vscode.window.onDidChangeWindowState(refresh)
  refresh()
  return {
    dispose: () => {
      unsub()
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

/** 机器人开关配置（desktop-robot.md §7）：机器人与机器人插件共写，SC 只读。
 *  不跨包 import packages/robot——那是独立发布的插件，SC 侧保持同语义的小抄 */
const robotConfigPath = (): string => join(homedir(), '.simple-code/robot/config.json')

/** enabled 的读：文件不存在/写坏了/没有这一项都算开（默认开，用户定
 *  2026-10-31）——与机器人插件 control.ts readEnabled 同语义 */
export function readRobotEnabled(): boolean {
  try {
    const v = JSON.parse(readFileSync(robotConfigPath(), 'utf8')) as unknown
    return !(typeof v === 'object' && v !== null && (v as { enabled?: unknown }).enabled === false)
  } catch {
    return true
  }
}

/** 机器人插件装没装（设置页「桌面机器人」分区的前提） */
export function robotInstalled(): boolean {
  return vscode.extensions.getExtension(ROBOT_EXTENSION_ID) !== undefined
}

/** 设置页开关的转发：enable/disable 命令带静默参数（拉起/退出逻辑只在
 *  机器人插件一处维护）。命令完成（disable 最多等 app 3s 退出）后由调用方回读 */
export async function toggleRobot(on: boolean): Promise<void> {
  await vscode.commands.executeCommand(
    on ? 'simpleCodeRobot.enable' : 'simpleCodeRobot.disable',
    true,
  )
}
