import type { SettingsEdit, SettingsView } from '@simple-code/core'
import {
  ModelAdvancedNote,
  ModelBasicFields,
  ModelChecks,
  NewProviderFields,
  ProviderPicker,
  ProviderSummary,
} from './settings-form-fields.tsx'
import {
  ErrorTail,
  FirstWelcome,
  FormButtons,
  FormHead,
  useModelFields,
} from './settings-shared.tsx'

/**
 * 模型表单：首开（mode=first，代替缺配置红框报错）/ 添加（new，可建新服务
 * 商）/ 编辑（edit，窗口、看图、设默认、删除）三形态。状态在
 * useModelFields（settings-shared.tsx），字段组在 settings-form-fields.tsx，
 * 校验与写回组装是本文件的纯函数。写回全走 onSave，由宿主校验落盘。
 */
export function ModelForm({
  mode,
  initial,
  view,
  serverError,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  mode: 'first' | 'new' | 'edit'
  initial?: { provider: string; model: string }
  view: SettingsView
  serverError: string | null
  busy: boolean
  onSave: (edit: SettingsEdit) => void
  onCancel: () => void
  /** 只在 edit 模式给：删除模型 */
  onDelete?: () => void
}) {
  if (mode === 'first')
    return (
      <FirstOpenForm
        view={view}
        serverError={serverError}
        busy={busy}
        onSave={onSave}
        onCancel={onCancel}
      />
    )
  return (
    <ModelEditForm
      mode={mode}
      initial={initial}
      view={view}
      serverError={serverError}
      busy={busy}
      onSave={onSave}
      onCancel={onCancel}
      onDelete={onDelete}
    />
  )
}

/** 首开表单：一个新服务商 + 它的第一个模型，保存并开始 */
function FirstOpenForm({
  view,
  serverError,
  busy,
  onSave,
}: {
  view: SettingsView
  serverError: string | null
  busy: boolean
  onSave: (edit: SettingsEdit) => void
  onCancel: () => void
}) {
  const f = useModelFields('first', undefined, view)
  const save = (): void => submitModelForm({ mode: 'first', view, f, onSave })
  return (
    <div className="page">
      <FirstWelcome path={view.path} />
      <NewProviderFields f={f} protocols={view.protocols} />
      <ModelBasicFields f={f} edit={false} />
      <ModelChecks f={f} showDefault={false} defaultLocked={false} />
      <ErrorTail serverError={serverError} formError={f.errs.form} />
      <FormButtons saveLabel="保存并开始" busy={busy} onSave={save} />
      <div className="foot">保存后写入 {view.path}</div>
    </div>
  )
}

/** 添加 / 编辑表单：选服务商（或新服务商）+ 模型字段 + 默认/删除 */
function ModelEditForm({
  mode,
  initial,
  view,
  serverError,
  busy,
  onSave,
  onCancel,
  onDelete,
}: {
  mode: 'new' | 'edit'
  initial: { provider: string; model: string } | undefined
  view: SettingsView
  serverError: string | null
  busy: boolean
  onSave: (edit: SettingsEdit) => void
  onCancel: () => void
  onDelete: (() => void) | undefined
}) {
  const f = useModelFields(mode, initial, view)
  const save = (): void => submitModelForm({ mode, view, f, onSave })
  // 删除前的引用检查（宿主侧还有一遍——webview 是不可信面）
  const deleteIt = (): void => requestDelete(view, f, onDelete)
  return (
    <div className="page">
      <FormHead title={f.edit ? `编辑 ${initial?.model}` : '添加模型'} onBack={onCancel} />
      <ProviderPicker f={f} edit={f.edit} />
      {f.isNewProvider ? (
        <NewProviderFields f={f} protocols={view.protocols} />
      ) : (
        f.editing !== undefined && <ProviderSummary provider={f.editing} />
      )}
      <ModelBasicFields f={f} edit={f.edit} />
      <ModelChecks f={f} showDefault defaultLocked={f.edit && f.wasDefault} />
      <ModelAdvancedNote m={f.editingModel} />
      <ErrorTail serverError={serverError} formError={f.errs.form} />
      <FormButtons
        saveLabel="保存"
        busy={busy}
        onSave={save}
        onCancel={onCancel}
        onDelete={f.edit ? deleteIt : undefined}
      />
    </div>
  )
}

// ---------------------------------------------------------------- 纯函数

/** 校验并提交：不过就停在原地标错误，过就组装写回操作交给 onSave */
function submitModelForm({
  mode,
  view,
  f,
  onSave,
}: {
  mode: 'first' | 'new' | 'edit'
  view: SettingsView
  f: ReturnType<typeof useModelFields>
  onSave: (edit: SettingsEdit) => void
}): void {
  const found = validateForm({ view, f })
  if (Object.keys(found).length > 0) {
    f.setErrs(found)
    return
  }
  onSave(buildOp({ mode, view, f }))
}

/** 删除前的引用检查（宿主侧还有一遍——webview 是不可信面） */
function requestDelete(
  view: SettingsView,
  f: ReturnType<typeof useModelFields>,
  onDelete: (() => void) | undefined,
): void {
  const blockers = refBlockers(view, f.provider, f.model)
  if (blockers.length > 0) {
    f.setErrs({ form: `它现在是${blockers.join('、')}，先换成别的再删。` })
    return
  }
  onDelete?.()
}

/** 表单校验：返回 错误字段 → 文案；空对象 = 过 */
function validateForm({
  view,
  f,
}: {
  view: SettingsView
  f: ReturnType<typeof useModelFields>
}): Record<string, string> {
  const e: Record<string, string> = {}
  const edit = f.editingModel !== undefined
  const name = f.np.name.trim()
  if (f.isNewProvider) {
    if (name === '') e.name = '必填'
    else if (view.providers.some((p) => p.name === name))
      e.name = `已有叫 ${name} 的服务商，换个名字，或在上面直接选它`
    if (f.np.protocol === '') e.protocol = '请选一个协议'
    if (f.np.baseUrl.trim() === '') e.baseUrl = '必填'
    else if (!/^https?:\/\/\S+$/.test(f.np.baseUrl.trim()))
      e.baseUrl = '要以 http:// 或 https:// 开头'
    if (f.np.apiKey.trim() === '') e.apiKey = '必填'
  }
  if (f.model.trim() === '') e.model = '必填'
  else if (
    !edit &&
    view.providers
      .find((p) => p.name === (f.isNewProvider ? name : f.provider))
      ?.models.some((x) => x.model === f.model.trim())
  )
    e.model = `${f.isNewProvider ? name : f.provider} 下已经有 ${f.model.trim()}`
  if (f.contextWindow === '') e.contextWindow = '必填'
  else if (!/^\d+$/.test(f.contextWindow.trim()) || Number(f.contextWindow) <= 0)
    e.contextWindow = '要填正整数'
  return e
}

/** 把表单状态组装成写回操作（首开/新服务商/加模型/编辑四种） */
function buildOp({
  mode,
  f,
}: {
  mode: 'first' | 'new' | 'edit'
  view: SettingsView
  f: ReturnType<typeof useModelFields>
}): SettingsEdit {
  const common = { model: f.model.trim(), contextWindow: Number(f.contextWindow), images: f.images }
  const newProv = {
    name: f.np.name.trim(),
    protocol: f.np.protocol,
    baseUrl: f.np.baseUrl.trim(),
    apiKey: f.np.apiKey.trim(),
  }
  if (mode === 'first') return { op: 'firstSave', ...newProv, ...common }
  if (f.isNewProvider) return { op: 'addProvider', ...newProv, ...common }
  if (mode === 'new') return { op: 'addModel', provider: f.provider, ...common }
  return {
    op: 'editModel',
    provider: f.provider,
    model: f.model.trim(),
    contextWindow: Number(f.contextWindow),
    images: f.images,
    makeDefault: f.makeDefault,
  }
}

/** 删除前的引用检查（宿主侧还有一遍——webview 是不可信面） */
function refBlockers(view: SettingsView, provider: string, model: string): string[] {
  const m = model.trim()
  const usedAs: string[] = []
  if (view.defaultRef?.provider === provider && view.defaultRef.model === m) usedAs.push('默认模型')
  if (view.visionModel?.provider === provider && view.visionModel.model === m)
    usedAs.push('看图模型')
  if (view.summaryModel?.provider === provider && view.summaryModel.model === m)
    usedAs.push('摘要模型')
  return usedAs
}
