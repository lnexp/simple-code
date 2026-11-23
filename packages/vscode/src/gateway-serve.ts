import net from 'node:net'
import {
  type Ack,
  type GatewayStatus,
  parseAck,
  parseGatewayStatus,
  parseWindowHello,
} from './gateway-protocol.ts'

/**
 * 网关的窗口侧服务（im-gateway.md §5.4）：unix socket 上收各 VS Code 窗口的
 * hello/status/ack，下发 allow/deny/send/stop。传输层——消息怎么处理在
 * gateway-hub.ts，两个文件在 gateway-main.ts 里组装（先造 serve、再造 hub、
 * listen 之前 wire，无竞态）。
 */

export type HubCallbacks = {
  /** 窗口第一次报身份（或重连） */
  onHello: (pid: number) => void
  onStatus: (pid: number, status: GatewayStatus) => void
  onAck: (ack: Ack) => void
  /** 连接断开。送达等待中的条目由本层重试/超时，hub 只需要知道人少了 */
  onGone: (pid: number) => void
}

export type GatewayServer = {
  /** 定向送达：找到报过这个 folder 的窗口，等 ack（waitMs 内窗口没回 = null）。
   *  窗口不在线时挂起等待——连回来（hello/status）就送（§5.5 的 30 秒）。
   *  make 收到分配的 ref，返回要发的整条消息（send/stop/allow/deny 四种） */
  deliver: (folder: string, make: (ref: number) => object) => Promise<Ack | null>
  /** 所有报过 status 的窗口快照（/列表、确认行、默认目标用） */
  windows: () => Array<{ pid: number; status: GatewayStatus }>
  /** 当前连接数（含刚 hello 还没报 status 的）。空闲退出看它——windows()
   *  只算报过 status 的，会把「连着但还没说话」的窗口漏掉 */
  connCount: () => number
  onHub: (cb: HubCallbacks) => void
  listen: () => Promise<void>
  close: () => void
}

export function createGatewayServer(deps: {
  sockPath: string
  log: (ev: Record<string, unknown>) => void
  /** 送达等待窗口（§5.5：30 秒；测试调小） */
  waitMs?: number
  /** 等待扫描间隔（测试调小） */
  tickMs?: number
}): GatewayServer {
  const waitMs = deps.waitMs ?? 30_000
  const tickMs = deps.tickMs ?? 1000
  let hub: HubCallbacks | null = null
  let server: net.Server | null = null
  let closed = false
  let refSeq = 0

  /** pid → 连接。hello 之后才有 pid；断开即删（§4.1 robot 同款） */
  const conns = new Map<number, { sock: net.Socket; status: GatewayStatus | null }>()
  const acks = new Map<number, (ack: Ack) => void>()
  /** 送达等待中（窗口不在线 / ack 未回） */
  const waiters: Array<{
    folder: string
    make: (ref: number) => object
    deadline: number
    resolve: (a: Ack | null) => void
    ref: number | null
  }> = []
  let ticker: NodeJS.Timeout | null = null

  const write = (sock: net.Socket, obj: unknown): void => {
    sock.write(`${JSON.stringify(obj)}\n`)
  }

  /** 报过这个 folder 的连接（status 里 tasks 有它才算打开过，§5.5） */
  const findConn = (folder: string): net.Socket | null => {
    for (const c of conns.values()) {
      if (c.status?.tasks.some((t) => t.folder === folder)) return c.sock
    }
    return null
  }

  const armTicker = (): void => {
    if (ticker !== null || closed) return
    ticker = setInterval(() => {
      const now = Date.now()
      for (const w of [...waiters]) {
        if (now < w.deadline) continue
        waiters.splice(waiters.indexOf(w), 1)
        if (w.ref !== null) acks.delete(w.ref)
        w.resolve(null)
      }
      if (waiters.length === 0) {
        if (ticker !== null) clearInterval(ticker)
        ticker = null
      }
    }, tickMs)
  }

  const trySend = (w: (typeof waiters)[number]): void => {
    if (w.ref !== null) return
    const sock = findConn(w.folder)
    if (sock === null) return
    const ref = ++refSeq
    w.ref = ref
    acks.set(ref, (ack) => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      acks.delete(ref)
      w.resolve(ack)
    })
    write(sock, w.make(ref))
  }

  return {
    onHub: (cb) => {
      hub = cb
    },
    windows: () =>
      [...conns.entries()].flatMap(([pid, c]) =>
        c.status === null ? [] : [{ pid, status: c.status }],
      ),
    connCount: () => conns.size,
    deliver: (folder, make) =>
      new Promise((resolve) => {
        const w = { folder, make, deadline: Date.now() + waitMs, resolve, ref: null }
        waiters.push(w)
        trySend(w)
        armTicker()
      }),
    listen: () =>
      new Promise((resolve, reject) => {
        server = net.createServer((sock) => {
          sock.setEncoding('utf8')
          let pid: number | null = null
          let buf = ''
          sock.on('data', (d: string) => {
            buf += d
            for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
              const line = buf.slice(0, i)
              buf = buf.slice(i + 1)
              if (line.trim() === '') continue
              const hello = parseWindowHello(line)
              if (hello !== null) {
                // 同 pid 重连：旧的还没断就先删（socket 还开着由 close 兜底）
                conns.get(hello.pid)?.sock.destroy()
                pid = hello.pid
                conns.set(pid, { sock, status: null })
                deps.log({ ev: 'gateway_window_hello', pid })
                hub?.onHello(pid)
                continue
              }
              const status = parseGatewayStatus(line)
              if (status !== null && pid !== null) {
                conns.get(pid)!.status = status
                // 有焦点的窗口成为默认目标（§5.5「最后在电脑上看的」）
                hub?.onStatus(pid, status)
                for (const w of [...waiters]) trySend(w)
                continue
              }
              const ack = parseAck(line)
              if (ack !== null) {
                acks.get(ack.ref)?.(ack)
              }
            }
          })
          sock.on('close', () => {
            if (pid !== null) {
              // 宿主断连观测（2026-11-21 排查：宿主↔网关连接静默断开、
              // 扩展侧 dispose 不打日志，导致「命令秒回但任务消息黑洞」
              // 无迹可查）——网关侧记下谁走了，剩下的 conns 数
              conns.delete(pid)
              deps.log({ ev: 'gateway_window_gone', pid, left: conns.size })
              hub?.onGone(pid)
            }
          })
          sock.on('error', () => {})
        })
        server.listen(deps.sockPath, () => resolve())
        server.on('error', reject)
      }),
    close: () => {
      closed = true
      if (ticker !== null) clearInterval(ticker)
      ticker = null
      for (const w of waiters.splice(0)) w.resolve(null)
      for (const c of conns.values()) c.sock.destroy()
      conns.clear()
      server?.close()
      server = null
    },
  }
}
