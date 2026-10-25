import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type { z } from 'zod'
import type { Protocol } from '../llm/protocol.ts'
import { resolveProtocol } from '../llm/registry.ts'
import type { Effort, Request } from '../llm/types.ts'
import { deepMerge, stripDenied } from './denylist.ts'
import { expandEnv } from './env.ts'
import { type Config, configSchema, type ModelSpec } from './schema.ts'

export const GLOBAL_CONFIG_PATH = join(homedir(), '.simple-code', 'settings.json')
/** MCP servers 的独立配置文件（2026-09-27 拍板移出 settings.json）。
 *  只认用户级——项目级不开放：MCP server 是可执行命令 + env 凭证，
 *  克隆来的仓库能塞一条就能借 agent 之手执行任意代码（settings 的
 *  strict schema 不认任何 mcp 键，塞了也进不来） */
export const MCP_CONFIG_PATH = join(homedir(), '.simple-code', 'mcp.json')
/** websearch 的独立配置文件（对齐 mcp.json：凭据类配置单独文件——bin 经
 *  bash 白名单 env 运行，宿主变量不在里面，key 只能落明文进文件） */
export const WEBSEARCH_CONFIG_PATH = join(homedir(), '.simple-code', 'websearch.json')
export const WORKSPACE_CONFIG_RELATIVE = join('.simple-code', 'settings.json')

export type LoadedConfig = {
  config: Config
  /** 解析后的当前模型规格，省得调用方每次都翻两层 map */
  model: ModelSpec
  protocol: Protocol
  baseUrl: string
  apiKey: string
  /** 合并后的请求偏好，已应用「模型级覆盖全局」 */
  /** effort 收窄为 Effort：'none' 只开放给副模型（SideModel.request） */
  request: Omit<Request, 'system' | 'tools' | 'messages' | 'model' | 'effort'> & { effort: Effort }
  /**
   * 后台摘要用的模型规格和请求偏好。`memory.summaryModel` 为 null 时就是主
   * 模型那一份（同一个对象）。
   *
   * **必填不可选**：可选的话调用方漏读一次就退回主模型，而那正是本次要修的
   * bug——症状是「配了摘要模型，请求里 model 换了、路由参数没换」，看起来
   * 生效了，实际发给了错的后端
   */
  summary: SideModel
  /**
   * 视觉转述副模型。与 summary 不同：null 就是 null（不折叠成主模型——
   * 主模型没视觉才需要它，折叠回去等于永远不转述），调用方判 null 走老路
   */
  vision: SideModel | null
  /** 被黑名单剥掉的工作区字段。调用方负责 warn */
  warnings: string[]
}

/** 副模型（summary / vision relay 共用）：规格 + 请求偏好 + 自己的连接 */
export type SideModel = {
  /** 模型名字符串。请求体的 model 字段用它，规格（窗口/能力）用 model */
  name: string
  model: ModelSpec
  request: Omit<Request, 'system' | 'tools' | 'messages' | 'model'>
  protocol: Protocol
  baseUrl: string
  apiKey: string
}

export type LoadOptions = {
  globalPath?: string
  env?: NodeJS.ProcessEnv
}

/**
 * 一个模型的完整身份。**必须是 provider + model 一对，不能只有 model**——
 * 同名模型可以配在两个 provider 下（网关 + 直连是真实场景），只给名字就有
 * 二义性。
 *
 * 也**不做成 `"provider/model"` 拼接串**：模型名本身允许含 `/`
 * （`anthropic/claude-opus-4-8` 这种网关命名很常见），拼接后再切分就得猜
 * 从哪个斜杠断。
 * 我们没有「用户手打模型串」这个入口，所以一步到位只用结构对
 */
export type ModelRef = {
  provider: string
  model: string
  /**
   * 参数预设（modelSpec.presets 的键）。省略 = 用模型本体的参数，
   * 界面上叫「默认」。名字在这个模型下找不到时 resolve 会抛——与
   * 模型名写错同样的处理，不静默退回默认（CLAUDE.md §1.2）
   */
  preset?: string
}

/**
 * 换一个模型，返回新的 LoadedConfig。**纯函数，不读文件**——
 * 换模型不该有 IO，也不该受「切换期间配置文件恰好被改了」的影响。
 *
 * 走的是 loadConfig 同一个 `resolve`，所以「provider 不存在」「model 不在
 * 这个 provider 下」的报错文案和启动时一模一样，不用维护第二套。
 *
 * 注意它换的**不只是模型名**：protocol / baseUrl / apiKey / request 偏好
 * 全部跟着 provider 重解析。跨 provider 切换因此天然支持——这正是「支持多
 * 协议」这句话要兑现的地方（CLAUDE.md §1.2）。
 */
export function selectModel(
  loaded: LoadedConfig,
  choice: ModelRef,
  env: NodeJS.ProcessEnv,
): LoadedConfig {
  const config = { ...loaded.config, provider: choice.provider, model: choice.model }
  return resolve(config, { env, warnings: loaded.warnings }, choice.preset)
}

/** 生图模型的连接（imageModel 解析结果）。只给宿主凭据代理用 */
export type ImageModel = { model: string; baseUrl: string; apiKey: string }

/**
 * 解析 `imageModel`：未配置返回 null（调用方报「未配置」）；provider 不存在
 * 抛错。model 不校验是否登记在 provider.models——生图模型不是对话模型
 */
export function resolveImageModel(config: Config, env: NodeJS.ProcessEnv = process.env): ImageModel | null {
  const ref = config.imageModel
  if (ref === null) return null
  const provider = config.providers[ref.provider]
  if (!provider) {
    const known = Object.keys(config.providers).join(' / ') || '(一个都没配)'
    throw new Error(`imageModel 的 provider "${ref.provider}" 不在 providers 里。已配置的：${known}`)
  }
  return { model: ref.model, baseUrl: provider.baseUrl, apiKey: expandEnv(provider.apiKey, env) }
}

/** 配置里所有可选的模型，按 provider 分组的顺序拍平。给选择器用 */
export function listModels(config: Config): ModelRef[] {
  return Object.entries(config.providers).flatMap(([provider, spec]) =>
    Object.keys(spec.models).map((model) => ({ provider, model })),
  )
}

/**
 * 加载顺序，每一步都不能调换：
 *
 *   读全局 → 读工作区 → **剥工作区黑名单** → 深合并 → zod 校验
 *   → 展开 ${ENV} → 解析 provider / model 引用
 *
 * 剥黑名单必须在合并之前：合并后就分不清某个 baseUrl 是全局来的还是
 * 工作区来的了（design.md §8）。
 */
export async function loadConfig(
  folderPath: string,
  options: LoadOptions = {},
): Promise<LoadedConfig> {
  const globalPath = options.globalPath ?? GLOBAL_CONFIG_PATH
  const workspacePath = join(folderPath, WORKSPACE_CONFIG_RELATIVE)

  const global = await readJson(globalPath)
  // 同一个文件不能既当全局又当工作区：空工作区时面板的 folderList 兜底成
  // home，<home>/.simple-code/settings.json 恰好是（默认）全局配置——再按
  // 工作区读一遍会把它剥掉 provider/model/baseUrl/apiKey，空壳过不了校验。
  // Remote-SSH 实测：远端窗口刚连上还没开文件夹时报「providers.deepseek.
  // baseUrl undefined」就是这个撞路径（远端 home 有份 CLI 时代的旧配置）
  const wsAbs = resolvePath(workspacePath)
  const sameAsGlobal =
    wsAbs === resolvePath(globalPath) || wsAbs === resolvePath(GLOBAL_CONFIG_PATH)
  const { value: workspace, stripped } = sameAsGlobal
    ? { value: null, stripped: [] }
    : stripDenied(await readJson(workspacePath))

  const merged = deepMerge(global ?? {}, workspace ?? {})
  const config = parse(merged)

  return resolve(config, {
    env: options.env ?? process.env,
    warnings: stripped.map(
      (path) => `工作区配置里的 ${path} 已忽略：该字段只认全局配置（${globalPath}）`,
    ),
  })
}

async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null // 文件不存在是正常的，两份配置都是可选的
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`配置文件 ${path} 不是合法的 JSON：${(e as Error).message}`)
  }
}

function parse(merged: unknown): Config {
  const result = configSchema.safeParse(merged)
  if (result.success) return result.data
  throw new Error(`配置校验失败：\n${formatIssues(result.error)}`)
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.') || '(根)'
      // 未知字段单独说明，否则 zod 的默认文案看不出是拼错了
      return issue.code === 'unrecognized_keys'
        ? `  ${path}: 未知的配置项 ${issue.keys.join(' / ')}（是不是拼错了？未知字段不会被忽略）`
        : `  ${path}: ${issue.message}`
    })
    .join('\n')
}

// ---------------------------------------------------------------- 引用解析

function resolve(
  config: Config,
  ctx: { env: NodeJS.ProcessEnv; warnings: string[] },
  /** 当前选中的参数预设（ModelRef.preset）。undefined = 用模型本体 */
  preset?: string,
): LoadedConfig {
  const provider = config.providers[config.provider]
  if (!provider) {
    const known = Object.keys(config.providers).join(' / ') || '(一个都没配)'
    throw new Error(`provider "${config.provider}" 不在 providers 里。已配置的：${known}`)
  }

  const base = provider.models[config.model]
  if (!base) {
    const known = Object.keys(provider.models).join(' / ') || '(一个都没配)'
    throw new Error(
      `model "${config.model}" 不在 provider "${config.provider}" 的 models 里。已配置的：${known}`,
    )
  }
  const picked = applyPreset(base, preset, config.provider, config.model)
  const request = mergeRequest(config, picked)
  // 买了 1h 缓存，过期判定就至少 1 小时——否则 5 分钟后照样 stale 压缩，1h 白买。
  // cacheTtlMs 是模型级、preset 改不了，只能从最终的 cacheTtl 推（2026-10-23）
  const model =
    request.cacheTtl === '1h' ? { ...picked, cacheTtlMs: Math.max(picked.cacheTtlMs, 3_600_000) } : picked

  const protocol = resolveProtocol(provider.protocol)
  if (model.claudeAgentSdk) {
    if (protocol.name !== 'anthropic-messages')
      throw new Error('claudeAgentSdk 仅支持 anthropic-messages')
    if (!config.claudeAgentSdkPath)
      throw new Error('启用 claudeAgentSdk 必须配置用户级 claudeAgentSdkPath')
    if (config.memory.summaryModel === null)
      throw new Error('启用 claudeAgentSdk 必须显式配置可直连的 memory.summaryModel')
  }
  const baseUrl = provider.baseUrl
  const apiKey = expandEnv(provider.apiKey, ctx.env)
  const main = { name: config.model, model, request, protocol, baseUrl, apiKey }
  return {
    config,
    model,
    protocol,
    baseUrl,
    apiKey,
    request: main.request,
    summary: resolveSummary(config, ctx, main),
    vision:
      config.visionModel === null
        ? null
        : resolveSideModel('visionModel', config.visionModel, config, ctx, main),
    warnings: ctx.warnings,
  }
}

/**
 * 解析 `memory.summaryModel`。**在这里校验而不是等发请求时报错**：写错模型名的
 * 后果本来是运行时 404，而摘要的异常被 `summarizeOnce` 的 catch 整个吞掉
 * （session.ts），症状是「摘要再也不动了，且一行日志都没有」。
 * 配置字段写错必须响（CLAUDE.md §1.2、§6.4）。
 *
 * 三种形态：null = 主模型（连接也用主的）；string = 当前 provider 下的
 * 模型名（老形态）；{ provider, model } = 跨 provider——protocol/baseUrl/
 * apiKey 按目标 provider 解析，摘要后台任务与主模型彻底解耦：主模型
 * 切换不该牵连摘要系统（用户配置里网关分了 anthropic/openai 两条协议，
 * 摘要固定走便宜模型、主模型两个 provider 来回切）。
 */
function resolveSummary(
  config: Config,
  ctx: { env: NodeJS.ProcessEnv; warnings: string[] },
  main: LoadedConfig['summary'],
): LoadedConfig['summary'] {
  const ref = config.memory.summaryModel
  if (ref === null) return main
  return resolveSideModel('memory.summaryModel', ref, config, ctx, main)
}

/**
 * 副模型引用的公共解析。label 只进报错文案（配置字段写错必须响，
 * CLAUDE.md §1.2——各调用方的吞错方式不同，校验只能在 load 时做）。
 *
 * ref 为 null 时返回 main（summary 的语义：null = 主模型兼任）。vision
 * 不想要这个折叠，在调用处先判 null 再进来
 */
function resolveSideModel(
  label: string,
  ref: string | { provider: string; model: string; effort?: Request['effort'] | undefined },
  config: Config,
  ctx: { env: NodeJS.ProcessEnv; warnings: string[] },
  main: SideModel,
): SideModel {
  const [providerName, modelName] = typeof ref === 'string' ? [config.provider, ref] : [ref.provider, ref.model]
  const provider = config.providers[providerName]
  if (!provider) {
    const known = Object.keys(config.providers).join(' / ') || '(一个都没配)'
    throw new Error(`${label} 的 provider "${providerName}" 不在 providers 里。已配置的：${known}`)
  }

  const model = provider.models[modelName]
  if (!model) {
    const known = Object.keys(provider.models).join(' / ') || '(一个都没配)'
    throw new Error(
      `${label} "${modelName}" 不在 provider "${providerName}" 的 models 里。已配置的：${known}`,
    )
  }
  if (model.claudeAgentSdk) throw new Error(`${label} 不支持 claudeAgentSdk，请选择可直连模型`)
  // 请求偏好也按摘要模型自己的算：主模型若把 maxTokens 顶到 16k，一句话的
  // 摘要请求没理由跟着要 16k 的输出预算
  return {
    name: modelName,
    model,
    // ref 上的 effort 只作用于这个副模型（摘要/转述），可取 'none'（见 schema sideModelRef）
    request: {
      ...mergeRequest(config, model),
      ...(typeof ref !== 'string' && ref.effort ? { effort: ref.effort } : {}),
    },
    protocol: resolveProtocol(provider.protocol),
    baseUrl: provider.baseUrl,
    apiKey: expandEnv(provider.apiKey, ctx.env),
  }
}

/**
 * 模型级覆盖全局，逐字段浅合并。
 *
 * 兜底值放在这里而不是 schema 的 default 里：schema 里给了默认值的话，
 * 「用户没配」和「用户配成了默认值」就分不开，模型级覆盖会永远失效
 * ——全局那层总是有值，模型级的 undefined 覆盖不掉它。
 */
/**
 * 把预设的覆盖叠到模型本体上（t885）。**深合并、逐字段**：预设只写要改的
 * 字段，没写的承袭本体——`{maxTokens:32000}` 不会把本体的 temperature 冲掉。
 *
 * 只动请求参数、头、body 和可选 SDK 调用方式，contextWindow 与 capabilities
 * 原样保留：窗口变了预算与压缩水位要
 * 重算，能力变了历史里的图会突然非法——那是模型属性不是线路属性。
 *
 * 名字找不到就抛，不静默退回默认：静默的话「切了线路其实没切」没人看得出来，
 * 而这正是要排查线路问题时最要命的假象（CLAUDE.md §1.2 配置错就报错）。
 */
function applyPreset(
  model: ModelSpec,
  preset: string | undefined,
  provider: string,
  modelName: string,
): ModelSpec {
  if (preset === undefined) return model
  const spec = model.presets[preset]
  if (!spec) {
    const known = Object.keys(model.presets).join(' / ') || '(这个模型没配 presets)'
    throw new Error(
      `预设 "${preset}" 不在 "${provider}/${modelName}" 的 presets 里。已配置的：${known}`,
    )
  }
  return {
    ...model,
    claudeAgentSdk: spec.claudeAgentSdk ?? model.claudeAgentSdk,
    request: { ...model.request, ...spec.request },
    headers: { ...model.headers, ...spec.headers },
    extraBody: { ...model.extraBody, ...spec.extraBody },
  }
}

function mergeRequest(config: Config, model: ModelSpec): LoadedConfig['request'] {
  const g = config.request
  const m = model.request
  const cacheTtl = m.cacheTtl ?? g.cacheTtl
  return {
    maxTokens: m.maxTokens ?? g.maxTokens ?? 32_000,
    thinking: m.thinking ?? g.thinking ?? 'adaptive',
    effort: m.effort ?? g.effort ?? 'high',
    reasoningDisplay: m.reasoningDisplay ?? g.reasoningDisplay ?? 'summarized',
    // 不配就不出现这个键：请求体与前缀指纹跟没有这个功能时逐字节一致
    ...(cacheTtl ? { cacheTtl } : {}),
  }
}
