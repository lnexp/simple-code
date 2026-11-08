/**
 * 派任务桥的本机端点约定（task-trunk 规则 11）——宿主侧（vscode task-bridge.ts）
 * 与 bin 侧（cli task-bin.ts）共用，零依赖（bin 深 import，不拖 barrel）。
 *
 * 端口、token 由宿主写进 process.env，经 schema.ts envPassthrough 进 bash
 * （两处成对，lesson env-passthrough-pair-with-inject）。token 挡的是网页对
 * 127.0.0.1 的跨站 POST 与本机其他进程——派任务会让 agent 干活，不能谁都能叫
 */
export const TASK_PORT_ENV = 'SIMPLE_CODE_TASK_PORT'
export const TASK_TOKEN_ENV = 'SIMPLE_CODE_TASK_TOKEN'
export const TASK_TOKEN_HEADER = 'x-sc-token'

/** bin → 桥。root = 派它的会话所在目录（多根工作区按它找 bridge）；
 *  owner = 派它的会话（主任务 ''），登记为回调对象（规则 12）；model = --model
 *  的原文（规则 14，model 或 provider/model，省略 = 配置默认） */
export type TaskDispatchRequest = {
  brief: string
  root: string
  owner: string
  model?: string
  /** --lean（2026-11-03）：精简上下文——只保常驻+floor+live，压缩=硬切 */
  lean?: boolean
}
export type TaskDispatchResponse = { ok: true; name: string } | { ok: false; error: string }

/** bin --models → 桥（POST /models）：root 所在目录的 taskModels 与配置默认模型 */
export type TaskModelsRequest = { root: string }
export type TaskModelEntry = {
  provider: string
  model: string
  effort?: string | undefined
  use: string
}
export type TaskModelsResponse =
  | { ok: true; models: TaskModelEntry[]; defaultModel: string }
  | { ok: false; error: string }

/** task_send（loop-interrupt.md §4）：任务互发/列任务，POST /send 与 /send-list */
export type TaskSendRequest = { root: string; task: string; text: string }
export type TaskSendResponse = { ok: true } | { ok: false; error: string }
/** 列任务：名字、状态、最近一句（agent 的任务视野——拿不准先列再发） */
export type TaskSendListRequest = { root: string }
export type TaskSendListEntry = { name: string; status: string; lastLine: string }
export type TaskSendListResponse =
  | { ok: true; tasks: TaskSendListEntry[] }
  | { ok: false; error: string }

/** $SIMPLE_CODE_WAKE（loop-interrupt.md §5）：闹钟。三种形态：
 *  --after 30m（相对）｜--at 08:00（绝对，已过则明天）｜--until-ok "命令"
 *  （宿主层每 --every 间隔跑命令，退出 0 那次唤醒；--every 默认 30m）。
 *  --note 是自己留给自己的备忘（非 --say——唤醒是闹钟事件不是用户说话）。
 *  投递 = 给设闹钟的会话（root+owner）发〔wake〕消息，复用 task_send 的路。
 *  不持久化：重启即丢，落回「agent 醒来看现场」兜底。App Nap 会把长定时器
 *  节流到 ~15 分钟一拍，精度按分钟级设计 */
export type WakeRequest = {
  root: string
  owner: string
  afterMs?: number
  at?: string
  untilOk?: string
  everyMs?: number
  note?: string
}
export type WakeResponse = { ok: true; id: string } | { ok: false; error: string }
