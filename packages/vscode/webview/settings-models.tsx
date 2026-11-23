import type { SettingsProviderView, SettingsView } from '@simple-code/core'
import { host, keyText, kfmt, type Nav } from './settings-shared.tsx'

/**
 * 设置页「模型」分区：服务商分卡的模型清单 + 添加入口（从 settings-list.tsx
 * 拆出，2026-11-17 左右两栏改版）。点模型行/服务商铅笔跳表单，Nav 由
 * SettingsPage 持有。
 */

/** 「模型」分区：服务商卡片 + 添加入口 */
export function ModelSection({ view, onNav }: { view: SettingsView; onNav: (nav: Nav) => void }) {
  return (
    <>
      <div className="sec">模型</div>
      {view.providers.map((p) => (
        <ProviderCard
          key={p.name}
          provider={p}
          isDefault={(pr, m) => view.defaultRef?.provider === pr && view.defaultRef.model === m}
          onEdit={(provider, model) => onNav({ view: 'model', mode: 'edit', provider, model })}
          onEditProvider={(provider) => onNav({ view: 'provider', provider })}
        />
      ))}
      <div className="add-row">
        <button
          type="button"
          className="icon-btn"
          onClick={() => onNav({ view: 'model', mode: 'new' })}
        >
          <span className="codicon codicon-add" />
          添加模型
        </button>
      </div>
    </>
  )
}

function ProviderCard({
  provider,
  isDefault,
  onEdit,
  onEditProvider,
}: {
  provider: SettingsProviderView
  isDefault: (p: string, m: string) => boolean
  onEdit: (provider: string, model: string) => void
  onEditProvider: (provider: string) => void
}) {
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="prov-head">
        <span className="name">{provider.name}</span>
        <span className="meta">
          {provider.protocol} · {host(provider.baseUrl)}
        </span>
        <button
          type="button"
          className="icon-btn muted"
          title="编辑服务商（协议、地址、密钥）"
          onClick={() => onEditProvider(provider.name)}
        >
          <span className="codicon codicon-edit" />
        </button>
      </div>
      <div className="prov-key">密钥：{keyText(provider.apiKey)}</div>
      {provider.models.map((m) => (
        <ModelRow
          key={m.model}
          m={m}
          isDefault={isDefault(provider.name, m.model)}
          onEdit={() => onEdit(provider.name, m.model)}
        />
      ))}
    </div>
  )
}

function ModelRow({
  m,
  isDefault,
  onEdit,
}: {
  m: SettingsProviderView['models'][number]
  isDefault: boolean
  onEdit: () => void
}) {
  return (
    <button type="button" className="row" title="编辑" onClick={onEdit}>
      <span className="name">{m.model}</span>
      {m.advanced.length > 0 && (
        <span className="num" title={m.advanced.join('、')}>
          高级参数
        </span>
      )}
      {m.images && <span className="codicon codicon-eye" title="能看图" aria-label="能看图" />}
      {isDefault && <span className="badge">默认</span>}
      <span className="num">{kfmt(m.contextWindow)}</span>
      <span className="codicon codicon-edit" />
    </button>
  )
}
