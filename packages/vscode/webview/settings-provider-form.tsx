import type { SettingsEdit, SettingsProviderView, SettingsView } from '@simple-code/core'
import { useState } from 'react'
import {
  ApiKeyInput,
  ErrorTail,
  Field,
  FormButtons,
  FormHead,
  keyText,
  ProtocolSelect,
} from './settings-shared.tsx'

/** 服务商编辑表单：协议 / Base URL / 密钥。改名不在表单里（删了重加模型同理） */
export function ProviderForm(props: {
  provider: SettingsProviderView | undefined
  view: SettingsView
  serverError: string | null
  busy: boolean
  onSave: (edit: SettingsEdit) => void
  onCancel: () => void
}) {
  // 状态只在真渲染时进子组件（hooks 不能有条件分支）
  if (props.provider === undefined) return null
  return <ProviderEditForm {...props} provider={props.provider} />
}

function ProviderEditForm({
  provider,
  view,
  serverError,
  busy,
  onSave,
  onCancel,
}: {
  provider: SettingsProviderView
  view: SettingsView
  serverError: string | null
  busy: boolean
  onSave: (edit: SettingsEdit) => void
  onCancel: () => void
}) {
  const [protocol, setProtocol] = useState(provider.protocol)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [err, setErr] = useState('')

  const save = (): void => {
    const urlErr = /^https?:\/\/\S+$/.test(baseUrl.trim()) ? '' : '要以 http:// 或 https:// 开头'
    setErr(urlErr)
    if (urlErr !== '') return
    onSave(editProviderOp(provider.name, protocol, baseUrl, apiKey))
  }

  return (
    <div className="page">
      <FormHead title={`编辑服务商 ${provider.name}`} onBack={onCancel} />
      <ProviderEditFields
        provider={provider}
        view={view}
        protocol={protocol}
        setProtocol={setProtocol}
        baseUrl={baseUrl}
        setBaseUrl={setBaseUrl}
        apiKey={apiKey}
        setApiKey={setApiKey}
        err={err}
      />
      <ErrorTail serverError={serverError} formError={err === '' ? undefined : err} />
      <FormButtons saveLabel="保存" busy={busy} onSave={save} onCancel={onCancel} />
    </div>
  )
}

/** 三个字段：协议 / Base URL / API Key（key 留空 = 不改） */
function ProviderEditFields({
  provider,
  view,
  protocol,
  setProtocol,
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  err,
}: {
  provider: SettingsProviderView
  view: SettingsView
  protocol: string
  setProtocol: (v: string) => void
  baseUrl: string
  setBaseUrl: (v: string) => void
  apiKey: string
  setApiKey: (v: string) => void
  err: string
}) {
  return (
    <>
      <Field label="协议" hint="改协议会影响这个服务商下的所有模型。">
        <ProtocolSelect value={protocol} onChange={setProtocol} protocols={view.protocols} />
      </Field>
      <Field label="Base URL" hint="写到 /v1 之前为止。" err={err === '' ? undefined : err}>
        <input
          type="text"
          className={err !== '' ? 'bad' : undefined}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </Field>
      <Field
        label="API Key"
        hint={`现在：${keyText(provider.apiKey)}。填了就替换，明文保存（写入后收紧到权限 600）；也可以填 $\{环境变量名}。`}
      >
        <ApiKeyInput value={apiKey} onChange={setApiKey} placeholder="不改就留空" />
      </Field>
    </>
  )
}

/** 服务商表单的写回操作；key 留空 = 不改 */
function editProviderOp(
  name: string,
  protocol: string,
  baseUrl: string,
  apiKey: string,
): SettingsEdit {
  return {
    op: 'editProvider',
    name,
    protocol,
    baseUrl: baseUrl.trim(),
    ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
  }
}
