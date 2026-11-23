/**
 * 窗口 ↔ 网关协议（docs/proposals/im-gateway.md §5.4）：robot 协议 v1 加
 * deny/send/stop 三条下发。两端共用这份类型与解析——窗口侧（gateway.ts）
 * 生成 status、消费 FromGateway；网关进程（gateway-main.ts 起）反向。
 *
 * 连接：unix socket，一行一条 JSON，上限 64KB（同 robot §4.1）。
 * 只认字段齐全的消息，类型不对的整行丢弃——对端是本机进程，但别让一条
 * 坏消息抛进任何一侧的事件循环。
 */
import type { RobotItem, RobotTask } from './robot-feed.ts'

/** 窗口 → 网关的整份状态（同 robot 的 status；网关多要的字段见 im-gateway.md §5.4） */
export type GatewayStatus = {
  type: 'status'
  items: RobotItem[]
  tasks: RobotTask[]
  /** 本窗口面板当前显示的目录与任务。默认目标 = 最后有焦点窗口的它（§5.5） */
  showing: { folder: string; task: string | null }
  /** 本窗口此刻有没有焦点。焦点变化时窗口会重推 status */
  focused: boolean
}

/** 网关 → 窗口的四种（前两种同 robot） */
export type FromGateway =
  | { type: 'allow'; ref: number; key: string }
  | { type: 'deny'; ref: number; key: string; reason?: string }
  | { type: 'send'; ref: number; folder: string; owner: string; text: string }
  | { type: 'stop'; ref: number; folder: string; owner: string }

/** 窗口处理完任何一条网关消息后沿同连接回的话 */
export type Ack = { type: 'ack'; ref: number; ok: boolean; reason?: string }

/** 网关进程发来的 hello（窗口侧用不到，网关侧解析见 gateway-serve.ts） */
export type WindowHello = {
  type: 'hello'
  protocol: number
  pid: number
  version: string
}

const isStr = (v: unknown): v is string => typeof v === 'string'

export function parseFromGateway(line: string): FromGateway | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (m.type === 'allow' && typeof m.ref === 'number' && isStr(m.key))
    return { type: 'allow', ref: m.ref, key: m.key }
  if (
    m.type === 'deny' &&
    typeof m.ref === 'number' &&
    isStr(m.key) &&
    (m.reason === undefined || isStr(m.reason))
  ) {
    const reason = m.reason
    return { type: 'deny', ref: m.ref, key: m.key, ...(reason !== undefined ? { reason } : {}) }
  }
  if (
    m.type === 'send' &&
    typeof m.ref === 'number' &&
    isStr(m.folder) &&
    isStr(m.owner) &&
    isStr(m.text)
  )
    return { type: 'send', ref: m.ref, folder: m.folder, owner: m.owner, text: m.text }
  if (m.type === 'stop' && typeof m.ref === 'number' && isStr(m.folder) && isStr(m.owner))
    return { type: 'stop', ref: m.ref, folder: m.folder, owner: m.owner }
  return null
}

export function parseAck(line: string): Ack | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (
    m.type === 'ack' &&
    typeof m.ref === 'number' &&
    typeof m.ok === 'boolean' &&
    (m.reason === undefined || isStr(m.reason))
  )
    return {
      type: 'ack',
      ref: m.ref,
      ok: m.ok,
      ...(m.reason !== undefined ? { reason: m.reason as string } : {}),
    }
  return null
}

/** items/tasks 的宽松解析：网关侧不 import 生成端类型也能安全消费 status */
export function parseGatewayStatus(line: string): GatewayStatus | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (m.type !== 'status' || !Array.isArray(m.items) || !Array.isArray(m.tasks)) return null
  const showing = m.showing as { folder?: unknown; task?: unknown } | undefined
  if (showing === undefined || !isStr(showing.folder)) return null
  if (
    typeof m.focused !== 'boolean' ||
    (showing.task !== null && !isStr(showing.task))
  )
    return null
  return {
    type: 'status',
    items: m.items as RobotItem[],
    tasks: m.tasks as RobotTask[],
    showing: { folder: showing.folder, task: (showing.task as string | null) ?? null },
    focused: m.focused,
  }
}

export function parseWindowHello(line: string): WindowHello | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (m.type === 'hello' && m.protocol === 1 && typeof m.pid === 'number' && isStr(m.version))
    return { type: 'hello', protocol: 1, pid: m.pid, version: m.version }
  return null
}
