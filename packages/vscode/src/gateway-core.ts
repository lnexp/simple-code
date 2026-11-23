import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { RobotItem, RobotTask } from './robot-feed.ts'

/**
 * 网关侧纯逻辑（im-gateway.md §5.5–§7）：飞书事件/补读条目解析、身份校验、
 * 去重、晚到判定、网关命令、审批回复、推送开关、文案。不认 socket 也不认
 * vscode——进程壳（gateway-serve.ts）注入 IO，这里只算。
 */

/** 一条来自用户的飞书消息（统一了实时事件与补读条目两种来源的字段名） */
export type FeishuMsg = {
  chat: string
  from: string
  /** message_id：去重键、审批回复的锚（§7.2） */
  id: string
  text: string
  /** 被回复消息的 message_id（审批回复绑定用它，§6 A1） */
  replyTo?: string
  /** 发出时刻（epoch ms）。实时事件是 create_time 原文；补读条目是
   *  "YYYY-MM-DD HH:mm"（分钟精度）解析成的本地时刻 */
  at: number
}

const str = (v: unknown): v is string => typeof v === 'string'

/** 从消息原文取被回复的 message_id。实时事件是 reply_to；**补读条目里被
 *  回复的字段名未验证**（2026-11-17 主任务指示：历史条目原文没有
 *  parent/reply 字段，是回复时叫什么未验证）——先只认实时事件的 reply_to */
export function replyTargetOf(raw: Record<string, unknown>): string | undefined {
  return str(raw.reply_to) ? raw.reply_to : undefined
}

/** 实时事件（lark-cli event consume 的一行 NDJSON）→ FeishuMsg。
 *  2026-11-17 实测 12 字段与 schema 一致；content 已渲染成文字 */
export function eventToMsg(ev: Record<string, unknown>): FeishuMsg | null {
  if (!str(ev.message_id) || !str(ev.chat_id) || !str(ev.sender_id) || !str(ev.content)) return null
  const at = Number(ev.create_time)
  if (!Number.isFinite(at) || at <= 0) return null
  return {
    chat: ev.chat_id,
    from: ev.sender_id,
    id: ev.message_id,
    text: ev.content,
    ...(str(ev.reply_to) ? { replyTo: ev.reply_to } : {}),
    at,
  }
}

/** 补读条目（chat-messages-list 的一条）→ FeishuMsg。真实字段：create_time
 *  是 "YYYY-MM-DD HH:mm"（本地时区、分钟精度，与实时事件的 epoch ms 不同源），
 *  sender 是嵌套对象（sender.id）、无 event_id、无 chat_type */
export function historyEntryToMsg(e: Record<string, unknown>): FeishuMsg | null {
  if (!str(e.message_id) || !str(e.chat_id)) return null
  const sender = e.sender
  const from =
    typeof sender === 'object' && sender !== null
      ? (sender as Record<string, unknown>).id
      : undefined
  if (!str(from) || !str(e.content) || !str(e.create_time)) return null
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(e.create_time)
  if (m === null) return null
  const at = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime()
  return { chat: e.chat_id, from, id: e.message_id, text: e.content, at }
}

/** §7.1：只认这个人在这个单聊里发的。别人的、群里的丢弃不回话 */
export function isFromUser(m: FeishuMsg, cfg: { openId: string; chatId: string }): boolean {
  return m.chat === cfg.chatId && m.from === cfg.openId
}

/** message_id 去重（§7.2）：飞书「至少发送一次」，实时重投、补读与实时
 *  重叠都靠它。Map 当 LRU——重插保序，容量外淘汰最旧 */
export function createDedup(cap = 1000) {
  const seen = new Map<string, true>()
  return {
    hit(id: string): boolean {
      return seen.has(id)
    },
    add(id: string): void {
      seen.delete(id)
      seen.set(id, true)
      if (seen.size > cap) seen.delete(seen.keys().next().value as string)
    },
  }
}

/** §5.5/§9-8：晚于 2 分钟的不直接进会话，先确认 */
export const LATE_MS = 2 * 60_000
export const isLate = (at: number, now: number): boolean => now - at > LATE_MS

export type Command =
  | { type: 'list' }
  | { type: 'to'; n: number }
  | { type: 'stop' }
  | { type: 'status' }
  | { type: 'push'; on: boolean | null }

/** §5.7：/列表 /切换 N /停止 /状态 /推送 全匹配；其余文字一律当消息发给目标。
 *  命令名全中文（2026-11-17 20:09 用户：「要么中文要么英文」，原 /list /to
 *  /stop 与 /推送 混用）——批/拒/执行 本是中文，统一后不再认英文命令 */
export function parseCommand(text: string): Command | null {
  const t = text.trim()
  if (t === '/列表') return { type: 'list' }
  if (t === '/停止') return { type: 'stop' }
  if (t === '/状态') return { type: 'status' }
  // §5.6（19:08 拍板）：显式推送开关。不带参数 = 查询当前状态。
  // 参数不合法（如「/推送 1」）不匹配 → 当普通消息送进会话，不回提示
  if (t === '/推送') return { type: 'push', on: null }
  if (t === '/推送 开') return { type: 'push', on: true }
  if (t === '/推送 关') return { type: 'push', on: false }
  // 中文后接数字常不打空格（「/切换8」），空格可有可无
  const m = /^\/切换\s*(\d+)$/.exec(t)
  return m === null ? null : { type: 'to', n: Number(m[1]) }
}

/** 审批回复（§6 A1）：「批」「拒」「拒 理由」。null = 不像 */
export type ApprovalReply = { act: 'allow' } | { act: 'deny'; reason: string | undefined }
export function parseApprovalReply(text: string): ApprovalReply | null {
  const t = text.trim()
  if (t === '批') return { act: 'allow' }
  if (t === '拒') return { act: 'deny', reason: undefined }
  const m = /^拒\s+(.+)$/s.exec(t)
  return m === null ? null : { act: 'deny', reason: m[1] }
}

/** 内容像审批操作但没绑定到卡（经补读丢了回复关系）：拦下来回提示，不进
 *  会话——「批」当普通话说出去没头没尾（2026-11-17 主任务指示） */
export const looksLikeApprovalReply = (text: string): boolean => parseApprovalReply(text) !== null

// ── 推送开关（§5.6，2026-11-17 19:08 用户拍板改显式开关）────────────
// 契约：设置页的「飞书推送」项也 import 这三个（签名定了不改）。
// 存 state.json 的 push 键，布尔。网关每次判断推不推都从文件读、不缓存
// 内存——设置页改了文件不用重启网关就生效；文件很小，同步读。
// 缺键、读失败都返回 true：默认开（state 里没有这个键 = 开）。

export function readPushOn(file: string): boolean {
  const v = readGatewayState(file).push
  return typeof v === 'boolean' ? v : true
}

export function writePushOn(file: string, on: boolean): void {
  writeGatewayState(file, { push: on })
}

/** state.json 路径（gateway-main 与设置页共用同一份） */
export function gatewayStateFile(): string {
  const home = process.env.SC_GATEWAY_HOME ?? join(homedir(), '.simple-code')
  return join(home, 'gateway/state.json')
}

// ── 文案（§5.5–§7）──────────────────────────────────────────────

const shortName = (folder: string): string => basename(folder) || folder

export const targetName = (folder: string, task: string | null): string =>
  `${shortName(folder)} ${task ?? '主任务'}`

/** /列表、/状态 的状态描述（RobotTask.state + since） */
export function stateText(t: RobotTask): string {
  switch (t.state) {
    case 'running':
      return `运行中 ${t.since === null ? '' : `${Math.max(1, Math.round((Date.now() - Date.parse(t.since)) / 60_000))} 分钟`}`
    case 'waiting':
      return '等审批'
    case 'done':
      return '已完成'
    case 'error':
      return '出错'
    default:
      return '空闲'
  }
}

/** 送达确认行（§5.5）。「作为插话送达」还是「已开始」由调用方按状态定 */
export function deliveryLine(t: RobotTask | null, folder: string): string {
  if (t === null) return `→ ${targetName(folder, null)}`
  const name = targetName(folder, t.task)
  if (t.state === 'running' || t.state === 'waiting')
    return `→ ${name}（${stateText(t)}，作为插话送达）`
  return `→ ${name}（${stateText(t)}，已开始）`
}

/** 手机上收到的审批卡（§6 A1）。canAllow=false 是 ask_rule 类：只通知回电脑 */
export function approvalMessage(a: Extract<RobotItem, { kind: 'approval' }>): string {
  const head = a.canAllow ? '等你批准' : '需回电脑处理'
  const until = new Date(a.expiresAt)
  const hh = String(until.getHours()).padStart(2, '0')
  const mm = String(until.getMinutes()).padStart(2, '0')
  const lines = [
    `${head} · ${targetName(a.folder, a.task)}（${hh}:${mm} 前有效）`,
    a.command,
    `原因：${a.reason}`,
  ]
  if (a.canAllow) lines.push('回复这条消息：批 / 拒 / 拒 理由')
  return lines.join('\n')
}

/** 一轮结束的推送（§5.6）：最后一段回答前 4000 字，超出写「全文在面板」 */
export const TURN_TEXT_MAX = 4000
export function turnEndMessage(item: Extract<RobotItem, { kind: 'done' | 'error' }>): string {
  const head = item.kind === 'done' ? '已完成' : '出错'
  const text = item.text ?? item.detail
  const clipped = text.length > TURN_TEXT_MAX
  const body = clipped ? `${text.slice(0, TURN_TEXT_MAX)}\n\n（超出 4000 字，全文在面板）` : text
  return `${head} · ${targetName(item.folder, item.task)}\n${body}`
}

/** 晚到消息的确认（§5.5）：多列各条，回「执行」合并送进会话。
 * dest 写明送到哪——目标可能随网关重启回到默认（用户 15:08 真机踩过：
 * /to 切过的目标丢了、晚到重投落到了别处，回「执行」时不知情） */
export function lateConfirmParts(
  msgs: FeishuMsg[],
  dest: string,
): { title: string; detail: string } {
  const at = (m: FeishuMsg): string => {
    const d = new Date(m.at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const list = msgs.map((m) => `- ${at(m)}：${m.text.slice(0, 100)}`).join('\n')
  return {
    title: `收到 ${msgs.length} 条晚到消息`,
    detail: `${list}\n\n回「执行」把它们送进「${dest}」；回别的话丢弃它们。`,
  }
}

/** state.json 的合并读写：watermark（feishu）与 target（hub）各写各的
 * 字段，互不抹——全量重写会丢对方的字段 */
export function readGatewayState(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function writeGatewayState(file: string, patch: Record<string, unknown>): void {
  try {
    const merged = { ...readGatewayState(file), ...patch }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(merged)}\n`)
  } catch {
    // 写坏不拖主流程（下次重写）
  }
}

/**
 * 空闲退出（im-gateway.md §5.3「所有窗口断开 60 秒后退出」）：**连接数**降到
 * 0 才开始计时，持续 idleMs 仍为 0 才算空闲——连接在线但没有消息不算（窗口
 * 侧 status 只在有活动时发，用户没动 VS Code 时网关会把「安静」当「断开」
 * 自杀，2026-11-17 两个网关实例都这么死的：最后一条 status 后整 60 秒）。
 * 启动后一直没人连，同样从 0 计满退出。
 *
 * log 给同步写（syncLogRunTo）：onIdle 返回后调用方通常立即 process.exit，
 * 异步链没冲完就退，idle_exit 这条就无声丢（两次死因排查都被它拖累）
 */
export function createIdleWatch(deps: {
  connCount: () => number
  /** 空闲阈值（生产 60s；测试注入小值） */
  idleMs: number
  log: (ev: Record<string, unknown>) => void
  onIdle: () => void
}): { dispose: () => void } {
  let zeroSince: number | null = null
  let disposed = false
  const timer = setInterval(
    () => {
      if (disposed) return
      if (deps.connCount() > 0) {
        zeroSince = null
        return
      }
      if (zeroSince === null) {
        zeroSince = Date.now()
        return
      }
      if (Date.now() - zeroSince < deps.idleMs) return
      deps.log({ ev: 'gateway_idle_exit' })
      deps.onIdle()
    },
    Math.min(5000, deps.idleMs),
  )
  timer.unref?.()
  return {
    dispose: () => {
      disposed = true
      clearInterval(timer)
    },
  }
}
