import type { SettingsProviderView } from '@simple-code/core'
import { Dropdown } from './settings-dropdown.tsx'
import {
  ApiKeyInput,
  EX,
  Field,
  host,
  keyText,
  type ModelFields,
  NEW_PROVIDER,
  ProtocolSelect,
} from './settings-shared.tsx'

/**
 * 模型表单的字段组（settings-model-form.tsx 用）。都是受控展示件，
 * 状态在 useModelFields（settings-shared.tsx），校验在 ModelForm 那侧。
 */

/** 新服务商的四项：名称 / 协议 / Base URL / API Key */
export function NewProviderFields({ f, protocols }: { f: ModelFields; protocols: string[] }) {
  return (
    <>
      <ProviderIdentityFields f={f} protocols={protocols} />
      <ProviderAccessFields f={f} />
    </>
  )
}

/** 服务商身份：名称 + 协议 */
function ProviderIdentityFields({ f, protocols }: { f: ModelFields; protocols: string[] }) {
  return (
    <>
      <Field label="服务商名称" hint="自己起的名字，只用来区分。" err={f.bad('name')}>
        <input
          type="text"
          className={f.bad('name') ? 'bad' : undefined}
          placeholder={`如 ${EX.provider}`}
          value={f.np.name}
          onChange={(e) => f.setNp({ ...f.np, name: e.target.value })}
        />
      </Field>
      <Field
        label="协议"
        hint="「兼容 OpenAI 接口」的服务选 openai-chat；Anthropic 官方或兼容网关选 anthropic-messages。"
        err={f.bad('protocol')}
      >
        <ProtocolSelect
          value={f.np.protocol}
          onChange={(protocol) => f.setNp({ ...f.np, protocol })}
          protocols={protocols}
          bad={f.bad('protocol')}
        />
      </Field>
    </>
  )
}

/** 服务商接入：Base URL + API Key（明文密钥写回后文件收紧到 600） */
function ProviderAccessFields({ f }: { f: ModelFields }) {
  return (
    <>
      <Field
        label="Base URL"
        hint="写到 /v1 之前为止，SC 自己拼后面的路径。"
        err={f.bad('baseUrl')}
      >
        <input
          type="text"
          className={f.bad('baseUrl') ? 'bad' : undefined}
          placeholder={`如 ${EX.baseUrl}`}
          value={f.np.baseUrl}
          onChange={(e) => f.setNp({ ...f.np, baseUrl: e.target.value })}
        />
      </Field>
      <Field
        label="API Key"
        hint="明文保存在 settings.json，文件权限设为仅本人可读（600）。也可以填 ${环境变量名}，从环境变量读。"
        err={f.bad('apiKey')}
      >
        <ApiKeyInput
          value={f.np.apiKey}
          onChange={(apiKey) => f.setNp({ ...f.np, apiKey })}
          bad={f.bad('apiKey')}
          placeholder="sk-…"
        />
      </Field>
    </>
  )
}

/** 选中已有服务商时的一行摘要（协议 · host · 密钥形态） */
export function ProviderSummary({ provider }: { provider: SettingsProviderView }) {
  return (
    <div className="field">
      <div className="readonly">
        <b>{provider.protocol}</b> · {host(provider.baseUrl)} · 密钥 {keyText(provider.apiKey)}
      </div>
    </div>
  )
}

/** 服务商选择下拉（edit 模式锁死；new 模式可选「新服务商…」） */
export function ProviderPicker({ f, edit }: { f: ModelFields; edit: boolean }) {
  return (
    <Field label="服务商" {...(edit ? { hint: '要换服务商，删掉后在那边重新添加。' } : {})}>
      <Dropdown
        cls="provider-picker"
        ariaLabel="服务商"
        options={[
          ...f.view.providers.map((p) => ({ key: p.name, label: p.name, payload: p.name })),
          { key: NEW_PROVIDER, label: '新服务商…', payload: NEW_PROVIDER },
        ]}
        selectedKey={f.provider}
        disabled={edit}
        onPick={f.setProvider}
      />
    </Field>
  )
}

/** 模型名 + 上下文窗口 */
export function ModelBasicFields({ f, edit }: { f: ModelFields; edit: boolean }) {
  return (
    <>
      <Field
        label="模型名"
        hint={edit ? '改名请删掉后重新添加。' : '服务商文档里的模型 ID，原样填。'}
        err={f.bad('model')}
      >
        <input
          type="text"
          className={f.bad('model') ? 'bad' : undefined}
          placeholder={`如 ${EX.model}`}
          value={f.model}
          disabled={edit}
          onChange={(e) => f.setModel(e.target.value)}
        />
      </Field>
      <Field
        label="上下文窗口"
        hint="单位 token，查服务商文档。上下文快满时按它卸载旧对话。"
        err={f.bad('contextWindow')}
      >
        <input
          type="number"
          className={f.bad('contextWindow') ? 'bad' : undefined}
          placeholder={`如 ${EX.contextWindow}`}
          value={f.contextWindow}
          onChange={(e) => f.setContextWindow(e.target.value)}
        />
      </Field>
    </>
  )
}

/** 能看图 + 设为默认 两个勾选框 */
export function ModelChecks({
  f,
  showDefault,
  defaultLocked,
}: {
  f: ModelFields
  /** 首开表单没有「设默认」（第一个模型天然是默认） */
  showDefault: boolean
  /** edit 且它已是默认：勾死了 */
  defaultLocked: boolean
}) {
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={f.images} onChange={(e) => f.setImages(e.target.checked)} />
        <span>
          能看图<span className="hint">模型支持图片输入才勾。不勾时按不支持处理。</span>
        </span>
      </label>
      {showDefault && (
        <label className="check">
          <input
            type="checkbox"
            checked={f.makeDefault}
            disabled={defaultLocked}
            onChange={(e) => f.setMakeDefault(e.target.checked)}
          />
          <span>
            设为默认模型
            <span className="hint">
              {defaultLocked
                ? '它就是默认模型。要换默认，去别的模型那里勾。'
                : '启动时用它。底栏下拉里随时可以换。'}
            </span>
          </span>
        </label>
      )}
    </>
  )
}

/** 高级参数提示条（表单不动那些字段，原样保留）；模型没带高级字段就不渲染 */
export function ModelAdvancedNote({
  m,
}: {
  m: SettingsProviderView['models'][number] | undefined
}) {
  if (m === undefined || m.advanced.length === 0) return null
  return (
    <div className="adv">
      这个模型还有 {m.advanced.join('、')}，保存时原样保留。要改请打开 settings.json。
    </div>
  )
}
