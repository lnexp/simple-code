/**
 * 扩展宿主事件循环卡顿观测：每秒打一拍，晚到 ≥ 1s 记一行 `loop_lag`。
 *
 * 起因：2026-09-28 19:45:28 VS Code 报本地扩展宿主 unresponsive 3.6s，
 * runlog 里没有任何痕迹，归不了因（宿主由十几个扩展共用）。这一行只说明
 * 「这个宿主卡了多久、何时」，是谁卡的看同 pid 前后的 runlog 事件——
 * 本身不做归因。setInterval 在宿主被占住时拍不出，放开后第一拍的迟到量
 * 就是卡的时长（误差 < 一拍）
 *
 * 分档（2026-10-21 周检拍板）：≥ 600s 记 `loop_nap` 不记 `loop_lag`——
 * 那是 macOS 睡眠/App Nap 对空闲进程的定时器节流（实测数值聚在
 * 905-1044s、lag 前后零活动；一周 348 条把真卡顿淹没）。loop_lag 留给
 * 事件循环被同步代码占住的秒级卡顿（见 note loop-lag-is-macos-sleep）
 */
export function watchLoopLag(
  log: (ev: { ev: 'loop_lag' | 'loop_nap'; ms: number }) => void,
  intervalMs = 1000,
  thresholdMs = 1000,
  napThresholdMs = 600_000,
): { dispose: () => void } {
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - intervalMs
    last = now
    if (lag >= napThresholdMs) log({ ev: 'loop_nap', ms: lag })
    else if (lag >= thresholdMs) log({ ev: 'loop_lag', ms: lag })
  }, intervalMs)
  timer.unref?.() // 不拖住进程退出
  return { dispose: () => clearInterval(timer) }
}
