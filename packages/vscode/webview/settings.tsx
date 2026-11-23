import type { SettingsEdit, SettingsView } from '@simple-code/core'
import { useEffect, useState } from 'react'
import type { GatewayCheck } from '../src/protocol.ts'
import { SettingsMain } from './settings-list.tsx'
import { ModelForm } from './settings-model-form.tsx'
import { ProviderForm } from './settings-provider-form.tsx'
import type { Nav, RobotState, Section } from './settings-shared.tsx'

/**
 * 设置页（2026-11-17 原型放行，.simple-code/tmp/settings-page-proto/）的
 * 对外入口——App 只 import 这一个。家族分文件：路由在本文（SettingsPage），
 * 列表 settings-list.tsx（左右两栏框架）+ settings-models.tsx（模型分区）+
 * settings-side.tsx（看图/摘要/记忆线索分区）、模型表单 settings-model-form.tsx、字段组
 * settings-form-fields.tsx、服务商表单 settings-provider-form.tsx、
 * 共享件 settings-shared.tsx。
 *
 * 页面自己**不读写文件**：数据全来自宿主推的 SettingsView，写全走
 * onWrite（宿主逐条校验后写回，回 settings_result）。首开保存成功后
 * view.missing 翻成 false，App 换回对话视图——这里不用管。
 */
type SettingsPageProps = {
  view: SettingsView
  /** 宿主写回的结果。nonce 每次写回 +1，0 = 还没写过 */
  result: { nonce: number; ok: boolean; error: string | null }
  busy: boolean
  onWrite: (edit: SettingsEdit) => void
  onOpenFile: () => void
  /** 飞书推送开关（不在 settings.json 里，不走 onWrite）；null = 网关没启用 */
  push: boolean | null
  onPush: (on: boolean) => void
  /** 飞书推送分区的检测卡（2026-11-18） */
  larkCli: string | null
  check: GatewayCheck | null
  checking: boolean
  onCheck: () => void
  /** 桌面机器人分区（2026-11-18）：null = 非 mac，不显示 */
  robot: RobotState
  onRobot: (on: boolean) => void
  onRobotInstall: () => void
  onBack: () => void
}

export function SettingsPage(props: SettingsPageProps) {
  const { view, result, busy, onWrite, onOpenFile, push, onPush, onBack } = props
  const { larkCli, check, checking, onCheck } = props
  const { robot, onRobot, onRobotInstall } = props
  const [nav, setNav] = useState<Nav>({ view: 'settings' })
  const [section, setSection] = useState<Section>('models')

  // 写回成功：表单回列表（首开模式由 App 换页面）；失败停在原地，
  // error 由各形态自己展示
  useEffect(() => {
    if (result.nonce === 0 || !result.ok) return
    setNav({ view: 'settings' })
  }, [result.nonce, result.ok])

  const serverError = result.nonce === 0 || result.ok ? null : result.error
  if (view.error !== null) return <SettingsError view={view} onOpenFile={onOpenFile} />
  if (view.missing)
    return (
      <ModelForm
        mode="first"
        view={view}
        serverError={serverError}
        busy={busy}
        onSave={onWrite}
        onCancel={onBack}
      />
    )
  return nav.view === 'settings' ? (
    <SettingsMain
      view={view}
      section={section}
      busy={busy}
      serverError={serverError}
      onSection={setSection}
      onWrite={onWrite}
      push={push}
      onPush={onPush}
      larkCli={larkCli}
      robot={robot}
      onRobot={onRobot}
      onRobotInstall={onRobotInstall}
      check={check}
      checking={checking}
      onCheck={onCheck}
      onNav={setNav}
      onBack={onBack}
      onOpenFile={onOpenFile}
    />
  ) : (
    <NavForms
      nav={nav}
      view={view}
      serverError={serverError}
      busy={busy}
      onWrite={onWrite}
      onBackToList={() => setNav({ view: 'settings' })}
    />
  )
}

/** 表单形态的分支（nav 指到模型/服务商表单时） */
function NavForms({
  nav,
  view,
  serverError,
  busy,
  onWrite,
  onBackToList,
}: {
  nav: Nav & { view: 'model' | 'provider' }
  view: SettingsView
  serverError: string | null
  busy: boolean
  onWrite: (edit: SettingsEdit) => void
  onBackToList: () => void
}) {
  if (nav.view === 'provider')
    return (
      <ProviderForm
        provider={view.providers.find((p) => p.name === nav.provider)}
        view={view}
        serverError={serverError}
        busy={busy}
        onSave={onWrite}
        onCancel={onBackToList}
      />
    )
  return (
    <ModelForm
      mode={nav.mode}
      {...(nav.mode === 'edit'
        ? {
            initial: { provider: nav.provider, model: nav.model },
            onDelete: () =>
              onWrite({ op: 'deleteModel', provider: nav.provider, model: nav.model }),
          }
        : {})}
      view={view}
      serverError={serverError}
      busy={busy}
      onSave={onWrite}
      onCancel={onBackToList}
    />
  )
}

/** view.error = 文件读得了但不是合法 JSON：设置页改不了，给兜底态 */
function SettingsError({ view, onOpenFile }: { view: SettingsView; onOpenFile: () => void }) {
  return (
    <div className="page">
      <div className="page-head">
        <span className="title">设置</span>
        <button type="button" className="icon-btn muted" onClick={onOpenFile}>
          <span className="codicon codicon-go-to-file" />
          settings.json
        </button>
      </div>
      <div className="field">
        <div className="err">{view.error}</div>
        <div className="hint">修好后回到这里再点齿轮；对话不受影响（用的还是上次能跑的配置）。</div>
      </div>
    </div>
  )
}
