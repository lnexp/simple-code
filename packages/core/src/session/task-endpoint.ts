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
  /** --goal --go（goal-mode.md）：目标模式任务——跑到达成或判定不可能。
   *  只有 --go 过闸后的正式派单才带；仅 --goal 不带（首调只回纪律不派） */
  goal?: true
}
export type TaskDispatchResponse = { ok: true; name: string } | { ok: false; error: string }

/** 派 goal 任务的父任务纪律（goal-mode.md）：CLI --goal 首调返回全文（先读
 *  后派——任务书质量在派单那一刻就定了）。放这里的理由同文件头：bin 深
 *  import 此文件，零依赖不拖 barrel */
export const PARENT_GOAL_BRIEFING = `〔goal 模式〕目标模式任务：跑到达成或判定不可能，不是跑完一轮就交差。派单纪律（先读后派）：
① 任务书目标写成「最终状态」，验收标准必须可观察（测试过 / 命令输出 / 文件存在），不写「感觉对了」。
② 派单后立即设 awake 兜底："$SIMPLE_CODE_WAKE" --after 45m --note 'goal 任务到点未返则 task_send 列状态'（时长按任务规模定）——〔任务结果〕是被动通道，子任务挂死不终止它永远不来；awake 是主动兜底。
③ awake 醒来：在跑就再设一个继续等；停了没下文就 task_send 问进展。
④ 收到终止结果：审产物不听自述（跑测试 / 看 diff / 对验收标准）；未达成 → task_send 续命并说清差什么；连续 2~3 次无进展 → 判无法达成，向用户说明原因。
⑤ 子任务被审批卡住 ≠ 失败——指引它跳过被拒部分继续，别当终局。

了解纪律后，用 "$SIMPLE_CODE_TASK" --goal --go <<'MD' 任务书 MD 正式派单（任务书 = 目标 + 验收标准 + 预期时长）。`

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
 *  持久化在 <root>/.simple-code/wake.json（wake-store.ts，2026-11-09 拍板）：
 *  重载恢复、过点补投；任务只能 awake 自己（list/cancel 只见自己的）。
 *  App Nap 会把长定时器节流到 ~15 分钟一拍，精度按分钟级设计 */
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
