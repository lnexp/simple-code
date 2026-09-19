import type { AgentEvent, HydratePart, Message } from '@simple-code/core'

/**
 * `AgentEvent` 流折叠成界面要渲染的东西。**纯函数，不碰 DOM。**
 *
 * 墙钟（startedAt/endedAt）从外面传进来（reduce 的第三个参数）：事件
 * **到达宿主时**打的时间戳随事件一起走。同一个事件流无论 reduce 多少
 * 次、在哪个进程里 reduce，时间戳都一致——宿主镜像重放（bridge 的
 * mirrorItems）因此幂等，切回目录时 hydrate 出来的秒表是真实起点。
 * 测试因此不断言时间值，只断言「有没有」。
 *
 * 拆出来不是为了「可能换 UI 框架」的灵活性，是为了可测：这一层的 bug 全都
 * 不抛异常，只是内容错（气泡该清没清、工具输出配错命令），必须能喂事件序列
 * 断言结果。React 组件因此不用测。见 vscode-impl.md §7
 */

/** 跟 core 的 ImageInput 同构。不 import core 是有意的：webview 只认识
 * vscode.ts 的 post/协议类型，保持依赖单向（见 tsconfig.webview.json 注释） */
export type ImageRef = { data: string; mimeType: string }

export type ChatItem =
  | { kind: 'user'; text: string; images?: ImageRef[] }
  | {
      kind: 'assistant'
      text: string
      /**
       * 本轮结束的墙钟，`finish` 到达时记。**只有本轮最后一条 assistant
       * 消息有**——页脚就挂在它下面（footer 只出现在一轮的末条）。
       * 中断/报错时 finish 仍会到，所以不会出现永远没有页脚的消息
       */
      finishedAt?: number
      /** 从用户发出到本轮结束的耗时。turnStartedAt 缺失时不显示，不猜 */
      elapsedMs?: number
      /** 本轮结束时的模型（provider/name）。切换模型不会改写已完成的轮次 */
      model?: string | null
    }
  | {
      kind: 'reasoning'
      text: string
      /**
       * 同 tool 行：startedAt 建块时记，endedAt 在 reasoning_end 记。
       * 历史回放（hydrate）时 startedAt 缺失——折叠头的时长那一栏直接不渲染
       */
      startedAt?: number
      endedAt?: number
    }
  | {
      kind: 'tool'
      id: string
      name: string
      command: string
      output: string
      failed: boolean
      /**
       * tool_input_start 的墙钟（ms）。**endedAt 未定义 = 还在跑**——
       * 运行中和完成的显示形态不同（spinner vs 结果行），渲染层靠这个分流。
       * **历史回放（hydrate）时两个都没有**：没有 spinner 也不算时长，
       * 只显示命令和输出——墙钟是过程信息，库里的消息只有定稿结果
       */
      startedAt?: number
      /** tool_result / tool_error 到达的时刻。跑完才有 */
      endedAt?: number
      /** 缩略图 data URL（256px JPEG，core 侧缩好）。webfetch 抓图用 */
      images?: string[]
    }
  /** 归档提示之类的系统说明，不是对话内容。error 落下来的 notice 带
   * errorKind/retryable——UI 据此标色、给重试按钮 */
  | { kind: 'notice'; text: string; errorKind?: string; retryable?: boolean }

export type ChatView = {
  items: ChatItem[]
  /**
    * 上次请求的观测面板（底栏那行）。timing 事件给时延、step_finish 给
    * in/out——两个事件各补一半，后到的合并不覆盖先到的一半
    */
  lastTiming: { ttftMs: number; totalMs: number; inputTokens: number; outputTokens: number } | null
  /**
   * 当前上下文占用。**取最后一步的输入量，不是累加**——累加的是「一共发了
   * 多少」，跑几轮就会显示超过 100%（cli/render.ts 里同样的坑）。
   *
   * 直接用 core 报的 `contextTokens`（下一轮要发多少），**不要自己拿 usage
   * 折算**：那个数滞后一轮、也不含上一轮响应之后新增的工具结果，跟归档的
   * 触发线不是一回事。一度这么显示，症状是「上下文才 126k、离 238k 还远，
   * 却弹了归档提示」
   */
  contextTokens: number
  /**
   * 本轮开始的墙钟，用户点发送时由 App 记（reduce 看不到用户消息，它是
   * 直接 append 进 items 的）。`finish` 时算出耗时后置回 null——不置回的话
   * 下一轮会拿上一轮的起点算，耗时越跑越大
   */
  turnStartedAt: number | null
}

export const emptyView = (): ChatView => ({
  items: [],
  lastTiming: null,
  contextTokens: 0,
  turnStartedAt: null,
})

/** 毫秒 → 人话：843ms / 1s / 8.4s（一位小数去尾零） */
export const fmtMs = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : `${parseFloat((ms / 1000).toFixed(1))}s`

/** token → 人话：850 / 1k / 45.2k / 96k */
export const fmtTok = (n: number): string =>
  n < 1000 ? `${n}` : `${parseFloat((n / 1000).toFixed(1))}k`

export function reduce(view: ChatView, agentEv: AgentEvent, now: number): ChatView {
  switch (agentEv.type) {
    // bridge 拦下不透传（拆成独立的 bg_processes 宿主消息）。类型上仍要
    // 认识它：reduce 是 AgentEvent 的穷尽 switch，漏一个编译就炸——
    // 这里返回原 view，万一未来有路径漏拦也不至于丢消息
    case 'bg_processes':
      return view
    case 'text_start':
      return append(view, { kind: 'assistant', text: '' })
    case 'text_delta':
      return appendText(view, 'assistant', agentEv.text, now)
    case 'reasoning_start':
      return append(view, { kind: 'reasoning', text: '', startedAt: now })
    case 'reasoning_delta':
      return appendText(view, 'reasoning', agentEv.text, now)

    case 'tool_input_start':
      return append(view, {
        kind: 'tool',
        id: agentEv.id,
        name: agentEv.name,
        command: '',
        output: '',
        failed: false,
        startedAt: now,
      })
    case 'tool_call':
      return withTool(view, agentEv.id, agentEv.name, now, (tool) => ({
        ...tool,
        command: commandOf(agentEv.input),
      }))
    case 'tool_result':
      return withTool(view, agentEv.id, 'bash', now, (tool) => ({
        ...tool,
        output: agentEv.output,
        failed: agentEv.exitCode !== 0,
        endedAt: now,
        ...(agentEv.images ? { images: agentEv.images } : {}),
      }))
    case 'tool_error':
      return withTool(view, agentEv.id, 'bash', now, (tool) => ({
        ...tool,
        output: agentEv.message,
        failed: true,
        endedAt: now,
      }))

    case 'restart':
      // 请求整个重发了，本轮已经吐的作废。**必须真的删掉**——留着的话
      // 第二次的文本会拼在后面，同一段话出现两遍（events.ts 的注释）
      return { ...view, items: dropTrailingAssistant(view.items) }

    case 'unloaded': {
      // 文案按触发原因分开（方案 A）：budget 才真的是「接近上限」；
      // stale 是缓存过期搭车压缩，预算没超也说「接近上限」是误导
      // （实测 raw 14% 也这么喊过）；force 是超限自救、连保底区一起卸
      const text =
        agentEv.reason === 'stale'
          ? `刚才这发缓存已过期、横竖全价，顺手把最早的 ${agentEv.count} 条归档了，之后基数更小`
          : agentEv.reason === 'force'
            ? `超出模型上限，紧急归档 ${agentEv.count} 条（含最近上下文）`
            : `上下文接近上限，最早的 ${agentEv.count} 条已归档到磁盘，模型需要时会自己读回来`
      return append(view, { kind: 'notice', text })
    }

    case 'step_finish':
      return {
        ...view,
        contextTokens: agentEv.contextTokens,
        lastTiming: {
          ...(view.lastTiming ?? { ttftMs: 0, totalMs: 0 }),
          inputTokens: agentEv.usage.inputTokens,
          outputTokens: agentEv.usage.outputTokens,
        },
      }

    case 'request_timing':
      return {
        ...view,
        lastTiming: {
          ...(view.lastTiming ?? { inputTokens: 0, outputTokens: 0 }),
          ttftMs: agentEv.ttftMs,
          totalMs: agentEv.totalMs,
        },
      }

    case 'error':
      return append(view, {
        kind: 'notice',
        text: agentEv.message,
        ...(agentEv.kind ? { errorKind: agentEv.kind } : {}),
        ...(agentEv.retryable ? { retryable: true } : {}),
      })

    // 这些不改变界面模型：
    // - text_end：气泡的结束由「下一个 start」决定，不需要标记
    //   （reasoning_end 例外：它记墙钟给折叠头的时长用，见上）
    // - tool_input_delta：攒参数的中间态，攒完的 tool_call 才有意义
    // - truncated：**故意什么都不做**。它是续写，前面的内容仍然有效，
    //   清空的话前半段凭空消失。跟 restart 相反，搞混了不报错
    case 'reasoning_end':
      // 用户中断时这个事件不一定到达——渲染层对「不是最后一条且无 endedAt」
      // 的块按已结束处理（vibrate 不出负时长即可，见 App.tsx 的 durationOf）
      return patchLast(view, (r) => ({ ...r, endedAt: now }))

    case 'text_end':
    case 'tool_input_delta':
    case 'truncated':
      return view
  }
}

/**
 * 一轮结束：给最后一条 assistant 消息记上完成时刻和耗时，供页脚显示。
 *
 * **由 App 在 `running` true→false 时调，不是 reduce 里的某个 case。**
 * AgentEvent 的 `finish` 从来不会到达（见 reduce 里那条注释）。用 running
 * 回落做信号还有个额外好处：中断和报错也走 bridge 的 finally，页脚照样出。
 *
 * **从后往前找 assistant，找不到就只清 turnStartedAt。** 一轮可以在工具
 * 之后就结束（用户中断），那时没有能挂页脚的消息；硬记到最后一条上会把
 * 时间戳写进工具行，页脚不会出现但数据是错的
 *
 * `interrupted` 时追加一条 notice。**中断原来什么条目都不产生**（bridge 的
 * finally 只把 running 置 false），于是第三层折叠一收，这一轮看起来就是
 * 「问了一句、什么都没发生」。原因写成独立 notice 而不是塞进折叠头：
 * `splitTurns` 的保留区本来就把尾部 notice 留在外面，折叠头因此保持
 * 「处理过程 · N 个操作 · 耗时」一种形态，不随结束方式变形
 */
export function finishTurn(
  view: ChatView,
  interrupted = false,
  /** 本轮用的模型，调用方在**结束时刻**取当时值——之后切换不改写它 */
  model: string | null = null,
  /** 墙钟从外面传（reduce 同款）。有默认值：finishTurn 只在 state 消息
   * 到达时实时跑一次，不进镜像重放，不存在「重放取假钟」的问题 */
  now: number = Date.now(),
): ChatView {
  const at = view.items.findLastIndex((item) => item.kind === 'assistant')
  const stopped: ChatItem[] = interrupted ? [{ kind: 'notice', text: '已中断' }] : []
  if (at === -1) return { ...view, items: [...view.items, ...stopped], turnStartedAt: null }
  const items = [...view.items]
  items[at] = {
    ...(items[at] as Extract<ChatItem, { kind: 'assistant' }>),
    finishedAt: now,
    model,
    // turnStartedAt 为空时不给 elapsedMs——宁可不显示耗时也不显示一个编的
    ...(view.turnStartedAt === null ? {} : { elapsedMs: now - view.turnStartedAt }),
  }
  return { ...view, items: [...items, ...stopped], turnStartedAt: null }
}

/**
 * 宿主权威页脚覆盖（state 消息的 footer 字段，收口那次才有）。
 * finishTurn 用的是 webview 内存里的 turnStartedAt——面板中途重开
 * （hydrate）它就是 null，页脚出不来耗时；宿主从 send 记到 finally，
 * 不受重开影响。null model 不覆盖：宿主没拿到时别抹掉本地已有的
 */
export function patchFooter(
  view: ChatView,
  footer: { model: string | null; finishedAt: number; elapsedMs: number },
): ChatView {
  const at = view.items.findLastIndex((item) => item.kind === 'assistant')
  if (at === -1) return view
  const items = [...view.items]
  items[at] = {
    ...(items[at] as Extract<ChatItem, { kind: 'assistant' }>),
    finishedAt: footer.finishedAt,
    elapsedMs: footer.elapsedMs,
    ...(footer.model === null ? {} : { model: footer.model }),
  }
  return { ...view, items }
}

/**
 * 最后一条是 reasoning 就就地更新（reasoning_end 记墙钟用），不是就原样
 * 返回——reasoning_end 对应的永远是最新 append 的那个块，不需要往前找
 */
const patchLast = (
  view: ChatView,
  patch: (item: Extract<ChatItem, { kind: 'reasoning' }>) => ChatItem,
): ChatView => {
  const last = view.items.at(-1)
  if (last?.kind !== 'reasoning') return view
  return { ...view, items: [...view.items.slice(0, -1), patch(last)] }
}

const append = (view: ChatView, item: ChatItem): ChatView => ({
  ...view,
  items: [...view.items, item],
})

/**
 * 往最后一条同类条目上追加文本。类型对不上就新建一条——`text_delta` 先于
 * `text_start` 到达是不该发生的，但真发生时新建一条比丢掉强
 */
function appendText(
  view: ChatView,
  kind: 'assistant' | 'reasoning',
  text: string,
  now: number,
): ChatView {
  const last = view.items.at(-1)
  if (last?.kind !== kind) {
    // reasoning 走这里 = delta 抢在 start 前面（不该发生），墙钟记当前
    return append(
      view,
      kind === 'reasoning' ? { kind, text, startedAt: now } : { kind, text },
    )
  }
  return {
    ...view,
    items: [...view.items.slice(0, -1), { ...last, text: last.text + text }],
  }
}

/**
 * 改 id 对应的那条工具记录。**按 id 找，不是取最后一条**——协议层允许并行
 * 工具调用，按顺序落会把输出配错命令，界面上看起来「执行 ls 输出了 pwd 的
 * 结果」，不报错
 */
function withTool(
  view: ChatView,
  id: string,
  name: string,
  now: number,
  patch: (tool: Extract<ChatItem, { kind: 'tool' }>) => ChatItem,
): ChatView {
  const index = view.items.findIndex((i) => i.kind === 'tool' && i.id === id)
  if (index === -1) {
    // 没有 tool_input_start 就直接来 tool_call 的情况（非流式的协议）
    const fresh: Extract<ChatItem, { kind: 'tool' }> = {
      kind: 'tool',
      id,
      name,
      command: '',
      output: '',
      failed: false,
      startedAt: now,
    }
    return append(view, patch(fresh))
  }
  const target = view.items[index]
  if (target?.kind !== 'tool') return view
  const items = [...view.items]
  items[index] = patch(target)
  return { ...view, items }
}

/** 从尾部往前删掉本轮的 assistant/reasoning 气泡，删到工具或用户消息为止 */
function dropTrailingAssistant(items: ChatItem[]): ChatItem[] {
  let end = items.length
  while (end > 0) {
    const kind = items[end - 1]?.kind
    if (kind !== 'assistant' && kind !== 'reasoning') break
    end--
  }
  return items.slice(0, end)
}

/** bash 工具的参数里取命令。其他工具或参数不合预期时留空，不猜 */
function commandOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const command = (input as { command?: unknown }).command
  return typeof command === 'string' ? command : ''
}

/**
 * 条目按渲染分块：user/assistant/notice 各自成块，**连续的 reasoning|tool
 * 归成一个「活动组」**——一轮的思考和执行过程，assistant 正文出现时整组
 * 自动收起（vscode-chat-ux.md D13 用户的补充需求）。分组是纯函数，组开合
 * 是 React 本地态（D15），两者分开测
 */
export type ActivityItem = Extract<ChatItem, { kind: 'reasoning' | 'tool' }>

/**
 * 独立成块的条目——**「不进活动组的都算」**，不是列举 user/assistant/notice。
 * 这样将来加新 kind 时，它自动走单块渲染（和 groupItems 的 else 分支一致），
 * 不会因为忘了更新这个联合而被静默漏掉。
 *
 * 第二个参数必须是 `ActivityItem` 这样的**对象类型**。写成
 * `Exclude<ChatItem, 'tool' | 'reasoning'>`（字符串字面量）时什么都排除不掉
 * ——对象类型不可能 assignable 到字符串，结果等于 `ChatItem` 本身，
 * 渲染层拿到 tool/reasoning 也不会报错，只是 switch 落空渲染出空白
 */
export type SingleItem = Exclude<ChatItem, ActivityItem>

export type Block =
  | { kind: 'single'; item: SingleItem }
  | { kind: 'activity'; items: ActivityItem[] }

export function groupItems(items: ChatItem[]): Block[] {
  const blocks: Block[] = []
  let group: ActivityItem[] = []
  const flush = () => {
    if (group.length > 0) {
      blocks.push({ kind: 'activity', items: group })
      group = []
    }
  }
  for (const item of items) {
    if (item.kind === 'reasoning' || item.kind === 'tool') group.push(item)
    else {
      flush()
      blocks.push({ kind: 'single', item })
    }
  }
  flush()
  return blocks
}

/**
 * 组头和折叠头的条数口径：**只数工具，不数 thinking**。
 *
 * 活动组头原来是 `items.length`，而 `ActivityItem = reasoning | tool`——
 * 所以「2 个操作」很可能是 1 次思考 + 1 条命令，「操作」这个词名不副实。
 * 第三层折叠也要报条数，两处口径不一致会当场露馅：外层说 34、点开把内层
 * 加起来是 41。收成一个函数，就不会只改一头
 */
export const toolCount = (items: readonly ActivityItem[]): number =>
  items.filter((item) => item.kind === 'tool').length

/**
 * 第三层折叠的渲染单元。`at` 是它在原 `Block[]` 里的下标——渲染层靠
 * 「是不是最后一块」决定 spinner 和流式节流，折完之后下标会乱，所以带着走
 */
export type Section =
  | { kind: 'block'; block: Block; at: number }
  | { kind: 'process'; blocks: Block[]; tools: number; elapsedMs?: number }

const isUserBlock = (block: Block): boolean => block.kind === 'single' && block.item.kind === 'user'
const isNoticeBlock = (block: Block): boolean =>
  block.kind === 'single' && block.item.kind === 'notice'
const isAssistantBlock = (block: Block): boolean =>
  block.kind === 'single' && block.item.kind === 'assistant'

/**
 * 轮的边界。**用 user 条目，不用 `finishedAt`**——后者只有实时那一轮有，
 * `hydrateItems` 回放历史时不写，拿它做边界的话往上翻的历史一轮都折不起来，
 * 而历史恰恰是最需要折的地方。
 *
 * 开头那段（分页截断出来的半轮）也算一轮，不然它永远折不了
 */
function turnStarts(blocks: Block[]): number[] {
  const starts = blocks.flatMap((block, at) => (isUserBlock(block) ? [at] : []))
  if (blocks.length > 0 && starts[0] !== 0) starts.unshift(0)
  return starts
}

/**
 * 第三层折叠：一轮结束后把「过程」收成一行，只留最终回答。
 *
 * 两层折叠（单条工具行 / 活动组）解决不了的是**一轮里有 N 个活动组**——
 * 模型一边干活一边说话，`groupItems` 只合并连续的 reasoning|tool，于是变成
 * 「说明 → 3 个操作 → 说明 → 10 个操作 → …」，中间那些说明一个字都不折。
 *
 * **保留区的判法不看「这轮为什么结束」，只看形状**：从末尾往前跳过 notice，
 * 再取一条 assistant 正文。四种结束方式自动都对：
 *
 * | 怎么结束的 | 留在外面 |
 * |---|---|
 * | 正常 | 最终回答 |
 * | 中断在命令中间 | 只有「已中断」那行 |
 * | 中断在回答中间 | 半截回答 + 「已中断」（用户正在读它） |
 * | 报错 | 「出错了：…」——**错误绝不能被折进去** |
 *
 * 正常结束时最终回答后面**结构上不可能有工具调用**：loop 的退出条件含
 * `!lastTurnCalledTools`（run.ts 的 shouldExit），最后一条 assistant 带
 * tool_call 就必然再跑一轮。所以不需要「回答之后又有工具」那种特判。
 *
 * @param foldLast 最后一轮折不折。跑着的时候不折——过程就是用户要看的东西
 */
export function splitTurns(blocks: Block[], foldLast: boolean): Section[] {
  const starts = turnStarts(blocks)
  const sections: Section[] = []
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1] ?? blocks.length
    const body = isUserBlock(blocks[start] as Block) ? start + 1 : start
    if (body > start) sections.push({ kind: 'block', block: blocks[start] as Block, at: start })

    let keep = end
    while (keep > body && isNoticeBlock(blocks[keep - 1] as Block)) keep--
    if (keep > body && isAssistantBlock(blocks[keep - 1] as Block)) keep--

    const process = blocks.slice(body, keep)
    if (process.length > 0 && (foldLast || i < starts.length - 1)) {
      sections.push({
        kind: 'process',
        blocks: process,
        ...processMeta(process, blocks, keep, end),
      })
    } else {
      for (const [j, block] of process.entries())
        sections.push({ kind: 'block', block, at: body + j })
    }
    for (let at = keep; at < end; at++)
      sections.push({ kind: 'block', block: blocks[at] as Block, at })
  }
  return sections
}

/**
 * 折叠头要的两个数：工具调用条数、整轮耗时。
 *
 * 耗时直接取保留区里那条 assistant 的 `elapsedMs`（`finishTurn` 记的整轮
 * 时长），不另存一份。**回放的历史没有这个字段**——`hydrateItems` 不带
 * 时间戳，所以往上翻的旧轮只有条数没有耗时，这是已知的、故意不修的
 * （要修得动 schema 加迁移，为一个装饰性数字不值）
 */
function processMeta(
  process: Block[],
  blocks: Block[],
  keep: number,
  end: number,
): { tools: number; elapsedMs?: number } {
  const tools = process.reduce(
    (sum, block) => sum + (block.kind === 'activity' ? toolCount(block.items) : 0),
    0,
  )
  for (let at = keep; at < end; at++) {
    const block = blocks[at]
    if (block?.kind !== 'single' || block.item.kind !== 'assistant') continue
    if (block.item.elapsedMs !== undefined) return { tools, elapsedMs: block.item.elapsedMs }
  }
  return { tools }
}

/**
 * 存库消息尾巴上的卸载标记。两种形态（unload.ts）：文本版 `\n[已卸载，…]`，
 * shell 版 `\n# [已卸载，…]`（`#` 前缀防泄漏事故的产物）。
 *
 * **带标记 = 这是一条存根**：它的完整原文在 messages 表的 unloaded 行里，
 * 往上拉的历史分页会渲染全文。所以这里**整条跳过而不是剥掉标记渲染头部**
 * ——剥了渲染的话同一段内容出现两遍（下方一份截断的、上方一份全的），
 * 界面上像是模型把同一句话说了两次
 */
const STUB_MARKER = /\n?#? ?\[已卸载，完整内容见 [^\]]*\]$/

const isStub = (text: string): boolean => STUB_MARKER.test(text)

/**
 * 定稿消息（store 里的 canonical 格式）→ 界面条目。**历史回放的总入口**：
 * - 面板重开时的基线（bridge 把 `session.messages()` 折成 items 推过来）
 * - 往上拉的分页（`historyPage` 的行再过一遍这个函数）
 *
 * 跟 reduce 的区别：reduce 消费事件流（有墙钟、有中间态），这里只有定稿
 * 结果——**没有 startedAt/endedAt**，渲染层据此区分「历史」和「正在跑」
 * （activity.tsx 的 `live` 判定）。
 *
 * tool_call 和 tool_result 是两条消息（assistant 行 / tool 行），这里按
 * id 配对合成一条工具条目——跟协议层的流式配对（withTool）同一个道理，
 * 不配对的话界面上一个调用渲染成两行。**配对的任意一侧是存根，整条丢弃**
 * （见 STUB_MARKER 的注释）；用 Set 标记、最后统一滤掉，这样 result 先于
 * call 到达的反序数据也不会漏标
 */
export function hydrateItems(
  // parts 收宽两态：HistoryRow 原样（fold 路径，images 是 ImagePart[]——
  // 原图，webview 不显示）和 toHydrateRows 转换后的（images 是 256px
  // 缩略图 data URL——显示）。配对循环里按元素类型窄化
  rows: readonly (Omit<Message, 'parts'> & {
    parts: readonly (Message['parts'][number] | HydratePart)[]
    turnId?: number
    meta?: FooterMeta | null
    elapsedMs?: number | null
    finishedAt?: number | null
  })[],
): ChatItem[] {
  const items: ChatItem[] = []
  const stubbed = new Set<ChatItem>()
  /** 每轮第一行处理前 items 的长度——页脚在本轮区间内定位尾部 assistant */
  const turnStarts = new Map<number, number>()
  /** 每行处理**前** items 的长度（循环开头记，continue 跳不到）。行 i 的
   *  产出区间 = [rowStarts[i], rowStarts[i+1])；页脚在轮的区间内定位 */
  const rowStarts: number[] = []

  for (let r = 0; r < rows.length; r++) {
    rowStarts.push(items.length)
    const message = rows[r]
    if (!message) continue
    if (message.turnId !== undefined && !turnStarts.has(message.turnId)) {
      turnStarts.set(message.turnId, items.length)
    }
    if (message.role === 'user') {
      const images: ImageRef[] = []
      let text = ''
      for (const part of message.parts) {
        if (part.type === 'text') text += part.text
        else if (part.type === 'image') images.push({ data: part.data, mimeType: part.mimeType })
      }
      if (isStub(text)) continue // 存根：全文在上方历史里
      if (text === '' && images.length === 0) continue
      items.push({ kind: 'user', text, ...(images.length > 0 ? { images } : {}) })
      continue
    }

    if (message.role === 'assistant') {
      for (const part of message.parts) {
        if (part.type === 'text') {
          if (isStub(part.text) || part.text === '') continue
          items.push({ kind: 'assistant', text: part.text })
        } else if (part.type === 'reasoning') {
          if (isStub(part.text) || part.text === '') continue
          items.push({ kind: 'reasoning', text: part.text })
        } else if (part.type === 'tool_call') {
          const command = commandOf(part.input)
          const item: Extract<ChatItem, { kind: 'tool' }> = {
            kind: 'tool',
            id: part.id,
            name: part.name,
            command,
            output: '',
            failed: false,
          }
          items.push(item)
          if (isStub(command)) stubbed.add(item)
        }
      }
      continue
    }

    // tool 行：配对进已有的 tool_call 条目（按 id 找，不是取最后一条——
    // 并行调用的输出会配错命令，跟 withTool 同一个坑）
    for (const part of message.parts) {
      if (part.type !== 'tool_result') continue
      const target = items.findLast(
        (i): i is Extract<ChatItem, { kind: 'tool' }> =>
          i.kind === 'tool' && i.id === part.toolCallId,
      )
      // 缩略图：只有 toHydrateRows 转换过的行才有（string[] data URL）；
      // 原图 ImagePart[]（fold 路径直传）不显示——live 路径的 ChatItem.images
      // 一直是缩略图口径，历史回放对齐它
      const thumbs =
        part.images && (part.images.length === 0 || typeof part.images[0] === 'string')
          ? (part.images as string[])
          : undefined
      if (target) {
        target.output = part.output
        target.failed = part.isError
        if (thumbs) target.images = thumbs
        if (isStub(part.output)) stubbed.add(target)
      } else if (!isStub(part.output)) {
        // 孤儿 tool_result（配对的 assistant 行不在这一页）：照样渲染，
        // 命令空着——丢掉的话这条执行记录凭空消失
        items.push({
          kind: 'tool',
          id: part.toolCallId,
          name: 'bash',
          command: '',
          output: part.output,
          failed: part.isError,
          ...(thumbs ? { images: thumbs } : {}),
        })
      }
    }
  }
  // 每轮最后一条 assistant 挂页脚（model/耗时/完成时刻）：落盘的
  // meta/elapsed_ms/finishedAt 随行带进来（historyPage 的行带，warmUp 的
  // messages() 基线不带——那里只有最近一轮，由 bridge 的 lastFooter 补）。
  // **finishedAt 是页脚的渲染开关**（App.tsx），不挂它整个页脚消失——
  // 曾经只挂 model/elapsedMs，reload 后历史轮全没页脚，就是这个坑。
  // model 是当时的快照（用户拍板：历史事实不可变，之后换模型不改写）；
  // `provider/name` 全身份取尾段，对齐实时页脚的显示口径
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.turnId === undefined || !row.meta || row.elapsedMs == null) continue
    const next = rows[i + 1]
    const last = next === undefined || next.turnId !== row.turnId
    if (!last) continue
    // 本轮的产出区间 = [turnStart, 行 i 的终点)。终点 = 下一行处理前的
    // items 长度（rowStarts[i+1]）——不能用 items.length：构建完成后它
    // 已含全部轮，页脚会补到下一轮的行上
    let at = -1
    const end = i === rows.length - 1 ? items.length : (rowStarts[i + 1] ?? items.length)
    for (let k = end - 1; k >= (turnStarts.get(row.turnId) ?? 0); k--) {
      if (items[k]?.kind === 'assistant') {
        at = k
        break
      }
    }
    if (at === -1) continue
    items[at] = {
      ...(items[at] as Extract<ChatItem, { kind: 'assistant' }>),
      model: row.meta.model.split('/').pop() ?? row.meta.model,
      elapsedMs: row.elapsedMs,
      // null（老轮次缺 elapsed 算不出时刻）→ 不挂，页脚不显示——对齐
      // 实时路：中断轮本来也没有页脚
      ...(row.finishedAt != null ? { finishedAt: row.finishedAt } : {}),
    }
  }
  return stubbed.size > 0 ? items.filter((i) => !stubbed.has(i)) : items
}

/** hydrateItems 用的轮 meta 子集（core 的 TurnMeta 同构，webview 不依赖 core） */
export type FooterMeta = { model: string; effort: string | null }
