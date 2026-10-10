/**
 * 扩展宿主事件循环卡顿观测：每秒打一拍，晚到 ≥ 1s 记一行 `loop_lag`。
 *
 * 起因：2026-09-28 19:45:28 VS Code 报本地扩展宿主 unresponsive 3.6s，
 * runlog 里没有任何痕迹，归不了因（宿主由十几个扩展共用）。这一行只说明
 * 「这个宿主卡了多久、何时」，是谁卡的看同 pid 前后的 runlog 事件——
 * 本身不做归因。setInterval 在宿主被占住时拍不出，放开后第一拍的迟到量
 * 就是卡的时长（误差 < 一拍）
 */
export function watchLoopLag(
  log: (ev: { ev: 'loop_lag'; ms: number }) => void,
  intervalMs = 1000,
  thresholdMs = 1000,
): { dispose: () => void } {
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - intervalMs
    last = now
    if (lag >= thresholdMs) log({ ev: 'loop_lag', ms: lag })
  }, intervalMs)
  timer.unref?.() // 不拖住进程退出
  return { dispose: () => clearInterval(timer) }
}
