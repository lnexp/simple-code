import { useEffect } from 'react'
import { fmtTok } from './events.ts'
import type { RegionsInfo } from '../src/protocol.ts'

/**
 * 上下文分析面板（方案 A，2026-09-11 拍板）：点底栏「上下文 X」弹出，
 * 显示一次请求的分区快照。数据来自 regions.jsonl 尾行（按需拉取，不常驻）。
 *
 * 不用 Menu 组件：那是单选菜单（menuitemradio 语义），这里是纯展示面板。
 * 交互就三条：Esc 关、点遮罩关、点条目无操作。
 */
export function ContextPanel({
  info: raw,
  pending,
  onClose,
}: {
  info: RegionsInfo | null
  /** 点击后、regions 消息回来前——有上一份也先标「取数中」 */
  pending: boolean
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const info = raw && calibrate(raw)
  const body =
    info === null ? (
      <div className="ctx-empty">{pending ? '取数中…' : '还没有记录——跑一轮对话后可看'}</div>
    ) : (
      <>
        <div className="ctx-head">
          <div className="ctx-title">上下文分析</div>
          <div className="ctx-sub">
            {fmtTok(info.contextWindow)} 窗口 · 用 <b>{pct(usedOf(info), info.contextWindow)}</b>
            {raw && !isCalibrated(raw) && '（估算）'}
            <span className="ctx-at">{fmtAt(info.at)}</span>
          </div>
        </div>
        {/* 总览堆叠条：各区按**真实比例**依次排开，剩下露出的底色就是空闲。
            旧版每行一根 `min(pct,8)*4` 的短条是错的——70% 的空闲和 8.5%
            的未卸载画出来一样长，看图得到的结论是反的。空闲不进堆叠
            （它就是轨道本身），所以这里过滤掉 */}
        <div className="ctx-stack">
          {rowsOf(info)
            .filter((r) => r.label !== '空闲')
            .map((r) => (
              <span key={r.label} style={{ width: `${r.pct}%`, background: r.color }} />
            ))}
        </div>
        <div className="ctx-list">
          {rowsOf(info).map((r) => (
            <div className="ctx-row" key={r.label}>
              <i className="ctx-dot" style={{ background: r.color }} />
              <span className="ctx-label">{r.label}</span>
              <span className="ctx-num">{fmtTok(r.tokens)}</span>
              <span className="ctx-pct">{r.pctText}</span>
            </div>
          ))}
        </div>
      </>
    )
  return (
    <div className="ctx-mask" onClick={onClose} role="presentation">
      <div
        className="ctx-panel"
        role="dialog"
        aria-label="上下文分析"
        onClick={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  )
}

type Row = {
  label: string
  tokens: number
  pct: number
  pctText: string
  /** 色点/堆叠段的颜色。**全部走 VS Code 图表色变量**，换主题自动跟随
   *  （style.ts 顶部的硬规则）；回落色只在变量缺失时生效 */
  color: string
}

function rowsOf(info: RegionsInfo): Row[] {
  const w = info.contextWindow
  const row = (label: string, tokens: number, color: string): Row => ({
    label,
    tokens,
    pct: (tokens / w) * 100,
    pctText: `${((tokens / w) * 100).toFixed(1)}%`,
    color,
  })
  const used = usedOf(info)
  const idle = Math.max(w - used, 0)
  return [
    row('system+tools', info.overhead, 'var(--vscode-descriptionForeground, #8a8a8a)'),
    row('冷区', info.cold, 'var(--vscode-charts-blue, #3794ff)'),
    row('温区', info.warm, 'var(--vscode-charts-purple, #b180d7)'),
    row('热区', info.hot, 'var(--vscode-charts-orange, #d18616)'),
    row('已卸载', info.stub, 'var(--vscode-charts-yellow, #cca700)'),
    row('未卸载', info.live, 'var(--vscode-charts-green, #89d185)'),
    // 不可卸与未卸载同属「原文」，配同族色：绿混蓝得青，既区分又不割裂。
    // 直接用 charts-foreground 会撞上 system+tools 的灰（实测近白）
    row('不可卸', info.floor, 'var(--ctx-teal)'),
    // 输出预留用粉而不是正红：红在这套 UI 里是「停止/报警」，预留是常态
    row('输出预留', info.maxTokens, 'var(--ctx-pink)'),
    row('空闲', idle, 'var(--ctx-idle)'),
  ]
}

const usedOf = (info: RegionsInfo): number =>
  info.overhead + info.cold + info.warm + info.hot + info.stub + info.floor + info.live + info.maxTokens

const REGION_KEYS = ['overhead', 'cold', 'warm', 'hot', 'stub', 'floor', 'live'] as const
const estimateOf = (info: RegionsInfo): number => REGION_KEYS.reduce((sum, key) => sum + info[key], 0)

/**
 * 各区按真实 usage 同比例缩放（2026-09-29 拍板）。估算器是字符密度法，
 * 各家模型切分不同，怎么调都校不准；usage 是这个模型对这一份请求的真账，
 * 只是不分区——所以总量取 usage、比例取估算。输出预留是配置值，不缩
 */
export function calibrate(info: RegionsInfo): RegionsInfo {
  const est = estimateOf(info)
  if (info.real === null || est <= 0) return info
  const k = info.real / est
  const out = { ...info }
  for (const key of REGION_KEYS) out[key] = info[key] * k
  return out
}

/**
 * 只在**没校准**时标「（估算）」（2026-09-29 拍板方案 2）：平时校准过是常态，
 * 不占位置；失败的尝试、渠道不报 usage、老记录才退回估算，数字偏小，提示一下
 */
const isCalibrated = (raw: RegionsInfo): boolean => raw.real !== null && estimateOf(raw) > 0

const pct = (used: number, window_: number): string => `${((used / window_) * 100).toFixed(1)}%`

const fmtAt = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
