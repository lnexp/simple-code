import type { Part, Usage } from '../llm/types.ts'

/**
 * **必须三者相加**（实测确证，design.md 附录 A）。只读 inputTokens 会把
 * 23k 读成 29——冷缓存那次 input_tokens 只有 29，其余 23,263 全在
 * cache_creation 里。
 *
 * 加法关系是不变量：三者之和 = 完整输入量，与是否命中缓存无关。
 */
export function totalInputTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
}

/** 一次请求的完整开销，用来判断离窗口上限还有多远 */
export const totalTokens = (usage: Usage): number => totalInputTokens(usage) + usage.outputTokens

/**
 * 输入还能占多少 token。**窗口不等于能装的输入量**——输出要在同一个窗口里
 * 占掉 `maxTokens`，不减的话「看起来还没满」的请求发出去照样 400。
 *
 * 减法形式（`usable = input_limit - min(...)`)）而不是纯比例：纯比例的
 * 输出预留只是**碰巧**盖住了默认的 maxTokens，有人把比例调大就直接爆。
 *
 * 再减一档 safetyMargin：估算永远有误差，而误差偏低的后果（撞窗口、
 * session 废掉）比偏高的后果（早卸一点）严重得多。
 *
 * **放在这里而不是 run.ts 里**：卸载（run）和合并（session）都要按预算的
 * 比例算自己那块配额，各写一遍的话两边会漂——而漂了不报错，只是某个区
 * 悄悄按另一套窗口在收口。
 */
export function inputBudget(limits: {
  contextWindow: number
  maxTokens: number
  safetyMargin: number
}): number {
  const reserved = limits.maxTokens + limits.safetyMargin
  // 窗口小到连输出都装不下时至少留一点，否则预算为负、每轮都卸载还是不够，
  // 变成一个卸光了也退不出去的循环。配置写成这样本身是错的，但静默死循环
  // 比"卸到只剩当前 turn 然后照常发请求撞 400"难查得多
  return Math.max(limits.contextWindow * MIN_BUDGET_RATIO, limits.contextWindow - reserved)
}

/** 预算的下限，防止 maxTokens 配得比窗口还大时预算变成负数 */
const MIN_BUDGET_RATIO = 0.1

/**
 * 粗略的字符→token 比。只用于「还能塞多少」的估算，精确值以 API 返回的
 * usage 为准（见 contextUsage）。
 *
 * 4 是通用取值（各家内建估算常量同值）。
 *
 * 原来写的 3.5，理由是「偏保守，宁可早卸载」——**那个理由是错的，而且方向反了**。
 * 3.5 比 4 小确实让纯文本估得偏高，但我们 context 里占大头的是 tool_call.input
 * 和 tool_result，它们是密集 JSON，真实比值接近 2（下面 JSON_CHARS_PER_TOKEN），
 * 3.5 对那类内容是**低估 75%**（实测：7781 字符的 JSON 按 3.5 得 2223，按 2 得
 * 3891）。低估不报错，只是不触发卸载，然后请求撞窗口 400。
 */
const CHARS_PER_TOKEN = 4

/**
 * 密集 JSON 的比值：
 *
 * > Dense JSON has many single-character tokens (`{`, `}`, `:`, `,`, `"`)
 * > which makes the real ratio closer to 2 rather than the default 4.
 *
 * **这个项目只有 bash 工具**，tool_result 几乎全是命令输出、
 * tool_call.input 全是 JSON，按 4 估会系统性低估。
 */
const JSON_CHARS_PER_TOKEN = 2

/**
 * 一张图 3,300 token（design.md §5.1），与字节数无关。
 *
 * Anthropic 的口径：token = (w×h)/750，1568 封顶。发送侧统一缩放进
 * 2048 边后最坏 2048×1536/750 ≈ 3,146（2:1 长边贴边），3300 取整上界
 * ——比 1900（旧值，对应未缩放前的小图估的）保守，但按 base64 长度算
 * 会得到几万的荒谬结果，按占位符文本算又严重低估，只有按张数估可用。
 */
const TOKENS_PER_IMAGE = 3300

/**
 * 按 part 类型分派。
 *
 * 即使第 1 步还没有图片，这个 switch 的形状现在就要有：写成
 * `estimateChars(msg)` 一把梭的话，加图片时要翻整个调用链。
 */
export function estimateTokens(part: Part): number {
  switch (part.type) {
    case 'text':
      return estimateText(part.text, CHARS_PER_TOKEN)
    case 'image':
      return TOKENS_PER_IMAGE
    case 'reasoning':
      // encrypted 是 base64，实际内容约为其长度的 3/4。解出来是什么无从判断
      // （本来就是密文），维持字节口径；CJK 修正只对明文有意义
      return part.encrypted
        ? (part.encrypted.length * 3) / 4 / CHARS_PER_TOKEN
        : estimateText(part.text, CHARS_PER_TOKEN)
    case 'tool_call':
      // input 序列化出来一定是 JSON，直接走密集口径
      return estimateText(part.name + JSON.stringify(part.input), JSON_CHARS_PER_TOKEN)
    case 'tool_result':
      // **按内容判断，不按 part 类型。** bash 的输出多数是 `ls` / `grep` 那样
      // 的普通文本（比值接近 4），只有模型跑了 `cat x.json` 之类才是密集的。
      // 一律按 2 会把普通输出高估一倍，触发不必要的卸载
      return (
        estimateText(part.output, charsPerToken(part.output)) +
        (part.images?.length ?? 0) * TOKENS_PER_IMAGE
      )
  }
}

/**
 * CJK 字符按 ~1 token/字估，其余按传入的字符比折算。
 *
 * 通用字符比（4 字符/token）是英文口径，对中文是**低估约 4 倍**：
 * 汉字在 BPE 里几乎一字一 token。本项目的真实使用以中文对话为主
 * （实测：卸载落点估算 52k、API 真实读数 71k，差值主要是中文段），
 * 所以这里要自己扩展。
 *
 * 判定用码点区间而不是 \p{Script} 正则：这个函数在预算判断里对每条消息的
 * 每个字符都要跑，Unicode property escape 比区间比较贵一个量级，而判定错
 * 的代价只是估算偏一点。
 */
function estimateText(text: string, charsPerToken: number): number {
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (isCJK(text.charCodeAt(i))) cjk++
    else other++
  }
  return cjk + other / charsPerToken
}

/**
 * 纯文本的 token 估算（CJK 口径同 estimateText）。给 AGENTS.md 上限这类
 * 「对整段文本判断」用——不经过 Part 包装，语义就是「这段字多大」。
 */
export function estimateTextTokens(text: string): number {
  return estimateText(text, CHARS_PER_TOKEN)
}

/** 汉字 + 假名 + 谚文 + 全角符号。逐字符调用，写成都市紧凑的区间判断 */
function isCJK(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) || // CJK 标点、假名
    (code >= 0x3130 && code <= 0x318f) || // 谚文兼容字母
    (code >= 0x3400 && code <= 0x4dbf) || // 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // 基本区
    (code >= 0xac00 && code <= 0xd7af) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // 兼容表意
    (code >= 0xff00 && code <= 0xffef) // 全角形式
  )
}

/**
 * 内容像 JSON 就用密集口径。
 *
 * 只看开头和结尾，不做完整解析：这个函数在每次预算判断里对每条消息都要跑一遍，
 * 而判断错的代价只是估算偏一点——不值得为它 `JSON.parse` 一个可能几十 KB 的串。
 */
function charsPerToken(text: string): number {
  const trimmed = text.trimStart()
  const head = trimmed.charCodeAt(0)
  // 123 = '{'，91 = '['
  const looksJson = (head === 123 || head === 91) && /[}\]]\s*$/.test(text)
  return looksJson ? JSON_CHARS_PER_TOKEN : CHARS_PER_TOKEN
}

export const estimateMessageTokens = (parts: Part[]): number =>
  parts.reduce((sum, part) => sum + estimateTokens(part), 0)

/**
 * 这一轮请求大概要用掉多少输入 token。**判断该不该卸载只能用这个函数。**
 *
 * ```
 * 上一轮 API 返回的真实 usage（权威）
 *   + 那之后新增消息的本地估算（只有这部分靠猜）
 * ```
 *
 * 真实值 + 增量估算，**不要用纯累计计数、也不要用纯真实值**。
 *
 * **为什么不能纯估算**（这是本项目原来的错法）：估算误差随历史长度累积，
 * 而 API 每轮都免费给出一个精确值放着没人用。误差的方向还是偏低（见
 * CHARS_PER_TOKEN 的注释），于是「算出来没超 → 不卸载 → 请求 400」，
 * 而 400 之后每加一条消息都更超，session 从此废掉。
 *
 * **为什么不能纯真实值**：usage 描述的是「上一轮发出去的那份」。之后跑了几个
 * bash、吐回几万字的 tool_result，这些都还没进过任何一次请求，纯看 usage 等于
 * 当它们不存在。
 *
 * `sinceIndex` 是「基线覆盖到哪」：`messages[sinceIndex]` 及其之后算新增。
 * 没有基线（第一轮，`baseline` 为 null）时全部估算，那时历史短，估错也撞不到窗口。
 */
export function contextUsage(
  messages: { parts: Part[] }[],
  baseline: Usage | null,
  sinceIndex: number,
): number {
  const base = baseline ? totalInputTokens(baseline) : 0
  const from = baseline ? sinceIndex : 0
  let added = 0
  for (let i = from; i < messages.length; i++) {
    added += estimateMessageTokens(messages[i]?.parts ?? [])
  }
  return base + added
}
