import { useEffect, useRef, useState } from 'react'

/**
 * 流式文本的 trailing-edge 节流（D1a：100ms）。决策部分是纯函数（可测），hook 只做定时器接线——React 组件
 * 不测的规矩（CLAUDE.md §4.3）下，逻辑全塞进纯函数
 */

export const STREAM_THROTTLE_MS = 100

/** 距下次放行还要等多久；0 = 立刻放行 */
export function throttleDelay(lastEmitAt: number, now: number, intervalMs: number): number {
  return Math.max(0, intervalMs - (now - lastEmitAt))
}

export function useThrottledText(
  text: string,
  active: boolean,
  intervalMs = STREAM_THROTTLE_MS,
): string {
  const [shown, setShown] = useState(text)
  const latest = useRef(text)
  latest.current = text
  const lastEmitAt = useRef(0)

  useEffect(() => {
    if (!active) {
      // 不流式了（结束/中断）：立刻上最终值，别把尾巴卡在节流窗里
      setShown(text)
      return
    }
    const delay = throttleDelay(lastEmitAt.current, Date.now(), intervalMs)
    if (delay === 0) {
      lastEmitAt.current = Date.now()
      setShown(text)
      return
    }
    // 到点放行「当时的最新值」——定时器回调里读 ref，不闭包住这一帧的 text
    const timer = setTimeout(() => {
      lastEmitAt.current = Date.now()
      setShown(latest.current)
    }, delay)
    return () => clearTimeout(timer)
  }, [text, active, intervalMs])

  return shown
}
