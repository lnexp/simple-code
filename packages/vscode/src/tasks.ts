import {
  type AgentEvent,
  type ApprovalCategory,
  type Session,
  type SetTimer,
  finalizeTask,
  flipTaskLive,
  createTask,
  lastTaskReply,
  listTaskManifests,
  logRun,
  postTaskResult,
  type TaskManifest,
  taskResultText,
  writeTaskManifest,
  scopeOf,
  watchIdle,
} from '@simple-code/core'
import {
  type ChatItem,
  type ChatView,
  emptyView,
  hydrateItems,
  replayWithUsers,
} from '../webview/events.ts'
import type { Effort, ModelRef } from '@simple-code/core'
import type { TaskState, ToWebview } from './protocol.ts'
import { turnTracker, type RobotTaskView, type TurnEnd } from './robot-feed.ts'

/**
 * 任务中枢（task-trunk，docs/proposals/task-trunk.md；前身 task-v3）。
 *
 * 每个文件夹一个实例（bridge 持有）。任务与对话共用同一个库（owner 分治，
 * core/session/task.ts + store.ts TaskScope），这里管任务的宿主侧生命周期：
 * 派活（开段 + 复制主干摘要 + owner-scoped session 起跑）、流事件镜像转发、发消息
 * （任务可交互）、关闭（唯一的收尾操作——live 翻 unloaded、摘要排空、
 * 段合回）。开/关都不等主任务静止，任务数不设上限。
 *
 * ## 分支是可交互的（2026-09-22 拍板）
 *
 * 推翻早前「一次性任务书跑完收口」的形态：切到分支能继续打字——
 * `send()` 在 running 时走 core 的插话路径（session.send 入队 + 软中断，
 * 空流立即返回），空闲时起一轮 `runLoop`。任务书退化成第一条消息。
 *
 * ## 分身 session
 *
 * `memoryRoot=任务目录` + `skipLock`（同进程主干已持锁——acquireLock 按
 * pid 判活，第二个 session 会撞自己）。审批走 bridge 的中枢（同一个开关、
 * 同一个 5 分钟超时），卡上带 `task` 标注。空闲摘要照常挂
 * （watchIdle）——不挂的话分身全程 live，merge 时「收尾段」口径会吞掉
 * 整段经历。
 *
 * ## 镜像
 *
 * 任务面板是 webview 的又一份投影：跑时推 `task_agent` 增量，切走/重开由
 * `rehydrate`（attach 调）补 `task_hydrate` 基线——和 bridge 的主镜像
 * 同一套 pattern（baseItems + replay + fold 重读 historyRows）。
 */
export type TaskApprovalQ = {
  command: string
  toolCallId: string
  category: ApprovalCategory
  detail: string
  reason: string
  parts?: ApprovalCategory[]
  always?:
    | { kind: 'lead'; lead: string }
    | { kind: 'path'; dir: string }
    | { kind: 'nonpath'; lead: string; from: number }
    | { kind: 'paths'; dirs: string[]; hidden?: { path: string; write: boolean }[] }
    | { kind: 'hidden'; path: string; write: boolean }
  task?: string
}
export type TaskApprovalResult = 'allow' | 'always' | 'deny' | 'timeout' | { deny: string }

/** 分支的模型选择持久化（键 = 任务目录，panel 层注 Memento 实现）。
 *  分支 session 是 core 的 getSession——saveChoice 是 bridge 层概念，
 *  分支的存取走这里。get 返回 null = 没存过（用配置默认） */
export type TaskChoice = { provider: string; model: string; effort?: string; preset?: string }
export type TaskChoiceStore = {
  get(dir: string): TaskChoice | null
  set(dir: string, choice: TaskChoice): void
}

export type TaskDeps = {
  folder: string
  post: (msg: ToWebview) => void
  /** 分支模型选择的持久化（2026-09-22 拍板：分支持久化）。不传 = 内存态 */
  choiceStore?: TaskChoiceStore
  /** 任务 session 工厂（skipLock 已含）：同一个库、同一个 root，owner 域 */
  session: (
    task: TaskManifest,
    requestApproval: (q: TaskApprovalQ) => Promise<TaskApprovalResult>,
  ) => Promise<Session>
  /** bridge 的审批中枢（带 task 标注透传） */
  requestApproval: (q: TaskApprovalQ) => Promise<TaskApprovalResult>
  setTimer?: SetTimer
  /** 有任务回调投给了主任务（task-trunk 规则 12）：bridge 在主任务空闲时取走、
   *  刷新主视图；在跑时 loop 下一个请求前自己取 */
  pokeMain?: () => void
}

export type TaskOutcome = { ok: boolean; error?: string }

type Run = {
  name: string
  manifest: TaskManifest
  status: 'running' | 'idle' | 'error' | 'closing'
  error?: string
  lastText: string
  /** 本轮被停止（停止键或关闭）。完成回调的状态判据——中断不产生事件 */
  stopRequested?: boolean
  /** 桌面机器人用：本轮开始时刻、上一轮的结局（desktop-robot.md §5.3） */
  startedAt?: number
  lastTurn?: TurnEnd
  /** agent 派任务时指定的模型（--model，规则 14）：会话建成时套上并持久化，然后清掉 */
  choice?: TaskChoice
  /** 惰性建立（fork 即建 / 恢复的第一次用到才建）。null = catch 兜底的
   *  建失败也进缓存——避免每次交互都重撞同一个错 */
  sessionP: Promise<Session | null> | null
  /** await sessionP 后的缓存——states() 是同步的，现算控件状态用 */
  session: Session | null
  idle: ReturnType<typeof watchIdle> | null
  baseItems: ChatItem[]
  replay: Array<{ ev: AgentEvent; at: number }>
  /** 进行中轮次的用户文本（插话不在这，在 queuedTexts）。mirror 要把它摆进 items——
   *  用户消息从不进 replay 事件流，没有它 task_hydrate 一替换就把 webview
   *  的乐观气泡抹掉（2026-09-23 真机：分支里用户消息消失、回答与上一条
   *  粘连）。fold 后清空——historyRows 里从此有了真的。pos = 进来时
   *  replay 的长度，镜像按它插回（和 bridge pendingUsers 同口径） */
  pendingTexts: Array<{ text: string; pos: number }>
  /** 跑着时的插话，镜像先放 ChatView.queued，重放到 `input_delivered` 才进
   *  items（同 bridge queuedUsers）。fold 后清空 */
  queuedTexts: string[]
  /** 没送达的插话（2026-09-23 检视：插话失败原来只进宿主日志的
   *  unhandled rejection，界面毫无痕迹）。常驻视图直到用户下一次发话——
   *  放 replay 里会被轮末 fold 清掉，一闪而过 */
  notices: string[]
  /** 本轮的错误事件（core 把轮内错误作为 error 事件产出、不抛）。轮末
   *  fold 清空 replay，错误事件跟着消失——视图上就是「发了没反应」
   *  （2026-09-23 真机：PrefixBrokenError 在任务里一闪而过）。常驻到用户
   *  下一次发话，同 notices */
  turnErrors: string[]
  /** 分支自己的审批开关（2026-09-22 拍板：审批配置跟分支走）。内存态，
   *  对齐主干（主干的开关也不持久化） */
  approvalOn: boolean
  /** 底栏的水位与上一轮用量（首字/总耗时/↑↓）。fold 清空 replay 前从镜像
   *  里接住——它们是 ChatView 字段、不在 items 里，hydrateItems 重建不出来；
   *  不存的话切走再切回（task_hydrate 整体替换）底栏就没了（2026-09-23 真机）。
   *  主镜像同款：bridge 的 lastContextTokens/lastTiming */
  usage: Pick<ChatView, 'contextTokens' | 'lastTiming'>
}

/** 分支 session 的当前模型选择（preset 带上——存-读回合丢字段的坑，
 *  见 bridge 的同款注释）。bridge 的主镜像也用这同一个实现 */
export const readModel = (session: Session): ModelRef => {
  const preset = session.presetState().current
  return {
    provider: session.config.config.provider,
    model: session.config.config.model,
    ...(preset === undefined ? {} : { preset }),
  }
}

/** 任务第一条消息前的轻量框架：系统提示词与对话共享（root 相同），只补一句它的
 *  处境——上下文只有主干那套已合回的历史摘要，看不到开它的任务最近在聊什么 */
export const frameBrief = (name: string, text: string): string =>
  `（task-${name}：你是一个独立任务。你的上下文只有已合回的历史摘要，看不到开你的那个任务最近的对话——按任务书干活。你的经历会合回历史，别的任务之后能看到。）\n\n${text}`

/** database is locked 的让线程退避重试（150/300/450ms，共 3 次）。同进程
 *  单线程下 busy_timeout 的同步等待等不来持锁者让出（COMMIT 也排在本线程
 *  队列里），只能让出线程再试——对话摘要器的事务毫秒级，几乎必过（2026-09-23
 *  实测 dispatch 撞摘要器写库必炸）。其他错重试无益，原样抛 */
export async function retryLocked<T>(fn: () => T | Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i > 3 || !String(error).includes('database is locked')) throw error
      await new Promise((res) => setTimeout(res, 150 * i))
    }
  }
}

export function createTaskCenter(deps: TaskDeps) {
  const runs = new Map<string, Run>()

  const postTasks = (): void => {
    deps.post({ type: 'tasks', tasks: states() })
  }

  const states = (): TaskState[] =>
    [...runs.values()].map((r) => {
      // 控件状态从 session 现算（setModel/setEffort 直改 session，不另记账）
      const ps = r.session?.presetState()
      const preset = ps?.current
      const effortState = r.session?.effortState()
      return {
        name: r.name,
        status: r.status,
        lastText: r.lastText,
        ...(r.error !== undefined ? { error: r.error } : {}),
        current: r.session === null ? null : readModel(r.session),
        effort: effortState?.effort ?? null,
        effortOverridden: effortState?.overridden ?? false,
        ...(preset === undefined ? {} : { preset }),
        presets: ps?.available ?? [],
        // 同 bridge refresh 的判据（直收图或走 visionRelay 转述）
        imagesEnabled:
          r.session !== null &&
          (r.session.config.model.capabilities.images || r.session.config.vision !== null),
        contextWindow: r.session?.config.model.contextWindow ?? 0,
        approvalOn: r.approvalOn,
      }
    })

  const mirror = (r: Run): ChatView => {
    let view: ChatView = {
      ...emptyView(),
      ...r.usage,
      items: [...r.baseItems],
      queued: r.queuedTexts.map((text) => ({ kind: 'user', text, interject: true }) as const),
    }
    // pending 用户气泡按进来时的位置插回 replay：本轮第一条在 replay 之前，
    // 既是「用户已说」的可见性，也把流式回答和上一条回答隔开（否则 reduce
    // 出的新 assistant 条目与 baseItems 末尾的 assistant 视觉粘连成一个）。
    // 插话由 replay 里的 input_delivered 从 queued 摆进来，和实时视图一致
    view = replayWithUsers(
      view,
      r.replay,
      r.pendingTexts.map(({ text, pos }) => ({
        item: { kind: 'user', text } as ChatItem,
        pos,
      })),
    )
    // 出错原因进视图（2026-09-23 实测：错误原来只在任务 tab 的 hover 里，
    // 切进任务看到的是空白或半截，用户无从知道发生了什么）。放镜像里而
    // 不是 webview 本地追加：hydrate 基线是单一真相，本地追加会被下一次
    // hydrate 冲掉
    if (r.status === 'error' && r.error !== undefined) {
      view = { ...view, items: [...view.items, { kind: 'notice', text: r.error, errorKind: '任务出错' }] }
    }
    for (const text of r.notices)
      view = { ...view, items: [...view.items, { kind: 'notice', text, errorKind: '插话失败' }] }
    // 已在 replay 里的（本轮还没 fold）由 reduce 渲染，不重复摆
    if (r.replay.length === 0)
      for (const text of r.turnErrors)
        view = { ...view, items: [...view.items, { kind: 'notice', text, errorKind: '任务出错' }] }
    return view
  }

  /** task_hydrate：items + 底栏两字段（主 hydrate 同款，见 protocol） */
  const hydrateMsg = (r: Run): ToWebview => {
    const view = mirror(r)
    return {
      type: 'task_hydrate',
      name: r.name,
      items: view.items,
      contextTokens: view.contextTokens,
      ...(view.lastTiming ? { lastTiming: view.lastTiming } : {}),
      ...(view.queued.length > 0 ? { queued: view.queued } : {}),
    }
  }

  const fold = (r: Run, session: Session): void => {
    // 同步版（原图行，hydrateItems 端窄化掉不显示）——bridge 的 fold 同款；
    // toHydrateRows 是 async（缩略图），跑完的收口不值得为它等一轮微任务
    const { contextTokens, lastTiming } = mirror(r)
    r.usage = { contextTokens, lastTiming }
    r.baseItems = hydrateItems(session.historyRows())
    r.replay = []
    r.pendingTexts = []
    r.queuedTexts = []
  }

  /** 最后一条 assistant 文本——卡片摘要预览 + 合并前的「大概知道它干了什么」 */
  const lastAssistantText = (items: ChatItem[]): string => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item !== undefined && item.kind === 'assistant' && item.text !== '') return item.text
    }
    return ''
  }

  /** 空闲的任务把投给它的回调取走、刷新视图（在跑的由 loop 自己取） */
  const absorb = (r: Run): void => {
    const s = r.session
    if (s === null || r.status === 'running' || r.status === 'closing') return
    if (s.takeTaskResults() === 0) return
    fold(r, s)
    deps.post(hydrateMsg(r))
  }

  /**
   * 投回调给登记者（规则 12）。登记者已关闭 = 不回调（经历照旧按段合回）。
   * 写进库里的信箱再戳一下：登记者的 session 可能还没建（主任务没说过话、
   * reload 后的任务还没点开），信箱等它下次跑时取
   */
  const deliver = async (task: string, parent: string, text: string): Promise<void> => {
    const target = parent === '' ? null : ([...runs.values()].find((x) => x.manifest.owner === parent) ?? null)
    if (parent !== '' && (target === null || target.status === 'closing')) {
      logRun({ ev: 'task_callback', folder: deps.folder, task, parent, skipped: 'parent_closed' })
      return
    }
    try {
      await retryLocked(() => postTaskResult(deps.folder, parent, text))
    } catch (error) {
      logRun({ ev: 'task_callback', folder: deps.folder, task, parent, error: String(error) })
      return
    }
    logRun({ ev: 'task_callback', folder: deps.folder, task, parent, chars: text.length })
    if (target === null) deps.pokeMain?.()
    else absorb(target)
  }

  /** 派出那一轮结束：定状态、标已回调（manifest）、投递。over = 恢复路径给定
   *  的状态与回复（reload 打断了那一轮） */
  const callback = (r: Run, over?: { status: string; reply: string }): void => {
    const status =
      over?.status ??
      (r.stopRequested || r.status === 'closing'
        ? '被停止'
        : r.status === 'error' || r.turnErrors.length > 0
          ? `出错：${r.error ?? r.turnErrors.at(-1) ?? ''}`
          : '完成')
    r.manifest = { ...r.manifest, callback: 'done' }
    // 关闭中不写：close 收尾会删 manifest，这里写回去任务就「复活」了
    if (r.status !== 'closing') writeTaskManifest(deps.folder, r.manifest)
    void deliver(r.name, r.manifest.parent ?? '', taskResultText(r.name, status, over?.reply ?? r.lastText))
  }

  /** 跑一轮。text = 本轮输入（第一轮带分身框架句）。轮与轮之间 idle 等输入 */
  const runLoop = async (r: Run, text: string): Promise<void> => {
    let session: Session | null = null
    r.stopRequested = false
    r.startedAt = Date.now()
    const turn = turnTracker()
    try {
      session = await ensureSession(r)
      if (session === null) return
      for await (const ev of session.send(firstOf(r, text))) {
        const at = Date.now()
        turn.see(ev)
        // 后台进程快照不是聊天条目（bridge 主循环同款姿势）：折成独立消息
        if (ev.type === 'bg_processes') {
          deps.post({ type: 'bg_processes', items: ev.items })
          continue
        }
        r.replay.push({ ev, at })
        if (ev.type === 'error') r.turnErrors.push(ev.message)
        deps.post({ type: 'task_agent', name: r.name, event: ev, at })
        if (ev.type === 'step_finish') r.lastText = lastAssistantText(mirror(r).items)
      }
      // closing 是终局态，只有 close() 自己能改（失败回 idle）：关闭会
      // interrupt 在跑的轮，这里跑完若照写 idle，任务条又冒出关闭键、
      // 还能发消息另起一轮
      if (r.status !== 'closing') r.status = 'idle'
    } catch (error) {
      if (r.status !== 'closing') {
        r.status = 'error'
        r.error = error instanceof Error ? error.message : String(error)
      }
    } finally {
      // 建会话失败（ensureSession 回 null，不走 catch）与 send 抛出都落在 error 态
      if (r.status === 'error') turn.fail(r.error ?? '任务出错')
      r.lastTurn = turn.end(r.stopRequested || r.status === 'closing')
      // fold 挪到 finally：错误路径的已落盘历史同样要进基线（session.save
      // 每 step 落一次，出错时库里已有半截），且 fold 后推一次权威快照——
      // 用户消息从此在 historyRows 里，webview 的乐观气泡换成真身
      // 分段计时同 bridge 的 turn_end_host（2026-10-31 观测版）
      let mark = Date.now()
      const lap = (): number => {
        const now = Date.now()
        const ms = now - mark
        mark = now
        return ms
      }
      let textMs = 0
      let foldMs = 0
      let postMs = 0
      let items = 0
      if (session !== null) {
        // 本轮最后一条回复（回调原文）：fold 前从重放取——这一轮的事件都在里面
        r.lastText = lastAssistantText(mirror(r).items) || r.lastText
        textMs = lap()
        // 轮跑着时投来、loop 没赶上插的回调（轮在最后一个请求后才收到）：
        // 现在空闲了，插到末尾再定稿基线
        session.takeTaskResults()
        fold(r, session)
        foldMs = lap()
        const msg = hydrateMsg(r)
        if (msg.type === 'task_hydrate') items = msg.items.length
        deps.post(msg)
        postMs = lap()
      }
      // 派出那一轮结束：回调登记者一次（规则 12）
      if (r.manifest.callback === 'pending') callback(r)
      // 跑完一轮 arm 空闲摘要（config 0 = 关）：分身的多 turn 经历不摘的话
      // 全程 live，merge 收尾段口径会把整段吞掉（fork-merge.md §4.6）
      if (r.status !== 'closing') r.idle?.arm()
      postTasks()
      logRun({
        ev: 'turn_end_host',
        folder: deps.folder,
        owner: r.manifest.owner,
        textMs,
        foldMs,
        items,
        postMs,
        tailMs: lap(),
      })
      // session 故意不关：空闲摘要还在跑。merge/discard/dispose 时关
    }
  }

  /** 空任务的第一条消息（规则 13）：拼框架句、去掉标记落盘。会话建成才算开跑——
   *  建失败用户重发，仍按第一条处理 */
  const firstOf = (r: Run, text: string): string => {
    if (r.manifest.awaitingFirstMessage !== true) return text
    const { awaitingFirstMessage: _, ...rest } = r.manifest
    r.manifest = rest
    writeTaskManifest(deps.folder, r.manifest)
    return frameBrief(r.name, text)
  }

  /** 分支 session 的惰性建立（fork 即建、恢复的分支第一次被用到才建）。
   *  建好后：持久化的模型选择读回 + fold 一次基线（fork 点前的主干历史）
   *  + 空闲摘要挂上 */
  const ensureSession = (r: Run): Promise<Session | null> => {
    if (r.sessionP === null) {
      const labeled = (q: TaskApprovalQ): Promise<TaskApprovalResult> =>
        deps.requestApproval({ ...q, task: r.name })
      const attempt = async (): Promise<Session | null> => {
        const s = await deps.session(r.manifest, labeled)
          r.session = s
          r.idle = watchIdle(s, deps.setTimer)
          // 上次建立失败留下的 error 态（open 重试成功的路径）清回 idle——
          // 否则会话好了 tab 还挂红点、视图还挂错误条。dispatch 路径此时是
          // running，不动
          if (r.status === 'error') {
            r.status = 'idle'
            delete r.error
          }
          // 持久化的模型选择读回（键 = owner，reload 后任务配置还在）
          const saved = deps.choiceStore?.get(r.manifest.owner) ?? r.choice
          if (saved) {
            try {
              s.setModel(saved)
              if (saved.effort !== undefined) s.setEffort(saved.effort as Effort)
              if (r.choice) persistChoice(r, s)
            } catch {
              /* 失效的选择（模型删了）：走配置默认，restore 的 setModel 抛
                 过的自愈路径在 session 层——这里静默即可 */
            }
            delete r.choice
          }
          // 现在就刷一次基线：historyRows 是 fork 点前的主干历史——第一轮
          // 还在跑时切过去（task_open），基线里就有主干历史 + 分支增量。
          // 刷完推一次：open() 常抢在建会话前推了空基线，这里补上真的。
          // **只刷 baseItems，不走 fold**：fold 会清 pendingTexts，而此刻
          // send 还没开始（runLoop 先 await 这里），用户消息既不在
          // historyRows 也不在 replay——清掉它第一轮全程看不见自己发的
          // 话（2026-09-23 真机；reload 后首条 task_send 同理）
          r.baseItems = hydrateItems(s.historyRows())
          deps.post(hydrateMsg(r))
          postTasks() // 控件状态从 null 变实——刷新一次
          return s
      }
      r.sessionP = retryLocked(attempt).catch((error: unknown) => {
        // 终态失败不能吞成静默的 null：runLoop 对 null 裸 return，任务
        // 会永远 running、零 turn 零报错。标 error 让任务条可见，清
        // sessionP 让下一次交互（send/open）能重试
        r.sessionP = null
        if (r.status !== 'closing') {
          r.status = 'error'
          r.error = `会话建立失败：${error instanceof Error ? error.message : String(error)}`
        }
        logRun({
          ev: 'task_session_fail',
          folder: deps.folder,
          task: r.name,
          owner: r.manifest.owner,
          error: String(error),
        })
        postTasks()
        // 正看着这个任务的话视图要跟着出错误条（runLoop 对 null 裸
        // return，finally 里的 hydrate 只在有 session 时推）
        deps.post(hydrateMsg(r))
        return null
      })
    }
    return r.sessionP
  }

  // ── 恢复（task-v3）────────────────────────────────────────────
  // reload/重启后内存丢了，manifest 在磁盘上。任务的对话状态本来就在库里
  // （owner 域的 live 行），重开 owner-scoped session 即原样回来——不存在
  // 「目录里的过期快照」问题
  for (const manifest of listTaskManifests(deps.folder)) {
    if (runs.has(manifest.name)) continue
    runs.set(manifest.name, {
      name: manifest.name,
      manifest,
      status: 'idle',
      lastText: '',
      sessionP: null,
      session: null,
      idle: null,
      baseItems: [],
      replay: [],
      pendingTexts: [],
      queuedTexts: [],
      notices: [],
      turnErrors: [],
      usage: { contextTokens: 0, lastTiming: null },
      approvalOn: true,
    })
  }
  // 派出那一轮被 reload 打断（manifest 还是 pending）：恢复时补一次「被停止」
  // 回调，否则登记者永远等不到结果
  for (const r of runs.values()) {
    // 空任务还没跑过（规则 13）：没有「派出那一轮」可被打断，回调留到第一轮结束
    if (r.manifest.callback !== 'pending' || r.manifest.awaitingFirstMessage === true) continue
    // 读最后回复要开库：锁/坏库抛错不能拖垮整个任务中心，回调照补、正文留空
    let reply = ''
    try {
      reply = lastTaskReply(deps.folder, r.manifest.owner)
    } catch (error) {
      logRun({ ev: 'task_callback', folder: deps.folder, task: r.name, replyError: String(error) })
    }
    callback(r, { status: '被停止（窗口重载打断）', reply })
  }
  if (runs.size > 0) postTasks()
  /** 派活。返回 null = 已受理；字符串 = 拒绝原因（fatal 透给用户）。
   *  不限数、不等任何会话静止（task-trunk 规则 7/11）：开任务只写自己的段与
   *  主干摘要的副本。parent = 开它时所在的任务（主任务 ''），只进 runlog——
   *  用户开的任务不回调（规则 12，见 openRun） */
  /** 开任务撞锁重试期间占着名字——await 让出线程后，连点两次同名得在这一刻就被拦住 */
  const forking = new Set<string>()
  const nameOf = (brief: string): string => brief.split('\n', 1)[0]?.slice(0, 20).trim() || '任务'
  const taken = (name: string): boolean => runs.has(name) || forking.has(name)

  const dispatch = (brief: string, parent?: string): Promise<string | null> =>
    dispatchNamed(nameOf(brief), brief, { via: 'user', ...(parent !== undefined ? { parent } : {}) })

  /** 只输名称开空任务（「+ 任务」，规则 13）：建好进任务条、idle，不跑——用户
   *  先切模型（setModel 照常建会话、按 owner 存选择）再发第一条消息 */
  const create = async (name: string, parent: string): Promise<string | null> => {
    const r = await openRun(nameOf(name), { via: 'user', parent, awaitingFirstMessage: true })
    if (typeof r === 'string') return r
    postTasks()
    return null
  }

  /** agent 派任务（规则 11，$SIMPLE_CODE_TASK）：同名不拒、自动编号——agent 一次
   *  派几个首行相近的任务是常态，拒了它只会换个写法重派。返回实际任务名。
   *  choice = --model 选中的 taskModels 项（规则 14），省略 = 配置默认 */
  const dispatchUnique = async (
    brief: string,
    parent: string,
    choice?: TaskChoice,
  ): Promise<{ name: string } | { error: string }> => {
    const base = nameOf(brief)
    let name = base
    for (let i = 2; taken(name); i++) name = `${base} ${i}`
    const error = await dispatchNamed(name, brief, { via: 'agent', parent, ...(choice ? { choice } : {}) })
    return error === null ? { name } : { error }
  }

  /** 开任务并立刻跑第一轮（任务书即第一条消息） */
  const dispatchNamed = async (name: string, brief: string, opts: OpenOpts): Promise<string | null> => {
    const r = await openRun(name, opts)
    if (typeof r === 'string') return r
    r.status = 'running'
    // brief 的用户气泡：webview 只对 task_send 乐观追加，/task 首条没有
    // 乐观路径——镜像里垫上（原文，不带任务框架句）
    r.pendingTexts = [{ text: brief, pos: r.replay.length }]
    postTasks()
    void runLoop(r, frameBrief(name, brief))
    return null
  }

  /** via：谁派的——用户（+ 任务、/task）还是 agent（$SIMPLE_CODE_TASK），进 runlog */
  type OpenOpts = { via: 'user' | 'agent'; parent?: string; awaitingFirstMessage?: true; choice?: TaskChoice }

  /** 建任务、进 runs（还不跑、不推快照）。字符串 = 拒绝原因 */
  const openRun = async (name: string, opts: OpenOpts): Promise<Run | string> => {
    const { via, parent } = opts
    if (taken(name)) return `已有同名任务「${name}」在跑`
    // 空闲摘要器照样在写库——撞锁退避重试（同 ensureSession；2026-09-23 检视）
    let manifest: TaskManifest
    forking.add(name)
    const t0 = Date.now()
    // 只有 agent 派的任务登记回调（规则 12，2026-10-30 用户订正）：agent 派出去
    // 就不管了，要靠回调知道结果；用户开的任务人自己会切过去看，回调进开它的
    // 任务反而往那边塞一段没人要的〔任务结果〕（10-30 真机三次：647/1176/1799 字）
    const register = via === 'agent' && parent !== undefined
    try {
      manifest = await retryLocked(() =>
        createTask(deps.folder, name, {
          ...(register ? { parent } : {}),
          ...(opts.awaitingFirstMessage ? { awaitingFirstMessage: true } : {}),
        }),
      )
    } catch (error) {
      logRun({
        ev: 'task_fork_fail',
        folder: deps.folder,
        task: name,
        via,
        parent: parent ?? null,
        error: String(error),
      })
      return `开任务失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      forking.delete(name)
    }
    const run: Run = {
      name,
      manifest,
      status: 'idle',
      lastText: '',
      sessionP: null,
      session: null,
      idle: null,
      baseItems: [],
      replay: [],
      pendingTexts: [],
      queuedTexts: [],
      notices: [],
      turnErrors: [],
      usage: { contextTokens: 0, lastTiming: null },
      approvalOn: true,
      ...(opts.choice ? { choice: opts.choice } : {}),
    }
    runs.set(name, run)
    // 段号在 segments 表（runlog 另有 segment_open），这里记身份、开它时所在的
    // 任务（用户开的不登记回调，manifest 里没有，取 opts）、谁派的与开场耗时
    // （复制主干摘要，规则 10 要求不调模型、快速启动）
    logRun({
      ev: 'task_fork',
      folder: deps.folder,
      task: name,
      owner: manifest.owner,
      parent: parent ?? null,
      via,
      ms: Date.now() - t0,
      ...(opts.awaitingFirstMessage ? { awaitingFirstMessage: true } : {}),
      ...(opts.choice ? { model: `${opts.choice.provider}/${opts.choice.model}` } : {}),
    })
    return run
  }

  /** 往分支发消息（切过去继续打字，2026-09-22 拍板）。running = core 的
   *  插话路径（session.send 入队 + 软中断，返回空流——消费它才触发入队）；
   *  空闲/出错 = 起新一轮。返回 null = 已受理 */
  const send = (name: string, text: string): string | null => {
    const r = runs.get(name)
    if (!r) return `没有任务「${name}」`
    if (r.status === 'closing') return `任务「${name}」正在关闭，不能再发消息`
    // 用户接着说话 = 看过了上次没送达的提示、上一轮的错误，清掉
    r.notices = []
    r.turnErrors = []
    if (r.status === 'running') {
      // 插话排队中：loop 顶才投递、fold 才落库，中间任何一次 task_hydrate
      // 都不能把它抹掉——记进 queuedTexts
      r.queuedTexts.push(text)
      // 消费空流：async generator 不 next 不执行体，tasks.push 就不会发生
      void (async () => {
        const session = await ensureSession(r)
        // null：建会话失败，任务已进 error 态并出了错误条——这里只把
        // 没送达的气泡撤掉
        if (session === null) throw null
        for await (const ev of session.send(text)) {
          // 正常是空流（插话即返回）。万一不是（状态竞态），照常镜像不丢事件
          const at = Date.now()
          r.replay.push({ ev, at })
          deps.post({ type: 'task_agent', name: r.name, event: ev, at })
        }
      })().catch((error: unknown) => {
        // 插话没进 loop：撤掉乐观气泡（它不会被 fold 落库），换成常驻的
        // 失败提示——带原文，用户好重发
        const i = r.queuedTexts.lastIndexOf(text)
        if (i >= 0) r.queuedTexts.splice(i, 1)
        if (error !== null) {
          const why = error instanceof Error ? error.message : String(error)
          r.notices.push(`插话没送达：「${text.slice(0, 40)}」（${why}）`)
        }
        deps.post(hydrateMsg(r))
      })
      return null
    }
    r.status = 'running'
    r.pendingTexts = [{ text, pos: r.replay.length }]
    postTasks()
    void runLoop(r, text)
    return null
  }

  /** 模型/深度改动后的持久化快照（effort 只在被盖过时存——对齐主干
   *  saveChoice 的口径） */
  const persistChoice = (r: Run, session: Session): void => {
    if (deps.choiceStore === undefined) return
    const es = session.effortState()
    deps.choiceStore.set(r.manifest.owner, {
      ...readModel(session),
      ...(es.overridden ? { effort: es.effort } : {}),
    })
  }

  /** 控件区跟分支走：模型/深度直接改分支 session，并持久化（分支持久化） */
  const setModel = async (name: string, choice: ModelRef): Promise<void> => {
    const r = runs.get(name)
    if (!r) return
    const session = await ensureSession(r)
    if (session === null) return
    session.setModel(choice)
    persistChoice(r, session)
    postTasks()
  }

  const setEffort = async (name: string, effort: Effort | null): Promise<void> => {
    const r = runs.get(name)
    if (!r) return
    const session = await ensureSession(r)
    if (session === null) return
    session.setEffort(effort)
    persistChoice(r, session)
    postTasks()
  }

  /** 选中分支：宿主补基线（单一真相——webview 的增量投影不跨 attach 存活，
   *  每次打开都重推，比分桶缓存对得了账） */
  const open = (name: string): void => {
    const r = runs.get(name)
    if (!r) return
    deps.post(hydrateMsg(r))
    // reload 恢复的任务 session 是惰性的：没建之前 baseItems 为空，切进来
    // 一片空白（2026-09-23 实测）。打开即建——ensureSession 建好后 fold 继承
    // 历史 + 自己的经历并再推一次基线。已建/在建时是同一个 Promise，无副作用
    if (r.sessionP === null && r.status !== 'closing') void ensureSession(r)
  }

  /** 分支自己的审批开关（内存态，对齐主干）。没这个分支给 true（fail-closed
   *  不了的折中：分支没了卡片也答不了，卡 5 分钟超时 deny） */
  const approvalOnOf = (name: string): boolean => runs.get(name)?.approvalOn ?? true

  const setApprovalOn = (name: string, on: boolean): void => {
    const r = runs.get(name)
    if (!r) return
    r.approvalOn = on
    postTasks()
  }

  /** 任务 session（get_regions 查任务视角用）。null = 没这个任务（已关闭） */
  const sessionOf = async (name: string): Promise<Session | null> => {
    const r = runs.get(name)
    if (!r) return null
    return ensureSession(r)
  }

  /** 手动压缩的目标。返回字符串 = 拒绝原因。关闭中的不压：关闭流程自己在
   *  排空摘要、owner 还俗，两边同时改这个任务的上下文 */
  const compactTarget = async (name: string): Promise<Session | string> => {
    const r = runs.get(name)
    if (!r) return `任务「${name}」已关闭`
    if (r.status === 'closing') return `任务「${name}」正在关闭，不能压缩`
    return (await ensureSession(r)) ?? `任务「${name}」打不开`
  }

  /** 关掉一个任务的分身 session（含空闲摘要定时器）。幂等 */
  const closeRun = async (r: Run): Promise<void> => {
    r.idle?.disarm()
    r.idle = null
    const s = await r.sessionP
    r.sessionP = null
    await s?.close()
  }

  /**
   * 关闭任务。异步——摘要是收尾的一部分，用户明确要求债清完才算关完
   * （2026-09-23 拍板）：
   *   ① 在跑则先停（普通停止语义，interrupt 当前轮）
   *   ② live→unloaded：数据即刻成为历史
   *   ③ 摘要排空：任务自己的摘要器把 owner 段全部摘完
   *   ④ 段即刻合回 + 删 manifest（finalizeTask）；别的任务下一轮切段、
   *      在压缩点拉它的摘要
   * 摘要连续失败 3 次 → 照样收尾 + runlog 记一行。只写自己的行和段表，
   * 不等任何会话静止（task-trunk 规则 8）
   */
  const close = async (name: string): Promise<TaskOutcome> => {
    const r = runs.get(name)
    if (!r) return { ok: false, error: `没有任务「${name}」` }
    // 幂等：已经在关了就无事可做（双击是正常输入，不是错误）
    if (r.status === 'closing') return { ok: true }
    r.status = 'closing'
    postTasks()
    const t0 = Date.now()
    try {
      await r.sessionP?.then((s) => s?.interrupt('task_close')).catch(() => {})
      const session = (await r.sessionP) ?? null
      const flipped = flipTaskLive(deps.folder, r.manifest.owner)
      let rounds = 0
      let failures = 0
      let debt = false
      if (session !== null) {
        for (let i = 0; i < 500 && failures < 3; i++) {
          rounds++
          try {
            await session.summarizeIdle()
          } catch (error) {
            failures++
            logRun({ ev: 'task_close_summary_fail', folder: deps.folder, task: name, i, error: String(error) })
          }
          // 债 = 摘要器挑不出段（session.summaryDebt，与 summarizeIdle 同一
          // 判据——原来这里是 task.ts 里同构的第二份 SQL，判据演进会漂移）
          debt = session.summaryDebt()
          if (!debt) break
        }
      }
      const counts = finalizeTask(deps.folder, r.manifest.owner)
      await closeRun(r)
      runs.delete(name)
      postTasks()
      logRun({
        ev: 'task_close',
        folder: deps.folder,
        task: name,
        owner: r.manifest.owner,
        ms: Date.now() - t0,
        rounds,
        failures,
        debtLeft: debt,
        flipped,
        ...counts,
      })
      return { ok: true }
    } catch (error) {
      // 关闭失败：状态回 idle，任务还在（可重试关闭）
      r.status = 'idle'
      postTasks()
      logRun({ ev: 'task_close_fail', folder: deps.folder, task: name, error: String(error) })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const stop = (name: string): boolean => {
    const r = runs.get(name)
    if (!r || r.status !== 'running') return false
    r.stopRequested = true
    void r.sessionP?.then((s) => s?.interrupt('task_stop')).catch(() => {})
    return true
  }

  /** 任务名 → owner（登记父任务用）。省略或已不在 = 主任务 '' */
  const ownerOf = (name?: string): string => (name === undefined ? '' : (runs.get(name)?.manifest.owner ?? ''))

  /** 任一分身在跑（folder tab 绿点用——分身干活也算这个目录在忙） */
  const anyRunning = (): boolean => {
    for (const r of runs.values()) if (r.status === 'running') return true
    return false
  }

  return {
    anyRunning,
    dispatch,
    dispatchUnique,
    create,
    ownerOf,
    send,
    open,
    sessionOf,
    compactTarget,
    approvalOnOf,
    setApprovalOn,
    setModel,
    setEffort,
    close,
    stop,
    states,
    /** 桌面机器人的现状（关闭中的不算——马上就没了） */
    robotViews: (): RobotTaskView[] =>
      [...runs.values()]
        .filter((r) => r.status !== 'closing')
        .map((r) => ({
          task: r.name,
          running: r.status === 'running',
          startedAt: r.startedAt ?? null,
          lastTurn: r.lastTurn ?? null,
        })),
    /** attach（ready/切回）时补发：任务快照 + 各任务面板基线。
     *  空清单不发——webview 的任务态是目录切换即清的，attach 面对的是
     *  空态，发空的只会打扰 ready 握手（state 之后的第二条消息） */
    rehydrate: (): void => {
      if (runs.size === 0) return
      postTasks()
      for (const r of runs.values()) {
        deps.post(hydrateMsg(r))
      }
    },
    /** 扩展停用：关全部分身 session（跑着的轮随 session 关闭而中止） */
    dispose: (): void => {
      for (const r of runs.values()) void closeRun(r)
      runs.clear()
    },
  }

}

export type TaskCenter = ReturnType<typeof createTaskCenter>
