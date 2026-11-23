import { join } from 'node:path'
import { logRun, resolveNodeBin } from '@simple-code/core'
import * as vscode from 'vscode'
import {
  gatewayPaths,
  launchGateway,
  plan,
  readGatewayConfig,
  readGatewayRunning,
} from './gateway-control.ts'
import { type FromGateway, parseFromGateway } from './gateway-protocol.ts'
import type { ChatPanel } from './panel.ts'
import { startLineClient } from './robot-client.ts'
import { createRobotFeed } from './robot-feed.ts'

/**
 * 通讯网关的窗口侧接线（im-gateway.md §5）：拉起网关进程（§5.3）、连上发
 * status、处理网关下发的 send/stop/allow/deny。逻辑在 gateway-control.ts
 * （拉起判断）、gateway-protocol.ts（协议）、robot-feed.ts（状态生成——
 * 网关单独一份 feed，consumed 与 robot 各自独立，§5.4），这里只接线。
 */

export async function startGateway(
  panel: ChatPanel,
  opts: { version: string; extensionPath: string },
): Promise<vscode.Disposable> {
  // Remote-SSH：SC 跑在远端，够不到本机的飞书网关（同 robot.ts）
  if (process.platform !== 'darwin' || vscode.env.remoteName !== undefined)
    return { dispose: () => {} }
  const paths = gatewayPaths()
  const config = readGatewayConfig(paths.config)
  if (config === null) return { dispose: () => {} }

  const running = readGatewayRunning(paths.pid)
  const step = plan(config, running, opts.version)
  if (step !== 'none') {
    if (step === 'replace' && running !== null) {
      try {
        process.kill(running.pid, 'SIGTERM')
      } catch {
        // 已经死了：直接拉新的
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    const nodeBin = await resolveNodeBin()
    launchGateway(nodeBin, join(opts.extensionPath, 'dist', 'gateway.js'), opts.version, (msg) =>
      logRun({ ev: 'gateway_launch_failed', error: msg }),
    )
  }

  const feed = createRobotFeed({ doneTextChars: 4000, reportSeenOnce: true })
  const client = startLineClient<FromGateway>({
    sockPath: paths.sock,
    hello: () => ({
      type: 'hello',
      protocol: 1,
      pid: process.pid,
      version: opts.version,
      windowName: vscode.workspace.name ?? 'VS Code',
    }),
    parse: parseFromGateway,
    evName: { connect: 'gateway_connect', disconnect: 'gateway_disconnect' },
    log: (ev) => logRun(ev),
    onMessage: (msg, reply) => {
      if (msg.type === 'allow') {
        const ok = panel.robotAllow(msg.key)
        logRun({ ev: 'gateway_allow', toolCallId: msg.key, ok })
        reply({ type: 'ack', ref: msg.ref, ok, ...(ok ? {} : { reason: '卡已处理' }) })
      } else if (msg.type === 'deny') {
        const ok = panel.robotDeny(msg.key, msg.reason)
        logRun({ ev: 'gateway_deny', toolCallId: msg.key, ok })
        reply({ type: 'ack', ref: msg.ref, ok, ...(ok ? {} : { reason: '卡已处理' }) })
      } else if (msg.type === 'send') {
        const error = panel.gatewaySend(msg.folder, msg.owner, msg.text)
        logRun({ ev: 'gateway_send', folder: msg.folder, owner: msg.owner, ok: error === null })
        reply({
          type: 'ack',
          ref: msg.ref,
          ok: error === null,
          ...(error === null ? {} : { reason: error }),
        })
      } else {
        const ok = panel.gatewayStop(msg.folder, msg.owner)
        logRun({ ev: 'gateway_stop', folder: msg.folder, owner: msg.owner, ok })
        reply({ type: 'ack', ref: msg.ref, ok, ...(ok ? {} : { reason: '没有在跑的轮' }) })
      }
    },
  })

  const refresh = (): void => {
    const showing = panel.robotShowing()
    client.send({
      ...feed.build(panel.robotFolders(), {
        focused: vscode.window.state.focused,
        panelVisible: panel.panelVisible(),
        folder: showing.folder,
        task: showing.task,
      }),
      showing,
      focused: vscode.window.state.focused,
    })
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
