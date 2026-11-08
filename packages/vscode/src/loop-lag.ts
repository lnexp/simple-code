/**
 * 扩展宿主事件循环卡顿观测：每秒打一拍，晚到 ≥ 1s 记一行 `loop_lag`。
 *
 * 起因：2026-09-28 19:45:28 VS Code 报本地扩展宿主 unresponsive 3.6s，
 * runlog 里没有任何痕迹，归不了因（宿主由十几个扩展共用）。这一行只说明
 * 「这个宿主卡了多久、何时」，是谁卡的看同 pid 前后的 runlog 事件——
 * 本身不做归因。setInterval 在宿主被占住时拍不出，放开后第一拍的迟到量
 * 就是卡的时长（误差 < 一拍）
 *
 * 分档：≥ 30s 记 `loop_nap` 不记 `loop_lag`——那是 macOS 睡眠/App Nap
 * 对空闲进程的定时器节流。2026-11-06 实测收紧：600s 档漏掉短睡眠残留
 * （414s/337s/49s/36s 共 7 条冒充卡顿，两个独立宿主 pid 同步报、前后
 * 零活动、前一条就是 nap——是电脑苏醒不是代码），而真卡顿聚在 1-7s
 * （store_save 类）。7s↔35s 之间是空档，30s 居中。真同步占住 30s+ =
 * 宿主假死，VS Code 自己会报 unresponsive，nap 标签不丢归因手段
 * （前后 runlog 事件仍可查）。见 note loop-lag-is-macos-sleep
 */
export function watchLoopLag(
  log: (ev: { ev: 'loop_lag' | 'loop_nap'; ms: number }) => void,
  intervalMs = 1000,
  thresholdMs = 1000,
  napThresholdMs = 30_000,
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
