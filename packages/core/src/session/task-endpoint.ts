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
export type TaskDispatchRequest = { brief: string; root: string; owner: string; model?: string }
export type TaskDispatchResponse = { ok: true; name: string } | { ok: false; error: string }

/** bin --models → 桥（POST /models）：root 所在目录的 taskModels 与配置默认模型 */
export type TaskModelsRequest = { root: string }
export type TaskModelEntry = { provider: string; model: string; effort?: string | undefined; use: string }
export type TaskModelsResponse =
  | { ok: true; models: TaskModelEntry[]; defaultModel: string }
  | { ok: false; error: string }
