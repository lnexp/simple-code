import net from 'node:net'

/**
 * 连桌面机器人的 unix socket（docs/proposals/desktop-robot.md §4）。机器人是
 * 服务端，本窗口的 SC 是客户端：一条长连接，一行一条 JSON，状态每次发整份。
 *
 * 机器人由它自己的插件拉起（§8），这里不启动它、也不关心它装没装：连不上就
 * 隔一会儿再试。断开后先每秒试（机器人重启/升级要几秒），10 次后改 10 秒——
 * 机器人被关掉时 connect 立刻 ENOENT/ECONNREFUSED，每 10 秒一次的代价可忽略。
 */

export type FromRobot =
  | { type: 'allow'; ref: number; key: string }
  | { type: 'focus'; folder: string | null; task: string | null }
  | { type: 'dismiss'; key: string }

export type RobotClientDeps = {
  sockPath: string
  /** 连上后的第一条（窗口身份，§5.5）。每次连上现取——工作区可能变了 */
  hello: () => object
  /** reply 沿同一条连接回话（allow 的 ack） */
  onMessage: (msg: FromRobot, reply: (obj: object) => void) => void
  log?: (ev: Record<string, unknown>) => void
  /** [断开后的快重试, 慢重试] 毫秒。测试用小值 */
  retryMs?: [number, number]
}

const FAST_TRIES = 10

/** 只认协议里的三种，字段类型不对的丢掉——对端是本机进程，但别让一条坏消息抛进宿主 */
export function parseFromRobot(line: string): FromRobot | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const str = (v: unknown): v is string => typeof v === 'string'
  const strOrNull = (v: unknown): v is string | null => v === null || str(v)
  if (m.type === 'allow' && typeof m.ref === 'number' && str(m.key))
    return { type: 'allow', ref: m.ref, key: m.key }
  if (m.type === 'focus' && strOrNull(m.folder) && strOrNull(m.task))
    return { type: 'focus', folder: m.folder, task: m.task }
  if (m.type === 'dismiss' && str(m.key)) return { type: 'dismiss', key: m.key }
  return null
}

export function startRobotClient(deps: RobotClientDeps): {
  send: (status: object) => void
  dispose: () => void
} {
  const [fastMs, slowMs] = deps.retryMs ?? [1000, 10_000]
  let sock: net.Socket | null = null
  let connected = false
  let disposed = false
  let tries = 0
  let timer: NodeJS.Timeout | null = null
  /** 最新一份 status（还没连上时先存着，连上补发） */
  let latest: string | null = null
  /** 这条连接上最后写出去的。status 刷新很频繁（每次目录清单重推），一样的不重发 */
  let written: string | null = null

  const write = (line: string): void => {
    sock?.write(`${line}\n`)
  }

  const flush = (): void => {
    if (!connected || latest === null || latest === written) return
    write(latest)
    written = latest
  }

  const retry = (): void => {
    if (disposed || timer !== null) return
    const ms = tries < FAST_TRIES ? fastMs : slowMs
    tries++
    timer = setTimeout(() => {
      timer = null
      connect()
    }, ms)
  }

  const connect = (): void => {
    if (disposed) return
    const s = net.createConnection(deps.sockPath)
    sock = s
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => {
      connected = true
      tries = 0
      written = null
      deps.log?.({ ev: 'robot_connect' })
      write(JSON.stringify(deps.hello()))
      flush()
    })
    s.on('data', (chunk: string) => {
      buf += chunk
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const msg = parseFromRobot(buf.slice(0, i))
        buf = buf.slice(i + 1)
        if (msg !== null) deps.onMessage(msg, (obj) => write(JSON.stringify(obj)))
      }
    })
    // error 之后必有 close；重连只挂在 close 上，免得排两次
    s.on('error', () => {})
    s.on('close', () => {
      if (sock !== s) return
      if (connected) deps.log?.({ ev: 'robot_disconnect' })
      sock = null
      connected = false
      retry()
    })
  }

  connect()
  return {
    send: (status) => {
      latest = JSON.stringify(status)
      flush()
    },
    dispose: () => {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      sock?.destroy()
      sock = null
    },
  }
}
