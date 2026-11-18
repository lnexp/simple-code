/** 切段的输入：一个 step 的 id 和它的估算 token 量 */
export type SizedStep = { id: number; tokens: number }

/**
 * 从一段**连续未覆盖的 step** 里取出下一个摘要单位（提案 §4.3）。
 *
 * 调用方传进来的必须是同一个 turn 内、按 id 升序、中间没洞的一段；返回它的
 * **前缀**。是前缀这一点就保证了 covers 连续无洞——§6.6 那个坑（跳过短 step
 * 把连续段打碎、L1 合并再也接不上）在这里结构上发生不了。
 *
 * ## 为什么要切
 *
 * §8.1 实测 turn 大小 p50=4,563 / p90=51,527 token，**p90 是 p50 的 11 倍**。
 * 不切的话一个十几万 token 的 turn 整个喂给摘要模型，出来的东西就是 §1.3 那种
 * 「无内容可提炼」。预算 16,000 的来历是 §1.1 那次**真实**调用：15,031 prompt
 * token 出了个好摘要。24k 超出已验证范围 60%，没有实测依据，不外推。
 *
 * ## 第一个 step 就超预算时，它自己成一段
 *
 * 返回空数组会让调用方拿不到候选，而这个 step 又永远排在队首——摘要线程从此
 * 空转，且**不报错**，症状只是「摘要不动了」。宁可超预算摘一次。
 */
export function takeSegment(steps: SizedStep[], budget: number): SizedStep[] {
  const segment: SizedStep[] = []
  let used = 0
  for (const step of steps) {
    // 先判断再累加。反过来的话超预算的那个 step 会留在段里，段的实际大小
    // 可以到预算的两倍，摘要模型那头就跑到验证过的范围之外了
    if (segment.length > 0 && used + step.tokens > budget) break
    segment.push(step)
    used += step.tokens
  }
  return segment
}

/**
 * 一个 turn 里各段**连续未覆盖**的 step（按 id 升序），被已覆盖的 step 隔开。
 *
 * 不能 filter 掉已覆盖的再整体切：那样会把洞两侧接起来，covers 就跨过一个
 * 洞了——洞不报错，只是那截历史从此既不在 context 里也不在任何摘要里
 */
export function uncoveredRuns(ids: number[], covered: (id: number) => boolean): number[][] {
  const runs: number[][] = []
  let run: number[] = []
  for (const id of ids) {
    if (!covered(id)) {
      run.push(id)
      continue
    }
    if (run.length > 0) runs.push(run)
    run = []
  }
  if (run.length > 0) runs.push(run)
  return runs
}

/**
 * 还没结束的 turn 里**现在就能摘**的段；没有返回空数组。「没结束」= 正在跑，
 * 或以 aborted/error 结束、下一次 send 可能续进去。
 *
 * 原来整轮都不当候选。一轮跑一个多小时的话（2026-11-13 真项目 task-ets47u，
 * 79 分钟 428 步），中途压缩卸下的几百个 step 一条 L0 都没有，存根顶不掉，
 * 一直挂到下一次压缩（那次 51k，设计 16k；note long-turn-l0-lag-stub-pileup）。
 * 现在两头等轮末，中间先摘（用户 2026-11-13 选定）：
 * - **开头那段**（含这一轮的提问）：摘了的话，压缩时提问原文被摘要顶掉，
 *   模型只剩摘要里的转述；卸载从不裁 user 消息，留着它就整轮都是原文
 * - **含最后一个 step 的那截**：还在长。现在摘了，后面跑出来的 step 只能
 *   另起一段，退回「一个 turn 摘九遍」（2026-09-03 真机 covers 1-1/2-2/3-3）
 *
 * 其余的段要么攒满了预算（takeSegment 在 run 末尾之前停下），要么被已覆盖的
 * step 截住，都不会再长。开头那段的边界在它后面那段摘了之后就由覆盖定死——
 * 不能每次从轮首重切：压缩把 step 卸成存根后库里多出 live 存根行，估算会变，
 * 重切出的切点和已摘的段对不上
 */
export function takeOpenTurnSegment(opts: {
  /** uncoveredRuns 的产出 */
  runs: number[][]
  /** 这一轮第一个 step（提问所在）与最后一个 step 的 id */
  first: number
  last: number
  size: (id: number) => number
  budget: number
}): SizedStep[] {
  for (const run of opts.runs) {
    let sized = run.map((id) => ({ id, tokens: opts.size(id) }))
    if (sized[0]?.id === opts.first) sized = sized.slice(takeSegment(sized, opts.budget).length)
    const segment = takeSegment(sized, opts.budget)
    const tail = segment[segment.length - 1]
    if (tail === undefined) continue
    return tail.id === opts.last ? [] : segment
  }
  return []
}
