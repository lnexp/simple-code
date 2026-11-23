#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
/**
 * 网关进程入口（im-gateway.md §5.2、§5.3）：监听 gateway.sock，各 VS Code
 * 窗口连上来；飞书接入骑 lark-cli。由 SC 的 gateway.ts 拉起（宿主内置
 * Node），也可以手动 node dist/gateway.js 跑（冒烟）。
 *
 * 生命周期：先试连 sock（已有实例 → 自己退出）→ 删残留 → 监听（0600）、
 * 写 pid → 拉起 lark-cli。所有窗口断开 60 秒后退出（§5.3）——按**连接数**
 * 判（createIdleWatch），不是按消息流量。
 */
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { syncLogRunTo } from '@simple-code/core'
import { type GatewayConfig, readGatewayConfig } from './gateway-control.ts'
import { createIdleWatch, gatewayStateFile } from './gateway-core.ts'
import { createFeishuAdapter } from './gateway-feishu.ts'
import { createGatewayHub } from './gateway-hub.ts'
import { createGatewayServer } from './gateway-serve.ts'

const home = process.env.SC_GATEWAY_HOME ?? join(homedir(), '.simple-code')
// 全同步写：网关的退出路径紧跟 process.exit，异步链没冲完最后几条就丢
const log = syncLogRunTo(join(home, 'logs'))
const sockPath = join(home, 'run/gateway.sock')
const pidFile = join(home, 'run/gateway.pid')
const stateFile = gatewayStateFile()

/** 已有实例在跑 → true（自己退出，不动它的 socket 与 pid 文件，§5.3） */
const alreadyRunning = (): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.createConnection(sockPath)
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('error', () => resolve(false))
    setTimeout(() => {
      s.destroy()
      resolve(false)
    }, 1500).unref?.()
  })

const exit = (code: number): void => {
  log({ ev: 'gateway_exit', code })
  // eslint-disable-next-line n/no-process-exit
  process.exit(code)
}

async function main(): Promise<void> {
  if ((await alreadyRunning()) === true) exit(0)
  const config: GatewayConfig | null = readGatewayConfig(join(home, 'gateway/config.json'))
  if (config === null) {
    log({ ev: 'gateway_config_missing' })
    exit(1)
    return
  }

  // 残留 socket：上一个没清干净。删掉再监听（robot 同款，教训：
  // 第二个实例退出时删了在用的 socket——这里只有「连不上」才删）
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath)
    } catch {
      // 删不掉就让 listen 报 EADDRINUSE 退出
    }
  }

  const server = createGatewayServer({ sockPath, log })
  const feishu = createFeishuAdapter({
    larkCli: config.larkCli,
    chatId: config.chatId,
    openId: config.openId,
    stateFile,
    onMessage: (m) => hub.onMessage(m),
    onCardAction: (c) => hub.onCardAction(c),
    log,
  })
  const hub = createGatewayHub({ server, feishu, stateFile, log })
  server.onHub({
    onHello: () => {},
    onStatus: (pid, status) => hub.onStatus(pid, status),
    onAck: () => {},
    onGone: (pid) => hub.onGone(pid),
  })

  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    feishu.stop()
    server.close()
    try {
      rmSync(sockPath, { force: true })
      rmSync(pidFile, { force: true })
    } catch {
      // 清不掉就算了（下一个启动者会删残留）
    }
    exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  try {
    await server.listen()
  } catch (e) {
    // EADDRINUSE：另一个实例抢到了（两个窗口同时拉起的竞态）——让它活
    log({ ev: 'gateway_listen_failed', error: e instanceof Error ? e.message : String(e) })
    feishu.stop()
    exit(1)
  }
  mkdirSync(dirname(pidFile), { recursive: true })
  writeFileSync(
    pidFile,
    `${JSON.stringify({ pid: process.pid, version: process.env.SC_GATEWAY_VERSION ?? 'manual' })}\n`,
  )
  log({ ev: 'gateway_started', pid: process.pid })

  // §5.3：所有窗口断开 60 秒后退出。启动后也适用（没人连的网关没有意义，
  // 下次 VS Code 启动会再拉起）。按连接数判——连接在线但没有消息不算空闲
  // （原实现看消息流量，用户没动 VS Code 时网关会把安静当断开自杀，
  // 2026-11-17 两个实例都这么死的）
  createIdleWatch({
    connCount: server.connCount,
    idleMs: Number(process.env.SC_GATEWAY_IDLE_MS ?? 60_000),
    log,
    onIdle: shutdown,
  })
}

void main()
