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
