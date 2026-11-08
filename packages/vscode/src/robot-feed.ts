import type { AgentEvent, ApprovalCategory } from '@simple-code/core'
import type { ApprovalRequest } from './protocol.ts'

/**
 * 桌面机器人的状态生成（docs/proposals/desktop-robot.md §4.3、§5）。
 *
 * 纯逻辑，不认 vscode 也不认 socket：路由层给出各目录各任务的现状，
 * 宿主给出「用户此刻在 VS Code 里看得到什么」，这里算出发给机器人的
 * 整份 status。机器人只显示 seen=false 的条目。
 */

/** 一轮怎么结束的。stopped = 用户自己停的，不提醒（§5.3） */
export type TurnEnd = { at: number; end: 'done' | 'error' | 'stopped'; text: string }

/**
 * 跟着一轮的事件流记结局：最后一段回答文字 + 致命错误。
 *
 * **error 事件不都致命**：reload_system 的 AGENTS.md 超限、note 读失败也发
 * error，之后照常发请求（core loop/run.ts）。错误之后模型还在出文字或调
 * 工具 = 这一轮没死在它手上，清掉。真正结束一轮的（协议错误、截断续写
 * 到上限、安全拒答）后面不会再有这两种事件
 */
export function turnTracker() {
  let text = ''
  let error: string | null = null
  return {
    see(ev: AgentEvent): void {
      if (ev.type === 'text_start') {
        text = ''
        error = null
      } else if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'tool_call') error = null
      else if (ev.type === 'error') error = ev.message
    },
    /** send 抛出（没跑起来、拿不到锁……）：本身就是结局 */
    fail(message: string): void {
      error = message
    },
    end(stopped: boolean): TurnEnd {
      const end = stopped ? 'stopped' : error !== null ? 'error' : 'done'
      return { at: Date.now(), end, text: error ?? text }
    },
  }
}

/** 一个任务的现状。task=null 是主任务 */
export type RobotTaskView = {
  task: string | null
  running: boolean
  /** 本轮开始的墙钟（running 时有意义），总览显示「在跑 N 分钟」 */
  startedAt: number | null
  lastTurn: TurnEnd | null
  /** 用户参与过（手打消息或用户开的）：只有这种任务弹完成/出错提醒——
   *  agent 派、无人参与的完成只回调主任务（2026-11-06 用户定） */
  userTouched?: boolean
}

export type RobotFolderView = {
  folder: string
  tasks: RobotTaskView[]
  /** 挂起中的审批卡（含分身任务的，card.task 标来源） */
  approvals: ApprovalRequest[]
}

/** 用户此刻看得到哪个目录的哪个任务（§5.1：窗口有焦点 + SC 面板可见 + 面板正显示它） */
export type Sight = { focused: boolean; panelVisible: boolean; folder: string; task: string | null }

export type RobotItem =
  | {
      kind: 'approval'
      /** = toolCallId。机器人点「允许」回传它，SC 只认此刻确实在等的 */
      key: string
      folder: string
      task: string | null
      command: string
      reason: string
      expiresAt: string
      canAllow: boolean
      seen: boolean
    }
  | {
      kind: 'done' | 'error'
      key: string
      folder: string
      task: string | null
      headline: string
      /** 悬停显示的前 200 字 */
      detail: string
      seen: boolean
    }

export type RobotTask = {
  folder: string
  task: string | null
  state: 'running' | 'waiting' | 'idle' | 'done' | 'error'
  since: string | null
}

export type RobotStatus = { type: 'status'; items: RobotItem[]; tasks: RobotTask[] }

/** D1（用户定 2026-10-31）：命中自定义规则（git push、gh、你配的 askCommands）
 *  或出网命令的卡只能回窗口处理。multi 卡看合并前的各段——两周 10 张含 git push
 *  的卡里 2 张是 multi */
const WINDOW_ONLY: ApprovalCategory[] = ['ask_rule']

export const canAllowOnRobot = (card: Pick<ApprovalRequest, 'category' | 'parts'>): boolean =>
  !WINDOW_ONLY.includes(card.category) && !(card.parts ?? []).some((p) => WINDOW_ONLY.includes(p))

const MD_LEAD = /^[\s#*`>-]+/

/**
 * 结论的第一句（§5.3）：首个非空行去掉开头的 Markdown 记号，截到第一个
 * 「。！？」，最多 60 字。用户约定「首句写结论或状态」，所以第一句就够用
 */
export function headline(text: string): string {
  const line = text.split('\n').find((l) => l.replace(MD_LEAD, '').trim() !== '') ?? ''
  const clean = line.replace(MD_LEAD, '').replaceAll('**', '').replaceAll('`', '').trim()
  const first = clean.match(/^.*?[。！？]/)?.[0] ?? clean
  const chars = [...first]
  return chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : first
}

const iso = (ms: number): string => new Date(ms).toISOString()

const taskState = (t: RobotTaskView, waiting: boolean): RobotTask['state'] => {
  if (waiting) return 'waiting'
  if (t.running) return 'running'
  if (t.lastTurn === null || t.lastTurn.end === 'stopped') return 'idle'
  return t.lastTurn.end
}

export function createRobotFeed() {
  /** 看过（seen 过一次）或在机器人上关掉的完成/出错。key 带结束时刻，
   *  同一任务下一轮结束是新 key */
  const consumed = new Set<string>()

  const approvalItem = (f: string, card: ApprovalRequest, seen: boolean): RobotItem => ({
    kind: 'approval',
    key: card.toolCallId,
    folder: f,
    task: card.task ?? null,
    // 截法同 approval_ask 日志（bridge.ts）
    command: card.command.slice(0, 300),
    reason: card.reason.slice(0, 200),
    expiresAt: iso(card.expiresAt),
    canAllow: canAllowOnRobot(card),
    seen,
  })

  /** 完成/出错提醒。在跑（开了新一轮）、被停止、看过、关掉过的、以及
   *  无人参与的（agent 派——结果走〔任务结果〕回主任务，robot 不打扰
   *  用户）不提醒；用户手打过一次就恢复 */
  const noticeItem = (f: string, t: RobotTaskView, seen: boolean): RobotItem | null => {
    const last = t.lastTurn
    if (t.running || last === null || last.end === 'stopped') return null
    if (t.userTouched !== true) return null
    const key = `${f}#${t.task ?? ''}#${last.at}`
    if (consumed.has(key)) return null
    // 用户正看着这个任务时结束的、或之后回来看到了：算处理过，以后也不再提醒
    if (seen) {
      consumed.add(key)
      return null
    }
    return {
      kind: last.end,
      key,
      folder: f,
      task: t.task,
      headline: headline(last.text),
      detail: last.text.slice(0, 200),
      seen: false,
    }
  }

  const build = (folders: RobotFolderView[], sight: Sight): RobotStatus => {
    const sees = (f: string, task: string | null): boolean =>
      sight.focused && sight.panelVisible && sight.folder === f && sight.task === task
    const items: RobotItem[] = []
    const tasks: RobotTask[] = []
    for (const { folder: f, tasks: views, approvals } of folders) {
      for (const card of approvals) items.push(approvalItem(f, card, sees(f, card.task ?? null)))
      for (const t of views) {
        const notice = noticeItem(f, t, sees(f, t.task))
        if (notice !== null) items.push(notice)
        const waiting = approvals.some((c) => (c.task ?? null) === t.task)
        const state = taskState(t, waiting)
        const since =
          state === 'running' ? t.startedAt : state === 'idle' ? null : (t.lastTurn?.at ?? null)
        tasks.push({ folder: f, task: t.task, state, since: since === null ? null : iso(since) })
      }
    }
    return { type: 'status', items, tasks }
  }

  return { build, dismiss: (key: string): void => void consumed.add(key) }
}

export type RobotFeed = ReturnType<typeof createRobotFeed>
