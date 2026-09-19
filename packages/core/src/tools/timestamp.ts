/** 落盘时间戳：本地时区，格式 `2026-09-17 16:29:50`。
 *  归档/notes 是给人看的文件（AGENTS.md「文件就是给人看的」），UTC 时刻
 *  对不上本地钟（2026-09-17 用户实报）；统一格式保证档案头部
 *  localeCompare 排序 = 时间序。runlog 的 at 保留 UTC ISO——机器流水，
 *  日志惯例，不混用 */
export const localStamp = (): string => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
