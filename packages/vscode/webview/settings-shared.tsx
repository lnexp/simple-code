import type { SettingsApiKey, SettingsView } from '@simple-code/core'
import { type ReactNode, useState } from 'react'
import { Dropdown } from './settings-dropdown.tsx'

/**
 * 设置页家族的共享小件（settings.tsx / settings-list / settings-model-form /
 * settings-provider-form 都用）：类型、格式化、Field、协议下拉、密钥输入、
 * 表单按钮排。页面不读写文件——数据全来自宿主推的 SettingsView。
 */

export type SideRef = { provider: string; model: string } | null

export type Nav =
  | { view: 'settings' }
  | { view: 'model'; mode: 'new' }
  | { view: 'model'; mode: 'edit'; provider: string; model: string }
  | { view: 'provider'; provider: string }

/** 列表形态左栏的分区（settings-list.tsx SECTIONS） */
export type Section = 'models' | 'vision' | 'summary' | 'recall' | 'push' | 'robot'

/** 桌面机器人分区状态（robot_state 推来）。null = 还没推/非 mac，分区不显示 */
export type RobotState = { installed: boolean; on: boolean } | null

/** 模型表单里「新服务商…」选项的哨兵值 */
export const NEW_PROVIDER = '__new__'

/** README 快速开始里的示例值——表单 placeholder 与它一致 */
export const EX = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  contextWindow: '1000000',
}

export const kfmt = (n: number): string =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const host = (u: string): string => {
  try {
    return new URL(u).host
  } catch {
    return u
  }
}

export const keyText = (k: SettingsApiKey): string =>
  k.kind === 'env' ? `环境变量 ${k.name}` : k.kind === 'literal' ? '已填写（明文）' : '未填写'

/** 下拉的 value 用 JSON 数组——模型名允许含 `/`，拼接串要猜断点 */
export const refKey = (r: SideRef): string =>
  r === null ? '' : JSON.stringify([r.provider, r.model])

export function Field({
  label,
  children,
  hint,
  err,
}: {
  label: string
  children: ReactNode
  hint?: string | undefined
  err?: string | undefined
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {err !== undefined && err !== '' ? (
        <div className="err">{err}</div>
      ) : hint !== undefined ? (
        <div className="hint">{hint}</div>
      ) : null}
    </div>
  )
}

/** 新服务商表单里的协议下拉（服务商编辑表单也用） */
export function ProtocolSelect({
  value,
  onChange,
  protocols,
  bad,
}: {
  value: string
  onChange: (next: string) => void
  protocols: string[]
  bad?: string
}) {
  return (
    <Dropdown
      cls="protocol-picker"
      ariaLabel="协议"
      options={[
        { key: '', label: '请选择', payload: '' },
        ...protocols.map((p) => ({ key: p, label: p, payload: p })),
      ]}
      selectedKey={value}
      bad={bad !== undefined && bad !== ''}
      onPick={onChange}
    />
  )
}

/** 密钥输入框：password 形态 + 眼睛切换 */
export function ApiKeyInput({
  value,
  onChange,
  bad,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  bad?: string
  placeholder: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="pw">
      <input
        type={show ? 'text' : 'password'}
        className={bad !== undefined && bad !== '' ? 'bad' : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="icon-btn muted"
        title="显示/隐藏"
        onClick={() => setShow(!show)}
      >
        <span className={`codicon codicon-${show ? 'eye-closed' : 'eye'}`} />
      </button>
    </div>
  )
}

/** 表单底部按钮排：保存 / 取消 / （edit 模式）删除 */
export function FormButtons({
  saveLabel,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  saveLabel: string
  busy: boolean
  onSave: () => void
  onCancel?: () => void
  onDelete?: (() => void) | undefined
}) {
  return (
    <div className="btns">
      <button type="button" className="btn" disabled={busy} onClick={onSave}>
        {saveLabel}
      </button>
      {onCancel !== undefined && (
        <button type="button" className="btn secondary" onClick={onCancel}>
          取消
        </button>
      )}
      {onDelete !== undefined && (
        <button type="button" className="btn danger" disabled={busy} onClick={onDelete}>
          <span className="codicon codicon-trash" /> 删除模型
        </button>
      )}
    </div>
  )
}

/** 模型表单的全部状态（useModelFields 的返回形态，字段组组件收这个对象） */
export type ModelFields = ReturnType<typeof useModelFields>

/**
 * 模型表单状态：首开 / 添加 / 编辑三形态共用一份（编辑形态从视图预填）。
 * 校验与写回组装是纯函数（settings-model-form.tsx），这里只管状态
 */
export function useModelFields(
  mode: 'first' | 'new' | 'edit',
  initial: { provider: string; model: string } | undefined,
  view: SettingsView,
) {
  const edit = mode === 'edit'
  const editing = edit ? view.providers.find((p) => p.name === initial?.provider) : undefined
  const editingModel = editing?.models.find((m) => m.model === initial?.model)
  const wasDefault =
    view.defaultRef?.provider === initial?.provider && view.defaultRef?.model === initial?.model
  const [provider, setProvider] = useState(
    mode === 'first'
      ? NEW_PROVIDER
      : (initial?.provider ?? view.defaultRef?.provider ?? view.providers[0]?.name ?? NEW_PROVIDER),
  )
  const [np, setNp] = useState({ name: '', protocol: '', baseUrl: '', apiKey: '' })
  const [model, setModel] = useState(editingModel?.model ?? '')
  const [contextWindow, setContextWindow] = useState(
    editingModel === undefined ? '' : String(editingModel.contextWindow),
  )
  const [images, setImages] = useState(editingModel?.images ?? false)
  const [makeDefault, setMakeDefault] = useState(edit && wasDefault)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const bad = (k: string): string => errs[k] ?? ''
  return {
    view,
    edit,
    provider,
    setProvider,
    np,
    setNp,
    model,
    setModel,
    contextWindow,
    setContextWindow,
    images,
    setImages,
    makeDefault,
    setMakeDefault,
    errs,
    setErrs,
    bad,
    editing,
    editingModel,
    wasDefault,
    isNewProvider: provider === NEW_PROVIDER,
  }
}

/** 首开表单的欢迎头（代替缺配置时的红框报错） */
export function FirstWelcome({ path }: { path: string }) {
  return (
    <div className="welcome" style={{ marginTop: 8 }}>
      <div className="t">还没有配置模型</div>
      <div className="s">填好下面几项就能开始。也可以按 README「快速开始」手写 {path}。</div>
    </div>
  )
}

/** 表单页的头：返回按钮 + 标题 */
export function FormHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="page-head">
      <button type="button" className="icon-btn" title="返回设置" onClick={onBack}>
        <span className="codicon codicon-chevron-left" />
      </button>
      <span className="title">{title}</span>
    </div>
  )
}

/** 表单的错误尾：宿主回执错误与本地校验错误，各有就各显 */
export function ErrorTail({
  serverError,
  formError,
}: {
  serverError: string | null
  formError: string | undefined
}) {
  if (serverError === null && formError === undefined) return null
  return (
    <div className="field">
      <div className="err">{serverError ?? formError}</div>
    </div>
  )
}
