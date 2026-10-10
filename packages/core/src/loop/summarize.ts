import { estimateMessageTokens } from './tokens.ts'
import type { Message, Part, Request } from '../llm/types.ts'
import type { LiveMessage, Summary } from './assemble.ts'
import { INDEX_LINE_MAX_CHARS } from './index-cap.ts'

/**
 * L0 摘要：把一个 turn 压成一两句「想做什么 + 工具返回了什么」（design.md §9.6）。
 *
 * 这里只有纯逻辑——挑哪个 turn、把它渲染成什么文本、组装什么请求。**发请求和
 * 写库不在这里**，留给调用方（session）。理由跟 reducer 必须是纯函数一样
 * （CLAUDE.md §4.3）：喂固定输入断言输出，不碰网络。
 */

/** 一个待摘要的 turn */
export type Candidate = { turnId: number; messages: Message[] }

/**
 * 挑下一个该摘要的 turn：**最老的、还没有摘要行的、且不是当前 turn 的**。
 *
 * 三个条件各有理由：
 * - **最老**：卸载也从最老开始（§9.4），摘要要赶在卸载前面才有意义
 * - **还没有摘要行**：已经有行的（pending/generating/ready）都不重复排队
 * - **不是当前 turn**：当前 turn 还在进行中，工具可能还没跑完，这时候摘要
 *   等于对着半截对话总结
 */
export function pickTurnToSummarize(live: LiveMessage[], covered: Set<number>): Candidate | null {
  const byTurn = new Map<number, Message[]>()
  for (const entry of live) {
    const bucket = byTurn.get(entry.turnId)
    if (bucket) bucket.push(entry.message)
    else byTurn.set(entry.turnId, [entry.message])
  }

  const turnIds = [...byTurn.keys()].sort((a, b) => a - b)
  // 最后一个 turn 是当前 turn，跳过
  for (const turnId of turnIds.slice(0, -1)) {
    if (covered.has(turnId)) continue
    const messages = byTurn.get(turnId)
    if (messages && messages.length > 0) return { turnId, messages }
  }
  return null
}

/**
 * 把一个 turn 渲染成给摘要模型看的文本。
 *
 * **tool_call 的 input 和 tool_result 的 output 必须成对出现**（§9.6）：单看
 * output 不知道在干嘛（一个空输出可能是「写文件成功」也可能是「grep 没找到」），
 * 单看 command 不知道成没成。所以按 toolCallId 配对，配不上的也照原样列出来
 * ——宁可给模型多余信息，也不要给它一半的信息。
 */
export function renderTurn(messages: Message[]): string {
  const outputs = collectOutputs(messages)
  const lines: string[] = []

  for (const message of messages) {
    for (const part of message.parts) {
      const line = renderPart(part, message.role, outputs)
      if (line) lines.push(line)
    }
  }
  return lines.join('\n')
}

/** toolCallId → 输出文本。渲染 tool_call 时就地把结果贴在后面 */
function collectOutputs(messages: Message[]): Map<string, string> {
  const outputs = new Map<string, string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_result')
        outputs.set(
          part.toolCallId,
          part.images?.length ? `${part.output}（附图 ${part.images.length} 张）` : part.output,
        )
    }
  }
  return outputs
}

function renderPart(part: Part, role: Message['role'], outputs: Map<string, string>): string {
  switch (part.type) {
    case 'text':
      return `${role === 'user' ? '用户' : '助手'}：${part.text}`
    case 'tool_call': {
      // 成对渲染：命令紧跟着它的输出，模型不用自己去别处找配对
      const output = outputs.get(part.id)
      const shown = output === undefined ? '(无输出记录)' : output || '(空输出)'
      return `调用 ${part.name}：${JSON.stringify(part.input)}\n返回：${shown}`
    }
    case 'tool_result':
      // 已经贴在对应的 tool_call 后面了，不重复列
      return ''
    case 'reasoning':
      // 推理过程不进摘要。它是模型的草稿，不是发生过的事实（§9.9 同理）
      return ''
    case 'image':
      return '(图片)'
  }
}

/**
 * L0 的摘要指令。
 *
 * 措辞照 §9.6 的正反例：要「写入 src/auth.ts，约 500 行 JWT 中间件实现，成功」，
 * 不要「用户询问了认证相关问题，助手进行了分析并给出建议」——后者读完等于没读，
 * 模型无法判断要不要展开原文。
 *
 * 「涉及文件」那句限定语是实测逼出来的：`turn-000005-s000037.md` 列了 4 个
 * 路径，**4 个全部只出现在对话正文里、一个都没出现在工具调用或返回里**
 * （其中 3 个磁盘上根本不存在）。那一段是纯讨论，正确答案是「无」。
 * 原来的指令只说「## 涉及文件」，没说什么算「涉及」，模型就把讨论中举例
 * 提到的路径全抄了进去——而这一行进了热区正文，下一个模型照着去 cat 会扑空。
 *
 * 锚到「调用 bash 那几行」而不是干说「不要编」：材料就在渲染出来的输入里
 * （`renderPart` 把命令和返回成对贴着），指一个它能核对的地方比让它自省有用。
 *
 * **这条改动没有自动化验证**（prompt 行为测不出确定性，CLAUDE.md §6.1 那条
 * 「先证明测试有效」在这里的诚实答案是：证明不了）。下一批叶子里再抽查。
 *
 * prompt 进代码常量不进配置，跟 systemPrompt 同理（session.ts 的注释）：
 * 它属于产品行为，放开了会让「摘要质量不稳定」变成无法排查的问题。
 */
const L0_SYSTEM =
  '你在为一段已经发生的对话写索引条目。严格按下面的格式输出，不要有别的话：\n' +
  '\n' +
  '名称: <十来个字的短标题>\n' +
  `描述: <一两句话说明做了什么、结果如何，不超过 ${INDEX_LINE_MAX_CHARS} 字>\n` +
  '\n' +
  '## 用户要求\n' +
  '## 实际完成\n' +
  '## 未完成/失败\n' +
  '## 涉及文件\n' +
  '\n' +
  '要具体到文件名、命令、数字。写「修改了 auth.ts 的 verify 函数，测试 3 条全过」，' +
  '不要写「进行了代码修改并验证」——后者读完等于没读。\n' +
  '失败和未完成的事必须写出来，那是后面最需要知道的；真的没有就写「无」。\n' +
  '「涉及文件」只列**出现在「调用 bash」那几行命令或它们的返回里**的路径。' +
  '对话里被谈到、举例、假设的文件不算——这一段要是一个文件都没碰过，就写「无」。\n' +
  '如果段落里读过头部的归档文件（.simple-code/memory 下的路径），必须在「实际完成」里' +
  '注明「已于本段重新展开过 turn N 原文」——上层摘要会保留这句，避免之后再次读同一个归档' +
  '（design.md §9.10 的重复读取抖动：内容回到 context、再被卸载、再被读，来回烧 token）。\n' +
  '不要前缀、不要解释、不要引号、不要代码块围栏。'

/** 摘要模型这次产出的东西：叶子的键（名称+描述）和正文，一次生成 */
export type SummaryOutput = { name: string; description: string; body: string }

/**
 * 解析 L0 的结构化输出。**解析不出结构不算失败**——退化成「整段都是描述、
 * 正文为空」，也就是这次改动之前的行为。
 *
 * 模型不听格式是常态而不是异常，而摘要是锦上添花的功能（§9.7）：为了拿不到
 * `名称` 就把整条摘要丢掉，等于用一个可选功能的瑕疵换掉它的全部价值。描述
 * 是唯一必需的那样，因为 context 里放的就是它。
 */
export function parseSummaryOutput(raw: string): SummaryOutput {
  const cleaned = cleanSummaryText(raw)
  const lines = unfoldOneLiner(cleaned).split('\n')
  // **键在第一个 markdown 标题之前找，不是认死行号 0 和 1。**
  //
  // 认死行号时，模型在「名称:」和「描述:」之间空一行、或者写成 `**描述**:`，
  // 就整条解析失败——退化成「整段当描述、正文为空」，而正文为空就不写叶子
  // 文件，热区那一条从此没有正文可展。真库实测：34 条叶子里 18 条没有 md，
  // 其中 8 条是这么丢的（痕迹是 description 以「名称/描述/#」开头，那正是
  // fallback 把整段吞进去的形状）。
  //
  // 边界仍然是「第一个标题之前」而不是全文：往下扫的话正文里的「描述: xxx」
  // 会被当成字段——模型在「## 涉及文件」下面写这个不是稀奇事
  const bodyAt = lines.findIndex((line) => /^\s*#/.test(line))
  const headEnd = bodyAt === -1 ? lines.length : bodyAt
  const find = (label: string): { at: number; value: string } | null => {
    for (let at = 0; at < headEnd; at++) {
      // 加粗和全角冒号是模型最常见的两种自选发挥，都认
      const m = lines[at]?.match(new RegExp(`^\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*(.*)$`))
      if (m) return { at, value: m[1]?.trim() ?? '' }
    }
    return null
  }
  const name = find('名称')
  const description = find('描述')
  // 描述都没有：整段当描述。**要跳过已经识别出的名称行**，不然那行会连着
  // 「名称:」四个字一起进 context
  if (description === null) {
    const rest = lines.filter((_, i) => i !== name?.at)
    return { name: name?.value ?? '', description: fallback(rest, cleaned), body: '' }
  }
  return {
    name: name?.value ?? '',
    description: fallback([description.value], cleaned),
    body: lines
      .slice(Math.max(name?.at ?? -1, description.at) + 1)
      .join('\n')
      .trim(),
  }
}

/**
 * **原文非空时，描述绝不能是空串。**
 *
 * 这不是「好看一点」，是整条流水线的活口：`session.ts` 里 `if (out.description)`
 * 为 false 就不调 `finishSummary`，那一行永远卡在 pending；pending 又在 covers
 * 上打洞，`pickMergeGroup` 要求连续，于是合并从此起不来。真库里 213 条 pending
 * 加上「L0 合并停滞」，根因就是这一个空串（2026-09-03 真机验证）。
 *
 * 所以宁可还一段没拆干净的原文——难看的摘要仍然有索引价值，空摘要让整个索引
 * 树停止生长。
 */
const fallback = (parts: string[], cleaned: string): string => {
  const joined = parts.join('\n').trim()
  return joined || cleaned
}

/**
 * 模型经常把整个格式**压成一行**：内容一个字不少，就是没有换行符。
 *
 * ```
 * 名称: 系统信息盘点描述: 执行 df -h 与 uname -a，确认是 macOS…未完成/失败: 无
 * ```
 *
 * 按行解析碰上它，`名称` 会把整行吃光、`描述` 匹配不到——真机跑 4 轮出 8 条
 * 摘要、**0 个叶子文件**就是这么来的。所以先按标签把它拆回多行。
 *
 * **只在整段就一行的时候拆。** 多行输入一个字不动，因为那时正文里出现
 * 「描述:」是正常的（模型爱在「## 涉及文件」底下再写一行），拆了反而会把
 * 正文片段当成字段——那是上面 `field` 只认开头两行所要防的事。
 */
function unfoldOneLiner(text: string): string {
  if (text.includes('\n')) return text
  return text.replace(/(描述|未完成\/失败|实际完成|用户要求|涉及文件)[:：]/g, '\n$1:')
}

/**
 * 组装摘要请求。**不带工具、不进 agent loop**——摘要是一次性的文本生成，
 * 给了工具反而可能让模型去跑命令「确认一下」，那是既慢又危险的。
 */
export function buildSummaryRequest(
  turnText: string,
  base: Omit<Request, 'messages' | 'system' | 'tools'>,
): Request {
  return {
    ...base,
    system: L0_SYSTEM,
    tools: [],
    // thinking 关掉：照着已经发生的对话填四个小标题不需要推理，开着纯粹是
    // 延迟和 token
    thinking: 'disabled',
    messages: [{ role: 'user', parts: [{ type: 'text', text: turnText }] }],
  }
}

/**
 * 摘要模型返回的文本可能带引号、前缀（「摘要：」）或多余换行——模型不总是
 * 严格听话。清一遍再入库，不然这些噪音会永久留在 context 里。
 */
export function cleanSummaryText(raw: string): string {
  const trimmed = raw.trim().replace(/^(摘要|总结)[:：]\s*/, '')
  const unquoted = trimmed.replace(/^["'「]|["'」]$/g, '')
  return unquoted.trim()
}

// ======================= 分层合并（3b-2）=======================

/**
 * 一个可合并的组：连续、都已生效的一批摘要。通常同层；同层凑不满时是跨层
 * 兜底组（方案 D），`level` = 成员最高层，新节点 = level + 1
 */
export type MergeGroup = {
  level: number
  members: Summary[]
}

/**
 * 这行摘要是否「代表着 context 里的内容」：自己生效着，**或者它的子树里有
 * 生效着的行**。
 *
 * 第二种是级联合并的前提：L0×4 → L1×2 之后立刻合 L2，L1 还没生效过
 * （待生效要等下次卸载才 apply），但它们顶替的那批 L0 在 context 里——
 * 在缓存语义上这批 L1 已经「占着位置」，攒够了就该继续向上收。只认
 * `inContext` 的话，L2 永远要等「L1 生效 + 再攒 mergeFactor 条」两轮空闲，
 * 级联就名存实亡了
 */
function representsContext(summaries: Summary[]): Set<number> {
  const childrenOf = new Map<number, Summary[]>()
  for (const s of summaries) {
    if (s.supersededBy !== null) {
      const bucket = childrenOf.get(s.supersededBy)
      if (bucket) bucket.push(s)
      else childrenOf.set(s.supersededBy, [s])
    }
  }
  const rep = new Set<number>()
  const mark = (id: number): boolean => {
    if (rep.has(id)) return true
    const node = summaries.find((x) => x.id === id)
    if (!node) return false
    if (node.inContext) {
      rep.add(id)
      return true
    }
    for (const child of childrenOf.get(id) ?? []) {
      if (mark(child.id)) {
        rep.add(id)
        return true
      }
    }
    return false
  }
  for (const s of summaries) mark(s.id)
  return rep
}

/**
 * **索引区的稳态成员**——所有待生效的合并都落地之后，context 里会剩下的那批。
 *
 * 三个条件的理由见 `pickMergeGroup`。单独拎出来是因为**合并触发也要用它**：
 * 触发判据是「索引区超没超配额」，而刚 `recordMerge` 完的那一刻，成员还
 * `inContext=1`、新节点还 `inContext=0`（等下一次卸载才翻），此时按 `inContext`
 * 量出来的大小**一点没降**——照着它循环就会一路把每一段都合掉。
 *
 * `supersededBy !== null` 的行按「已经走了」算，正是这个口径。
 */
export function indexMembers(summaries: Summary[]): Summary[] {
  const rep = representsContext(summaries)
  return summaries.filter((s) => rep.has(s.id) && s.status === 'ready' && s.supersededBy === null)
}

/**
 * 找下一个该合并的组：同层、`inContext`、`ready`、未被合并过，且 **covers
 * 严格连续**，条数 ≥ mergeFactor。从最老的（最低 level、最靠前）开始。
 * **同层一组都凑不出时**，退到跨层：时间轴上最老的连续 mergeFactor 条
 * （2026-09-28 方案 D，理由见函数体第二轮）。
 *
 * 四个条件各有理由：
 * - **代表 context**（见 representsContext）：合并的是「context 正在用的
 *   （或级联中即将顶替进来的）」那批。子树全没生效的行不在 context 里，
 *   把它并进来会让上层摘要声称覆盖一段模型从没见过的历史
 * - **ready**：占位文本（pending/generating）没有内容可压，并进去等于让
 *   模型给一段「（摘要生成中）」写摘要
 * - **supersededBy = null**：已经被上层吃掉的不能再吃一次。正常流程到不了
 *   非 null 还 inContext 的状态（apply 会一起翻掉），这条是防御
 * - **连续或空缝可跨**（covers_to + 1 == 下一个的 covers_from，或中间的
 *   缝是纯死空间）：中间有洞的话 L1 的覆盖区间会把洞盖进去，apply 时拼装
 *   的 findCovering 会吞掉洞里那个 turn 的 live 消息——历史凭空消失，
 *   不报错。**正常流程下洞不存在**（卸载严格从最老开始，inContext 的 L0
 *   天然是前缀），但实现不能默默依赖它，校验断了就返回 null（不合这批），
 *   下次空闲再看。唯一的合法例外是 **fork 预留号段的死尾巴**：任务关闭后
 *   没用完的预留段谁也不会再写（任务关了、对话在 fork 那一刻就跳过了），
 *   它把摘要链永久切成两段——每 fork 一次索引地板就永久抬一行。跨它的
 *   判据在 `chainable` 里，三重保险见那里的注释
 *
 * 返回 null = 没有可合并的。
 */
export function pickMergeGroup(
  summaries: Summary[],
  mergeFactor: number,
  gapHasContent?: (from: number, to: number) => boolean,
): MergeGroup | null {
  const eligible = indexMembers(summaries)
  const levels = [...new Set(eligible.map((s) => s.level))].sort((a, b) => a - b)

  // 第一轮：同层连续 ≥ mergeFactor（金字塔的正常形态，从最低层、最老的开始）
  for (const level of levels) {
    // covers_from 升序。同层连续段从这里才谈得上「最老的优先」
    const layer = eligible
      .filter((s) => s.level === level)
      .sort((a, b) => a.coversFrom - b.coversFrom)
    const group = firstRun(summaries, layer, mergeFactor, gapHasContent)
    if (group) return { level, members: group }
  }

  // 第二轮（2026-09-28 方案 D）：**同层凑不满、且有节点被夹住时，跨层合
  // 时间轴上最老的、含被夹住节点的连续 mergeFactor 条**，层 = 成员最高层
  // （调用方再 +1）。
  //
  // 为什么需要：层在时间轴上会交错（L1 L0 L3 L1 L0 …）——链只要暂时断过
  // 一次（摘要还在生成、任务开着没关、摘要被撤场），断点之后的新 L0 照样
  // 攒满合成 L1，断点之前不满 mergeFactor 的那几条就被夹在高层节点之前，
  // 同层永远连不上。真库 119 条稳态成员按时间轴两两全可链（零真断点），
  // 同层却 5 次合并后卡在配额上方 27%（18.4k/14.5k）。
  //
  // **「被夹住」= 时间轴上更新的一侧有比它更高层的节点**：它的同层段再也
  // 长不大了。反过来，从老到新层级只降不升（L3 L2 L1 L0 L0）是正常金字塔
  // 在攒，等就行——这里不许动它，否则刚合出一条 L1、下一条 L0 还没到齐就
  // 被 L1+L0 跨层吞掉，退化成方案 C 的滚雪球（每次吞最老的，几次后整个
  // 历史只剩一行 + 最近几十条）。merge-e2e 级联测试（配额恒超）就是这么
  // 抓到的。
  //
  // 调用方只在索引超配额时来要组。跨缝保险与同 owner 约束与第一轮同一套
  const timeline = [...eligible].sort((a, b) => a.coversFrom - b.coversFrom)
  // 没有被夹住的节点时下面挑不出窗口，自然返回 null
  const stuck = strandedIds(timeline)
  for (const run of runs(summaries, timeline, gapHasContent)) {
    for (let start = 0; start + mergeFactor <= run.length; start++) {
      const window = run.slice(start, start + mergeFactor)
      if (window.some((s) => stuck.has(s.id))) {
        return { level: Math.max(...window.map((s) => s.level)), members: window }
      }
    }
  }
  return null
}

/** 被夹住的节点：时间轴（coversFrom 升序）上更新的一侧有比它层级更高的 */
function strandedIds(timeline: Summary[]): Set<number> {
  const out = new Set<number>()
  let maxAfter = -1
  for (let i = timeline.length - 1; i >= 0; i--) {
    const s = timeline[i]
    if (!s) continue
    if (s.level < maxAfter) out.add(s.id)
    maxAfter = Math.max(maxAfter, s.level)
  }
  return out
}

/**
 * 在按 coversFrom 升序的 `seq` 里找第一段「可链」的连续 ≥ mergeFactor 条，
 * 返回它的前 mergeFactor 条。
 *
 * **只吃 mergeFactor 条，不吃整段。** 原来是 `run.slice()`——积压越多一次
 * 吞得越狠，真库里 25 条连续 L0 被一次合成一行。扇出是个常数，不该随
 * 「后台摘要攒了多少还没合」浮动
 */
function firstRun(
  summaries: Summary[],
  seq: Summary[],
  mergeFactor: number,
  gapHasContent?: (from: number, to: number) => boolean,
): Summary[] | null {
  for (const run of runs(summaries, seq, gapHasContent)) {
    if (run.length >= mergeFactor) return run.slice(0, mergeFactor)
  }
  return null
}

/**
 * 把 `seq` 切成一段段「可链」的连续 run，按先后产出。
 *
 * 连续还得**同 owner**（task-v3）：任务视角的可见集里混着对话的行和自己的
 * 私有行，混着合会让私有父行顶替对话的成员——对话看不见那个父行，成员被
 * 幽灵顶掉，历史凭空缺一块。对话视角全 owner=null，此约束自然不生效
 */
function* runs(
  summaries: Summary[],
  seq: Summary[],
  gapHasContent?: (from: number, to: number) => boolean,
): Generator<Summary[]> {
  let run: Summary[] = []
  for (const summary of seq) {
    const last = run[run.length - 1]
    if (
      last &&
      run[0] &&
      chainable(summaries, run[0].coversFrom, last, summary, gapHasContent) &&
      (summary.owner ?? null) === (last.owner ?? null)
    ) {
      run.push(summary)
    } else {
      if (run.length > 0) yield run
      run = [summary]
    }
  }
  if (run.length > 0) yield run
}

/** `last` 与 `next` 之间能否链上。`spanFrom` = 当前合并组首成员的 coversFrom */
function chainable(
  summaries: Summary[],
  spanFrom: number,
  last: Summary,
  next: Summary,
  gapHasContent?: (from: number, to: number) => boolean,
): boolean {
  if (next.coversFrom === last.coversTo + 1) return true
  // 重叠的不是「缝」，是两条在场节点互相罩着（异常态，正常流程到不了）。
  // 同层扫描几乎碰不到；跨层时间轴会把它们排成邻居——链上的话新节点把
  // 两边一起收掉，重叠那截的两份表述只剩一份。拒，等修复路径去处理
  if (next.coversFrom <= last.coversTo) return false
  // fork 预留号段留下的死缝（task-v3）：对话在 fork 时跳过整段，任务
  // 关闭后没用完的尾巴谁也不会再写。可跨，但三重保险缺一不可——
  // 任何一条不满足都意味着缝里有内容、跨过去会静默丢历史：
  // ① 缝里没有被【新节点的 covers】罩住的摘要行：有摘要就有被它盖着
  //    的历史，消息行可能还已被 applyPendingMerges 整删——跨过去后
  //    新节点的 covers 罩住它，coversActive 把它收掉，而它的内容没
  //    进新节点的 text。判据不是「缝里没有任何行」——**罩着缝两侧
  //    的上层节点**也跟缝相交，那样判会把空缝全锁死：真库 L2 大节点
  //    （covers 1–663613）罩住老区所有空缝，五条空缝全部不可跨，
  //    金字塔永久碎着、索引区悬在配额上方 53%（2026-09-25 实测
  //    18243/11900，事件 pickmergegroup-gap-crossing）。精确口径：
  //    会出事的只有「完整落进本次合并组跨度 [本组首成员, next] 里」
  //    的行——跨过缝两侧的上层节点至少一端伸出跨度外，新节点罩不
  //    住它，放行。跨度用当前 run 的首成员：run 比 mergeFactor 长
  //    时实际只合前 mergeFactor 条，这里判得更宽 = 更保守，安全
  // ② 缝里没有可见消息行：未摘要的活内容（如前沿段）会被新节点的
  //    covers 罩住，装配的 findCovering 从此不渲染原文
  // ③ 缝里没有外主 steps：任务活着时它的 step 在缝里（owner 分治，
  //    ②查不见）——跨过去等它关闭合并回来，经历摘要落在新节点
  //    covers 里面被收掉，任务经历丢失。①② 由本函数/调用方各查
  //    一半：① 用手头的 summaries 纯查，②③ 走 store 的
  //    gapHasContent
  if (!gapHasContent) return false
  const from = last.coversTo
  const to = next.coversFrom
  if (
    summaries.some(
      (x) =>
        x.coversTo > from &&
        x.coversFrom < to &&
        x.coversFrom >= spanFrom &&
        x.coversTo <= next.coversTo,
    )
  )
    return false
  return !gapHasContent(from, to)
}

/**
 * 把一组摘要渲染成给合并模型看的文本：逐条「step 范围 + 详情路径 + 摘要」。
 *
 * 路径要带上——L1 的职责之一是记住「展开去哪找」（§9.6），不给它路径它就
 * 只能复述 L0 里恰好提到的。**指的是叶子文件**（`summaries/*.md`），跟
 * `renderSummary` 同一个口径：那才是下一档分辨率，raw 归档要再往下一跳。
 *
 * 标签写 `step` 不是 `turn`：`covers_from/to` 从 B 那次起就是 step id 了
 * （一个大 turn 会切成几段，每段一条摘要）。标错的后果是模型把 step 号当
 * turn 号写进路由行，读的人照着去 `turns/turn-00xxxx.jsonl` 找会扑空。
 */
export function renderMergeInput(members: Summary[]): string {
  return members
    .map((s) => {
      const where = s.archivePath ? `\n详情：${s.archivePath}` : ''
      return `[step ${s.coversFrom}-${s.coversTo}]${where}\n${s.text}`
    })
    .join('\n\n')
}

/**
 * L1+ 的指令。**要的是目录里的一行，不是一段摘要**（提案 §3.2）。
 *
 * B+ 树的内部节点存分隔键，不存子树的摘要——它不试图总结左子树讲了什么，
 * 只说往哪走。读者（模型）拿这一行只做一件事：判断自己要找的东西在不在这段
 * 里，在就去 `cat` 原文。所以**关键词比通顺重要**。
 *
 * 上一版要的是「控制在一段话以内」的散文。那正是 §1.3 里 L3 退化成「无内容
 * 可提炼」的写法：「这段历史做了很多重构和修复」读着顺，但定位不到任何一轮。
 *
 * 改成路由行之后**写错的代价性质变了**（§3.2 的对照表）：压缩写错是内容
 * 永久丢失，路由写错只是找起来绕一下，正文一个字没少——叶子和归档都还在。
 *
 * 仍然调一次模型，这不矛盾：§4.6 的事件 E 本来就是「是（一次，永久）」。
 * 不调模型的是事件 D（热区降级成键），因为键在 B 那次已经和正文一并生成了。
 */
const MERGE_SYSTEM =
  '你在为一段项目历史写**索引目录**，不是写摘要。\n' +
  '读者拿它只做一件事：判断自己要找的东西在不在这段里，在就去展开原文。\n' +
  '所以要关键词，不要句子。每行一个主题，格式：\n' +
  '\n' +
  '<这段的主题>：<关键词> · <关键词> · <关键词>\n' +
  '\n' +
  '例：UI 排版修复：折叠动画、流式 CSS、消息页脚\n' +
  `**总长不超过 ${INDEX_LINE_MAX_CHARS} 字，输入再多也不许超**：这是往上一层归并，` +
  '信息必须比输入少——主题相近的并成一行，次要的关键词删掉，不要逐条照抄输入。\n' +
  '关键词优先用文件名、命令、专有名词——那是能被搜到的东西。\n' +
  '后来被推翻的结论也留一个词并标「(已推翻)」，那是后面最需要知道的。\n' +
  '不要完整句子，不要「本段历史进行了……」这类开场，不要引号。'

/** 组装合并请求。跟 L0 一样：不带工具、关 thinking */
export function buildMergeRequest(
  membersText: string,
  base: Omit<Request, 'messages' | 'system' | 'tools'>,
): Request {
  return {
    ...base,
    system: MERGE_SYSTEM,
    tools: [],
    thinking: 'disabled',
    messages: [{ role: 'user', parts: [{ type: 'text', text: membersText }] }],
  }
}

/**
 * 摘要进场判定（compaction-v2 §0.4/§0.5，2026-09-24 拍板）——**只搭压缩点
 * 的车**（前缀不变式：进场改写前缀中段）。
 *
 * 三层从新往旧：保底区（floorStart 起，原文全保真）→ 存根区（保底上方
 * 最多 stubSteps 个 step **且** 最多 stubTokens，先到先停）→ 区外段摘要行进场。
 *
 * **判据是位置制，不是水位**：2026-09-12 的水位闸（存根段超 16k 才进场）
 * 在 v2 的节奏下退役——四趟车都卸后每趟只新卸一小段增量，水位几乎永远
 * 不再冲高，判据永远不开、老段摘要进不来（这正是 v2 要治的病）。改从
 * 保底往上**数实际存在的 step**定界：fork 的预留号段缝（号段跳号的空洞）
 * 数不进去——按「段尾之后又过几步」做减法的话，fork 缝会把几步虚报成几万步。
 *
 * 进场条件：段的 live 消息**全部**在存根区天花板之外（更老）。跨在
 * 天花板上的段不进——半存根半摘要没有意义，等它整段老化出界。
 * activateSummary 自带段头已卸校验（推进线没到过的段顶了会抢跑吞掉
 * 还在场的原文），这里不重复判。
 *
 * 区外还有 step 没被任何摘要盖住 → kick 催一把（不阻塞本轮，
 * summarizeIdle 自带并发闸）
 */
export function activateBeyondStubZone(opts: {
  live: LiveMessage[]
  /** 保底区第一条消息的下标（run.ts floorStartIndex 的产出） */
  floorStart: number
  stubSteps: number
  stubTokens: number
  summaries: () => Summary[]
  activateSummary: (stepId: number) => boolean
  kick?: () => void
}): void {
  const ceiling = stubCeiling(opts.live, opts.floorStart, opts.stubSteps, opts.stubTokens)
  const all = opts.summaries()
  const ready = all.filter((s) => s.status === 'ready' && !s.inContext && s.supersededBy === null)
  const liveIn = (s: Summary) =>
    opts.live
      .map((entry, index) => ({ index, stepId: entry.stepId }))
      .filter((e) => e.stepId >= s.coversFrom && e.stepId <= s.coversTo)

  // **孤儿段：段内一条 live 都没有、摘要又不在场**（2026-09-28 真库 409 步
  // 空洞）。来源已查实：**关闭任务留下的尾巴**——任务关闭时还是原文的那段，
  // flipTaskLive 把原文全卸、摘要还俗但从没进过场，停在 in_context=0（真库
  // 两段孤儿 663622-663686、714065-714410 恰是 task-4f6pqq/ws12fr 段尾）。
  // 下面「段内 live 全在区外」要求 indices 非空，这种段永远满足不了，模型对
  // 那几小时一无所知、也没有任何线索去 cat。它们比一切 live 都老，与存根区
  // 位置无关，所以放在 ceiling 判断之前。端到端钉在 task.test.ts「关闭任务
  // 留下的尾巴」。
  //
  // 只防一件事：与在场摘要重叠（重复顶替同一段）。高层优先——同一段有 L1
  // 和未合并的 L0 并存时，先进 L1，L0 随之被判重叠
  const active = all.filter((s) => s.inContext).map((s) => [s.coversFrom, s.coversTo] as const)
  const overlapsActive = (s: Summary) => active.some(([from, to]) => from <= s.coversTo && to >= s.coversFrom)
  const orphans = ready.filter((s) => liveIn(s).length === 0).sort((a, b) => b.level - a.level || a.coversFrom - b.coversFrom)
  for (const summary of orphans) {
    if (overlapsActive(summary)) continue
    if (opts.activateSummary(summary.coversFrom)) active.push([summary.coversFrom, summary.coversTo])
  }

  if (ceiling === 0) return
  for (const summary of ready) {
    // 段内 live 消息全在 ceiling 之外（下标更小 = 更老）才进场
    const indices = liveIn(summary)
    if (indices.length > 0 && indices.every((e) => e.index < ceiling)) {
      opts.activateSummary(summary.coversFrom)
    }
  }
  // 区外还有 step 没被任何（未失效的）摘要盖住——在等自己的 L0，催一把。
  // 只认未失效的行：superseded 的段由它的链根负责，别替它们 kick
  const covered = new Set<number>()
  for (const s of opts.summaries()) {
    if (s.supersededBy !== null) continue
    for (let id = s.coversFrom; id <= s.coversTo; id++) covered.add(id)
  }
  const uncovered = opts.live.some((entry, index) => index < ceiling && !covered.has(entry.stepId))
  if (uncovered) opts.kick?.()
}

/**
 * 存根区天花板的下标：live[ceiling..floorStart) 是存根区，比 ceiling 更老
 * 的（下标更小）都在区外。从保底往上（下标递减）数，两个上界先到先停。
 */
function stubCeiling(
  live: LiveMessage[],
  floorStart: number,
  stubSteps: number,
  stubTokens: number,
): number {
  let steps = 0
  let tokens = 0
  let lastStep: number | null = null
  for (let i = floorStart - 1; i >= 0; i--) {
    const entry = live[i]
    if (!entry) continue
    // 按 step 数，不按 turn（2026-09-28 纠偏：用户 9-24 原话「保底区往上再数
    // 30 个组 tool call」，并否决 turn——一个 turn 常有 20~50 次工具调用，
    // 30 turn 永远到不了、实际只剩 16k 界在管）。新的 step：已装满就停在门口
    if (entry.stepId !== lastStep) {
      if (steps >= stubSteps) return i + 1
      steps++
      lastStep = entry.stepId
    }
    tokens += estimateMessageTokens(entry.message.parts)
    // 这条把区撑到 stubTokens——它自己算区外，先到先停
    if (tokens >= stubTokens) return i + 1
  }
  return 0
}

