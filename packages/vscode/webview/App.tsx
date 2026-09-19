import type { BgProcessInfo } from '@simple-code/core'
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ApprovalRequest, FolderState, RegionsInfo, ToWebview } from '../src/protocol.ts'
import { ActivityGroup, ProcessGroup } from './activity.tsx'
import { ContextPanel } from './ctx-panel.tsx'
import { EffortPicker, FolderTabs, ModelPicker, PresetPicker } from './controls.tsx'
import {
  composeWithAttachments,
  hasOsFileDrag,
  isExplorerDrag,
  parseExplorerPaths,
  toDisplayPath,
} from './dropPaths.ts'
import {
  type Block,
  type ChatItem,
  type ChatView,
  emptyView,
  finishTurn,
  patchFooter,
  fmtMs,
  fmtTok,
  groupItems,
  type ImageRef,
  reduce,
  type SingleItem,
  splitTurns,
} from './events.ts'
import { MessageFooter } from './footer.tsx'
import { renderMarkdown, splitOpenFence } from './markdown.ts'
import { findPathTokens } from './pathlink.ts'
import { useThrottledText } from './throttle.ts'
import { post } from './vscode.ts'

/**
 * 底栏控件的全部状态。**收成一个对象，不是五个 useState**——它们总是同一条
 * `state` 消息一起到，拆开就多了五个「漏更新一个」的机会，而漏了的现象是
 * 界面某一处停在旧值，不报错
 */
type Controls = Pick<
  Extract<ToWebview, { type: 'state' }>,
  | 'current'
  | 'models'
  | 'effort'
  | 'effortOverridden'
  | 'preset'
  | 'presets'
  | 'imagesEnabled'
  | 'approvalOn'
>

const noControls: Controls = {
  current: null,
  models: [],
  effort: null,
  effortOverridden: false,
  presets: [],
  imagesEnabled: false,
  approvalOn: true,
}

export function App() {
  const [view, setView] = useState<ChatView>(emptyView)
  const [running, setRunning] = useState(false)
  /**
   * 点开的原图（data URL）。null = 没开。缩略图（user 行 / tool 行 /
   * composer 附件）都是 <img data-zoom>，点击走根级委托把 src 提上来
   */
  const [zoom, setZoom] = useState<string | null>(null)
  const [controls, setControls] = useState<Controls>(noControls)
  const [fatal, setFatal] = useState<string | null>(null)
  /** 上下文分析面板（点底栏「上下文 X」）。数据按需拉取，不进 ChatView */
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxPending, setCtxPending] = useState(false)
  const [regions, setRegions] = useState<RegionsInfo | null>(null)
  /** 挂起中的审批（approval_request 到、approval_closed 消）多问并发时
   * 会有多条——每条一个 id，答复按钮各自对应 */
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  /** 工作区根（state 消息每次都带）。拖拽路径相对化用它，见 Composer 的 onDrop */
  const [folder, setFolder] = useState('')
  /** 多根工作区的文件夹清单（design.md §7）。length > 1 才渲染顶部下拉 */
  const [folderList, setFolderList] = useState<FolderState[]>([])
  /** 后台进程条按目录隔离（用户拍板）。切回时 attach 补推清单，切走即清 */
  const [bgItems, setBgItems] = useState<BgProcessInfo[]>([])
  /**
   * 往上拉加载的分页状态。cursor = 下一页游标（null = 还没拉过）；
   * more = 还有更早的（false 就不再触发）；loading 防抖——scroll 事件
   * 一帧能来几十次，没它会对着宿主连发几十条 fetchHistory
   */
  const [history, setHistory] = useState<{
    cursor: number | null
    more: boolean
    loading: boolean
  }>({ cursor: null, more: true, loading: false })
  /** 消息处理在事件回调里（非渲染期），读 state 要走 ref 镜像——
   *  否则拿到的是挂载那次渲染的旧值（finishTurn 漂移翻过这个车） */
  const viewRef = useRef(view)
  viewRef.current = view
  const historyRef = useRef(history)
  historyRef.current = history
  const folderRef = useRef('')
  folderRef.current = folder
  /**
   * 切换 = 清空重取（用户拍板）：宿主是唯一
   * 真相——bridge.attach 会推 hydrate（镜像基线+带真钟的重放）+ bg 清单
   * + 待处理审批卡。webview 不做多目录缓存：之前的三套桶（view/bg/
   * approvals）和宿主镜像各记各的账，不对账就串台（「N 个操作」双份、
   * 秒表被重放假钟顶掉、进程条凭空消失）。代价是切回瞬间有一屏空白
   * （hydrate 异步到），换来永远单一真相
   */
  const swapFolder = (next: string): void => {
    const prev = folderRef.current
    if (next === prev) return
    setView(emptyView())
    setHistory({ cursor: null, more: true, loading: false })
    setBgItems([])
    setApprovals([])
  }

  /**
   * 上一次收到的 running。**一轮结束的唯一可靠信号是它由 true 回落 false**
   * ——AgentEvent 里那个 `finish` core 从来不产生（events.ts 里有说明）。
   * 用 ref 不用 state：它只用来比较，变化本身不需要触发重渲染
   */
  const wasRunning = useRef(false)
  /**
   * 用户这一轮点过停止没有。**中断原来什么条目都不产生**——core 收到 abort
   * 就返回，bridge 的 finally 只把 running 置 false，界面上一个字都没有。
   * 第三层折叠一收，那一轮看起来就是「问了一句、什么都没发生」。
   *
   * 记在 webview 侧而不是让扩展报：停止请求本来就是从这里发出去的
   * （onStop），来回一趟反而多一处能漂移的状态
   */
  const stopRequested = useRef(false)

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToWebview>) => {
      const msg = e.data
      if (msg.type === 'agent') setView((v) => reduce(v, msg.event, msg.at))
      else if (msg.type === 'hydrate') {
        // 基线整体替换：面板重开、首轮 ready、多根切回（attach 必推）。
        // 之后的增量走带 at 的 agent 事件，重放的 startedAt 是真实起点
        // （事件到达宿主时打的钟），秒表不用继承
        setView({
          ...emptyView(),
          items: msg.items,
          // 水位/上一轮用量随镜像一起回（ChatView 的字段不在 items 里）
          contextTokens: msg.contextTokens ?? 0,
          lastTiming: msg.lastTiming ?? null,
        })
        setHistory({ cursor: null, more: true, loading: false })
      } else if (msg.type === 'historyPage') {
        // 更早的一页，prepend。滚回原来的位置由 Log 的 sticky 逻辑处理
        setView((v) => ({ ...v, items: [...msg.items, ...v.items] }))
        setHistory({ cursor: msg.next, more: msg.next !== null, loading: false })
      } else if (msg.type === 'state') {
        setRunning(msg.running)
        swapFolder(msg.folder)
        setFolder(msg.folder)
        setControls({
          current: msg.current,
          models: msg.models,
          effort: msg.effort,
          effortOverridden: msg.effortOverridden,
          // 条件展开：preset 是可选字段（exactOptionalPropertyTypes）
          ...(msg.preset === undefined ? {} : { preset: msg.preset }),
          presets: msg.presets,
          imagesEnabled: msg.imagesEnabled,
          approvalOn: msg.approvalOn,
        })
        // 跑完了（正常结束、中断、报错都走这条）——给页脚记时间
        if (wasRunning.current && !msg.running) {
          const stopped = stopRequested.current
          // 模型取**这条消息自带**的 current：handler 的 useEffect 是空依赖，
          // 闭包里的 controls 定格在首渲染（永远 null → 页脚永远吃全局值，
          // 正是这次要修的漂移）。jsdom 接线测试抓到过这个
          setView((v) => finishTurn(v, stopped, msg.current?.model ?? null))
          // 宿主权威页脚：同一条 state 里 footer 晚于 finishTurn 覆盖——
          // turnStartedAt 因面板重开丢失时，finishTurn 出不了耗时，靠它补
          const f = msg.footer
          if (f) setView((v) => patchFooter(v, f))
        }
        // 新一轮开始时清零：这一轮的停止请求不能算到下一轮头上
        if (!wasRunning.current && msg.running) stopRequested.current = false
        wasRunning.current = msg.running
      } else if (msg.type === 'folders') {
        // 切换意图已表达：active 顶栏要跟随。之前只更新列表、不更新
        // folder state，切过去顶栏还挂着旧的文件夹名，[1] 以为没切换
        setFolderList(msg.folders)
        swapFolder(msg.active)
        setFolder(msg.active)
      } else if (msg.type === 'approval_request') {
        // 只显示当前目录的卡（用户拍板：彻底隔离）。后台目录的卡等用户
        // 切过去时 attach 重推——它 5 分钟超时 deny 是隔离语义的一部分
        if (msg.folder === folderRef.current) setApprovals((a) => [...a, msg])
      }
      else if (msg.type === 'approval_closed')
        // 关卡按 (folder, id)：后台文件夹的卡带 folder，active 的不带。
        // 两个 bridge 的 id 序列各自从 1 起，只看 id 会关错
        setApprovals((a) => a.filter((x) => x.id !== msg.id || x.folder !== msg.folder))
      else if (msg.type === 'bg_processes') {
        // 只认当前目录的快照（router 对 active 也注入 folder）；后台目录
        // 的变化切回时 attach 会补推
        if (msg.folder === folderRef.current) setBgItems(msg.items)
      }
      else if (msg.type === 'fatal') setFatal(msg.message)
      else if (msg.type === 'regions') {
        setRegions(msg.info)
        setCtxPending(false)
      }
    }
    window.addEventListener('message', onMessage)
    // **挂载完成才报 ready。** 扩展在收到它之前不推任何东西——VS Code 会
    // 静默丢弃 acquireVsCodeApi 就绪前的 postMessage（vscode-impl.md §5.3）
    post({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const send = (text: string, images: ImageRef[] = []) => {
    // turnStartedAt 在这里记：reduce 看不到用户消息（它是直接 append 的），
    // 而「一轮的起点」对用户来说就是点发送的那一刻，不是第一个事件到达时
    setView((v) => ({
      ...v,
      // exactOptionalPropertyTypes：空数组不落 key，序列化别带 images: []
      items: [...v.items, { kind: 'user', text, ...(images.length > 0 ? { images } : {}) }],
      turnStartedAt: Date.now(),
    }))
    post({ type: 'send', text, ...(images.length > 0 ? { images } : {}) })
  }

  return (
    <div
      className="app"
      // 缩略图放大的委托放最外层：三个来源（user 行、tool 行、composer
      // 附件）分属 Log/Composer 两棵子树，挂根上一处管全部。链接和代码
      // 复制的委托在 Log 里（onLogClick），那些只存在于 .log 内
      onClick={(e) => {
        const img = (e.target as HTMLElement).closest('img[data-zoom]')
        if (img) setZoom(img.getAttribute('src'))
      }}
    >
      {fatal !== null && <div className="fatal">{fatal}</div>}
      {/* 多根工作区的对话头（design.md §7）：单根不渲染。切换不打断后台
          轮——选中的文件夹决定记忆存哪，跑着的标 ● 提示还有活在后面 */}
      {folderList.length > 1 && (
        <div className="folder-head">
          <FolderTabs folders={folderList} active={folder} />
        </div>
      )}
      <Log
        view={view}
        running={running}
        model={controls.current?.model ?? null}
        history={history}
        approvals={approvals}
        onApprovalReply={(id, choice, f, feedback) =>
          post({
            type: 'approval_reply',
            id,
            choice,
            ...(f ? { folder: f } : {}),
            ...(feedback ? { feedback } : {}),
          })
        }
        onFetchTop={() => {
          const h = historyRef.current
          if (!h.more || h.loading) return
          setHistory({ ...h, loading: true })
          post({ type: 'fetchHistory', cursor: h.cursor })
        }}
      />
      {bgItems.length > 0 && (
        // 输入框上方的后台进程条：agent 启动的、还没退出的孤儿。全量快照
        // 驱动——进程死了下次快照自动消失，这里不做定时轮询
        <div className="bg-strip">
          {bgItems.map((p) => (
            <div key={p.pid} className="bg-item" title={`${p.command} · pid ${p.pid}`}>
              <span className="bg-dot" />
              <span className="bg-cmd">{p.command}</span>
              <span className="bg-pid">{p.pid}</span>
              <button
                type="button"
                className="bg-kill"
                aria-label="结束后台进程"
                onClick={() =>
                  post({ type: 'bg_kill', pid: p.pid, folder: folderRef.current })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <Composer
        running={running}
        view={view}
        controls={controls}
        folder={folder}
        onSend={send}
        onStop={() => {
          stopRequested.current = true
          post({ type: 'interrupt' })
        }}
        onOpenRegions={() => {
          setCtxOpen(true)
          setCtxPending(true)
          post({ type: 'get_regions' })
        }}
        onNotice={(text) =>
          setView((v) => ({ ...v, items: [...v.items, { kind: 'notice', text }] }))
        }
      />
      {ctxOpen && (
        <ContextPanel info={regions} pending={ctxPending} onClose={() => setCtxOpen(false)} />
      )}
      {zoom !== null && (
        // 点浮层任意处关闭。img 上 stopPropagation：点图本身不冒泡到
        // 浮层（否则点图也关，没机会看细节）。键盘 Esc 同关——不写的话
        // 键盘用户被困在浮层里（它盖住整个面板）
        <div
          className="lightbox"
          role="button"
          tabIndex={0}
          aria-label="关闭图片"
          onClick={() => setZoom(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setZoom(null)
          }}
        >
          <img src={zoom} alt="图片原尺寸" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

function Log({
  view,
  running,
  model,
  history,
  approvals,
  onApprovalReply,
  onFetchTop,
}: {
  view: ChatView
  running: boolean
  model: string | null
  history: { cursor: number | null; more: boolean; loading: boolean }
  approvals: ApprovalRequest[]
  onApprovalReply: (
    id: number,
    choice: 'allow' | 'always' | 'deny',
    folder?: string,
    feedback?: string,
  ) => void
  onFetchTop: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  /**
   * prepend 更早的历史后把视口钉回原来的内容——不补的话浏览器默认保持
   * scrollTop，顶部新塞进的页把用户正看的内容顶出屏外，观感是「一拉就跳」。
   * 记 prepend 前后的 scrollHeight 差值，垫回 scrollTop
   */
  const restoring = useRef<{ prevHeight: number; prevTop: number } | null>(null)

  // 滚动跟随，但**用户往上翻的时候不抢**——不判断的话，用户想看前面的内容
  // 会被每个 text_delta 拽回底部，等于没法翻
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const mark = restoring.current
    if (mark) {
      // 历史页刚 prepend：钉住原位置。**必须先于底部的跟随判定**——
      // prepend 时用户必然不在底部（正往上翻），pinned 本来就是 false
      el.scrollTop = el.scrollHeight - mark.prevHeight + mark.prevTop
      restoring.current = null
      return
    }
    if (pinned.current) el.scrollTop = el.scrollHeight
  })

  // 只在 items 头部变化时记锚点（往尾部 append 不该进 sticky 路径）：
  // 对比「items 数组第一个元素」不够（可以是同一条），用长度突变 + 头条
  // 变化双条件太绕——直接由 historyPage 的 state 变化驱动更可靠
  const firstItem = view.items[0]
  const prevFirst = useRef<ChatItem | undefined>(undefined)
  const prevLen = useRef(0)
  if (
    firstItem !== undefined &&
    prevFirst.current !== undefined &&
    view.items.length > prevLen.current &&
    firstItem !== prevFirst.current
  ) {
    const el = ref.current
    if (el) restoring.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop }
  }
  prevFirst.current = firstItem
  prevLen.current = view.items.length

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    // 留 24px 容差：滚到底时 scrollTop 常常差几个像素对不齐
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    // 触顶拉历史：40px 内就发——等到 scrollTop === 0 才发的话最后一屏
    // 恰好填满时用户拉不动，卡在没有加载更多的死区里
    if (el.scrollTop < 40 && history.more && !history.loading) onFetchTop()
  }

  /**
   * .log 里渲染出来的内联交互统一走这一个委托（dangerouslySetInnerHTML
   * 的内容挂不了 React 处理器）：链接外开、代码块复制。不逐节点挂
   */
  const onLogClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement

    const copy = target.closest('.code-copy')
    if (copy) {
      e.preventDefault()
      void copyCode(copy.closest('pre'))
      return
    }

    // 路径链接（pathlink）：无 href，和 markdown 链接分流。宿主侧拼
    // 工作区根，webview 不掺和（folder 的源头本来就在宿主）
    const path = target.closest('a[data-open-path]')
    if (path) {
      e.preventDefault()
      const line = path.getAttribute('data-open-line')
      post({ type: 'openFile', path: path.getAttribute('data-open-path') ?? '', ...(line ? { line: Number(line) } : {}) })
      return
    }
    const anchor = target.closest('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (href !== '') post({ type: 'openLink', url: href })
  }

  const blocks = groupItems(view.items)
  // 跑着的那一轮不折：过程就是用户此刻要看的东西
  const sections = splitTurns(blocks, !running)
  const renderBlock = (block: Block, at: number) =>
    block.kind === 'activity' ? (
      // 组身份 = 组首条的墙钟：块只追加不重排，天然稳定
      <ActivityGroup
        key={`g${block.items[0]?.startedAt ?? `hx${at}`}`}
        items={block.items}
        last={at === blocks.length - 1}
        running={running}
        approvals={approvals}
        onApprovalReply={onApprovalReply}
      />
    ) : (
      <Item
        key={`b${at}`}
        item={block.item}
        streaming={running && at === blocks.length - 1}
        model={model}
      />
    )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 事件委托不是交互元素，可交互的是渲染出来的 <a>
    // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘路径由 <a> 自身保证（Enter 激活走同一 click）
    <div className="log" ref={ref} onScroll={onScroll} onClick={onLogClick}>
      {history.loading && (
        <div className="history-loading">
          <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden />{' '}
          正在加载更早的消息…
        </div>
      )}
      {!history.loading && !history.more && view.items.length > 0 && (
        <div className="history-end">— 没有更早的了 —</div>
      )}
      {sections.map((section, i) =>
        section.kind === 'block' ? (
          renderBlock(section.block, section.at)
        ) : (
          // 折叠组的身份用它在 sections 里的位置：sections 只追加不重排
          // biome-ignore lint/suspicious/noArrayIndexKey: 同上，且块只追加
          <ProcessGroup key={`p${i}`} tools={section.tools} elapsedMs={section.elapsedMs}>
            {section.blocks.map((block, j) => renderBlock(block, -1 - j))}
          </ProcessGroup>
        ),
      )}
    </div>
  )
}

/** user 行的路径链接化（受控渲染，不走 innerHTML；识别逻辑同 markdown
 * 管线，都在 pathlink.ts）。React key 用 start——token 不重叠 */
function PathText({ text }: { text: string }) {
  const tokens = findPathTokens(text)
  if (tokens.length === 0) return text
  const out: ReactNode[] = []
  let pos = 0
  for (const tk of tokens) {
    if (tk.start > pos) out.push(text.slice(pos, tk.start))
    const seg = text.slice(tk.start, tk.end)
    const path = text.slice(tk.start, tk.pathEnd)
    out.push(
      <a key={`p${tk.start}`} data-open-path={path} {...(tk.line !== undefined ? { 'data-open-line': tk.line } : {})}>
        {seg}
      </a>,
    )
    pos = tk.end
  }
  if (pos < text.length) out.push(text.slice(pos))
  return out
}

/** 用户长消息折叠（方案 A，用户拍板）：超约 15 行截断 + 底部渐隐 +
 * 「展开 N 行 / 收起」。是否截断由渲染后 scrollHeight 溢出判断——阈值在
 * CSS（.user-clamp 的 max-height:24em，15 行 × 1.6 行高），两处口径一致；
 * 行数按 \n 数（自动换行不计），作按钮文案够用 */
export function UserBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    // 只在收起态测：展开态 max-height 已摘除，scrollHeight==clientHeight
    // 恒 false，会把按钮连「收起」入口一起抹掉——展开就再也收不回去了。
    // c || 锁定：曾溢出保持 true（user 消息不可变，无 text 变短的 edge）
    if (open) return
    const el = ref.current
    if (el) setClamped((c) => c || el.scrollHeight - el.clientHeight > 4)
  }, [text, open])
  return (
    <div className="user-col">
      <div ref={ref} className={'user' + (open ? '' : ' user-clamp')}>
        <PathText text={text} />
      </div>
      {clamped && (
        <button className="user-toggle" onClick={() => setOpen(!open)}>
          {open ? '收起' : `展开 ${text.split('\n').length} 行`}
        </button>
      )}
    </div>
  )
}

/** 独立成块的条目（user/assistant/notice）。tool/reasoning 永远走 ActivityGroup */
function Item({
  item,
  streaming,
  model,
}: {
  item: SingleItem
  streaming: boolean
  model: string | null
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="item user-row">
          {item.images !== undefined && item.images.length > 0 && (
            <div className="user-images">
              {item.images.map((img, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 与 composer 的 attach 条一致，i 只为 key 唯一性服务
                <img
                  key={`u${i}`}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt="已发送图片"
                  data-zoom
                />
              ))}
            </div>
          )}
          <UserBubble text={item.text} />
        </div>
      )
    case 'assistant':
      // 流式期间节流渲 markdown（C3，D1a+D2b）；结束后最终渲一次
      return (
        <div className="item">
          {streaming ? (
            <StreamMarkdown text={item.text} />
          ) : (
            <div
              className="assistant markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }}
            />
          )}
          {/* finishedAt 只有本轮末条 assistant 有（events.ts finishTurn） */}
          {item.finishedAt !== undefined && (
            <MessageFooter
              model={item.model ?? model}
              elapsedMs={item.elapsedMs}
              finishedAt={item.finishedAt}
              text={item.text}
            />
          )}
        </div>
      )
    case 'notice':
      return (
        <div className={`item notice${item.errorKind ? ' notice-error' : ''}`}>
          {item.errorKind && <span className="notice-kind">{item.errorKind}</span>}
          {item.text}
          {item.retryable && (
            <button type="button" className="notice-retry" onClick={() => post({ type: 'retry' })}>
              重试
            </button>
          )}
        </div>
      )
  }
}

/**
 * 流式中的 markdown：节流（100ms）+ 围栏隔离。未闭合 ``` 的尾部按纯文本
 * 渲（splitOpenFence），其余全量 parse——几 KB 文本的 marked parse 是 ~1ms
 * 级，10 次/秒无感（D2b 的取舍：lexer 分块缓存是给
 * Shiki/KaTeX 这类重渲染器配的，这里不需要）
 */
function StreamMarkdown({ text }: { text: string }) {
  const throttled = useThrottledText(text, true)
  const open = splitOpenFence(throttled)
  if (open === null) {
    return (
      <div
        className="assistant markdown streaming"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(throttled) }}
      />
    )
  }
  return (
    <div className="assistant markdown streaming">
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(open.settled) }} />
      <pre className="stream-raw">{open.raw}</pre>
    </div>
  )
}

function Composer({
  running,
  view,
  controls,
  folder,
  onSend,
  onStop,
  onNotice,
  onOpenRegions,
}: {
  running: boolean
  view: ChatView
  controls: Controls
  /** 工作区根：拖入路径在项目内时显示相对路径（dropPaths.toDisplayPath） */
  folder: string
  onSend: (text: string, images: ImageRef[]) => void
  onStop: () => void
  onNotice: (text: string) => void
  /** 点「上下文 X」：开面板 + 按需拉取分区快照（state 在 App，数据不进 ChatView） */
  onOpenRegions: () => void
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageRef[]>([])
  /** 拖入的文件路径（Explorer 拖放，2026-09-12 拍板方案 A：气泡区而非插文本） */
  const [attached, setAttached] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)

  /** Explorer 拖文件 → 路径文本（dropPaths.ts 文件头有完整拍板）。
   *
   * 为什么是 document 原生监听而不是 React props：Cursor 实测（2026-09-09
   * 三轮）React 合成 dragenter 触发、drop 却不触发，同一环境 document 层
   * 三个事件全通——不赌委托，直接走已实证的通道：
   * dragover 里 preventDefault + dropEffect='copy'（不设宿主可能按拒绝
   * 处理），drop 先 preventDefault 再解析（textarea 原生会把 payload 插进
   * 输入框，默认动作在派发完才执行，document 冒泡层取消也来得及）。
   *
   * dragover 判据从宽：types 命中任一宿主私有标志即接受——Cursor 的
   * dragover 阶段 types 是残缺的（payload 保护，drop 才给全），窄判据会
   * 漏 preventDefault → drop 永不触发。浏览器拖 URL（无私有类型）不拦，
   * 走 textarea 原生插入，合理。 */
  useEffect(() => {
    let depth = 0
    const carriesHostData = (dt: DataTransfer | null): boolean =>
      Array.from(dt?.types ?? []).some(
        (ty) =>
          ty.startsWith('application/vnd.code.') ||
          ty === 'codefiles' ||
          ty === 'CodeFiles' ||
          ty === 'resourceurls' ||
          ty === 'codeeditors',
      )
    const onEnter = (e: DragEvent): void => {
      if (!carriesHostData(e.dataTransfer)) return
      e.preventDefault()
      depth++
      setDragOver(true)
    }
    const onOver = (e: DragEvent): void => {
      if (!carriesHostData(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragOver(false)
    }
    const onDrop = (e: DragEvent): void => {
      const host = carriesHostData(e.dataTransfer)
      if (!host && !(e.dataTransfer && e.dataTransfer.files.length > 0)) return
      e.preventDefault() // textarea 原生插入 payload 的防御，见上
      depth = 0
      setDragOver(false)
      const dt = e.dataTransfer
      if (dt && isExplorerDrag(dt)) {
        const lines = parseExplorerPaths(dt).map((p) => toDisplayPath(p, folder))
        if (lines.length === 0) {
          onNotice('拖入的内容里没解析出文件路径')
          return
        }
        setAttached((cur) => [...cur, ...lines.filter((p) => !cur.includes(p))])
      } else if (hasOsFileDrag(dt)) {
        onNotice('仅支持从 VS Code 资源管理器拖入（图片继续用粘贴）')
      }
    }
    document.addEventListener('dragenter', onEnter)
    document.addEventListener('dragover', onOver)
    document.addEventListener('dragleave', onLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragenter', onEnter)
      document.removeEventListener('dragover', onOver)
      document.removeEventListener('dragleave', onLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [folder, onNotice])

  /** 单图上限。没有的话一张 40MB 截图既撑请求体也撑 store，三端都遭殃 */
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024

  const submit = () => {
    const trimmed = text.trim()
    // running 不拦：插话进 core 的任务队列，当前命令跑完、下一次请求
    // 模型前插进去（send running 时 tasks.push 入队）。用户气泡本地
    // append，Enter 立刻可见，不用等回显
    if (trimmed === '' && images.length === 0 && attached.length === 0) return
    setText('')
    setImages([])
    const payload = composeWithAttachments(trimmed, attached)
    setAttached([])
    onSend(payload, images)
  }

  /** 粘贴板里的图 → base64。不拦 e.preventDefault：文本粘贴走默认路径，
   * 只有真的拿到图才动手；截图工具普遍把图同时以 PNG 文件+位图两种形态放
   * 剪贴板，items 会重复命中，用 Set 按文件去重 */
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (!controls.imagesEnabled) {
      // 不静默：贴了没反应像坏了。但也别 alert——打断输入流，notice 是聊天语境的反馈
      const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith('image/'))
      if (items.length > 0) {
        e.preventDefault()
        onNotice('当前模型不支持图片（换模型或在配置里开启 capabilities.images）')
      }
      return
    }
    const files = new Set<File>()
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file !== null) files.add(file)
      }
    }
    if (files.size === 0) return
    e.preventDefault()
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) {
        onNotice(`图片 ${(file.size / 1048576).toFixed(1)}MB 超过 8MB 上限`)
        continue
      }
      const dataUrl = await readAsDataURL(file)
      // data:image/png;base64,xxxx → { mimeType, data }
      const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
      const mimeType = match?.[1]
      const data = match?.[2]
      if (mimeType === undefined || data === undefined) continue
      setImages((cur) => [...cur, { mimeType, data }])
    }
  }

  return (
    <div className={dragOver ? 'composer dragover' : 'composer'}>
      {images.length > 0 && (
        <div className="attach">
          {images.map((img, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 预览条随编辑增删，i 只为 key 唯一性服务
            <div key={`a${i}`} className="attach-thumb">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt="待发送图片" data-zoom />
              <button
                type="button"
                aria-label="移除图片"
                onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {attached.length > 0 && (
        <div className="attach-files">
          {attached.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 与图片预览条同构，i 只为 key 唯一性服务
            <div key={`f${i}`} className="file-chip" title={p}>
              <span className="file-chip-name">{p}</span>
              <button
                type="button"
                aria-label="移除附件"
                onClick={() => setAttached((cur) => cur.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        value={text}
        placeholder={
          running
            ? '正在跑……（Enter 插话，当前命令跑完后处理）'
            : '说点什么（Enter 发送，Shift+Enter 换行）'
        }
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => void onPaste(e)}
        onKeyDown={(e) => {
          // 输入法组合期间的 Enter 是「确认候选词」，不是发送。不判断的话
          // 中文输入到一半按 Enter 就把半截话发出去了
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {/* **左边状态、右边控件+发送**（`justify-between`，右侧 `justify-end`）。
          右侧顺序：推理深度 → 模型 → 发送。原来发送按钮在最左，控件离手最远，
          而它们是每轮都要瞄一眼的东西 */}
      <div className="bar">
        {(view.lastTiming || view.contextTokens > 0) && (
          <span className="usage">
            {view.lastTiming && (
              <>
                首字 {fmtMs(view.lastTiming.ttftMs)} · 总 {fmtMs(view.lastTiming.totalMs)} · ↑
                {fmtTok(view.lastTiming.inputTokens)} ↓{fmtTok(view.lastTiming.outputTokens)}
              </>
            )}
            {view.contextTokens > 0 && (
              <>
                {view.lastTiming ? ' ｜ ' : ''}
                <button
                  type="button"
                  className="usage-ctx"
                  title="上下文分区分析"
                  onClick={onOpenRegions}
                >
                  上下文 {fmtTok(view.contextTokens)}
                </button>
              </>
            )}
          </span>
        )}
        <div className="bar-right">
          {/* 审批两态开关（approval.md §4.2）。关 = 触发即放行；默认开。
              放在控件区最前：它是安全语义，和模型选择不是一类东西，
              排最左让「现在关着」这个状态在扫一眼的视野里 */}
          <button
            type="button"
            className={`approval-toggle${controls.approvalOn ? '' : ' is-off'}`}
            title="项目外/隐藏目录/网络命令执行前要不要问你"
            onClick={() => post({ type: 'setApprovalEnabled', on: !controls.approvalOn })}
          >
            {/* 图标跟着状态换（闭锁↔开锁），不是只换颜色：关掉守门是件该
                一眼看见的事，形状变化比颜色变化更容易被扫到 */}
            <i
              className={`codicon codicon-${controls.approvalOn ? 'lock' : 'unlock'}`}
              aria-hidden
            />
            {controls.approvalOn ? '开' : '关'}
          </button>
          <EffortPicker
            effort={controls.effort}
            overridden={controls.effortOverridden}
            running={running}
          />
          <ModelPicker current={controls.current} models={controls.models} running={running} />
          {/* 预设紧挨模型右侧：它从属于模型，隔开会看不出这层关系。
              没配 presets 的模型整个不渲染，那时这一排跟以前一模一样 */}
          <PresetPicker
            preset={controls.preset}
            presets={controls.presets}
            current={controls.current}
            running={running}
          />
          {running ? (
            <button
              type="button"
              className="send-btn is-stop"
              onClick={onStop}
              title="停止（Esc）"
              aria-label="停止"
            >
              <i className="codicon codicon-primitive-square" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              onClick={submit}
              disabled={text.trim() === ''}
              title="发送（Enter）"
              aria-label="发送"
            >
              <PlaneIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 发送键的纸飞机。**自绘而不是用 codicon-send**：那个字形在字面框里偏右下
 * （放大 4 倍加十字准星看，尾尖几乎压在圆心、机头冲出右边界），而 flex 居中
 * 对齐的是字面框不是视觉重心，怎么调 CSS 都正不过来。自绘的 path 坐标直接
 * 把重心压在 viewBox 正中，顺带能把机身拉长——26px 圆钮里细长的比 codicon
 * 那个偏胖的造型清楚。以后想调角度/长度改 d 即可，不用迁就字体设计。
 */
const PlaneIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden>
    <path d="M22.2 2.4 2.9 11.4c-.6.28-.55 1.15.08 1.36l6.5 2.2 2.2 6.5c.21.63 1.08.68 1.36.08L22.2 2.4z" />
  </svg>
)

/** FileReader 的 promise 包装。webview 环境没有 arrayBuffer→base64 的快捷道，
 * dataURL 是最省事且不引依赖的路径 */
const readAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/**
 * 复制代码块。成功/失败都在按钮上反馈 1.5s——这段 DOM 是
 * dangerouslySetInnerHTML 渲的，不属于 React 树，就地改文本是最直接的
 * 反馈通道（改完超时还原，不积累状态）
 */
async function copyCode(pre: Element | null): Promise<void> {
  if (!pre) return
  const btn = pre.querySelector('.code-copy')
  const code = pre.querySelector('code')?.textContent ?? ''
  try {
    // clipboard API 在 webview 里来自用户手势时可用；execCommand 兜底
    // 老宿主（Cursor 的 Electron 版本参差）
    if (navigator.clipboard) await navigator.clipboard.writeText(code)
    else throw new Error('no clipboard api')
    if (btn) {
      btn.textContent = '已复制'
      setTimeout(() => (btn.textContent = '复制'), 1500)
    }
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = code
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      if (btn) {
        btn.textContent = '已复制'
        setTimeout(() => (btn.textContent = '复制'), 1500)
      }
    } catch {
      if (btn) {
        btn.textContent = '失败'
        setTimeout(() => (btn.textContent = '复制'), 1500)
      }
    }
  }
}
