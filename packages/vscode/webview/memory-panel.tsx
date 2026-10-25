import { useEffect } from 'react'
import type { MemoryStats } from '@simple-code/core'
import type { TaskState } from '../src/protocol.ts'

/** 色彩纪律同 ctx-panel（style.ts 顶部硬规则）：全部走 VS Code charts
 *  色变量，换主题自动跟随；回落色只在变量缺失时生效。
 *  条形图只讲体量：四个库一条一个、长度按总数等比（t172245 拍板，
 *  推翻堆叠可见性条 + 四元组行——信息全但乱，没有整体概念） */
export function MemoryPanel({
  stats,
  reflectTask,
  busy,
  error,
  onStart,
  onReopen,
  onView,
  onClose,
}: {
  stats: MemoryStats | null
  reflectTask: TaskState | null
  /** 主任务跑轮中——开不了新任务 */
  busy: boolean
  /** dispatch 失败的理由（受理成功面板就关了，看不到） */
  error: string | null
  onStart: () => void
  onReopen: () => void
  onView: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // closing 也算「反思中」：正在收尾，既不能看报告也不能关
  const running =
    reflectTask !== null && (reflectTask.status === 'running' || reflectTask.status === 'closing')
  const present = reflectTask !== null && !running
  // 同上下文面板：一根整条按四库条数分段，下面每库一行只给总数与占比
  const libs =
    stats === null
      ? []
      : [
          { label: 'note', color: NOTE, n: stats.notes.total },
          { label: 'lesson', color: LESSON, n: stats.lessons.total },
          { label: 'event', color: EVENT, n: stats.events.total },
          { label: 'skill', color: TEAL, n: stats.skills },
        ]
  const total = libs.reduce((s, l) => s + l.n, 0)
  const pct = (n: number): number => (total > 0 ? (n / total) * 100 : 0)

  const action =
    running ? (
      <button type="button" className="ctx-compact" disabled>
        反思中…
      </button>
    ) : busy ? (
      <button type="button" className="ctx-compact" disabled title="主任务运行中，等这轮跑完">
        主任务运行中
      </button>
    ) : present ? (
      <span className="mem-choice">
        <button type="button" className="ctx-compact" onClick={onView}>
          去查看
        </button>
        <button
          type="button"
          className="ctx-compact"
          onClick={onReopen}
          title="关掉挂着的反思任务、起新的一次（跳过上次报告的过目）"
        >
          关闭并重开
        </button>
      </span>
    ) : (
      <button
        type="button"
        className="ctx-compact"
        onClick={onStart}
        title="以任务形态跑一次记忆整理（内置指令，后台执行，报告后挂起待过目）"
      >
        反思
      </button>
    )

  return (
    <div className="ctx-mask" onClick={onClose} role="presentation">
      <div
        className="ctx-panel"
        role="dialog"
        aria-label="记忆"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ctx-head">
          <div className="ctx-title-row">
            <div className="ctx-title">记忆</div>
            {action}
          </div>
          <div className="ctx-sub">
            {stats === null
              ? '取数中…'
              : `共 ${total} 条 · 上次反思 ${
                  stats.lastReflect !== null
                    ? `${stats.lastReflect.date} · ${stats.lastReflect.theme}`
                    : '还没跑过'
                }`}
          </div>
        </div>
        {stats === null ? (
          <div className="ctx-empty">{error ?? '取数中…'}</div>
        ) : (
          <>
            <div className="ctx-stack">
              {libs.map((l) =>
                l.n > 0 ? (
                  <span key={l.label} style={{ width: `${pct(l.n)}%`, background: l.color }} />
                ) : null,
              )}
            </div>
            <div className="ctx-list">
              {libs.map((l) => (
                <div className="ctx-row" key={l.label}>
                  <i className="ctx-dot" style={{ background: l.color }} />
                  <span className="ctx-label">{l.label}</span>
                  <span className="ctx-num">{l.n}</span>
                  <span className="ctx-pct">{Math.round(pct(l.n))}%</span>
                </div>
              ))}
            </div>
            <div className="ctx-hint">另有 summary {stats.summaries} 份（盘上档案，不进常驻）</div>
            {error !== null && <div className="ctx-hint">{error}</div>}
          </>
        )}
      </div>
    </div>
  )
}

/** 库身份色 */
const NOTE = 'var(--vscode-charts-blue, #3794ff)'
const LESSON = 'var(--vscode-charts-purple, #b180d7)'
const EVENT = 'var(--vscode-charts-orange, #d18616)'
const TEAL = 'var(--ctx-teal)'
