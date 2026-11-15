import type { Effort, ModelRef } from '@simple-code/core'
import type { Attendance, TaskDraftDefaults, ToHost } from '../src/protocol.ts'

/**
 * 「+ 任务」的新任务状态（task-trunk.md 规则 13，2026-11-14 改为第一条消息即开）：
 * 任务还没建，用户在这里先选的模型/档位/审批只记在 webview，发第一条消息时随
 * task_create 一起交给宿主。null = 没动过、跟默认（宿主 state.taskDraft 预算）。
 */
export type TaskDraft = { model: ModelRef | null; effort: Effort | null; attendance: Attendance }

/** 审批默认「拒绝」：同宿主 openRun 给任务的初值（2026-11-05 拍板子任务默认拒绝） */
export const NEW_DRAFT: TaskDraft = { model: null, effort: null, attendance: 'unattended' }

/** 选模型（预设也走这里——它的选择带 preset）。换了模型撤掉档位覆盖，同 core
 *  setModel：档位含义由模型决定；同模型只换预设则保留 */
export function pickModel(
  d: TaskDraft,
  defaults: ModelRef | undefined,
  choice: ModelRef,
): TaskDraft {
  const was = d.model ?? defaults
  const same = was?.provider === choice.provider && was?.model === choice.model
  return { ...d, model: choice, effort: same ? d.effort : null }
}

type DraftControls = {
  current: ModelRef | null
  effort: Effort | null
  effortOverridden: boolean
  preset?: string
  presets: string[]
  imagesEnabled: boolean
  contextWindow: number
  attendance: Attendance
}

/** 新任务状态下底栏控件显示什么：选过的用选的，没选的跟默认 */
export function draftControls(
  models: ModelRef[],
  defaults: TaskDraftDefaults | undefined,
  d: TaskDraft,
): DraftControls {
  const current = d.model ?? defaults?.model ?? null
  const i = models.findIndex((m) => m.provider === current?.provider && m.model === current?.model)
  const info = i >= 0 ? defaults?.perModel[i] : undefined
  return {
    current,
    effort: d.effort ?? info?.effort ?? null,
    effortOverridden: d.effort !== null,
    ...(current?.preset !== undefined ? { preset: current.preset } : {}),
    presets: info?.presets ?? [],
    // 不知道（还没收到预算值、或这个模型解析失败）时同主任务 noControls：不收图
    imagesEnabled: info?.imagesEnabled ?? false,
    contextWindow: info?.contextWindow ?? 0,
    attendance: d.attendance,
  }
}

/** 发第一条时带给宿主的选择。没动过模型也没动档位 = 不带（宿主走配置默认） */
export function draftChoice(
  defaults: TaskDraftDefaults | undefined,
  d: TaskDraft,
): Extract<ToHost, { type: 'task_create' }>['choice'] {
  if (d.model === null && d.effort === null) return undefined
  const model = d.model ?? defaults?.model
  if (model === undefined) return undefined
  return { ...model, ...(d.effort !== null ? { effort: d.effort } : {}) }
}
