import { execFile } from 'node:child_process'
import { join } from 'node:path'
import * as vscode from 'vscode'
import {
  isRobotProcess,
  plan,
  readEnabled,
  readRunning,
  robotPaths,
  writeEnabled,
} from './control.ts'

/**
 * 桌面机器人插件（只发 mac 版，desktop-robot.md §8）：VS Code 启动后拉起
 * SimpleCodeRobot.app，提供开/关命令。机器人的状态由各窗口的 SC 经 unix
 * socket 推过去，本插件不碰。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 等旧进程退出（SIGTERM 后最多 3 秒），否则新进程会探到旧 socket 还活着而自己退出 */
async function stop(pidFile: string): Promise<void> {
  const running = readRunning(pidFile)
  if (running === null) return
  try {
    process.kill(running.pid, 'SIGTERM')
  } catch {
    return
  }
  for (let i = 0; i < 30 && isRobotProcess(running.pid); i++) await sleep(100)
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform !== 'darwin') return
  const paths = robotPaths()
  const app = join(context.extensionPath, 'dist', 'SimpleCodeRobot.app')
  const version: string = context.extension.packageJSON.version

  // -g：不抢前台。不加 -n：已在跑的同一个 .app 不会再开一份（机器人自己也会
  // 探 socket，探到活的就退出）
  const launch = (): void => {
    execFile('open', ['-g', app], (err) => {
      if (err) void vscode.window.showErrorMessage(`桌面机器人启动失败：${err.message}`)
    })
  }

  const ensure = async (): Promise<void> => {
    const step = plan(readEnabled(paths.config), readRunning(paths.pid), version)
    if (step === 'replace') await stop(paths.pid)
    if (step !== 'none') launch()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('simpleCodeRobot.enable', async () => {
      writeEnabled(paths.config, true)
      await ensure()
    }),
    vscode.commands.registerCommand('simpleCodeRobot.disable', async () => {
      writeEnabled(paths.config, false)
      await stop(paths.pid)
      void vscode.window.showInformationMessage(
        '桌面机器人已关闭。要再打开：命令面板「SimpleCode Robot: 开启桌面机器人」',
      )
    }),
  )
  await ensure()
}

/** 不在这里关机器人：别的 VS Code 窗口可能还在用它。所有窗口的 SC 都断开 60 秒后它自己退出 */
export function deactivate(): void {}
