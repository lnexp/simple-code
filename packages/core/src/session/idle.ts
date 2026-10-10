import type { Session } from './session.ts'

/**
 * 排一个定时器，返回取消它的函数。换掉它测试就不用真的等几秒 */
export type SetTimer = (ms: number, fn: () => void) => () => void

const defaultTimer: SetTimer = (ms, fn) => {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}

/**
 * 空闲超过 `idleSummarizeDelayMs` 就让 session 去做一个 turn 的 L0 摘要
 * （design.md §9.7）。
 *
 * 「空闲」由调用方定义：CLI 是「提示符出来了、用户还没敲完一行」，VS Code
 * 面板是「一轮跑完了、用户还没发下一条」。两个前端在各自的空闲起点 arm，
 * 空闲被打断（敲了东西 / 发了新消息）时 disarm。
 *
 * **摘要跑完之后重新计时，接着摘下一个**——一次空闲期内不是只做一条。用户
 * 泡杯咖啡回来，攒下的几个 turn 应该都摘完了，而不是只摘掉最老那个。
 *
 * 并发规则由 `session.summarizeIdle` 自己保证（同时最多一个、已经在跑的不打断），
 * 这里不判断——判断散在两处迟早对不上。**「loop 跑着就不开新的」那条已经不在了**
 * （§9.7 修正二）：摘要现在也由每个 step 跑完时触发，空闲只是它的另一个入口，
 * 不再是唯一入口。
 *
 * 放在 core 而不是各前端各写一份的理由是实测过的教训：watchIdle 起初只在
 * CLI 里，VS Code 扩展上线后没人记得接这条线，摘要在扩展里一次都没跑过——
 * 538 条消息攒着没有 L0，卸载全退化成「头部+路径」，窗口压不下去。
 */
export function watchIdle(session: Session, setTimer: SetTimer = defaultTimer) {
  const delay = session.config.config.memory.idleSummarizeDelayMs
  let cancel: (() => void) | null = null
  // disarm 撤不掉已经在跑的摘要，只能让它跑完别再排下一次：代次变了就不 arm。
  // 不挡的话会话关闭（先 disarm 再关库）后 3 秒读已关的库——2026-09-28~30
  // exthost 里 8 次 `database is not open`；用户插话 disarm 后同样会被偷偷重新计时
  let generation = 0

  const arm = () => {
    // 配 0 就是关掉这个功能。配置项本来就允许 0（schema 是 nonnegative），
    // 不挡的话会排一个 0ms 定时器，变成每轮结束都摘一次
    if (delay <= 0) return
    cancel?.()
    cancel = setTimer(delay, () => {
      cancel = null
      const gen = generation
      // 不 await：这里是定时器回调，没人接它的 promise。摘要本身永不抛异常
      // （session.ts 的注释），所以不会有未处理的 rejection
      void session.summarizeIdle().then(() => {
        if (gen === generation) arm() // 跑完接着摘下一个
      })
    })
  }

  return {
    arm,
    disarm: () => {
      generation++
      cancel?.()
      cancel = null
    },
  }
}
