/**
 * 消息列表的「跟随底部」判定（App.tsx Log）。纯函数，组件不测的规矩下
 * 逻辑放这里测（CLAUDE.md §4.3）。
 *
 * 原来每次 scroll 事件按「离底部 < 24px」重算 pinned。坑：程序滚到底后
 * scroll 事件要等下一帧才派发，这期间流式文本的节流提交（throttle.ts，
 * 子组件自己的定时器，不经 Log）又长出几行——事件到达时离底部已超 24px，
 * pinned 被算成 false，之后再也不跟。回答一次吐一大块（多行列表/表格）时
 * 几乎必现（10-29 用户：「最后的回答流式生成时没有将页面自动上拉」；
 * 夹具每批 6 行，改前第 5 批起不再跟随，距离一路涨到 3400px）。
 *
 * 改为：只有**往上翻**（scrollTop 变小且不在底部）才取消跟随；内容自己
 * 变长、程序往下滚都不算用户动作
 */

/** 离底部多少像素以内算「在底部」：滚到底时 scrollTop 常差几个像素对不齐 */
export const FOLLOW_SLACK_PX = 24

export function nextPinned(
  prev: boolean,
  s: { top: number; lastTop: number; distance: number },
): boolean {
  if (s.distance < FOLLOW_SLACK_PX) return true
  if (s.top < s.lastTop) return false
  return prev
}
