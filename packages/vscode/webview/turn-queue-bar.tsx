import type { TurnQueueView } from '../src/protocol.ts'

/**
 * 排队发送的列表（docs/proposals/queued-sends.md）：输入框上方，只显示当前
 * 选中目标（主任务或某任务）的队列。不进聊天流——发出前这条消息在历史里
 * 没有位置，宿主发出时补推基线，它才作为用户消息上屏（lesson
 * optimistic-bubble-must-follow-core-insert-point）。
 *
 * 无状态：宿主每次变化全量推快照，这里只渲染；× 按 id 取消。
 */
export function TurnQueueBar({
  view,
  onCancel,
}: {
  view: TurnQueueView | undefined
  onCancel: (id: number) => void
}) {
  if (view === undefined || view.items.length === 0) return null
  return (
    <div className="turn-queue">
      {view.paused && (
        <div className="turn-queue-paused">
          已暂停：上一轮被停止或出错。你发一条消息、那一轮正常结束后接着发
        </div>
      )}
      {view.items.map((it) => (
        <div key={it.id} className="turn-queue-item">
          <span className="turn-queue-tag">排队</span>
          <span className="turn-queue-text">
            {it.text}
            {it.imageCount > 0 && <span className="turn-queue-img">（{it.imageCount} 张图）</span>}
          </span>
          <button type="button" aria-label="取消排队" title="取消" onClick={() => onCancel(it.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
