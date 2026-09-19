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
  info,
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

  const body =
    info === null ? (
      <div className="ctx-empty">{pending ? '取数中…' : '还没有记录——跑一轮对话后可看'}</div>
    ) : (
      <>
        <div className="ctx-head">
          上下文分析 · {fmtTok(info.contextWindow)} 窗口 · 用 {pct(usedOf(info), info.contextWindow)}
          <span className="ctx-at">{fmtAt(info.at)}</span>
        </div>
        <table className="ctx-table">
          <tbody>
            {rowsOf(info).map((r) => (
              <tr key={r.label}>
                <td className="ctx-label">{r.label}</td>
                <td className="ctx-num">{fmtTok(r.tokens)}</td>
                <td className="ctx-pct">{r.pctText}</td>
                <td className="ctx-range">{r.range}</td>
                <td className="ctx-bar">
                  <span style={{ width: `${Math.min(r.pct, 8) * 4}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

type Row = { label: string; tokens: number; pct: number; pctText: string; range: string }

function rowsOf(info: RegionsInfo): Row[] {
  const w = info.contextWindow
  const row = (label: string, tokens: number, range = ''): Row => ({
    label,
    tokens,
    pct: (tokens / w) * 100,
    pctText: `${((tokens / w) * 100).toFixed(1)}%`,
    range,
  })
  // 范围列：step 闭区间，纯数字（用户拍板：不要条数、不要单位字样）。
  // 摘要的 covers 是「顶替掉的 step」，live 三类是「消息所在 step」，
  // 同一 step 轴；未卸载/已卸载区间重叠是语义使然（同一 live 段两种状态）
  const fmtRange = (x: { from: number; to: number } | null | undefined) =>
    !x ? '' : x.from === x.to ? `${x.from}` : `${x.from}–${x.to}`
  const used = usedOf(info)
  const idle = Math.max(w - used, 0)
  const g = info.ranges
  return [
    row('system+tools', info.overhead, '0'),
    row('冷区', info.cold, fmtRange(g?.cold)),
    row('温区', info.warm, fmtRange(g?.warm)),
    row('热区', info.hot, fmtRange(g?.hot)),
    row('已卸载', info.stub, fmtRange(g?.stub)),
    row('未卸载', info.live, fmtRange(g?.live)),
    row('不可卸', info.floor, fmtRange(g?.floor)),
    row('输出预留', info.maxTokens),
    row('空闲', idle),
  ]
}

const usedOf = (info: RegionsInfo): number =>
  info.overhead + info.cold + info.warm + info.hot + info.stub + info.floor + info.live + info.maxTokens

const pct = (used: number, window_: number): string => `${((used / window_) * 100).toFixed(1)}%`

const fmtAt = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
