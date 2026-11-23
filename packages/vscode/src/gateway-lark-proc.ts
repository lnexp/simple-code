/** lark-cli 子进程工具（gateway-feishu 用）：一次性命令与常驻行消费者。
 *  从适配器拆出来只为行数（feishu 职责是飞书语义，这里是进程语义）。
 *  lark-cli 是 nvm 下的 node 脚本，shebang 的 node 从 PATH 找——统一
 *  spawn(nodeBin, [larkCli, …])，网关自己就跑在 node 上（§8.2 注）。 */
import { type ChildProcess, spawn } from 'node:child_process'

/** 子进程重启的退避（崩溃循环别把机器打满） */
export const BACKOFF_MS = [1000, 5000, 30_000]

/** lark-cli 子进程跑一条命令收 stdout 全量（一次性调用：补读/发送/改卡）。
 *  stdin 可选：updateCard 的 --data - 走它（21:29 实测，@文件受白名单限制） */
export function runOnce(
  nodeBin: string,
  args: string[],
  log: (ev: Record<string, unknown>) => void,
  stdin?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, args, { cwd: process.env.HOME ?? process.cwd() })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      err += d
    })
    if (stdin !== undefined) {
      child.stdin.on('error', () => {}) // EPIPE：对端不读就随它
      child.stdin.end(stdin)
    }
    child.on('error', (e) => {
      log({ ev: 'gateway_lark_spawn_failed', error: e.message })
      resolve(null)
    })
    child.on('close', (code) => {
      if (code !== 0) {
        log({ ev: 'gateway_lark_exit', code, stderr: err.slice(-300) })
        resolve(null)
        return
      }
      resolve(out)
    })
  })
}

/** 常驻行消费者骨架（消息与卡片点击两个 consume 共用，§15）：
 *  stdout 按行解 JSON 回调；stderr 的 connected 行回调；close 后按退避
 *  重启（重启句柄由调用方登记——onSpawn 回调拿新 child）。 */
export function spawnLineConsumer(deps: {
  nodeBin: string
  args: string[]
  stopped: () => boolean
  log: (ev: Record<string, unknown>) => void
  backoff: () => number
  onSpawn: (child: ChildProcess) => void
  onLine: (ev: Record<string, unknown>) => void
  onConnected: () => void
  connectedLine: string
}): ChildProcess {
  const child = spawn(deps.nodeBin, deps.args, { cwd: process.env.HOME ?? process.cwd() })
  deps.onSpawn(child)
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim() === '') continue
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      deps.onLine(ev)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    // 内部断线重连会不会再打这行未验证（§13）——打了也只是多补读一次，
    // message_id 去重兜底（卡片 consume 不需要补读，点击即当下）
    if (d.includes(deps.connectedLine)) {
      deps.log({ ev: 'gateway_feishu_connected' })
      deps.onConnected()
    }
  })
  child.on('close', (code) => {
    if (deps.stopped()) return
    deps.log({ ev: 'gateway_consume_exit', code })
    const ms = deps.backoff()
    const t = setTimeout(() => {
      if (deps.stopped()) return
      deps.onSpawn(spawnLineConsumer(deps))
    }, ms)
    t.unref?.()
  })
  return child
}
