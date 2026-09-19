import { estimateMessageTokens } from './tokens.ts'
import type { Message, Part, Request } from '../llm/types.ts'
import type { LiveMessage, Summary } from './assemble.ts'

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
  '描述: <一两句话说明做了什么、结果如何>\n' +
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

/** 一个可合并的组：同层、连续、都已生效的一批摘要 */
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
 *
 * 四个条件各有理由：
 * - **代表 context**（见 representsContext）：合并的是「context 正在用的
 *   （或级联中即将顶替进来的）」那批。子树全没生效的行不在 context 里，
 *   把它并进来会让上层摘要声称覆盖一段模型从没见过的历史
 * - **ready**：占位文本（pending/generating）没有内容可压，并进去等于让
 *   模型给一段「（摘要生成中）」写摘要
 * - **supersededBy = null**：已经被上层吃掉的不能再吃一次。正常流程到不了
 *   非 null 还 inContext 的状态（apply 会一起翻掉），这条是防御
 * - **连续**（covers_to + 1 == 下一个的 covers_from）：中间有洞的话 L1 的
 *   覆盖区间会把洞盖进去，apply 时拼装的 findCovering 会吞掉洞里那个 turn
 *   的 live 消息——历史凭空消失，不报错。**正常流程下洞不存在**（卸载严格
 *   从最老开始，inContext 的 L0 天然是前缀），但实现不能默默依赖它，
 *   校验断了就返回 null（不合这批），下次空闲再看
 *
 * 返回 null = 没有可合并的。
 */
export function pickMergeGroup(summaries: Summary[], mergeFactor: number): MergeGroup | null {
  const eligible = indexMembers(summaries)
  const levels = [...new Set(eligible.map((s) => s.level))].sort((a, b) => a - b)

  for (const level of levels) {
    // covers_from 升序。同层连续段从这里才谈得上「最老的优先」
    const layer = eligible
      .filter((s) => s.level === level)
      .sort((a, b) => a.coversFrom - b.coversFrom)

    let run: Summary[] = []
    // **只吃 mergeFactor 条，不吃整段。** 原来是 `run.slice()`——积压越多一次
    // 吞得越狠，真库里 25 条连续 L0 被一次合成一行。扇出是个常数，不该随
    // 「后台摘要攒了多少还没合」浮动
    const flush = (): MergeGroup | null => {
      if (run.length >= mergeFactor) return { level, members: run.slice(0, mergeFactor) }
      return null
    }

    for (const summary of layer) {
      const last = run[run.length - 1]
      // 连续才延长；断了先看前一段够不够，够就地返回，不够从当前重新数
      if (last && summary.coversFrom === last.coversTo + 1) {
        run.push(summary)
      } else {
        const done = flush()
        if (done) return done
        run = [summary]
      }
    }
    const done = flush()
    if (done) return done
  }
  return null
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
  '你在为一段项目历史写**索引目录的一行**，不是写摘要。\n' +
  '读者拿这一行只做一件事：判断自己要找的东西在不在这段里，在就去展开原文。\n' +
  '所以要关键词，不要句子。格式：\n' +
  '\n' +
  '<这段的主题>：<关键词> · <关键词> · <关键词>\n' +
  '\n' +
  '例：UI 排版修复：折叠动画、流式 CSS、消息页脚\n' +
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
 * 存根段水位检查——三级递进的第二级核心（2026-09-12 拍板）。
 *
 * 原文 →（触发线）存根 →（本函数）摘要进场。摘要在手也不急着用：存根比
 * 摘要便宜地保留真实头部文本，只有装配后的存根段超过 `stubTokens`（默认
 * 16k，与 floorTokens 同量级）才让最老的 ready 摘要翻 `in_context` 进场
 * 顶替。这条线之前的行为是「卸载时 ready 的当场顶替」（两级绑死），连续
 * 使用中 idle 摘要跟不上时 floor 外原文全文堆积（实测 121k 未卸载）——解绑后触发线一到原文就塌缩成存根，窗口控制不再依赖
 * 摘要进度。
 *
 * **进场时机有两个调用方**（都汇到这）：run 循环发请求前（runStep），和
 * 摘要生成完成后（session 的 idle 链尾）。缺第二个的话，idle 里刚生成的
 * L0 要等到下一次用户消息才有机会进场，纯 idle 时段索引区冻结（merge-e2e
 * 的级联用例当场抓到）。
 *
 * 激活顺序最老优先；`activateSummary` 只认段头已卸的段（段头没卸说明推进
 * 线没到过，顶了会吞掉还在场的 live 原文）。全激活完仍超线 = 没有更多
 * ready 摘要了 → kick 主动催一次（不阻塞，summarizeIdle 自带并发闸）。
 *
 * 每激活一条重新装配算水位：激活顶替掉的是它 covers 的整个 step 区间，
 * 增量算容易和 covers 的边界口径漂，装配口径是唯一不会错的。ready 摘要
 * 十几条的量级，循环成本可忽略
 */
export function drainStubWater(opts: {
  /** 装配出「要发出去的那份」+ 每条消息的 step 归属。水位必须是装配口径
   * ——顶替判断和请求同一把尺子 */
  assemble: () => { messages: Message[]; stepOf: Map<Message, number> }
  stubTokens: number
  summaries: () => Summary[]
  activateSummary: (stepId: number) => boolean
  /** 已卸 step 集合——滞留的判定键 */
  unloadedSteps: () => Set<number>
  kick?: () => void
}): void {
  // **滞留 = 装配后 step 已卸但摘要未顶替的内容**（存根和裁不动的原文都算）。
  // 只算存根的旧口径有个洞：纯文本段裁不动、没有存根形态，不把它算上的话
  // 触发卸载后它原文全文在场，token 一点不降（merge-e2e 纯文本夹具当场抓到）
  const water = (): number => {
    const unloaded = opts.unloadedSteps()
    const { messages, stepOf } = opts.assemble()
    let sum = 0
    for (const message of messages) {
      const stepId = stepOf.get(message)
      if (stepId !== undefined && unloaded.has(stepId)) {
        sum += estimateMessageTokens(message.parts)
      }
    }
    return sum
  }
  if (water() <= opts.stubTokens) return
  const ready = opts
    .summaries()
    .filter((s) => s.status === 'ready' && !s.inContext && s.supersededBy === null)
    .sort((a, b) => a.coversFrom - b.coversFrom)
  // coversFrom 是段的第一个 step，activateSummary 按它定位段
  for (const summary of ready) {
    if (water() <= opts.stubTokens) break
    opts.activateSummary(summary.coversFrom)
  }
  // 水位仍超线：没有 ready 摘要可顶了，剩下的滞留在等自己的 L0——催一把
  if (water() > opts.stubTokens) opts.kick?.()
}

