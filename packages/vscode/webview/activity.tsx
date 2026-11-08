import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ApprovalRequest } from '../src/protocol.ts'
import type { ChatItem } from './events.ts'
import { formatElapsed } from './footer.tsx'
import { renderMarkdown } from './markdown.ts'
import { errorLine, type Stats } from './steps.ts'

/**
 * 过程的零件：工具行、思考块、处理过程头（时间线骨架在 timeline.tsx）。
 * 从 App.tsx 分出来的——那边超了
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
 * 工具名 → 人话名（没有 desc 时站标题位）。
 *
 * 我们第一版只有 bash，所以是一张两行的表 + 一个兜底。**兜底不是防御性代码**：core 加了新工具而
 * 这里忘了加映射时，界面显示原始工具名而不是崩掉或显示空白。
 *
 * 行首图标表示结果（✓ / ✗ / 转圈），不再按工具类型配（2026-10-28 时间线
 * 改版：标题已是 desc，类型图标不带信息，只让失败显眼）
 */
const TOOL_DISPLAY: Record<string, string> = { bash: 'Shell 命令' }

const displayOf = (name: string): string => {
  // 回退链同 core 的 resolveTool（run.ts）：大小写 → 剥 mcp__<server>__ 前缀。
  // GLM 渠道把 bash 采样成 Bash（2026-10-17 标题从「Shell 命令」变 Bash）；
  // 某网关把 bash 包成 mcp__client__bash（2026-10-22 同症状）。流式行
  // 是 tool_input_start 用渠道原名建的，库里老轮次也存着原名，只能在这里回退
  const stripped = name.replace(/^mcp__[a-z0-9-]+__/i, '')
  return (
    TOOL_DISPLAY[name] ??
    TOOL_DISPLAY[name.toLowerCase()] ??
    TOOL_DISPLAY[stripped.toLowerCase()] ??
    name
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
  const label = displayOf(tool.name)
  const icon = tool.failed ? 'close' : 'check'

  return (
    <>
      <div
        className="tool-row"
        data-failed={tool.failed}
        data-running={running}
        data-open={expanded}
      >
        <button type="button" className="tool-head" onClick={() => setExpanded((v) => !v)}>
          <span className="tool-icon" aria-hidden>
            {running ? <span className="spinner" /> : <i className={`codicon codicon-${icon}`} />}
          </span>
          {/* 耗时紧跟图标（10-29 用户：计时在最右侧注意不到）：跑着蓝色跳秒、
              跑完灰色定格，一格定宽右对齐，说明文字不随位数跳。回放的历史没有
              时间戳（duration 为空），这一格不渲染 */}
          {duration !== '' && <span className="tool-duration">{duration}</span>}
          {/* 方案 C「desc 当标题」（2026-09-29 拍板，推翻 9-28 的「desc 并进
              命令格」）：有 desc 时 desc 顶替「Shell 命令」站标题位——正常亮色、
              界面字体、无底色；命令格照旧跟在后面（code 底色、单行截断）。
              没 desc 的（旧历史、非 bash 工具）标题仍是工具人话名 */}
          <span className="tool-title">{tool.desc || label}</span>
          <code className="tool-cmd">{tool.command || tool.name}</code>
        </button>
        {tool.failed && (
          // 失败原因不用点开就看得到（原型「只让异常显眼」）。bash 的失败只
          // 看退出码，输出里找不到报错行时照实说——见 steps.ts errorLine
          <div className="tool-err">{errorLine(tool.output, label === TOOL_DISPLAY.bash)}</div>
        )}
        {(tool.command !== '' || tool.output !== '' || (tool.images?.length ?? 0) > 0) && (
          // 开合走 data-open，**不能用 `hidden`**：作者样式表里的 `display: grid`
          // 优先级高于 UA 的 `[hidden] { display: none }`，写了等于没写（tool 行
          // 曾经因此根本展不开）。.tool-row 上那份 data-open 只管行头样式
          // （展开时命令格常显），开合本身仍只认这里
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
          {/* 分身任务弹的卡：标注任务名，不然用户以为当前对话要跑这条
              （fork-merge.md §3）。目录不标：App 只收当前目录的卡（隔离），
              「来自：目录」永远是当前目录，10-29 去掉 */}
          {approval.task && <div className="approval-folder">来自分身任务「{approval.task}」</div>}
          <code className="approval-cmd">{approval.command}</code>
          {approval.detail && !inReason(approval.detail, approval.reason) && (
            <div className="approval-detail">触碰：{approval.detail}</div>
          )}
          {approval.always && (
            <div className="approval-detail">
              始终允许将记：
              <code>
                {approval.always.kind === 'nonpath'
                  ? `${approval.always.lead} 的第 ${approval.always.from} 位参数起不是路径`
                  : approval.always.kind === 'paths'
                    ? [
                        ...approval.always.dirs.map((d) => `${d}/*`),
                        ...(approval.always.hidden ?? []).map(
                          (h) => `${h.write ? '写' : '读'} ${h.path}`,
                        ),
                      ].join('、')
                    : `${approval.always.dir}/*`}
              </code>
            </div>
          )}
          <div className="approval-actions">
            <button
              type="button"
              className="approval-once"
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
                  ? approval.always.hidden?.length
                    ? `始终允许这 ${approval.always.dirs.length + approval.always.hidden.length} 项`
                    : `始终允许这 ${approval.always.dirs.length} 个目录`
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
            {countdown && (
              <span className="approval-countdown" data-urgent={countdown.urgent}>
                {countdown.text}
              </span>
            )}
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
  ask_rule: '自定义规则',
  multi: '多重触发',
}

/** 「触碰：detail」是否和第一行重复：core 的 reason 多半已带着 detail
 * （「要读项目外路径：X」配 detail X；多处审批的 detail 是各条用「；」连起来，
 * reason 里逐条列过），重复就不再起一行 */
function inReason(detail: string, reason: string): boolean {
  return detail.split('；').every((part) => reason.includes(part))
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
 * thinking 块：只在时间线里给**还在流式的那段思考**用（想完的收进步骤右上
 * 角的「思考 N」，timeline.tsx）。流式中自动展开（D5），想完收起；用户点过
 * 就听用户的。10-28 改版曾改成流式也不展开，10-29 用户实机看过后要回来：
 * 「思考应该展开，思考完了再收起……一直在干活的感觉」
 */
export function ThinkingBlock({ block, streaming }: { block: ReasoningItem; streaming: boolean }) {
  const [byUser, setByUser] = useState<boolean | null>(null)
  const expanded = byUser ?? streaming
  // 流式中跑表（同工具行）：收起后一行字不动，看不出还在想
  const now = useTick(streaming && block.startedAt !== undefined)
  const duration =
    streaming && block.startedAt !== undefined ? ticking(now - block.startedAt) : durationOf(block)

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
export const MThinkingBlock = memo(ThinkingBlock)
export const MToolRow = memo(ToolRow)

/**
 * 第三层折叠：一轮结束后，从提问到最终回答之间的**全部过程**收成一行。
 *
 * 两层折叠治不了「一轮里有 N 个活动组」——模型一边干活一边说话，于是
 * 「说明 → 3 个操作 → 说明 → 10 个操作 → …」，中间那些说明一个字都不折，
 * 最终回答被推到屏幕最底下。折进来的就是这些块，切分规则见 `splitTurns`。
 *
 * 头部：「处理过程」+ 图标打头的「12 步」「39 个操作」「1 个失败」「耗时」
 * + 右侧操作条（一格一条命令，失败标红，步与步之间留空）——不展开也看得出
 * 失败在哪一段（2026-10-28 时间线改版）。整行淡底条、图标与回答底部那行
 * 同款（10-29 对比页用户选 P3，替掉原来的「 · 」点号串）。
 *
 * **默认收起，不跟随事件**：这一层只在轮结束后才存在（跑着的那一轮
 * `splitTurns` 不折），所以没有「流式中自动展开」这回事，展开只由用户决定
 */
export function ProcessGroup({
  stats,
  elapsedMs,
  children,
}: {
  stats: Stats
  /** 回放的历史没有耗时（hydrateItems 不带时间戳），那时不显示 */
  elapsedMs: number | undefined
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const meta = (icon: string, text: string, extra = '') => (
    <span key={icon} className={`process-meta${extra}`}>
      <i className={`codicon codicon-${icon}`} aria-hidden />
      {text}
    </span>
  )

  return (
    <div className="process">
      <button type="button" className="process-head" onClick={() => setOpen(!open)}>
        <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden />
        <span className="process-title">处理过程</span>
        {stats.steps > 0 && meta('list-ordered', `${stats.steps} 步`)}
        {stats.tools > 0 && meta('tools', `${stats.tools} 个操作`)}
        {stats.failed > 0 && meta('error', `${stats.failed} 个失败`, ' process-fail')}
        {elapsedMs !== undefined && meta('watch', formatElapsed(elapsedMs))}
        {stats.tools > 0 && (
          <span className="process-strip" aria-hidden>
            {stats.strip.map((step, i) => (
              <span key={i} className="strip-step">
                {step.map((failed, j) => (
                  <i key={j} data-failed={failed} />
                ))}
              </span>
            ))}
          </span>
        )}
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
