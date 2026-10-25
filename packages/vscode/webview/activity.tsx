import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApprovalRequest } from '../src/protocol.ts'
import { type ActivityItem, type ChatItem, toolCount } from './events.ts'
import { formatElapsed } from './footer.tsx'
import { renderMarkdown } from './markdown.ts'

/**
 * 活动组：一轮里 thinking + 工具调用的渲染。从 App.tsx 分出来的——那边超了
 * 300 行（CLAUDE.md §2），而「模型干活的过程」本来就是独立于「消息气泡」的
 * 一个概念。
 *
 * 视觉结构：**扁平行 + hover 背景 + 展开区靠 1px 竖线归属**，
 * 不是带边框的卡片。
 * 一轮动辄十几个命令，十几个边框叠起来时噪音会盖过内容。
 */

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type ReasoningItem = Extract<ChatItem, { kind: 'reasoning' }>

/**
 * 工具名 → 人话名 + codicon。
 *
 * 我们第一版只有 bash，所以是一张两行的表 + 一个兜底。**兜底不是防御性代码**：core 加了新工具而
 * 这里忘了加映射时，界面显示原始工具名而不是崩掉或显示空白。
 */
const TOOL_DISPLAY: Record<string, { label: string; icon: string }> = {
  bash: { label: 'Shell 命令', icon: 'terminal' },
}

const displayOf = (name: string): { label: string; icon: string } => {
  // 回退链同 core 的 resolveTool（run.ts）：大小写 → 剥 mcp__<server>__ 前缀。
  // GLM 渠道把 bash 采样成 Bash（2026-10-17 图标从终端变扳手）；
  // claude-opus-5-5 网关包成 mcp__client__bash（2026-10-22 同症状）。流式行
  // 是 tool_input_start 用渠道原名建的，库里老轮次也存着原名，只能在这里回退
  const stripped = name.replace(/^mcp__[a-z0-9-]+__/i, '')
  return (
    TOOL_DISPLAY[name] ??
    TOOL_DISPLAY[name.toLowerCase()] ??
    TOOL_DISPLAY[stripped.toLowerCase()] ?? { label: name, icon: 'tools' }
  )
}

const clock = (ms: number): string => {
  const sec = ms / 1000
  return sec < 10 ? `${sec.toFixed(1)}s` : `${Math.round(sec)}s`
}

/** 跑表格式：整秒递增（1s、2s…），跨分钟给 "1m 5s"。结束后换 clock 的精确值 */
const ticking = (ms: number): string => {
  const sec = Math.floor(ms / 1000)
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

/** 运行中的工具行每秒一个 tick。并行工具各行各一个 interval——一秒一次的
 * setState 到不了值得优化的量级，不为它上全局 ticker */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/**
 * 单条工具调用。**默认折叠**：运行中一行 + spinner（core 的 output 是
 * tool_result 一次性带回，运行中没有中间输出可滚），完成后收成一行结果，
 * 点开看输出（限高滚动，D11）。这个默认来自决策 D9——「盯执行→不再关心」
 * 的注意力曲线。用户点开过就保持用户的选择，不跟着事件再变
 */
export function ToolRow({
  tool,
  approval,
  onReply,
}: {
  tool: ToolItem
  /** 挂在该工具行下面的审批请求（toolCallId 匹配）。无则不渲染 */
  approval?: ApprovalRequest
  /** 答复按钮的回调——activity 保持纯展示，发消息由 App 的 post 做 */
  /** folder：后台文件夹弹的卡带来源，回执路由回原 bridge（active 的卡不带）。
   * feedback：拒绝时输入框里留给 agent 的一句话（可选） */
  onReply: (
    id: number,
    choice: 'allow' | 'always' | 'deny',
    folder?: string,
    feedback?: string,
  ) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [feedback, setFeedback] = useState('')
  // startedAt 缺失 = 历史回放：没有 spinner 也不算时长。判进 running 的话
  // 历史工具行会永远转圈（hydrate 的行永远等不到 tool_result）
  const live = tool.startedAt !== undefined
  const running = live && tool.endedAt === undefined
  const now = useTick(running)
  // 审批倒计时：到点 bridge 静默 deny。不显示的话用户不知道在倒数
  // （2026-09-12 拍板：只做信息展示，不加续时/暂停机制）。复用上面的
  // useTick(running)：等审批的工具必然 running，卡与 spinner 同心跳动
  const countdown =
    approval && approval.expiresAt - now > 0 ? formatCountdown(approval.expiresAt - now) : null
  const duration = running
    ? ticking(now - (tool.startedAt ?? now))
    : tool.endedAt !== undefined && tool.startedAt !== undefined
      ? clock(tool.endedAt - tool.startedAt)
      : ''
  const { label, icon } = displayOf(tool.name)

  return (
    <>
      <div className="tool-row" data-failed={tool.failed}>
        <button type="button" className="tool-head" onClick={() => setExpanded((v) => !v)}>
          <span className="tool-icon" aria-hidden>
            {running ? <span className="spinner" /> : <i className={`codicon codicon-${icon}`} />}
          </span>
          {/* 方案 C「desc 当标题」（2026-09-29 拍板，推翻 9-28 的「desc 并进
              命令格」）：有 desc 时 desc 顶替「Shell 命令」站标题位——正常亮色、
              界面字体、无底色；命令格照旧跟在后面（code 底色、单行截断）。
              没 desc 的（旧历史、非 bash 工具）标题仍是工具人话名 */}
          <span className="tool-title">{tool.desc || label}</span>
          <span className="tool-duration">{duration}</span>
          <code className="tool-cmd">{tool.command || tool.name}</code>
        </button>
        {(tool.command !== '' || tool.output !== '' || (tool.images?.length ?? 0) > 0) && (
          // 开合走 data-open，**不能用 `hidden`**：作者样式表里的 `display: grid`
          // 优先级高于 UA 的 `[hidden] { display: none }`，写了等于没写（tool 行
          // 曾经因此根本展不开）。CSS 只认这两个 wrapper 上的 data-open，别往
          // .tool-row/.thinking/.activity 上加——加了没有任何选择器会用
          <div className="tool-body" data-open={expanded}>
            {tool.command !== '' && (
              // 完整命令：收起态 head 上是单行省略版，长命令看不全——展开在
              // 输出上方看全量（pre-wrap 换行）。pre 同款样式：终端观感里
              // 命令和输出本来就是一个底色，间距见 .tool-cmd-full 的展开态
              <pre className="tool-cmd-full">{tool.command}</pre>
            )}
            {(tool.images?.length ?? 0) > 0 && (
              // 缩略图行：core 侧已缩成 256px JPEG data URL，这里只管排。
              <div className="tool-images">
                {tool.images?.map((src) => (
                  // data-zoom：点击走 App 根级委托开 lightbox
                  <img key={src.slice(-32)} src={src} alt="工具结果附图" data-zoom />
                ))}
              </div>
            )}
            {tool.output !== '' && <pre>{tool.output}</pre>}
          </div>
        )}
      </div>
      {approval && (
        <div className="approval-card" role="alert">
          <div className="approval-title">
            <span className="approval-tag">
              {APPROVAL_TAG[approval.category] ?? approval.category}
            </span>
            <span className="approval-reason">{approval.reason}</span>
          </div>
          {/* 后台文件夹弹的卡：标明来源，不然用户以为当前对话要跑这条。
              分身任务弹的卡同理——标注任务名（fork-merge.md §3） */}
          {approval.folder && <div className="approval-folder">来自：{approval.folder}</div>}
          {approval.task && (
            <div className="approval-folder">来自分身任务「{approval.task}」</div>
          )}
          <code className="approval-cmd">{approval.command}</code>
          {approval.detail && <div className="approval-detail">触碰：{approval.detail}</div>}
          {countdown && (
            <div className="approval-countdown" data-urgent={countdown.urgent}>
              {countdown.text}
            </div>
          )}
          {approval.always && (
            <div className="approval-detail">
              始终允许将记：
              <code>
                {approval.always.kind === 'lead'
                  ? `${approval.always.lead} *`
                  : approval.always.kind === 'hidden'
                    ? `${approval.always.write ? '写' : '读'} ${approval.always.path}`
                    : approval.always.kind === 'nonpath'
                      ? `${approval.always.lead} 的第 ${approval.always.from} 位参数起不是路径`
                      : approval.always.kind === 'paths'
                        ? approval.always.dirs.map((d) => `${d}/*`).join('、')
                        : `${approval.always.dir}/*`}
              </code>
            </div>
          )}
          <div className="approval-actions">
            <button
              type="button"
              className="approval-allow"
              onClick={() => onReply(approval.id, 'allow', approval.folder)}
            >
              允许一次
            </button>
            {approval.always && (
              <button
                type="button"
              className="approval-allow"
              onClick={() => onReply(approval.id, 'always', approval.folder)}
            >
              {approval.always.kind === 'paths'
                ? `始终允许这 ${approval.always.dirs.length} 个目录`
                : '始终允许'}
            </button>
          )}
            <button
              type="button"
              className="approval-deny"
              onClick={() =>
                onReply(approval.id, 'deny', approval.folder, feedback.trim() || undefined)
              }
            >
              拒绝
            </button>
          </div>
          {/* 拒绝反馈：留一句话，模型带着它重试，
              比裸拒绝猜方向质量高一档。空 = 裸拒绝，行为不变 */}
          <input
            className="approval-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="拒绝时留一句话给 agent（可选）"
          />
        </div>
      )}
    </>
  )
}

/** 审批类别标签（approval.md §4.2）。webview 自持一份，不依赖 core 运行时 */
const APPROVAL_TAG: Record<string, string> = {
  external_dir: '项目外路径',
  hidden_path: '隐藏路径',
  network_cmd: '网络命令',
  unparseable: '无法静态判定',
}

/** 头部摘要读成纯文本的 strip 序列 */
const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner) => inner.trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .trim()

/** 折叠头摘要：纯文本压平后取 80 字（词边界截断 + …） */
const summaryOf = (text: string): string => {
  const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= 80) return flat
  const cut = flat.lastIndexOf(' ', 80)
  return `${flat.substring(0, cut > 0 ? cut : 80).trimEnd()}…`
}

/**
 * 思考时长。reasoning_end 不一定到达（用户中断），没有 endedAt 就不显示时长
 * ——用 startedAt 对此刻求差会越跑越大，不如只显示「已思考」
 */
const durationOf = (block: ReasoningItem): string | null =>
  block.endedAt === undefined || block.startedAt === undefined
    ? null
    : clock(block.endedAt - block.startedAt)

/**
 * thinking 块（D5）：流式中自动展开——能看到思考过程；结束自动收起
 * 成摘要行。**用户点过优先**：手动开/关之后
 * 自动状态不再覆盖用户的选择
 */
export function ThinkingBlock({ block, streaming }: { block: ReasoningItem; streaming: boolean }) {
  const [byUser, setByUser] = useState<boolean | null>(null)
  const expanded = byUser ?? streaming
  const duration = durationOf(block)

  /**
   * 内盒跟随。`.thinking-body` 展开时是**限高 40vh 的内部滚动容器**
   * （style.ts D11），thinking 长过 40vh 之后新内容全在容器内部生长，
   * `.log` 那套页面跟随量不到它——没有这里的话，新内容一直钻到内盒
   * 可视区下面，页面和内盒都不动，看起来就是「thinking 输出不滚动」。
   *
   * 和 Log 的页面跟随同一个形状：用户在内盒里往上翻就不抢（24px 容差），
   * `pinnedInner` 只在内盒自己的 scroll 事件里重算
   */
  const bodyRef = useRef<HTMLDivElement>(null)
  const pinnedInner = useRef(true)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el || !streaming) return
    if (pinnedInner.current) el.scrollTop = el.scrollHeight
  })
  const onBodyScroll = () => {
    const el = bodyRef.current
    if (!el) return
    pinnedInner.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  /**
   * 流式结束把内盒归零。不归的话 scrollTop 停在自动跟随的底部，块收起、
   * 用户哪天再点开，看到的是思考的**结尾**——读思考过程天然从开头读
   */
  useEffect(() => {
    if (!streaming && bodyRef.current) bodyRef.current.scrollTop = 0
  }, [streaming])

  return (
    <div className="thinking">
      <button type="button" className="thinking-head" onClick={() => setByUser(!expanded)}>
        <span className="thinking-icon" aria-hidden>
          <i className="codicon codicon-lightbulb" />
        </span>
        <span className="thinking-label">
          {streaming ? '思考中' : '已思考'}
          {duration !== null ? ` ${duration}` : ''}
        </span>
        {!expanded && block.text !== '' && (
          <span className="thinking-summary">{summaryOf(block.text)}</span>
        )}
      </button>
      {/* 常驻 DOM + grid-rows 开合（同 tool-body）：条件渲染做不了过渡。
          收起态也 parse 一次 markdown——thinking 块不长，可接受 */}
      <div className="thinking-wrap" data-open={expanded}>
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="thinking-body markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
        />
      </div>
    </div>
  )
}

/**
 * memo 化的行组件（2026-10-06 内存事件）：流式期间 Log 每 100ms 重渲一次，
 * 已完成的行 props 引用稳定（events.ts 折叠只替换末条）→ 整行跳过。此前
 * 每秒 10 次对全部历史 thinking 块重跑 renderMarkdown、全部工具行重渲，
 * 垃圾以内容千倍的量级产出，V8 提交的堆只涨不还——面板进程 24h 涨到 2.9GB
 */
const MThinkingBlock = memo(ThinkingBlock)
const MToolRow = memo(ToolRow)

/**
 * 活动组：一轮的 thinking + 命令（D8a 两层折叠的外层）。
 * **收起时机**：组后面一有别的块（assistant 正文/用户消息）就自动收起
 * ——「最终回答出现时，之前的流程折叠」是用户在 D13 的补充需求。用户手动
 * 展开过则尊重用户。
 *
 * **收起 = 一条都不留。** 曾经保留最后 2 行预览，实际用下来
 * 那 2 行既读不出上下文、又让「已收起」看起来像没收起——用户的原话是
 * 「最上面没有都收起来」。要看过程就点开，头部的「N 个操作」是入口。
 *
 * **一个工具都没有的组不套组头**，直接把 thinking 块铺出来——见下面 tools 处
 */
export function ActivityGroup({
  items,
  last,
  running,
  approvals,
  onApprovalReply,
}: {
  items: ActivityItem[]
  last: boolean
  running: boolean
  /** 挂在这一组里的审批请求（toolCallId 匹配），可能空 */
  approvals: ApprovalRequest[]
  onApprovalReply: (
    id: number,
    choice: 'allow' | 'always' | 'deny',
    folder?: string,
    feedback?: string,
  ) => void
}) {
  const [byUser, setByUser] = useState<boolean | null>(null)
  // 组后面已有内容（不是最后一块）= 它的「流程」已经被回答接棒，自动收起
  const autoOpen = last && running
  const open = byUser ?? autoOpen
  /**
   * 一个工具都没有的组 = 纯 thinking（模型想一下就直接回答）。这种组**不套
   * 组头**：ThinkingBlock 自身就是一层折叠，外面再包一行「思考过程」等于把
   * 同一件事折了两次——组头带不出任何内层没有的信息，却要多点一次才读得到
   */
  const tools = toolCount(items)
  // 没有组头就没有展开它的入口，此时 open 无意义——内容必须直接铺出来
  const collapsed = tools > 0 && !open

  return (
    <div className="activity">
      {tools > 0 && (
        <button type="button" className="activity-head" onClick={() => setByUser(!open)}>
          <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden />
          {`${tools} 个操作`}
        </button>
      )}
      {(collapsed ? [] : items).map((item, j) => {
        const isTail = item === items.at(-1)
        return item.kind === 'reasoning' ? (
          // startedAt 做身份：组开合切换 preview 切片时块的组件状态不丢。
          // 历史回放没有墙钟，落到下标——同组内已回放块不会增删改，够稳
          <MThinkingBlock
            key={`r${item.startedAt ?? `h${j}`}`}
            block={item}
            streaming={last && running && isTail}
          />
        ) : (
          <MToolRow
            key={item.id}
            tool={item}
            {...(() => {
              const a = approvals.find((x) => x.toolCallId === item.id)
              return a ? { approval: a } : {}
            })()}
            onReply={onApprovalReply}
          />
        )
      })}
    </div>
  )
}

/**
 * 第三层折叠：一轮结束后，从提问到最终回答之间的**全部过程**收成一行。
 *
 * 两层折叠治不了「一轮里有 N 个活动组」——模型一边干活一边说话，于是
 * 「说明 → 3 个操作 → 说明 → 10 个操作 → …」，中间那些说明一个字都不折，
 * 最终回答被推到屏幕最底下。折进来的就是这些块，切分规则见 `splitTurns`。
 *
 * **默认收起，不跟随事件**：这一层只在轮结束后才存在（跑着的那一轮
 * `splitTurns` 不折），所以没有「流式中自动展开」这回事，展开只由用户决定
 */
export function ProcessGroup({
  tools,
  elapsedMs,
  children,
}: {
  tools: number
  /** 回放的历史没有耗时（hydrateItems 不带时间戳），那时只显示条数 */
  elapsedMs: number | undefined
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const parts = ['处理过程']
  if (tools > 0) parts.push(`${tools} 个操作`)
  if (elapsedMs !== undefined) parts.push(formatElapsed(elapsedMs))

  return (
    <div className="process">
      <button type="button" className="process-head" onClick={() => setOpen(!open)}>
        <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden />
        {parts.join(' · ')}
      </button>
      {open && <div className="process-body">{children}</div>}
    </div>
  )
}

/** 审批倒计时文案：秒 → m:ss；最后 60 秒标 urgent（CSS 变红提醒） */
function formatCountdown(ms: number): { text: string; urgent: boolean } {
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  const r = s % 60
  return { text: `${m}:${String(r).padStart(2, '0')} 后自动拒绝`, urgent: s <= 60 }
}
