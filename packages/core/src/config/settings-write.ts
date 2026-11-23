import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applyEdits, modify } from 'jsonc-parser'
import { PROTOCOL_NAMES } from '../llm/registry.ts'
import { SIDE_EFFORTS } from './schema.ts'
import {
  asObject,
  ENV_REF,
  parseRoot,
  readSettingsView,
  refOf,
  type SettingsEdit,
  type SettingsView,
} from './settings-edit.ts'
import { deleteKey, FMT, modelBody, pruneEmpty } from './settings-jsonc.ts'

/**
 * 设置页的**写侧**（读侧与类型见 settings-edit.ts）：每个操作只动自己
 * 那几个键，jsonc-parser 的 modify 保留注释、缩进和其余字段（手写配置
 * 的 `$comment` 不毁）。所有校验在这里做——webview 是不可信面。
 */

/** 校验并落一个写操作，返回新视图。失败抛 Error，文案直接给用户看 */
export async function applySettingsEdit(path: string, edit: SettingsEdit): Promise<SettingsView> {
  let text: string | null
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = null
  }
  const next = applyEdit(text, path, edit)
  await mkdir(dirname(path), { recursive: true })
  // mode 只在新建时生效；已存在的文件保持用户自己的权限设置——但写进
  // 了明文密钥就必须收紧到 600，否则密钥躺在 644 的文件里人人可读
  await writeFile(path, next, text === null ? { mode: 0o600 } : {})
  if (writesPlainKey(edit)) await chmod(path, 0o600)
  return readSettingsView(path)
}

/** 这次写操作会不会把明文密钥落盘（${环境变量} 形态不算） */
const writesPlainKey = (edit: SettingsEdit): boolean => {
  if (edit.op === 'firstSave' || edit.op === 'addProvider') return !ENV_REF.test(edit.apiKey)
  if (edit.op === 'editProvider') {
    const key = edit.apiKey ?? ''
    return key !== '' && !ENV_REF.test(key)
  }
  return false
}

/** 纯文本版写操作（不经 fs），测试直接喂字符串 */
export function applyEdit(text: string | null, path: string, edit: SettingsEdit): string {
  if (text === null) {
    if (edit.op !== 'firstSave') throw new Error(`${path} 不存在，只能用「保存并开始」建第一份配置`)
    return buildFirstFile(edit)
  }
  if (edit.op === 'firstSave') throw new Error(`${path} 已经存在，不能走首开表单——点齿轮进设置页改`)
  const root = parseRoot(text, path)
  if (typeof root === 'string') throw new Error(root)
  switch (edit.op) {
    case 'addProvider':
      return opAddProvider(text, root, edit)
    case 'addModel':
      return opAddModel(text, root, edit)
    case 'editModel':
      return opEditModel(text, root, edit)
    case 'deleteModel':
      return opDeleteModel(text, root, edit)
    case 'editProvider':
      return opEditProvider(text, root, edit)
    case 'setSide':
      return opSetSide(text, root, edit)
    case 'setRecall':
      return opSetRecall(text, edit)
  }
}

function opAddProvider(
  text: string,
  root: Record<string, unknown>,
  edit: Extract<SettingsEdit, { op: 'addProvider' }>,
): string {
  const name = validName(edit.name)
  if (asObject(root.providers)[name] !== undefined)
    throw new Error(`已有叫 ${name} 的服务商，换个名字，或在上面直接选它`)
  validProviderFields(edit.protocol, edit.baseUrl, edit.apiKey)
  const model = validModelName(edit.model)
  validWindow(edit.contextWindow)
  const body: Record<string, unknown> = {
    protocol: edit.protocol,
    baseUrl: edit.baseUrl.trim(),
    apiKey: edit.apiKey.trim(),
    models: { [model]: modelBody(edit.contextWindow, edit.images) },
  }
  return applyEdits(text, modify(text, ['providers', name], body, FMT))
}

function opAddModel(
  text: string,
  root: Record<string, unknown>,
  edit: Extract<SettingsEdit, { op: 'addModel' }>,
): string {
  const provider = mustProvider(root, edit.provider)
  const model = validModelName(edit.model)
  if (asObject(provider.models)[model] !== undefined)
    throw new Error(`${edit.provider} 下已经有叫 ${model} 的模型`)
  validWindow(edit.contextWindow)
  return applyEdits(
    text,
    modify(
      text,
      ['providers', edit.provider, 'models', model],
      modelBody(edit.contextWindow, edit.images),
      FMT,
    ),
  )
}

function opEditModel(
  text: string,
  root: Record<string, unknown>,
  edit: Extract<SettingsEdit, { op: 'editModel' }>,
): string {
  const provider = mustProvider(root, edit.provider)
  mustModel(provider, edit.model, edit.provider)
  validWindow(edit.contextWindow)
  const base = ['providers', edit.provider, 'models', edit.model]
  let out = applyEdits(text, modify(text, [...base, 'contextWindow'], edit.contextWindow, FMT))
  if (edit.images)
    out = applyEdits(out, modify(out, [...base, 'capabilities', 'images'], true, FMT))
  else {
    out = deleteKey(out, [...base, 'capabilities', 'images'])
    out = pruneEmpty(out, [...base, 'capabilities'])
  }
  if (edit.makeDefault) {
    out = applyEdits(out, modify(out, ['provider'], edit.provider, FMT))
    out = applyEdits(out, modify(out, ['model'], edit.model, FMT))
  }
  return out
}

function opDeleteModel(
  text: string,
  root: Record<string, unknown>,
  edit: Extract<SettingsEdit, { op: 'deleteModel' }>,
): string {
  const provider = mustProvider(root, edit.provider)
  mustModel(provider, edit.model, edit.provider)
  guardReferences(root, edit.provider, edit.model)
  // models 键是必填（providerSpec），删空了也留着 `{}`；想连服务商一起删
  // 去 settings.json 手删——那是「换服务商」级别的事，不归表单管
  return applyEdits(
    text,
    modify(text, ['providers', edit.provider, 'models', edit.model], undefined, FMT),
  )
}

function opEditProvider(
  text: string,
  root: Record<string, unknown>,
  edit: Extract<SettingsEdit, { op: 'editProvider' }>,
): string {
  mustProvider(root, edit.name)
  if (!(PROTOCOL_NAMES as string[]).includes(edit.protocol))
    throw new Error(`请选一个协议（可选：${PROTOCOL_NAMES.join(' / ')}）`)
  if (!/^https?:\/\/\S+$/.test(edit.baseUrl.trim()))
    throw new Error('Base URL 要以 http:// 或 https:// 开头')
  let out = applyEdits(text, modify(text, ['providers', edit.name, 'protocol'], edit.protocol, FMT))
  out = applyEdits(out, modify(out, ['providers', edit.name, 'baseUrl'], edit.baseUrl.trim(), FMT))
  // apiKey 空串/缺省 = 不改（表单「不改就留空」）
  if (edit.apiKey !== undefined && edit.apiKey.trim() !== '')
    out = applyEdits(out, modify(out, ['providers', edit.name, 'apiKey'], edit.apiKey.trim(), FMT))
  return out
}

function opSetSide(
  text: string,
  root: Record<string, unknown>,
  edit: Extract<SettingsEdit, { op: 'setSide' }>,
): string {
  const at: (string | number)[] =
    edit.key === 'visionModel' ? ['visionModel'] : ['memory', 'summaryModel']
  if (edit.value === null) {
    const out = deleteKey(text, at)
    return pruneEmpty(out, ...(edit.key === 'summaryModel' ? [['memory']] : []))
  }
  const provider = mustProvider(root, edit.value.provider)
  mustModel(provider, edit.value.model, edit.value.provider)
  // 只写这三个字段（webview 是不可信面，value 不整个落盘）；effort 显式带
  // 才写——设置页的推理档位下拉每次把当前档位一起发过来，换模型不丢
  const { effort } = edit.value
  if (effort !== undefined && !(SIDE_EFFORTS as readonly string[]).includes(effort))
    throw new Error(`推理档位只能选 ${SIDE_EFFORTS.join(' / ')}`)
  const ref = { provider: edit.value.provider, model: edit.value.model }
  return applyEdits(text, modify(text, at, effort === undefined ? ref : { ...ref, effort }, FMT))
}

function opSetRecall(text: string, edit: Extract<SettingsEdit, { op: 'setRecall' }>): string {
  if (!edit.on) {
    const out = deleteKey(text, ['recall', 'mode'])
    return pruneEmpty(out, ['recall'])
  }
  return applyEdits(text, modify(text, ['recall', 'mode'], 'on', FMT))
}

// ---------------------------------------------------------------- 字段校验

const validName = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('服务商名称必填')
  return trimmed
}

function mustProvider(root: Record<string, unknown>, name: string): Record<string, unknown> {
  const hit = asObject(root.providers)[name]
  if (hit === undefined) throw new Error(`没有叫 ${name} 的服务商`)
  return asObject(hit)
}

function mustModel(provider: Record<string, unknown>, model: string, providerName: string): void {
  if (asObject(provider.models)[model] === undefined)
    throw new Error(`${providerName} 下没有叫 ${model} 的模型`)
}

function validProviderFields(protocol: string, baseUrl: string, apiKey: string): void {
  if (!(PROTOCOL_NAMES as string[]).includes(protocol))
    throw new Error(`请选一个协议（可选：${PROTOCOL_NAMES.join(' / ')}）`)
  const u = baseUrl.trim()
  if (!/^https?:\/\/\S+$/.test(u)) throw new Error('Base URL 要以 http:// 或 https:// 开头')
  if (apiKey.trim() === '') throw new Error('API Key 必填')
}

const validModelName = (model: string): string => {
  const trimmed = model.trim()
  if (trimmed === '') throw new Error('模型名必填')
  return trimmed
}

function validWindow(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new Error('上下文窗口要填正整数（token）')
}

/** 被默认/看图/摘要/taskModels 引用的模型不让删——引用悬空会让下一次启动
 *  直接报错（taskModels 由 load.ts checkTaskModels 校验，11-18 实测删后起不来） */
function guardReferences(root: Record<string, unknown>, provider: string, model: string): void {
  const usedAs: string[] = []
  if (root.provider === provider && root.model === model) usedAs.push('默认模型')
  const vision = refOf(root.visionModel, root.provider)
  if (vision?.provider === provider && vision.model === model) usedAs.push('看图模型')
  const summary = refOf(asObject(root.memory).summaryModel, root.provider)
  if (summary?.provider === provider && summary.model === model) usedAs.push('摘要模型')
  const tasks = Array.isArray(root.taskModels) ? root.taskModels : []
  const inTasks = tasks.some((t) => {
    const o = asObject(t)
    return o.provider === provider && o.model === model
  })
  const why: string[] = []
  if (usedAs.length > 0) why.push(`它现在是${usedAs.join('、')}，先换成别的再删。`)
  if (inTasks) why.push('它在派任务模型 taskModels 里，先在 settings.json 删掉那一项再删。')
  if (why.length > 0) throw new Error(why.join(''))
}

/** 首开整份文件：结构同 README「快速开始」——过得了 strict schema 的最小集 */
function buildFirstFile(edit: Extract<SettingsEdit, { op: 'firstSave' }>): string {
  validProviderFields(edit.protocol, edit.baseUrl, edit.apiKey)
  const name = validName(edit.name)
  const model = validModelName(edit.model)
  validWindow(edit.contextWindow)
  const config = {
    provider: name,
    model,
    providers: {
      [name]: {
        protocol: edit.protocol,
        baseUrl: edit.baseUrl.trim(),
        apiKey: edit.apiKey.trim(),
        models: { [model]: modelBody(edit.contextWindow, edit.images) },
      },
    },
  }
  return `${JSON.stringify(config, null, 2)}\n`
}
