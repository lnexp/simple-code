import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type LoadedConfig,
  type LoadOptions,
  loadConfig,
  type ModelRef,
  selectModel,
} from '../config/load.ts'
import type { ModelSpec } from '../config/schema.ts'
import type { AgentEvent } from '../events.ts'
import { sendRequest } from '../llm/client.ts'
import { thumbnailDataUrl } from '../llm/resizer.ts'
import type { ProviderContext } from '../llm/protocol.ts'
import type { Effort, ImageInput, Message, Part, Request } from '../llm/types.ts'
import { assembleContext, hotSummaryIds, indexTokens, type Summary } from '../loop/assemble.ts'
import { drainStubWater } from '../loop/summarize.ts'
import { regionSizes } from '../loop/regions.ts'
import { requestWithRetry, type StreamEvent } from '../loop/retry.ts'
import { headOf, type LoopContext, type LoopDeps, run, type Task, userParts } from '../loop/run.ts'
import {
  buildMergeRequest,
  buildSummaryRequest,
  cleanSummaryText,
  indexMembers,
  parseSummaryOutput,
  pickMergeGroup,
  renderMergeInput,
  renderTurn,
  type SummaryOutput,
} from '../loop/summarize.ts'
import { estimateMessageTokens, estimateTextTokens, inputBudget } from '../loop/tokens.ts'
import { runEventArchive, type ArchiveSummary } from '../loop/archiver.ts'
import { readEventsIndex } from '../tools/events.ts'
import { lessonNamesIndex } from '../tools/lesson.ts'
import { listNoteCards, NOTES_INDEX_LIMIT } from '../tools/note.ts'
import { createBashTool } from '../tools/bash.ts'
import { BgRegistry, type BgProcessInfo } from '../tools/bg.ts'
import type { Tool, ToolContext } from '../tools/types.ts'
import { createViewImageTool } from '../tools/viewimage.ts'
import { acquireLock } from './lock.ts'
import { type HistoryRow, openStore, type Segment, type Store } from './store.ts'

/**
 * hydrate 出口的行（historyPage 的返回）。tool_result.images 从原图
 * ImagePart[] 换成 256px 缩略图 data URL——与 live 路径 run.ts 发给
 * webview 的 ChatItem.images 同口径。原图只留库里（库里的是资产），
 * 不过 hydrate 载荷：白拖几 MB base64 还用不上。union 逐成员分布，
 * 其余 part 原样
 */
export type HydratePart = Part extends infer P
  ? P extends { type: 'tool_result' }
    ? Omit<P, 'images'> & { images?: string[] }
    : P
  : never
export type HydrateRow = Omit<HistoryRow, 'parts'> & { parts: HydratePart[] }

/**
 * 行的 parts 过一遍缩略图转换（hydrate 出口专用）。泛型保住行上的其余
 * 字段（historyPage 的 HistoryRow、historyRows 的裸 Message 行都能喂）。
 * 无图的 tool_result 也走解构剔除：完整 ToolResultPart 的
 * images?: ImagePart[] 与目标的 images?: string[] 不相容
 * （exactOptionalPropertyTypes），运行时是 undefined 也不行
 */
export async function toHydrateRows<T extends { parts: readonly Part[] }>(
  rows: readonly T[],
): Promise<(Omit<T, 'parts'> & { parts: HydratePart[] })[]> {
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      parts: await Promise.all(
        row.parts.map(async (part): Promise<HydratePart> => {
          if (part.type !== 'tool_result') return part
          const { images: _originals, ...rest } = part
          if (!part.images || part.images.length === 0) return rest
          const thumbs = (
            await Promise.all(
              part.images.map((img) => thumbnailDataUrl(img).then((u) => u ?? '')),
            )
          ).filter((u) => u !== '')
          // 缩略图全失败 → 不带 images 字段（live 路径同样 filter 掉空）
          return thumbs.length > 0 ? { ...rest, images: thumbs } : rest
        }),
      ),
    })),
  )
}
import { warmupShellParser } from '../tools/shell-ast.ts'

export type Session = {
  readonly root: string
  readonly config: LoadedConfig
  /** 当前历史的只读快照。第 2 步换成 SQLite 时这个签名不变 */
  messages(): readonly Message[]
  /**
   * messages() 的加强版：每行带 turnId/meta/elapsedMs——webview 基线用。
   * 页脚（当时模型·耗时）的真相在 turns 表，messages() 不 JOIN 看不到；
   * live 轮又不走 historyPage（那是 unloaded 翻页）。归属用 withTurns
   * 的内存版（跟 save 共用规则），meta/耗时批查 turnsInfo
   */
  historyRows(): readonly (Message & {
    turnId: number
    meta: { model: string; effort: string | null } | null
    elapsedMs: number | null
    finishedAt: number | null
  })[]
  /**
   * 历史分页（UI 往上拉加载用）。store 分页是纯读，但 Session 层不再直通：
   * tool_result 的原图要换成缩略图（HydrateRow），这个变换是异步的
   * （wasm resizer），所以 async
   */
  historyPage(cursor: number | null, limit: number): Promise<{ rows: HydrateRow[]; next: number | null }>
  /**
   * 发一条消息并消费事件流。
   *
   * **agent 正在跑的时候调用不会拒绝，也不会并发跑两个 loop**——那条消息进
   * 任务队列，当前 loop 下一轮就会处理它，返回的流立刻结束（事件从正在跑的
   * 那次 send 出）。丢消息和跑两个 loop 都是不报错的错。
   */
  send(text: string, images?: ImageInput[]): AsyncIterable<AgentEvent>
  /** 中断正在跑的 loop。没在跑就是空操作 */
  interrupt(): void
  /**
   * 用户在 UI 关掉一个后台残留进程（bg.ts）：SIGTERM 并返回更新后的快照。
   * 不走事件流——宿主调完拿返回值直接推给 webview，少一次状态同步
   */
  terminateBg(pid: number): BgProcessInfo[]
  /** 当前后台进程快照。多根切回时宿主补推清单用（bg 显示按目录隔离） */
  bgSnapshot(): BgProcessInfo[]
  isRunning(): boolean
  /**
   * 换模型。**跨 provider 也行**——protocol / baseUrl / apiKey 跟着换。
   *
   * **正在跑的那一轮不受影响，下一次 send 才生效**。所以调用方
   * 不需要「等跑完再切」——但 UI 上仍然该说清楚，见 vscode 那边的注释。
   *
   * 模型不存在时**抛异常**，会话保持原样可用。这里不能沿用「找不到就用默认」
   * ——那正是 CLAUDE.md §1.2 要挡的。
   *
   * 会**改历史**：跨模型时剥掉 reasoning 的签名（见 dropSignatures）。
   *
   * 会**清掉 effort 覆盖**（见 setEffort）。
   */
  setModel(choice: ModelRef): void
  /**
   * 盖住配置里的推理深度。`null` = 不盖，用配置算出来的那个值。
   *
   * **换模型会清掉这个覆盖**：没显式给 effort 就
   * 退回新模型自己的默认。理由是档位的含义按模型而定——在 A 上选的 `max` 换到 B 上可能根本
   * 不是同一件事，甚至不被接受。
   *
   * 同 setModel：正在跑的那一轮不受影响，下一次 send 才生效。
   */
  setEffort(effort: Effort | null): void
  /**
   * 当前**生效**的推理深度，以及它是不是被 setEffort 盖过的。
   *
   * 有这个 getter 是因为「生效值」只有 core 知道：它是配置值和覆盖的合并
   * 结果，而**换模型时覆盖会被自己清掉**。调用方各记一份的话，那次自动清理
   * 它看不见，UI 上会一直显示用户早先选的档位，实际发出去的是另一个——
   * 不报错，只是显示和事实分叉
   */
  effortState(): { effort: Effort; overridden: boolean }
  /** 当前预设与当前模型可选的预设名。available 为空 = 这个模型没配 presets */
  presetState(): { current: string | undefined; available: string[] }
  /**
   * 空闲时生成一个 turn 的 L0 摘要（design.md §9.7）。上层在「用户超过 N 秒
   * 没敲东西」时调它。
   *
   * **调用方不用判断能不能跑**——里面自己有闸：已经有一个在跑就直接返回，
   * loop 正在跑也直接返回。返回的 promise 在这次摘要结束时 resolve；
   * 没东西可做时立刻 resolve。
   *
   * 不返回事件流：摘要是后台行为，不该混进对话的事件序列里。要给 UI 提示的话
   * 将来单独加事件。
   */
  summarizeIdle(): Promise<void>
  close(): Promise<void>
}

export type SessionOptions = LoadOptions & {
  /** 覆盖工具集，测试用。默认只有 bash（第 1 步的边界） */
  tools?: Tool[]
  /** 覆盖发流的方式，测试用。绕开协议层和 HTTP */
  stream?: LoopDeps['stream']
  /** 换掉 fetch，测试用。**保留协议层和重试**，只把网络那一跳换成 fixture 回放 */
  fetchImpl?: typeof fetch
  /** 跳过文件锁，测试用。生产路径必须拿锁 */
  skipLock?: boolean
  /**
   * 不落盘，全程只用内存。**测试用**——绝大多数测试不关心持久化，
   * 让它们各自建临时目录再清理，成本和噪音都不值得
   */
  ephemeral?: boolean
  /**
   * 权限审批（approval.md §4.1）。宿主注入；不传 = 无审批（工具直接
   * 放行），ephemeral / 单测走这条路
   */
  requestApproval?: LoopDeps['requestApproval']
}

/**
 * 历史落在 SQLite 里，进程重启能读回来（design.md §13 第 2 步）。
 *
 * 第 1 步这里是内存空壳，换成 SQLite 时**签名一个字没改**——
 * core-modules.md §9 说的「接口按最终形态定」兑现了。
 */
export async function getSession(
  folderPath: string,
  options: SessionOptions = {},
): Promise<Session> {
  // 审批 AST 解析器预热（fire-and-forget）：classify 是同步接口，wasm
  // 只能提前加载；期间审批走正则回退，语义一致只是精度低
  void warmupShellParser()
  let config = await loadConfig(folderPath, options)
  // 只读一次，之后 buildDeps 复用。理由与「故意不热重载」都在 systemPrompt 上
  // 建会话超限 → 截断 + 内嵌警告行（agent 可见，会转告用户）；reloadSystem
  // 的「保旧版」语义见下方——那里的超限是新版本变大，不是用户初次配置
  const agentsText = await readAgentsFile(folderPath)
  const agents = agentsText === null ? null : clampAgents(agentsText)
  let notes = await readNotesIndex(folderPath)
  let events = readEventsIndex(folderPath)
  let lessons = lessonNamesIndex(folderPath)
  const lock = options.skipLock ? null : await acquireLock(folderPath)
  const store = options.ephemeral ? null : openStore(folderPath)

  // 重启后接着上次的历史往下走。这是第 2 步的全部目的
  const messages: Message[] = store?.load() ?? []
  const tasks: Task[] = []
  const bg = new BgRegistry()
  const tools = options.tools ?? [
    createBashTool(config.config.bash, options.env ?? process.env),
    createViewImageTool(),
  ]

  /** null = 没盖，用 config.request 里算好的那个（见 setEffort） */
  let effortOverride: Effort | null = null
  /** 当前选中的参数预设名（undefined = 模型本体，界面上叫「默认」）。
   * 与 effortOverride 并列存在会话里：配置本身不记「现在选的是哪个」，
   * 那是运行时状态不是文件形状 */
  let currentPreset: string | undefined
  /** AGENTS.md 本体建会话读一次（const，可能已截断）；notes 索引可被 reloadSystem 重读 */
  let agentsMutable: string | null = agents
  /**
   * visionRelay 转述缓存（图 data → 成品文本）。session 级：ctx 每次 send
   * 新建，挂 ctx 上每条消息都要把历史图重述一遍。run.ts 的
   * relayPendingImages 只填不建——见 LoopContext.relayCache 的注释。
   * 换 visionModel 配置不失效（键只有 data）——重配副模型是编辑 settings
   * 的罕见操作，沿用旧转述的偏差小到不值得为此多一层键
   */
  const relayCache = new Map<string, string>()

  const buildDeps = (): LoopDeps => {
    // 视觉转述按**当前** config 现算，不能提到外面算一次死：setModel 换到
    // 视觉模型后 relay 得撤销（否则有眼睛的模型还在收转述文本），换回无
    // 视觉模型又要出现。门控在 makeVisionRelay 里（caps.images=true 或
    // 没配 visionModel → undefined）
    const visionRelay = makeVisionRelay(config, folderPath)
    const deps: LoopDeps = {
    stream: options.stream ?? httpStream(config, options.fetchImpl, folderPath),
    tools: new Map(tools.map((t) => [t.name, t])),
    root: folderPath,
    caps: config.model.capabilities,
    now: () => Date.now(),
    requestApproval: options.requestApproval,
    request: {
      ...config.request,
      // 覆盖压在 config 算出来的值上面。展开在后面，顺序不能反
      ...(effortOverride === null ? {} : { effort: effortOverride }),
      model: config.config.model,
      // 状态行跟着 deps 每轮现算：setModel 之后下一轮 system 自动带上新
      // 模型的能力（方案 A——模型切换是静默操作，agent 得能低头看到现状）
      system: systemPrompt(
        folderPath,
        agentsMutable,
        notes,
        events,
        lessons,
        options.env ?? process.env,
        {
          provider: config.config.provider,
          name: config.config.model,
          contextWindow: config.model.contextWindow,
          images: config.model.capabilities.images,
        },
        visionRelay !== undefined,
        new Date().toLocaleDateString('sv-SE'),
      ),
      tools: tools.map((t) => t.definition),
    },
    maxIterations: config.config.loop.maxIterations,
    bg,
    ...(visionRelay ? { visionRelay } : {}),
    ...(store
      ? {
          rawSink: (id: string) => store.rawSink(id),
          // 没有 store 就没有 memory：卸载的前提是原文能留在磁盘上，
          // 否则「卸载」就成了单纯的丢数据（design.md §9.3）
          memory: {
            contextWindow: config.model.contextWindow,
            targetRatio: config.config.memory.unloadTargetRatio,
            cacheTtlMs: config.model.cacheTtlMs,
            now: () => Date.now(),
            lastResponseAt: () => lastResponseAt,
            markResponded: () => {
              lastResponseAt = Date.now()
            },
            floorTokens: config.config.memory.floorTokens,
            stubTokens: config.config.memory.stubTokens,
            safetyMargin: config.config.memory.reservedTokens,
            keepHeadChars: config.config.memory.keepHeadChars,
            clipThresholdChars: config.config.memory.clipThresholdChars,
            remap: (origin) => store.remapMessages(origin),
            unload: (indices: number[]) => store.unload(indices),
            markCold: (stepIds: number[]) => store.markCold(stepIds),
            activateSummary: (stepId) => store.activateSummary(stepId),
            unloadedSteps: () => store.unloadedSteps(),
            summaries: () => store.summaries(),
            leafBodies: (rows) => store.leafBodies(rows),
            hotLeaves: config.config.memory.hotLeaves,
            demoteBatch: config.config.memory.demoteBatch,
            withTurns: (msgs: Message[]) => store.withTurns(msgs),
            recordRegions: (sizes, budget) => store.recordRegions(sizes, budget),
            pruneMessages: (indices) => store.pruneMessages(indices),
            applyMerges: () => store.applyMerges(),
          },
        }
      : {}),
    }
    // **只会在卸载触发点被调用**（run.ts unloadIfNeeded 的注释写了契约）。
    // 这里改动的是 deps.request.system——deps 整体仍是「setModel 才重建」，
    // 只有 system 这一个字段在压缩点上被原地换新。重读后顺手更新闭包变量，
    // setModel 重建 deps 时拼出来的就是已刷新的版本，不会闪回旧文
    deps.reloadSystem = async () => {
      const [freshAgents, freshNotes] = await Promise.all([
        readAgentsFile(folderPath),
        readNotesIndex(folderPath),
      ])
      // AGENTS.md 新版超限 → 保旧版不换 + 报给 run 侧发提示。缩小/删除/
      // 改名都照常生效——「停止」只拦「变大到超限」，死保旧版仅此一种触发
      const overLimit =
        freshAgents !== null && estimateTextTokens(freshAgents) > AGENTS_MAX_TOKENS
      agentsMutable = overLimit ? agentsMutable : freshAgents === null ? null : clampAgents(freshAgents)
      notes = freshNotes
      // events 索引同款：压缩点换新（proposals/events.md §6——新归档的事件
      // 这时才进索引；此前原文还热着，本来不需要档案）
      events = readEventsIndex(folderPath)
      lessons = lessonNamesIndex(folderPath)
      deps.request.system = systemPrompt(
        folderPath,
        agentsMutable,
        notes,
        events,
        lessons,
        options.env ?? process.env,
        {
          provider: config.config.provider,
          name: config.config.model,
          contextWindow: config.model.contextWindow,
          images: config.model.capabilities.images,
        },
        visionRelay !== undefined,
        new Date().toLocaleDateString('sv-SE'),
      )
      return overLimit ? { agentsOverLimit: true } : {}
    }
    // 存根段水位检查的「催摘要」：summarizeIdle 自带并发闸（同时最多一个、
    // 正在跑的不打断），这里只管点火不管等——水位检查是同步路径，不能挂
    deps.kickSummary = () => void kickSummary()
    return deps
  }

  /**
   * **每轮 send 现取，不是建会话时定死。** `setModel` 换掉它之后，正在跑的
   * 那一轮仍然用旧的（它在 send 时就把引用抓走了），下一轮才换。
   * 这里是白捡的：ctx 抓引用本来就是这个行为，不用额外写「切换要排队」
   */
  let deps = buildDeps()

  let running: AbortController | null = null
  /**
   * 正在跑的后台摘要。**非 null 就是闸落下**——同一时刻最多一个（§9.7）。
   *
   * 不是 AbortController 而是 promise：摘要**不因用户输入而中断**，只是不开
   * 新的。用户连续问短问题时若每条都半路被杀，会永远生成不出一条摘要——
   * 而那恰好是上下文涨得最快、最需要摘要的时候。
   */
  let summarizing: Promise<void> | null = null
  /**
   * 正在跑的那个 turn 的 id，**整个不当摘要候选**。
   *
   * 只排除最后一个 step 是不够的：摘要每个 step 跑完都被踢一脚，那时「除最后
   * 一个之外」只剩刚跑完的那一个，于是一个 turn 出一条摘要变成出九条
   * （真机验证 2026-09-03，covers 1-1 / 2-2 / 3-3）。
   *
   * loop 结束时清回 null，空闲摘要才够得着最新那一轮——那正是最该摘的一轮。
   */
  let activeTurn: number | null = null

  /**
   * 上次模型响应结束的时刻（提案 §12 缓存过期判断的计时起点）。
   *
   * **必须是跨 send 存活的闭包变量**，不能放 LoopContext——那个每次 send
   * 都新建，「用户隔夜回来发第一条消息」恰恰发生在两次 send 之间，放 ctx
   * 里的话主场景永远读到 null。
   *
   * 重启兜底从库里读最后一个 step 的 started_at：那是 step **开始**的时刻，
   * 比「响应结束」早一个 step 的时长（秒到分钟级），对 3 小时量级的阈值是
   * 噪音，方向上略偏「更容易判 stale」，但差不出数量级。重启后第一轮之后
   * markResponded 就接管了，这个初值只用一次
   */
  let lastResponseAt: number | null = store?.lastRespondedAt() ?? null

  /**
   * 后台摘要的唯一入口，两个触发点共用：空闲定时器（`watchIdle`）和每个
   * step 跑完（`persist`）。
   *
   * **闸只剩两条**：① 已经有一个在跑 ② 没有 store（ephemeral 没地方写）。
   * 原来还有第三条「loop 正在跑就不开」，**在此处被推翻**——见 design.md
   * §9.7 修正二。规则 1（同时最多一个）保留，成本仍然封顶。
   */
  const kickSummary = (): Promise<void> => {
    if (summarizing || !store) return Promise.resolve()

    const task = summarizeOnce(store, config, options.fetchImpl, activeTurn).finally(() => {
      summarizing = null
      // 摘要生成完成 → 顺手查一次存根段水位（三级递进第二级的另一个入口）。
      // 只靠 runStep 入口的话，idle 里刚生成的 L0 要等下一次用户消息才有机会
      // 进场，纯 idle 时段（挂机、夜里）索引区冻结——merge-e2e 的级联用例
      // 当场抓到过。装配与 assembleForRequest 同构（withTurns + summaries +
      // 热区正文）；不 strip 图片：水位只看 stub 区，图片不影响
      // try/catch 挡 close 竞态：close 不等摘要跑完（见 close 注释），进程
      // 退出/测试收尾时 store 先关、这条 finally 里迟到的 drain 撞上
      // closed db（node:sqlite ERR_INVALID_STATE）。丢掉即可——进场只是
      // 顺手优化，与 generating 行同哲学，下次启动 drainStubWater 重做
      try {
        drainStubWater({
          assemble: () => {
            const live = store.withTurns(messages)
            const summaries = store.summaries()
            const hot = hotSummaryIds(summaries, {
              hotLeaves: config.config.memory.hotLeaves,
              batch: config.config.memory.demoteBatch,
            })
            const stepOf = new Map(messages.map((m) => [m, -1]))
            for (const entry of live) stepOf.set(entry.message, entry.stepId)
            return {
              messages: assembleContext(
                live,
                summaries,
                store.leafBodies(summaries.filter((summary) => hot.has(summary.id))),
              ),
              stepOf,
            }
          },
          stubTokens: config.config.memory.stubTokens,
          summaries: () => store.summaries(),
          activateSummary: (stepId) => store.activateSummary(stepId),
          unloadedSteps: () => store.unloadedSteps(),
          kick: () => void kickSummary(),
        })
      } catch {
        // 见上：迟到的进场，丢给下次启动
      }
    })
    summarizing = task
    return task
  }

  return {
    root: folderPath,
    // getter 而不是固定值：setModel 之后 config 整个换了一份，
    // 拿旧引用的调用方会读到换之前的 baseUrl / contextWindow
    get config() {
      return config
    },
    messages: () => messages,
    historyRows: () => {
      if (!store)
        return messages.map((m) => ({ ...m, turnId: 0, meta: null, elapsedMs: null, finishedAt: null }))
      const live = store.withTurns(messages)
      const infos = store.turnsInfo(live.map((l) => l.turnId))
      return live.map(({ message, turnId }) => {
        const info = infos.get(turnId)
        return {
          ...message,
          turnId,
          meta: info?.meta ?? null,
          elapsedMs: info?.elapsedMs ?? null,
          finishedAt: info?.finishedAt ?? null,
        }
      })
    },
    historyPage: async (cursor, limit) => {
      if (!store) return { rows: [], next: null } // ephemeral 会话没有历史
      const page = store.historyPage(cursor, limit)
      return { ...page, rows: await toHydrateRows(page.rows) }
    },
    isRunning: () => running !== null,
    interrupt: () => running?.abort(),
    terminateBg: (pid) => bg.terminate(pid),
    bgSnapshot: () => bg.snapshot(),

    setModel: (choice) => {
      // 同模型只换预设（t885）：**不清 effort、不剥签名**——档位含义由模型
      // 决定，模型没变含义就没变；reasoning 签名同理，换的是线路不是模型。
      // 这正是「预设」相对于「同模型配两条 model 条目」的价值所在：后者走
      // 的是换模型语义，白清一次档位、白改一次历史
      const sameModel =
        choice.provider === config.config.provider && choice.model === config.config.model
      if (sameModel && choice.preset === currentPreset) return
      // 先解析再改状态：模型名/预设名写错时抛异常，会话保持原样可用
      const next = selectModel(config, choice, options.env ?? process.env)
      config = next
      currentPreset = choice.preset
      if (!sameModel) effortOverride = null
      deps = buildDeps()
      if (!sameModel && dropSignatures(messages)) store?.save(messages)
      return
    },
    setEffort: (effort) => {
      effortOverride = effort
      deps = buildDeps()
    },

    effortState: () => ({
      effort: effortOverride ?? config.request.effort,
      overridden: effortOverride !== null,
    }),

    // 可选列表跟着**当前模型**走：换模型后旧模型的预设名不再有效（t885
    // 拍板 A：清空回默认），UI 拿这个列表重画即可，不用自己翻配置
    presetState: () => ({
      current: currentPreset,
      available: Object.keys(config.model.presets),
    }),

    summarizeIdle: () => kickSummary(),

    close: async () => {
      running?.abort()
      // **不等摘要跑完。** 等的话用户按了 /exit 还得干等几秒。中途丢下的
      // generating 行由下次启动的 resetStaleGenerating 兜住（§9.7）
      store?.close()
      await lock?.release()
    },

    send: (text, images) => {
      // 门控在入口，不在 loop：排队的图也要拦（§726——images 配错发出去是
      // 400 + 消息留在 context 里污染后续每轮，必须本地判断；effort 类不配错的
      // 才轮到 API 说话）。UI 侧有同款前置拦截，这里是第二道防线，CLI/测试
      // 直连 core 时靠它
      // 有 visionRelay 兜底时放行（非视觉模型下贴图走转述，与 view_image 同
      // 口径）。visionRelay 的存在性门控就是「config.vision 非空且当前模型
      // 无视觉」（makeVisionRelay），这里同款条件；只有既不支持图又没配
      // visionModel 才硬拒——那时图发出去就是 400 且消息留在 context 里
      // 污染后续每轮，没有第二条路
      if (
        images !== undefined &&
        images.length > 0 &&
        !config.model.capabilities.images &&
        config.vision === null
      ) {
        throw new Error('当前模型未开启图片支持（settings.json 里该模型的 capabilities.images）')
      }
      if (running) {
        // 已经在跑了。入队而不是新起一个 loop——两个 loop 同时改一份历史，
        // 谁也不会报错，只是历史乱掉
        tasks.push({ type: 'newInput', text, ...(images ? { images } : {}) })
        return empty()
      }
      // 轮身份快照：页脚按轮显示「这句是谁说的」，不随后续切换漂移
      // elapsed 的起点也在这里记——页脚耗时落盘（用户拍板：历史事实不可变）
      const turnStartedAt = Date.now()
      activeTurn =
        store?.beginTurn({
          model: `${config.config.provider}/${config.config.model}`,
          effort: effortOverride ?? config.request.effort ?? null,
        }) ?? null
      messages.push({ role: 'user', parts: userParts(text, images) })
      // 先落盘再发请求。反过来的话，请求发出去了但用户这条消息没记下来，
      // 崩溃重启后模型的回答在历史里成了没有来由的一段话
      store?.save(messages)

      const controller = new AbortController()
      running = controller
      const ctx: LoopContext = { messages, tasks, deps, signal: controller.signal, relayCache }
      const persist = () => {
        // 历史是 loop 内部重新赋值的（normalize 返回新数组），要同步回来
        messages.splice(0, messages.length, ...ctx.messages)
        store?.save(messages)
        // 一个 step 跑完就顺手踢一脚摘要（§9.7 修正二）。**必须在 save 之后**：
        // 候选是查库挑的，没落盘的话刚结束的这个 step 还不在库里。
        //
        // 触发点放这里而不是前端：idle.ts 记着的教训就是 watchIdle 起初只在
        // CLI 接了线，扩展上线后没人记得，摘要在扩展里一次都没跑过。
        //
        // 总开关判在**调用点**不判在 kickSummary 里：关掉的是「自动摘要」这个
        // 行为（两个触发点共用一个开关），而 `summarizeIdle()` 是调用方明确
        // 要求摘一次，闸在里面的话连显式调用都会被静默吞掉
        if (config.config.memory.idleSummarizeDelayMs > 0) void kickSummary()
      }

      return finallyDo(tap(run(ctx), persist), () => {
        persist()
        // 定稿写耗时。update 的是当时的 turn 行，meta（model）也是当时的
        // 快照——之后换模型不会改写这一轮的任何记录
        if (activeTurn !== null) store?.finishTurn(activeTurn, Date.now() - turnStartedAt)
        running = null
        // **清在 persist 之后**：那一脚 kickSummary 还属于「turn 正在跑」，
        // 早清的话它会摘到刚结束但还没落定的这一轮。清完之后空闲摘要才够得着
        activeTurn = null
      })
    },
  }
}

/**
 * 换模型时剥掉历史里所有 reasoning 的签名。**就地改 messages**，改了返回 true。
 *
 * reasoning 的 `encrypted` 是**签发方绑定**的不透明串（Anthropic 的
 * signature、OpenAI 的 encrypted_content）。拿 A 模型签的块去请求 B 模型，
 * 服务端校验不过直接 400——而且是整个请求失败，不是降级，用户看到的是
 * 「换完模型就再也发不出消息了」。
 *
 * 我们的方案：换模型时把历史里的 reasoning 签名直接丢掉。
 * 在每条消息上记产出模型的替代方案（记下来、切回 A 时 A 的旧签名还能用），
 * canonical Message 没有这个字段，加它要动 store 的 JSON 和迁移。代价收益不成比例——签名没了
 * 只是那块思考不发（协议层本来就丢无签名的 reasoning，见
 * anthropic-messages.ts:130 和 openai-responses.ts:104），而留着错签名是硬
 * 失败。**降级和硬失败不对称，往降级那边倒。**
 *
 * 也**不把 reasoning 文本降级成 assistant 正文**：那会让模型看见自己
 * 「说」过一段本来是内心独白的话，而且用户在界面上会突然多出一段没来由的
 * 回答。整块丢掉是协议层已有的、写过理由的行为，跟着它走。
 */
function dropSignatures(messages: Message[]): boolean {
  let changed = false
  for (const [i, message] of messages.entries()) {
    if (!message.parts.some((p) => p.type === 'reasoning' && p.encrypted !== undefined)) continue
    changed = true
    messages[i] = {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== 'reasoning' || part.encrypted === undefined) return part
        const { encrypted: _dropped, ...rest } = part
        return rest
      }),
    }
  }
  return changed
}

/**
 * 生成一个 turn 的 L0 摘要，从头到尾（design.md §9.6/§9.7）。
 *
 * 流程：挑 turn → 建 pending 行（占位文本立刻可用）→ 标 generating →
 * 发请求 → 写回 ready。
 *
 * **先建行再发请求**，顺序不能反：请求要几秒，这期间如果触发卸载，那个 turn
 * 得有个占位文本可用，否则 context 里就是个空洞。
 *
 * **永不抛异常。** 摘要是纯粹的锦上添花——失败了 context 继续用占位文本，
 * 功能一点不受影响（§9.7 的降级路径）。抛出去反而会让上层的空闲驱动崩掉，
 * 拿一个可选功能的失败去换掉整个 REPL，不值。
 */
async function summarizeOnce(
  store: Store,
  config: LoadedConfig,
  fetchImpl: typeof fetch | undefined,
  /** 正在跑的 turn，整个不当候选。idle 时是 null——那会儿没有「正在跑的」 */
  activeTurn: number | null,
): Promise<void> {
  try {
    // 候选是**一个 turn 内的一段连续 step**（live 与 unloaded 都在 messages
    // 表里）——摘要资格不绑定 live 状态，卸载掏空的 turn 也能补摘
    // （step-summary-rework §4.3，推翻 §9.7「倾向不补」）
    const segment = store.nextSegmentToSummarize(config.config.memory.segmentTokens, activeTurn)
    // L0 的账先还（§9.7「摘要要赶在卸载前面」）。还完了才轮到合并——
    // 合并的成员必须在 context 里用了一阵才有「合并的资格」，账没还完就
    // 合并等于给刚出炉的 L0 立刻打包，缓存意义上的等待全白费
    if (segment !== null) {
      const messages = store.segmentMessages(segment)
      // 空段不该成为候选（nextSegmentToSummarize 的 JOIN 已经滤掉），真出现
      // 了也不能往下走——抛出去会被本函数的 catch 吞掉，然后每次空闲 tick
      // 重撞同一个候选，症状是「摘要不动了」且一行日志都没有
      if (messages.length === 0) return
      const estimated = messages.reduce((sum, m) => sum + estimateMessageTokens(m.parts), 0)
      if (estimated < config.config.memory.summaryMinTokens) {
        writeLocalL0(store, config, segment, messages)
        return
      }
      await summarizeSegment(store, config, fetchImpl, segment)
      return
    }

    // 没有 L0 债：看该层攒够没有。级联在一次空闲 tick 里做完——L1 合并
    // 不依赖 context（纯库操作 + 一次模型调用），不级联的话 L2 要等
    // 「L1 攒够 10 条」之后的**下一次**空闲，而那可能是很久以后
    await mergeWhileDue(store, config, fetchImpl)
  } catch {
    // 吞掉。没生成完的行由 summarizeSegment 自己收掉（它的 finally），
    // 进程直接没了那种由下次启动的 dropUnfinishedSummaries 兜底
  }
}

/**
 * 太短的 step 走本地 L0：不调模型，取最长那条消息的头部直接落一条 ready 行。
 *
 * 压缩比接近 1:1 的 step 花一次模型调用不值；但**必须落行**——covers 连着
 * 才能进 L1 合并，跳过的话短 step 夹在长 step 之间会把合并的连续段打碎，
 * 金字塔停摆（第一版直接跳过，merge-e2e 当场抓出来。见提案 §6.6）
 */
function writeLocalL0(
  store: Store,
  config: LoadedConfig,
  segment: Segment,
  messages: Message[],
): void {
  const main = messages.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b))
  const description = headOf(main, config.config.memory.keepHeadChars)
  const id = store.addSummary({
    level: 0,
    coversFrom: segment.from,
    coversTo: segment.to,
    // 本地路径不调模型，没有标题可写。空串是如实的，不拿描述的前几个字凑
    name: '',
    text: description,
    status: 'ready',
    inContext: false,
    supersededBy: null,
    head: null,
    archivePath: null,
  })
  // **这条路径也要落叶子文件**，哪怕内容和库里那行一模一样：摘要里给模型的
  // 路径指的是叶子（`archivePath`），少一个文件就是一次「No such file」。
  // 没有 name 和正文是如实的——这一段本来就短到不值得调模型
  store.writeLeaf(segment, { name: '', description, body: '' })
  // 翻转规则与模型路径共用：段头被推进线碰过就直接生效（碰头即上岗）
  if (store.segmentHeadUnloaded(segment)) store.flipSummary(id)
}

/** 消息的总字符量，给「哪条消息是主角」用（精确估算已在候选侧做过） */
const sizeOf = (m: Message): number => m.parts.reduce((sum, p) => sum + partChars(p), 0)
const partChars = (p: Part): number => {
  if (p.type === 'text') return p.text.length
  if (p.type === 'reasoning') return (p.text ?? p.encrypted ?? '').length
  return JSON.stringify(p).length
}

/** L0：摘一段（提案 §4.3） */
async function summarizeSegment(
  store: Store,
  config: LoadedConfig,
  fetchImpl: typeof fetch | undefined,
  segment: Segment,
): Promise<void> {
  const messages = store.segmentMessages(segment)
  if (messages.length === 0) return
  const id = store.addSummary({
    level: 0,
    coversFrom: segment.from,
    coversTo: segment.to,
    name: '',
    // 占位：请求还没回来时若发生卸载，context 里用的是这个
    text: `第 ${segment.from} 步（摘要生成中）`,
    status: 'pending',
    inContext: false,
    supersededBy: null,
    head: null,
    archivePath: null,
  })
  store.startSummary(id)

  // **没走到 finish 就得把这行删掉**，所有失败路径收口在一处（CLAUDE.md §4.5）。
  // 留着的话它会永久占住这一段 step：`nextSegment` 算「已覆盖」时不看 status，
  // 没人会再来补摘；而 covers 上的洞让 pickMergeGroup 的连续性判断断掉，合并
  // 从此起不来。真库 213 条 pending 加 L0 合并停滞就是这么攒的
  let finished = false
  try {
    const out = await requestSummary(messages, config, fetchImpl, store.root)
    if (!out.description) return
    // **库里存描述，正文落文件**（§4.4 的分辨率梯度）。进 context 的是描述
    // 那一行；正文只在叶子里，等模型真要展开这一轮时去 cat。
    //
    // **正文为空也写文件。** 原来跳过，理由是「只有 frontmatter 的空叶子比
    // 没有叶子更糟——索引树会把它当成『这轮什么都没干』」。那条理由在当时
    // 成立：内部节点是读 frontmatter 拼出来的，空的会污染路由行。现在内部
    // 节点改成调模型生成（§10 ②），frontmatter 只被 `leafBodies` 用来取正文，
    // 空正文渲染出来就是温区那一档，不会假装成别的。
    //
    // 而不写的代价现在变实了：**摘要里那行路径要指向叶子**，缺文件就是
    // 「No such file」。真库 34 条叶子里 18 条没文件，一条都不能少
    store.finishSummary(id, out.description, out.name)
    finished = true
    store.writeLeaf(segment, { name: out.name, description: out.description, body: out.body })
    // 摘要落库 → 顺手触发事件归类（v3：单次判断 + 原子落盘，见 archiver.ts
    // 头注释）。闸内不吞——排队，跑完续（每批摘要恰好一次分类，不丢不过载）。
    // 只挂 L0（新窗口摘要）；L1/L2 合并不触发——合并不产生新信息
    const fresh: ArchiveSummary = {
      name: out.name,
      description: out.description,
      body: out.body,
      coversFrom: segment.from,
      coversTo: segment.to,
    }
    queueEventArchive(store.root, fresh, config, fetchImpl)
    // **翻转规则（重做的核心）**：段头被推进线碰过 → 直接生效（碰头即上岗，
    // 判定与 activateSummary 同源）。旧账（632 条存根）就是这样被顶替的：
    // 不翻的话 in_context 永远是 0，存根滞留 context。段头还没被碰过的
    // 照旧等卸载时翻（run.ts 的 activateSummary）
    if (store.segmentHeadUnloaded(segment)) store.flipSummary(id)
  } finally {
    if (!finished) store.dropSummary(id)
  }
}

/** 归档并发闸：按 root 一把。跨 session 模块级——同一 folder 的两个
 *  session 实例（reload 前后）也共享这道闸 */
const archivingRoots = new Set<string>()

/** 待归档摘要队列（闸内不吞的代价）：跑完 finally 里续排，每批恰好一次分类 */
const pendingArchive = new Map<string, Array<{ s: ArchiveSummary; cfg: LoadedConfig; fetchImpl?: typeof fetch }>>()

function queueEventArchive(root: string, s: ArchiveSummary, cfg: LoadedConfig, fetchImpl?: typeof fetch): void {
  const q = (pendingArchive.get(root) ?? []).concat([{ s, cfg, ...(fetchImpl ? { fetchImpl } : {}) }])
  pendingArchive.set(root, q)
  if (archivingRoots.has(root)) return // 在跑：留在队列，跑完续
  archivingRoots.add(root)
  const drain = (): void => {
    const next = pendingArchive.get(root)?.shift()
    if (!next) {
      pendingArchive.delete(root)
      archivingRoots.delete(root)
      return
    }
    void runEventArchive({ root, summary: next.s, config: next.cfg, ...(next.fetchImpl ? { fetchImpl: next.fetchImpl } : {}) })
      .catch((e) => console.error('[archiver] 归类失败（本批跳过，不重试）:', e))
      .finally(drain)
  }
  drain()
}

/**
 * **索引区超了配额就合并**，一直合到降回配额以内或没有可合的为止。
 *
 * 一次合并 = 一次模型调用（把 mergeFactor 条压成 1 条）+ 一次 `recordMerge`
 * （事务）。合出来的 L1 可能让 L1 层也攒够——循环。
 *
 * **触发条件从「攒够 mergeFactor 条」改成了「索引区超配额」**（`indexRatio`）。
 * 原来那条跟索引区占了多少无关：真库里索引区只用了 2.7%，25 条 L0 叶子已经
 * 被折成一行关键词，热区和温区两档从没出现过——攒够 10 条在第 7 个 turn 就
 * 发生了，而按配额算要到第 87 个 turn 才轮得到第一次折叠。
 *
 * 退出条件有两个，缺一个就退不出去：配额以内（正常）、没有可合的组（配额
 * 超了但连续段不够 mergeFactor 条，等后台补摘）。
 */
async function mergeWhileDue(
  store: Store,
  config: LoadedConfig,
  fetchImpl: typeof fetch | undefined,
): Promise<void> {
  const { mergeFactor: factor, indexRatio, hotLeaves, demoteBatch } = config.config.memory
  const quota =
    inputBudget({
      contextWindow: config.model.contextWindow,
      maxTokens: config.request.maxTokens,
      safetyMargin: config.config.memory.reservedTokens,
    }) * indexRatio

  for (;;) {
    const summaries = store.summaries()
    // 稳态成员而不是 inContext：刚 recordMerge 完的那一刻新节点还没生效、
    // 成员还在用着，按 inContext 量的话大小一点没降，循环会把每段都合掉
    const index = indexMembers(summaries)
    const hot = hotSummaryIds(index, { hotLeaves, batch: demoteBatch })
    const bodies = store.leafBodies(index.filter((s) => hot.has(s.id)))
    if (indexTokens(index, bodies) <= quota) return

    const group = pickMergeGroup(summaries, factor)
    if (!group) return

    const members = group.members
    const text = await requestMerge(members, config, fetchImpl, store.root)
    if (!text) return // 合并失败：下次空闲再试（成员原样，没有半截状态）

    store.recordMerge(
      {
        level: group.level + 1,
        coversFrom: members[0]?.coversFrom ?? 0,
        coversTo: members[members.length - 1]?.coversTo ?? 0,
        // 内部节点没有单独的标题：它产出的**本来就是一行**
        // 「<主题>：<关键词> · <关键词>」，主题就在 text 里，再切一个
        // 标题出来等于把同一句话拆两半
        name: '',
        text,
        status: 'ready',
        // 待生效：context 里成员们还在用着，等下一次卸载才换（§9.1）
        inContext: false,
        supersededBy: null,
        // 锚点用第一个成员的开头（最老的原话）；路径全带上——L1 的职责
        // 就是记住「原文去哪找」（§9.6），十个不同 turn 十个不同归档文件
        head: members[0]?.head ?? null,
        archivePath: [...new Set(members.map((m) => m.archivePath).filter((p) => p !== null))].join(
          '\n',
        ),
      },
      members.map((m) => m.id),
    )
  }
}

/** 发一次非流式意义上的请求——协议层恒流式（§5），这里只是把文本收全 */
async function requestSummary(
  messages: Message[],
  config: LoadedConfig,
  fetchImpl?: typeof fetch,
  folder?: string,
): Promise<SummaryOutput> {
  const request = buildSummaryRequest(renderTurn(messages), {
    ...config.summary.request,
    model: config.summary.name,
  })

  let text = ''
  const stream = sendRequest(request, {
    // 摘要自己的连接（跨 provider 时与主模型无关），resolveSummary 里解析
    protocol: config.summary.protocol,
    provider: {
      baseUrl: config.summary.baseUrl,
      apiKey: config.summary.apiKey,
      headers: config.summary.model.headers,
      extraBody: config.summary.model.extraBody,
    },
    signal: new AbortController().signal,
    idleTimeoutMs: config.config.loop.streamIdleTimeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
      tag: 'summary',
      ...(folder ? { folder } : {}),
    })
  for await (const llmEv of stream) {
    if (llmEv.type === 'text_delta') text += llmEv.text
  }
  return parseSummaryOutput(text)
}

/** 视觉转述的 system：描述者是主模型的眼睛，不是聊天对象 */
const RELAY_SYSTEM = `你是给编码助手转述图片的描述者，对方完全看不到图片，只能读到你的文字。
规则：
1. 逐字读出图中所有文字——报错、标题、按钮、数值，一字不改；报错栈完整转写
2. UI/网页截图：说布局与几何（什么元素在哪、是否溢出视口、对齐、遮挡、截断）
3. 图表：轴名、关键数值、趋势、异常点
4. 只说看得到的，不推断看不到的；400 字内`

/**
 * 视觉转述（vision relay）。主模型无视觉且配了 visionModel 时，把
 * view_image 的图换成文字描述。门控在注入端做（caps.images=true 或
 * vision=null 都不注入），工具层只认「有没有 relay」。
 *
 * 请求形态照 requestSummary：不带工具、关 thinking、收全 text_delta。
 * 不接 turn 的 AbortSignal——最坏情况是中断后转述还挂到 idle 超时，
 * 结果丢弃，无害（不为边缘情况加机制）
 */
function makeVisionRelay(
  config: import('../config/load.ts').LoadedConfig,
  folder?: string,
): ToolContext['visionRelay'] {
  const v = config.vision
  if (!v || config.model.capabilities.images) return undefined
  return async (image, focus) => {
    const request: Request = {
      ...v.request,
      model: v.name,
      system: RELAY_SYSTEM,
      tools: [],
      thinking: 'disabled',
      messages: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: focus === '' ? '请描述这张图。' : `调用方给出重点关注：${focus}`,
            },
            { type: 'image', data: image.data, mimeType: image.mimeType },
          ],
        },
      ],
    }
    let text = ''
    const stream = sendRequest(request, {
      protocol: v.protocol,
      provider: {
        baseUrl: v.baseUrl,
        apiKey: v.apiKey,
        headers: v.model.headers,
        extraBody: v.model.extraBody,
      },
      signal: new AbortController().signal,
      idleTimeoutMs: config.config.loop.streamIdleTimeoutMs,
      tag: 'vision-relay',
      ...(folder ? { folder } : {}),
    })
    for await (const llmEv of stream) {
      if (llmEv.type === 'text_delta') text += llmEv.text
    }
    return text.trim()
  }
}

/**
 * 把一组摘要合成一条上层节点。请求形态跟 L0 一致（不带工具、关 thinking），
 * 只有指令不同（buildMergeRequest）——L0 写「这一轮做了什么」，上层写
 * **目录里的一行路由**，不是把十条摘要再压一遍（提案 §3.2）
 */
async function requestMerge(
  members: Summary[],
  config: LoadedConfig,
  fetchImpl?: typeof fetch,
  folder?: string,
): Promise<string> {
  const request = buildMergeRequest(renderMergeInput(members), {
    ...config.summary.request,
    model: config.summary.name,
  })

  let text = ''
  const stream = sendRequest(request, {
    protocol: config.summary.protocol,
    provider: {
      baseUrl: config.summary.baseUrl,
      apiKey: config.summary.apiKey,
      headers: config.summary.model.headers,
      extraBody: config.summary.model.extraBody,
    },
    signal: new AbortController().signal,
    idleTimeoutMs: config.config.loop.streamIdleTimeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
    tag: 'merge',
    ...(folder ? { folder } : {}),
  })
  for await (const llmEv of stream) {
    if (llmEv.type === 'text_delta') text += llmEv.text
  }
  return cleanSummaryText(text)
}

/**
 * 每个 step_finish 之后落一次盘，**不是每个事件之后**。
 *
 * step_finish 是「模型这一步说完了，消息已经进历史」的时刻（loop/run.ts:247
 * 紧接着 push）。挑这个点有两层意思：
 *
 * 1. **半截消息不会落盘。** text_delta 期间消息还在 accumulator 里没进
 *    ctx.messages，这时 kill -9，磁盘上没有那条残缺的 assistant 消息——
 *    重启后是干净的「用户问了，还没答」，而不是一段说到一半的话
 * 2. 长任务跑十几轮时，中途崩溃只丢最后一轮，不是全部
 *
 * 工具执行后不单独落盘：tool_result 进历史是在下一轮 runStep 开头，
 * 那一轮的 step_finish 会一起带上。
 */
async function* tap(
  source: AsyncIterable<AgentEvent>,
  onStepFinish: () => void,
): AsyncIterable<AgentEvent> {
  for await (const agentEv of source) {
    yield agentEv
    if (agentEv.type === 'step_finish') onStepFinish()
  }
}

/**
 * config 里跟「往哪发、怎么发」有关的部分，喂给协议层。
 *
 * `headers` / `extraBody` 是模型级的，所以**规格由调用方传**——主对话传主模型、
 * 后台摘要传摘要模型。同一个网关下不同模型要带不同的路由参数
 * （比如 `providerId`），写死成 `config.model` 的话，配了 summaryModel 之后
 * 发出去的是「model 换了、providerId 没换」，路由到错的后端且不报错。
 *
 * 默认参数而不是拆成两个函数：拆开就是在邀请两条路径各自漂移，而它们只该差
 * 一个 ModelSpec。
 */
const providerContext = (
  config: LoadedConfig,
  spec: ModelSpec = config.model,
): ProviderContext => ({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  headers: spec.headers,
  extraBody: spec.extraBody,
})

/** 真正发 HTTP 的那条路径。协议、重试、鉴权都收在这里，loop 不认识它们 */
function httpStream(
  config: LoadedConfig,
  fetchImpl?: typeof fetch,
  folder?: string,
): LoopDeps['stream'] {
  return (request: Request, signal: AbortSignal): AsyncIterable<StreamEvent> =>
    requestWithRetry(
      (attemptSignal) =>
        sendRequest(request, {
          protocol: config.protocol,
          provider: providerContext(config),
          signal: attemptSignal,
          idleTimeoutMs: config.config.loop.streamIdleTimeoutMs,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(folder ? { folder } : {}),
        }),
      config.config.loop.retry,
      signal,
      { model: request.model, ...(folder ? { folder } : {}) },
    )
}

/**
 * 项目根的 `AGENTS.md`，读不到就返回 null。
 *
 * **缺失是正常情况，不报错**——它不是配置（配置缺失要响，CLAUDE.md §1.2），
 * 是项目可选的约定文件：读不到就当没有，整个会话照常起。
 *
 * **上限 2,048 token（2026-09 拍板）**：system 常驻区每轮全价，放任膨胀
 * 会同时吃预算余量（reservedTokens 才 2k）和注意力。建会话超限 → 截断
 * + 内嵌警告行；reloadSystem 超限 → 保旧版不换（见调用处）。
 */
const AGENTS_MAX_TOKENS = 2_048

function clampAgents(text: string): string {
  if (estimateTextTokens(text) <= AGENTS_MAX_TOKENS) return text
  // 两步保守切：先按 1.5 字/token 粗切（多数文本），复查仍超再按纯中文
  // 1 字/token 切。宁可多切一点也不超——常驻区超限的代价是每轮的
  let sliced = text.slice(0, Math.floor(AGENTS_MAX_TOKENS * 1.5))
  if (estimateTextTokens(sliced) > AGENTS_MAX_TOKENS) sliced = sliced.slice(0, AGENTS_MAX_TOKENS)
  return `${sliced}\n\n<!-- ⚠ AGENTS.md 超过 ${AGENTS_MAX_TOKENS} token 上限，此处已截断。请精简——常驻区每轮全价，砍下来的内容可拆进 .simple-code/notes/ -->`
}

async function readAgentsFile(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, 'AGENTS.md'), 'utf8')
  } catch {
    return null
  }
}

/**
 * `.simple-code/notes/` 的描述索引，一行一条（文件名 — description）。目录不存在
 * 或为空返回 null——和 AGENTS.md 同一款「可选文件缺失静默跳过」。
 *
 * notes 是 agent 的结论记忆（决策/约定/一次性事实），一笔记一事。标题进
 * system 常驻（联想成本归零），正文用 $SIMPLE_CODE_NOTE 读（顺带喂 LRU）。
 * 只收最近使用的 NOTES_INDEX_LIMIT 条（见 tools/note.ts 的 LRU 说明），
 * 挤出索引的不删，list 全量可查。
 */
async function readNotesIndex(root: string): Promise<string | null> {
  const cards = listNoteCards(root)
  if (cards.length === 0) return null
  const lines = cards
    .slice(0, NOTES_INDEX_LIMIT)
    .map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''}`)
  const rest = cards.length - NOTES_INDEX_LIMIT
  if (rest > 0) lines.push(`- （另有 ${rest} 条较旧未入索引："$SIMPLE_CODE_NOTE" list 全量可查）`)
  return lines.join('\n')
}

/**
 * system prompt = 内建段（一句话 + 产品工具约定，见 toolRules）+ 项目的 AGENTS.md。
 *
 * 配置里**没有** systemPrompt 字段（design.md §8）：它属于产品行为，不是
 * 用户配置项，放开了会让「模型表现不一致」变成无法排查的问题。
 * AGENTS.md 不违反这条——它是**项目**的文件，跟 package.json 同性质，
 * 不是用户的运行时配置。
 *
 * 为什么需要它：会话历史按时间衰减分辨率（见 turn-summary.md §4.6），
 * 而用户的约定是**常量不是事件**，放进衰减结构里等于判它死刑。实测本库
 * turn 96 用户不得不重说一遍「源码在 code external 目录下，之前告诉过你了」
 * ——那条信息其实一直写在 CLAUDE.md §8 里，只是从来没人打开过。
 *
 * **只在建会话时读一次**，改了 AGENTS.md 要重开会话才生效。
 * 刻意不做热重载：我们的 deps 只在 setModel 时重建，做热重载得改 send
 * 的结构，属于当前没有需求的复杂度（CLAUDE.md §2）。真嫌麻烦了再加。
 *
 * 模型状态行（方案 A，2025-09）：模型切换是静默操作——UI 和 host 的状态
 * 变了，agent 侧零感知，只能从工具输出倒推（view_image 的转述前缀曾
 * 误导出「当前是另一个模型」的错误判断）。状态行让 agent 任何一轮都能看到
 * 当前环境，与工作目录同构，不需要事件机制。effort 故意不进：effort
 * 切换高频，每次变都破 system prompt 缓存，纯亏。
 */
const systemPrompt = (
  root: string,
  agents: string | null,
  notes: string | null,
  /** 事件档案名称索引（proposals/events.md）。null = 空库不进段 */
  events: string | null,
  /** 教训 name 清单（lessonNamesIndex）。null = 空库不进段 */
  lessons: string | null,
  env: NodeJS.ProcessEnv,
  /** 模型身份与能力，只挑状态行要用的四个标量——纯函数不背整个 config */
  model: { provider: string; name: string; contextWindow: number; images: boolean },
  /** view_image 会走视觉副模型转述（caps.images=false 且配了 visionModel） */
  visionRelay: boolean,
  /** 本地日期（YYYY-MM-DD）。天粒度：跨天后第一个请求 system prompt 变一行，
   * prompt cache 全量失效一次——一天至多一次，与 notes 索引变动同级（2026-09-14
   * 拍板）。刻意不用 toISOString：那是 UTC，东八区每天 08:00 前差一天 */
  date: string,
): string => {
  const base =
    '你是 SimpleCode（SC）里的编码 agent——跑在 VS Code 扩展面板或终端 sc 一次性命令里，' +
    '与用户往返对话、调用工具、修改项目，loop 由 SC 驱动。' +
    // DOC 入口条件拼（理由同 toolRules）：没注入 bin 的环境指路就是误导。
    // 2026-09-17 v2 拍板：开场先立图景（在哪跑/给谁干活/全貌去哪查），
    // 原来的「你是一个在终端里工作的编码助手」直接跳进规则、低估了面板形态
    (env.SIMPLE_CODE_DOC !== undefined
      ? 'SC 自身的运作（上下文分区/记忆/审批/排障）任何目录可查：grep "<关键词>" "$SIMPLE_CODE_DOC"。'
      : '') +
    `\n当前工作目录是 ${root}。\n` +
    `今天是 ${date}（本地时区）。` +
    `当前模型：${model.provider}/${model.name}，上下文窗口 ${model.contextWindow} tokens。` +
    (model.images
      ? '支持图片输入：view_image 的图直接进上下文。\n'
      : visionRelay
        ? '不支持图片：view_image 返回视觉副模型的文字转述，原图只存档。\n'
        : '不支持图片：view_image 只返回图片的格式与字节数。\n') +
    `需要了解或修改项目时，用 bash 工具执行命令。${contextRules(env)}${growthRules(lessons, env)}${toolRules(env)}${modelRules(env)}`
  // notes 段独立于 AGENTS.md——没有约定文件的项目照样可以记笔记
  const withAgents =
    agents === null ? base : `${base}\n\n以下是本项目的约定，来自 AGENTS.md：\n\n${agents}`
  if (notes === null) return withAgents
  const withNotes =
    notes === null
      ? withAgents
      : `${withAgents}\n\n## notes 索引（相关的读正文："$SIMPLE_CODE_NOTE" read <name>；新结论当场写："$SIMPLE_CODE_NOTE" write）：\n\n${notes}`
  if (events === null) return withNotes
  return `${withNotes}\n\n## 历史事件档案（按事归档、跨摘要窗口完整；检索："$SIMPLE_CODE_EVENT" search <关键词> / read <name>）：\n\n${events}`
}


/**
 * 产品级工具约定，**条件拼**：宿主注入了对应 bin 才写那行（CLI/测试环境
 * 没注入，写了只会误导）。为什么放 system prompt 不放 AGENTS.md：这是
 * simple-code 自带的行为，不是项目约定。为什么只写分流规则不写格式：
 * 格式与示例在 bash 工具描述里（那里才是操作手册），这里管「该用哪个」——
 * 它是常量，放进衰减的历史里等于判它死刑（理由同上）。
 */
const toolRules = (env: NodeJS.ProcessEnv): string => {
  const lines: string[] = []
  if (env.SIMPLE_CODE_APPLY_PATCH !== undefined)
    lines.push(
      '- 修改既有文件用 "$SIMPLE_CODE_APPLY_PATCH"（上下文匹配补丁，格式与完整示例在 bash 工具描述里）；' +
        'python3/sed 只在补丁表达不了时用（按行号定位、跨文件计算）。',
    )
  if (env.SIMPLE_CODE_MEMORY !== undefined)
    lines.push('- 下钻历史会话用 "$SIMPLE_CODE_MEMORY" search/show（one session 全量落盘，细节随时可捞）。')
  if (env.SIMPLE_CODE_EVENT !== undefined)
    lines.push(
      '- 历史事件档案（按事归档、跨摘要窗口完整）：查「之前那件事怎么做的」优先用 "$SIMPLE_CODE_EVENT" search <关键词> / read <name>，别拼摘要碎片。',
    )
  // LSP 分流行（2026-09-17 v2 拍板）：分流句+语言无关从 bash 描述挪到这里——
  // 与 APPLY_PATCH 分工对齐：工具约定管「该用哪个」，描述管「怎么写」
  if (env.SIMPLE_CODE_LSP !== undefined)
    lines.push(
      '- 代码符号检索优先用 "$SIMPLE_CODE_LSP"（查引用/看文件结构时优先于 grep——grep 找字符串会漏同名遮蔽，' +
        '语言无关，TS/Java/Python 只要宿主有语言服务就通；命令格式在 bash 工具描述里）。',
    )
  // LESSON/NOTE 行（2026-09-17 v2 拍板）：read 入口从经验沉淀节挪来——分工
 // 变为「沉淀讲什么时候记，约定讲什么时候用哪个」
  if (env.SIMPLE_CODE_LESSON !== undefined)
    lines.push(
      '- 查教训用 "$SIMPLE_CODE_LESSON" read <name>（name 即症状，清单见经验沉淀①）；search <关键词> 跨库查。',
    )
  if (env.SIMPLE_CODE_NOTE !== undefined)
    lines.push('- 读结论记忆用 "$SIMPLE_CODE_NOTE" read <name>；list 全量描述。')
  if (env.SIMPLE_CODE_MCP !== undefined)
    lines.push(
      '- 外部工具经 MCP："$SIMPLE_CODE_MCP" list 看已配置的 server，"$SIMPLE_CODE_MCP" tools <server> 看工具清单（含参数 schema），' +
        "调用 \"$SIMPLE_CODE_MCP\" <server> <tool> '{\\\"key\\\":\\\"value\\\"}'；不重造轮子前先看有没有现成的 MCP 工具。",
    )
  return lines.length === 0 ? '' : `\n\n## 工具约定\n${lines.join('\n')}`
}

/**
 * 上下文系统的自我说明（产品内置）。模型不知道自己的记忆会被摘要降分辨率、
 * 不知道原文全量落盘时，会凭模糊印象猜历史细节、把关键决策只说在对话里——
 * 几轮摘要后决策就蒸发了（turn-127 的教训反哺给系统本身）。
 * one session / 摘要 / 卸载 / 落盘不丢是 core 行为，任何环境都成立，无条件；
 * 检索句条件拼，理由同 toolRules：没注入 bin 的环境说了就是误导。
 */
const contextRules = (env: NodeJS.ProcessEnv): string => {
  const retrieval =
    env.SIMPLE_CODE_MEMORY !== undefined
      ? '细节模糊时先检索再下结论（宽搜直接 grep memory 的 turns 目录，定位用 "$SIMPLE_CODE_MEMORY" search/show，见工具约定），不要凭印象猜。'
      : ''
  return (
    '\n\n## 上下文与记忆\none session——没有「新会话」，历史连续、全量落盘。' +
    `老对话会被自动摘要降分辨率并卸载到磁盘，原文不丢。${retrieval}` +
    // 摘要按 step 窗口机械切分，横跨窗口边界的事会分进两份摘要——旧份停在
    // 「未完成」、做完的记录落在新份（turn-700 误报熔断未修的教训：引用旧份
    // 的快照当现状）。警示无条件在场：不依赖检索工具，git/notes 是盘上事实
    '摘要按 step 窗口压缩，横跨边界的事会分进两份——旧摘要的「未完成/待办」是窗口结束时的快照，不是现状；凡「做没做过/改没改过」的结论，以 git、notes 与 events 为准，别引用摘要下结论。' +
    '也因此，重要的决策、约定、路径应写进文件（AGENTS.md、代码注释、commit message）——对话会衰减，文件不会。' +
    // 上提自 AGENTS.md（t884 拍板）：这两条是产品前提不是用户偏好——原文
    // 全量落盘、捞得回来，所以不必处处加保险，也因此核实的代价很低。合成
    // 一段是因为共享同一个前提；写成动作而非态度是因为态度版在 AGENTS.md
    // 里存在已久，t880 仍连犯两次（凭印象断言 orphan 只能重做、没跑命令
    // 就说产物里没有某句）——「先核实」四个字读了会点头，不改变行为
    '代价可恢复的问题不加机制：多绕一下、多跑一次命令就能补回来的，就让它绕。也因此下结论前先核实——「能不能」跑一次试试，「有没有」grep 一次，别拿印象当事实。' +
    // 常驻清单（t885 用户提出）：模型只有读了本仓源码才知道「AGENTS.md 每轮
    // 全价」——换个目录就不知道自己在花钱，会往 AGENTS.md 猛写、把该记 note
    // 的塞进常驻区。只写「谁常驻/谁不常驻」的相对关系，不写 2048/30 条这类
    // 参数：数字会变，写进 prompt 就是第二处真相，细节归 DOC（§1 常驻层）
    '常驻上下文（每轮全价重发）：内建段 + AGENTS.md 全文 + notes/教训/事件的索引行；各类正文只在你主动 read 时才进上下文。放不进 AGENTS.md 的内容拆进 notes，别硬塞常驻区。'
  )
}

/**
 * 经验沉淀机制（产品内置）。教训和技能都是盘上的文件约定，**零注入**——
 * 索引职责由文件名/目录名承担，不往 system prompt 里塞 description 清单。
 * 两类机制的触发方不同：教训是模型受挫自发触发（受挫本身就是「该查了」
 * 的信号）；技能是用户点名才触发（发现性责任在用户，模型不主动）。
 * 写入门槛「失败 ≥2 次后成功」是噪音过滤器：一次成功的常规操作和纯失败
 * 都不值得记（t250 webview 弹层之战的设计沉淀）。
 */
const growthRules = (lessons: string | null, env: NodeJS.ProcessEnv): string =>
  '\n\n## 经验沉淀\n' +
  // 教训清单（2026-09-17 方案 A）：name 即症状句，看得见才会想起查——
  // 零注入时期实测只写不读（write 60 / read 9），清单把复用链路接回来。
  // 压缩点换新（与 notes/events 索引同点）：新教训在原文还热时不进清单
  '①教训（name 即症状，调试受挫先对着清单看一眼，查法见工具约定）：' +
  (lessons === null ? '教训库为空。' : `\n${lessons}\n`) +
  '一件事失败 ≥2 次后终于做成，用 write 记一条（五段内容，front matter 和标题' +
  '自动组装——description 写清治什么症状、什么时候读）。\n' +
  '②技能：仅当用户点名时使用——项目 `.simple-code/skills/<name>/SKILL.md` 与' +
  '用户 `~/.simple-code/skills/<name>/SKILL.md`（同名时用户级覆盖项目级），' +
  '目录名即名字，按 SKILL.md 内容执行。\n' +
  '③note：结论记忆（决策/约定/一次性事实）。' +
  '重要的结论当场 `write` 记一条（name/title/description/正文，一笔记一事，读法见工具约定），' +
  '别指望对话衰减后还记得。\n' +
  // 常驻推论（t885）：①的 name、③的 description 是索引行，每轮全价重发；
  // 正文只在 read 时才进。模型不知道这个落差时会把力气花在正文、把
  // description 写成标题的同义反复——而那行才是「将来会不会点开」的唯一依据
  '写 ①③ 时注意：教训的 name 与 note 的 description 是常驻索引行（每轮重发），正文只在被 read 时才进上下文——那一行要写成检索线索（治什么症状、何时该读），正文不怕长。\n' +
  // ④机制说明非动作（2026-09-17 v2 拍板）：event 的写入是 archiver 在压缩点
  // 自动跑的，模型只读——补齐全家福（教训/技能/note/事件四层沉淀各自怎么进出）
  (env.SIMPLE_CODE_EVENT !== undefined
    ? '④事件归档：压缩点由 archiver 自动按事归档，跨摘要窗口完整——查「之前那件事怎么做的」优先 `"$SIMPLE_CODE_EVENT" search`（详见工具约定）。'
 : '')

/**
 * 模型身份的操作事实（产品内置）。模型不知道「用户可以随时换掉自己」时，
 * 遇到能力缺口会硬撑（无视觉的模型拿占位文本糊弄看图请求）而不是说
 * 「切个模型」。切换不重开会话、历史延续——「切到 vision 模型再看这张图」
 * 才是一条真实可行的指令。
 *
 * 条件拼：vscode 宿主才注入 bin（extension.ts activate），CLI 一次性
 * 进程用户中途切不了模型，说了就是误导。
 */
const modelRules = (env: NodeJS.ProcessEnv): string =>
  Object.keys(env).some((k) => k.startsWith('SIMPLE_CODE_'))
    ? '\n\n## 模型与档位\n用户可以随时切换模型与推理档位，切换不重开会话、历史照常延续。' +
      '遇到当前模型的能力缺口（比如看图需要视觉模型），建议用户切换，不要硬撑。'
    : ''

async function* empty(): AsyncIterable<AgentEvent> {}

/** for await 提前 break 时也要跑 cleanup——用户关掉面板就是这种情况 */
async function* finallyDo<T>(source: AsyncIterable<T>, cleanup: () => void): AsyncIterable<T> {
  try {
    yield* source
  } finally {
    cleanup()
  }
}
