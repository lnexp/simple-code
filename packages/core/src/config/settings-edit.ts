import { readFile } from 'node:fs/promises'
import { type ParseError, parse } from 'jsonc-parser'
import { PROTOCOL_NAMES } from '../llm/registry.ts'
import type { ModelRef } from './load.ts'
import { SIDE_EFFORTS, type SideEffort } from './schema.ts'

/**
 * 设置页（2026-11-17 原型放行）对用户级 settings.json 的读写。
 * 本文件是**读侧**：类型 + 视图投影；写操作在 settings-write.ts。
 *
 * 读：**原始 JSONC 投影，不走 zod**——文件可能正处于坏状态（字段拼错、
 * 引用悬空），那正是要进设置页修的对象，schema 一挡就只剩红框报错可看。
 *
 * 与 load.ts 的分工：那边管「启动时怎么读生效配置」，这边管「设置页怎么
 * 展示与改写」。两层各一份视角是刻意的——视图容忍残缺，加载不容忍。
 */

/** apiKey 在视图里的形态：只说「是什么」，不带值——视图要发给 webview */
export type SettingsApiKey =
  | { kind: 'env'; name: string }
  | { kind: 'literal' }
  | { kind: 'missing' }

export type SettingsModelView = {
  model: string
  contextWindow: number
  images: boolean
  /** 表单不管的字段名（extraBody、presets…），设置页标「高级参数」 */
  advanced: string[]
}

export type SettingsProviderView = {
  name: string
  protocol: string
  baseUrl: string
  apiKey: SettingsApiKey
  models: SettingsModelView[]
}

/** 看图/摘要模型的引用。effort = ref 上的推理档位（schema sideModelRef，
 *  可取 none）；没写就不带这个键（沿用模型级/全局 effort） */
export type SideModelView = { provider: string; model: string; effort?: SideEffort }

/**
 * 设置页的全部数据。missing = 文件不存在（首开表单）；error = 读得了但
 * 不是合法 JSON（页面给「打开 settings.json」的兜底态）。两者互斥。
 */
export type SettingsView = {
  missing: boolean
  error: string | null
  /** 实际编辑的文件路径（Remote-SSH 时是 settings.remote.json） */
  path: string
  defaultRef: { provider: string; model: string } | null
  visionModel: SideModelView | null
  summaryModel: SideModelView | null
  /** null = 没写 recall.mode（走默认 shadow） */
  recallMode: 'on' | 'off' | 'shadow' | null
  providers: SettingsProviderView[]
  /** 与 listModels 同口径的拍平清单，bridge 直接喂 state.models */
  models: ModelRef[]
  protocols: string[]
  /** 推理档位下拉的候选（schema SIDE_EFFORTS；webview 只 import type，靠视图带过去） */
  efforts: SideEffort[]
}

/** 设置页的一个写操作。宿主逐条校验（webview 是不可信面，同 openLink） */
export type SettingsEdit =
  /** 首开表单「保存并开始」：文件不存在时写整份（结构同 README 快速开始） */
  | {
      op: 'firstSave'
      name: string
      protocol: string
      baseUrl: string
      apiKey: string
      model: string
      contextWindow: number
      images: boolean
    }
  /** 「添加模型」选了新服务商：建 provider + 第一个模型 */
  | {
      op: 'addProvider'
      name: string
      protocol: string
      baseUrl: string
      apiKey: string
      model: string
      contextWindow: number
      images: boolean
    }
  | { op: 'addModel'; provider: string; model: string; contextWindow: number; images: boolean }
  /** 编辑模型：窗口/看图/设默认。不支持改名换服务商（删了重加） */
  | {
      op: 'editModel'
      provider: string
      model: string
      contextWindow: number
      images: boolean
      makeDefault: boolean
    }
  | { op: 'deleteModel'; provider: string; model: string }
  | { op: 'editProvider'; name: string; protocol: string; baseUrl: string; apiKey?: string }
  /** 辅助模型：value null = 删掉回默认，不写空串占位 */
  | {
      op: 'setSide'
      key: 'visionModel' | 'summaryModel'
      value: SideModelView | null
    }
  /** 记忆线索开关：off 是删键回默认 shadow，不是写 "off" */
  | { op: 'setRecall'; on: boolean }

// ---------------------------------------------------------------- 读视图

export const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

const keyKind = (v: unknown): SettingsApiKey => {
  if (typeof v !== 'string' || v === '') return { kind: 'missing' }
  const m = ENV_REF.exec(v)
  return m ? { kind: 'env', name: m[1] as string } : { kind: 'literal' }
}

export const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const MODEL_BASIC = new Set(['contextWindow', 'capabilities'])

/** string 形态的引用（= 当前 provider 下的模型名）换算成显式二元组。
 *  provider 字段本身残缺时解不了——宁可显示空，不猜。effort 只认 schema 里的值 */
export const refOf = (raw: unknown, provider: unknown): SideModelView | null => {
  if (typeof raw === 'string') {
    return typeof provider === 'string' && provider !== '' ? { provider, model: raw } : null
  }
  const obj = asObject(raw)
  if (typeof obj.provider !== 'string' || typeof obj.model !== 'string') return null
  const effort = SIDE_EFFORTS.find((e) => e === obj.effort)
  const ref = { provider: obj.provider, model: obj.model }
  return effort === undefined ? ref : { ...ref, effort }
}

/** providers 段投影成卡片数据 + 拍平的模型清单 */
function projectProviders(root: Record<string, unknown>): {
  providers: SettingsProviderView[]
  models: ModelRef[]
} {
  const providers: SettingsProviderView[] = []
  const models: ModelRef[] = []
  for (const [name, p] of Object.entries(asObject(root.providers))) {
    const po = asObject(p)
    const list: SettingsModelView[] = []
    for (const [model, m] of Object.entries(asObject(po.models))) {
      const mo = asObject(m)
      list.push({
        model,
        contextWindow: typeof mo.contextWindow === 'number' ? mo.contextWindow : 0,
        images: asObject(mo.capabilities).images === true,
        advanced: Object.keys(mo).filter((k) => !MODEL_BASIC.has(k)),
      })
      models.push({ provider: name, model })
    }
    providers.push({
      name,
      protocol: typeof po.protocol === 'string' ? po.protocol : '',
      baseUrl: typeof po.baseUrl === 'string' ? po.baseUrl : '',
      apiKey: keyKind(po.apiKey),
      models: list,
    })
  }
  return { providers, models }
}

const emptyView = (path: string): SettingsView => ({
  missing: false,
  error: null,
  path,
  defaultRef: null,
  visionModel: null,
  summaryModel: null,
  recallMode: null,
  providers: [],
  models: [],
  protocols: [...PROTOCOL_NAMES],
  efforts: [...SIDE_EFFORTS],
})

/** 读出设置页视图。**不抛**——所有失败都折进 view.error，页面自己有兜底态 */
export async function readSettingsView(path: string): Promise<SettingsView> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return { ...emptyView(path), error: `读不了 ${path}：${(error as Error).message}` }
    return { ...emptyView(path), missing: true }
  }
  const root = parseRoot(text, path)
  if (typeof root === 'string') return { ...emptyView(path), error: root }
  const { providers, models } = projectProviders(root)
  const rawRecall = asObject(root.recall).mode
  return {
    ...emptyView(path),
    defaultRef:
      typeof root.provider === 'string' && typeof root.model === 'string'
        ? { provider: root.provider, model: root.model }
        : null,
    visionModel: refOf(root.visionModel, root.provider),
    summaryModel: refOf(asObject(root.memory).summaryModel, root.provider),
    recallMode:
      rawRecall === 'on' || rawRecall === 'off' || rawRecall === 'shadow' ? rawRecall : null,
    providers,
    models,
  }
}

/** JSONC 文本 → 根对象。坏文本返回给用户看的错误文案（不抛） */
export function parseRoot(text: string, path: string): Record<string, unknown> | string {
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (
    parsed === undefined ||
    errors.length > 0 ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  )
    return `${path} 不是合法的 JSON，设置页改不了——先在编辑器里修好它`
  return parsed as Record<string, unknown>
}
