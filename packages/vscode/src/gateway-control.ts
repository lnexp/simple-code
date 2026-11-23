import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GatewayCheck } from './protocol.ts'

/**
 * 网关进程的拉起判断（im-gateway.md §5.3，照 robot 的 control.ts 模式）。
 * 不认 vscode，能直接测；gateway.ts 只做接线。
 */

export const gatewayPaths = (home = homedir()) => ({
  config: join(home, '.simple-code/gateway/config.json'),
  pid: join(home, '.simple-code/run/gateway.pid'),
  sock: join(home, '.simple-code/run/gateway.sock'),
  /** 补读水位线（§5.3）：网关进程读写，这里只定路径 */
  state: join(home, '.simple-code/gateway/state.json'),
})

export type GatewayConfig = {
  enabled: boolean
  /** lark-cli 绝对路径（§13：nvm 下的脚本，PATH 里未必有——配置里写死） */
  larkCli: string
  /** 用户的 open_id（§7.1：只认这个人的单聊消息） */
  openId: string
  /** 与机器人的单聊 chat_id */
  chatId: string
}

const readJson = (file: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * 读配置。与 robot 相反，**默认关**（§5.3「没有或 enabled=false → 什么都不做」，
 * 2026-11-17 用户定）——装机 reload 后不会立刻真发消息，启用留给用户手改。
 * enabled=true 但缺 larkCli/openId/chatId → null：不猜（CLAUDE.md §1.2），
 * 调用方不拉起并记日志
 */
export function readGatewayConfig(file: string): GatewayConfig | null {
  const j = readJson(file)
  if (j.enabled !== true) return null
  const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''
  if (!isStr(j.larkCli) || !isStr(j.openId) || !isStr(j.chatId)) return null
  return { enabled: true, larkCli: j.larkCli, openId: j.openId, chatId: j.chatId }
}

export type GatewayRunning = { pid: number; version: string }

/**
 * pid 文件里正在跑的网关。pid 可能被复用——「替换旧版」要 SIGTERM，认错
 * 进程就是误杀，所以按命令行里有没有 gateway.js 再核一次
 */
export function readGatewayRunning(
  file: string,
  isGateway: (pid: number) => boolean = isGatewayProcess,
): GatewayRunning | null {
  const j = readJson(file)
  if (typeof j.pid !== 'number' || typeof j.version !== 'string') return null
  return isGateway(j.pid) ? { pid: j.pid, version: j.version } : null
}

export function isGatewayProcess(pid: number): boolean {
  try {
    return /gateway\.js/.test(
      execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }),
    )
  } catch {
    return false // ps 找不到这个 pid 时退出码 1
  }
}

/** 每个窗口激活都会问一次。同版本在跑 = 不动（多窗口共用一个）；版本不同 = 换掉 */
export function plan(
  config: GatewayConfig | null,
  running: GatewayRunning | null,
  version: string,
): 'none' | 'launch' | 'replace' {
  if (config === null) return 'none'
  if (running === null) return 'launch'
  return running.version === version ? 'none' : 'replace'
}

export function writeGatewayPid(file: string, pid: number, version: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ pid, version })}\n`)
}

/**
 * 用宿主内置 Node 跑 dist/gateway.js（detached：网关独立于窗口存活，reload
 * 不打断飞书连接，§5.2）。cwd/env 显式写（lesson later-guard-breaks-caller）
 */
export function launchGateway(
  nodeBin: string,
  gatewayJs: string,
  version: string,
  log?: (msg: string) => void,
): void {
  const child = spawn(nodeBin, [gatewayJs], {
    detached: true,
    stdio: 'ignore',
    cwd: homedir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SC_GATEWAY_VERSION: version },
  })
  child.unref()
  child.on('error', (e) => log?.(`launch failed: ${e.message}`))
}

/** 一次性跑 lark-cli 收 stdout/stderr/退出码。与 gateway-lark-proc 的
 *  runOnce 差别：stderr 与退出码要带回给界面（不可用时用户要看原因），
 *  不只是留日志；超时兜底 10s——检测按钮不能永远停在「检测中」 */
const run = (
  nodeBin: string,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> =>
  new Promise((resolve) => {
    const child = spawn(nodeBin, args, { cwd: homedir() })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
    })
    child.stderr.on('data', (d: string) => {
      err += d
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    timer.unref?.()
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, out: '', err: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })

/** 设置页「飞书推送」分区的检测（2026-11-18 用户：lark-cli 坏了静默失效）。
 *  --version 判安装，auth status 判登录（identities.bot.status）。只读，
 *  不发消息不碰状态——检测本身无副作用 */
export async function checkLarkCli(nodeBin: string, larkCli: string): Promise<GatewayCheck> {
  const versionRun = await run(nodeBin, [larkCli, '--version'])
  if (versionRun.code !== 0) {
    return {
      larkCli,
      installed: false,
      error: versionRun.err.slice(-200) || `退出码 ${versionRun.code}`,
    }
  }
  const authRun = await run(nodeBin, [larkCli, 'auth', 'status'])
  let auth: string | null = null
  if (authRun.code === 0) {
    try {
      const parsed = JSON.parse(authRun.out) as { identities?: { bot?: { status?: unknown } } }
      auth =
        typeof parsed.identities?.bot?.status === 'string' ? parsed.identities.bot.status : null
    } catch {
      auth = null
    }
  }
  return { larkCli, installed: true, version: versionRun.out.trim(), auth }
}
