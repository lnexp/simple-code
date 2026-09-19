import { useState } from 'react'

/**
 * 一轮结束后挂在最后一条 assistant 消息下的元信息条。
 *
 * **只做我们真有数据的那几项。** agent 模式徽章、provider logo、改动
 * 文件列表、导出图片、朗读——我们没有 agent 模式概念，也没引
 * html-to-image，硬凑等于造假数据（CLAUDE.md §2：不加没要求的东西）。
 */

export const formatElapsed = (ms: number): string => {
  const sec = ms / 1000
  // 不足一分钟给一位小数，超过就 "2m 34s"——
  // 秒数三位以上时小数位没有信息量
  if (sec < 60) return `${sec.toFixed(1)}s`
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
}

/**
 * 时间戳。同一天只给时分——聊天里绝大多数消息就是今天的，带上日期是噪音。
 * 跨天了才补日期，避免「11:11」到底是哪天说不清
 */
const formatStamp = (at: number): string => {
  const date = new Date(at)
  const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`
}

/**
 * 复制按钮。成功后图标切成对勾 1.2s——**没有这个反馈的话点了和没点一样**，
 * 用户会反复点。navigator.clipboard 在 webview 里可用（同源 https 上下文）
 */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      },
      // 失败就保持原图标。这里没有能给用户看的地方，弹窗又太重
      () => undefined,
    )
  }

  return (
    <button
      type="button"
      className="footer-btn"
      data-done={done}
      title={done ? '已复制' : '复制回答'}
      aria-label={done ? '已复制' : '复制回答'}
      onClick={copy}
    >
      <i className={`codicon codicon-${done ? 'check' : 'copy'}`} aria-hidden />
    </button>
  )
}

export function MessageFooter({
  model,
  elapsedMs,
  finishedAt,
  text,
}: {
  /** 来自扩展侧的 `state` 消息。session 建起来之前是 null，那时不显示 */
  model: string | null
  elapsedMs: number | undefined
  finishedAt: number
  text: string
}) {
  return (
    <div className="footer">
      {model !== null && (
        <span className="footer-item footer-model" title={model}>
          <i className="codicon codicon-chip" aria-hidden />
          {model}
        </span>
      )}
      {elapsedMs !== undefined && (
        <span className="footer-item" title="本轮耗时">
          <i className="codicon codicon-watch" aria-hidden />
          {formatElapsed(elapsedMs)}
        </span>
      )}
      <span className="footer-item footer-time" title={new Date(finishedAt).toLocaleString()}>
        <i className="codicon codicon-clock" aria-hidden />
        {formatStamp(finishedAt)}
      </span>
      <span className="footer-actions">
        <CopyButton text={text} />
      </span>
    </div>
  )
}
