import { memo, type ReactNode, useMemo, useState } from 'react'
import type { ApprovalRequest } from '../src/protocol.ts'
import { MThinkingBlock, MToolRow, ProcessGroup } from './activity.tsx'
import type { Block, ChatItem, Section } from './events.ts'
import { renderMarkdown } from './markdown.ts'
import {
  buildSteps,
  type Row,
  type Stats,
  type Step,
  sameTurn,
  stepStats,
  type Turn,
} from './steps.ts'

/**
 * 一轮的渲染：吸顶的用户消息 + 过程时间线 + 回答（2026-10-28 改版，原型
 * .simple-code/tmp/activity-redesign/index.html，用户原话「原型没有问题，
 * 非常好」）。
 *
 * ```
 * 用户消息（吸顶）  ● 进行中 · 第 12 步 · 已做 37 个操作 · 1 个失败
 *   ○ 说明甲。  9 个操作 ›          ← 之前的步骤收起，只留说明和句尾计数
 *   ○ 说明乙。  6 个操作 · 1 个失败 ›  ← 有失败的步骤节点标红
 *   ◉ 说明丙。  1 个操作 ⌄          ← 当前步骤展开
 *       ◌ 提交并装机            0:12
 * ```
 * 跑完后整段过程收成一行「处理过程」（ProcessGroup），点开是同一条时间线，
 * 各步默认收起。
 */

type Reply = (
  id: number,
  choice: 'allow' | 'always' | 'deny',
  folder?: string,
  feedback?: string,
) => void
type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type ReasoningItem = Extract<ChatItem, { kind: 'reasoning' }>

type Shared = {
  /** 正在流式的块下标（跑着 = 最后一块，否则 null）：说明走流式渲染、思考跑表 */
  streamingAt: number | null
  approvals: ApprovalRequest[]
  onApprovalReply: Reply
  /** 单块交回 Log 的同一个渲染入口（notice、流式中的说明、带页脚的说明） */
  renderBlock: (block: Block, at: number) => ReactNode
}

function TurnView({ turn, live, ...shared }: TurnProps) {
  // 跑着的那一轮 splitTurns 不折，body 全是单块，整段进时间线。**没折的
  // 活动块也必须进时间线**：renderBlock 不画活动块（返回 null）。跑着时插话
  // 把一轮切成两段，前一段不是最后一轮、splitTurns 也不折它（插话不折），
  // 曾整段命令消失、挂着的审批卡跟着没了（2026-10-31 真机）。这种段各步收起
  const rows =
    live || turn.body.some((s) => s.kind === 'block' && s.block.kind === 'activity')
      ? buildSteps(entriesOf(turn.body))
      : null
  return (
    <div className="turn">
      {turn.head && (
        <div className="turn-head">
          {shared.renderBlock(turn.head.block, turn.head.at)}
          {rows && live && <TurnProgress stats={stepStats(rows)} />}
        </div>
      )}
      {rows ? (
        <Timeline rows={rows} live={live} {...shared} />
      ) : (
        turn.body.map((section, i) =>
          section.kind === 'block' ? (
            shared.renderBlock(section.block, section.at)
          ) : (
            <Folded key={`p${i}`} section={section} {...shared} />
          ),
        )
      )}
    </div>
  )
}

const entriesOf = (body: readonly Section[]) =>
  body.flatMap((s) => (s.kind === 'block' ? [{ block: s.block, at: s.at }] : []))

type TurnProps = Shared & { turn: Turn; live: boolean }

/**
 * 内容没变的轮跳过渲染。流式中 Log 每 100ms 重渲，不跳的话历史上每一轮
 * 都要重跑一遍（折叠段还要重算步骤），2500 条历史实测主线程比改版前多
 * 约 25%；跳过后约为改版前的一半。turn 每次都是新外壳，按内容比
 * （steps.ts sameTurn）；其余 prop 按引用比——**所以 Log 传进来的
 * renderBlock 必须是稳定引用**，它一变就全部重渲（App.tsx useCallback）
 */
export const MTurnView = memo(
  TurnView,
  (a: TurnProps, b: TurnProps) =>
    a.live === b.live &&
    a.streamingAt === b.streamingAt &&
    a.approvals === b.approvals &&
    a.onApprovalReply === b.onApprovalReply &&
    a.renderBlock === b.renderBlock &&
    sameTurn(a.turn, b.turn),
)

/** 进度行：用户消息下面，跟着吸顶，轮很长时也看得到走到哪了 */
function TurnProgress({ stats }: { stats: Stats }) {
  return (
    <div className="turn-progress">
      <span className="turn-live">进行中</span>
      {stats.steps > 0 && <span>{` · 第 ${stats.steps} 步 · 已做 ${stats.done} 个操作`}</span>}
      {stats.failed > 0 && <span className="turn-fail">{` · ${stats.failed} 个失败`}</span>}
    </div>
  )
}

/** 跑完收起的过程。折进来的块没有有效下标，给负数：永远不是「最后一块」 */
function Folded({
  section,
  ...shared
}: Shared & { section: Extract<Section, { kind: 'process' }> }) {
  const rows = buildSteps(section.blocks.map((block, j) => ({ block, at: -1 - j })))
  return (
    <ProcessGroup stats={stepStats(rows)} elapsedMs={section.elapsedMs}>
      <Timeline rows={rows} live={false} {...shared} />
    </ProcessGroup>
  )
}

export function Timeline({ rows, live, ...shared }: Shared & { rows: Row[]; live: boolean }) {
  const last = rows.findLastIndex((row) => row.kind === 'step')
  return (
    <div className="tl">
      {rows.map((row, i) =>
        row.kind === 'block' ? (
          <div key={`b${row.at}`} className="tl-block">
            {shared.renderBlock(row.block, row.at)}
          </div>
        ) : (
          <TimelineStep key={`s${row.at}`} step={row} current={live && i === last} {...shared} />
        ),
      )}
    </div>
  )
}

const isTool = (item: Step['items'][number]): item is ToolItem => item.kind === 'tool'

/**
 * 一个步骤。**开合**：跑着的那一轮只展开当前步，新说明一出现上一步就收起
 * （同原来活动组的时机）；用户点过就听用户的；挂着审批卡的步骤强制展开
 * ——卡被收进去，用户就看不到要他批的东西了。
 * **收起 = 一条命令都不留**，只剩说明和句尾「N 个操作 ›」（用户原话
 * 「最上面没有都收起来」，见 activity.tsx 旧活动组的记录）
 */
function TimelineStep({ step, current, ...shared }: Shared & { step: Step; current: boolean }) {
  const { streamingAt, approvals, onApprovalReply } = shared
  const [byUser, setByUser] = useState<boolean | null>(null)
  const [thinksOpen, setThinksOpen] = useState(false)
  const ops = step.items.filter(isTool)
  const failed = ops.filter((t) => t.failed).length
  const pending = ops.some((t) => approvals.some((a) => a.toolCallId === t.id))
  const open = pending || (byUser ?? current)
  const toggle = () => setByUser(!open)

  const tail = step.items.at(-1)
  const liveThought =
    streamingAt !== null && step.itemsAt === streamingAt && tail?.kind === 'reasoning' ? tail : null
  const thoughts = step.items.filter(
    (x): x is ReasoningItem => x.kind === 'reasoning' && x !== liveThought && x.text.trim() !== '',
  )
  const token = ops.length > 0 ? countHtml(ops.length, failed, open) : ''

  return (
    <div className="tl-step" data-current={current} data-failed={failed > 0}>
      <i className="tl-node" aria-hidden />
      {stepText(step, token, toggle, shared)}
      {thoughts.length > 0 && (
        <button
          type="button"
          className="tl-think"
          data-bare={!step.text && ops.length === 0}
          onClick={() => setThinksOpen(!thinksOpen)}
        >
          {`思考 ${thoughts.length}`}
        </button>
      )}
      {thinksOpen && <Thoughts items={thoughts} />}
      {open && (ops.length > 0 || liveThought) && (
        <div className="tl-ops">
          {step.items.map((item) =>
            isTool(item) ? (
              <MToolRow
                key={item.id}
                tool={item}
                {...(() => {
                  const a = approvals.find((x) => x.toolCallId === item.id)
                  return a ? { approval: a } : {}
                })()}
                onReply={onApprovalReply}
              />
            ) : item === liveThought ? (
              <MThinkingBlock key={`r${item.startedAt ?? 'live'}`} block={item} streaming />
            ) : null,
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 说明：一般走自己的渲染（句尾要挂计数）；还在流式的、或带页脚的（一轮的
 * 收尾回答被下一段接上时会落进过程里）交回 Log 的单块渲染，计数另起一行
 */
function stepText(step: Step, token: string, toggle: () => void, shared: Shared): ReactNode {
  const text = step.text
  if (text && (text.at === shared.streamingAt || text.item.finishedAt !== undefined)) {
    return (
      <>
        {shared.renderBlock({ kind: 'single', item: text.item }, text.at)}
        {token !== '' && <StepText text="" token={token} onToggle={toggle} />}
      </>
    )
  }
  if (!text && token === '') return null
  return <StepText text={text?.item.text ?? ''} token={token} onToggle={toggle} />
}

/** 句尾计数（HTML 串：要塞进 markdown 渲染结果的最后一段里） */
function countHtml(n: number, failed: number, open: boolean): string {
  const fail = failed > 0 ? `<span class="tl-fail"> · ${failed} 个失败</span>` : ''
  return `<button type="button" class="tl-count" data-open="${open}">${n} 个操作${fail}<i class="codicon codicon-chevron-right" aria-hidden="true"></i></button>`
}

function StepText({
  text,
  token,
  onToggle,
}: {
  text: string
  token: string
  onToggle: () => void
}) {
  // 缓存的是 { __html } 对象本身，不是字符串：React 19 按对象引用比较这个
  // prop，每次新建对象就重设一次 innerHTML。流式中 Log 每 100ms 重渲，跑着
  // 的那一轮每一步都被重设（实测 60 个 delta 重设 720 次）——选中的文字随
  // 之丢失，悬停态闪烁
  const inner = useMemo(
    () => ({ __html: withToken(text === '' ? '' : renderMarkdown(text), token) }),
    [text, token],
  )
  return (
    <div
      className="tl-text markdown"
      onClick={(e) => {
        if ((e.target as Element).closest('.tl-count')) onToggle()
      }}
      dangerouslySetInnerHTML={inner}
    />
  )
}

/**
 * 计数挂到最后一段的句尾；最后一块是列表就挂进最后一项，是代码块/表格
 * 这类挂不进去的，另起一行
 */
export function withToken(html: string, token: string): string {
  if (token === '') return html
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  let host = tpl.content.lastElementChild
  if (host?.tagName === 'UL' || host?.tagName === 'OL') host = host.lastElementChild
  if (host?.tagName === 'LI' && host.lastElementChild?.tagName === 'P') host = host.lastElementChild
  if (host?.tagName === 'P' || host?.tagName === 'LI') host.insertAdjacentHTML('beforeend', token)
  else {
    const row = document.createElement('div')
    row.className = 'tl-count-row'
    row.innerHTML = token
    tpl.content.append(row)
  }
  return tpl.innerHTML
}

/** 想完的思考：点「思考 N」才渲染，渲染了也只是一个限高的灰色框 */
function Thoughts({ items }: { items: ReasoningItem[] }) {
  // 按文本缓存：items 每次渲染都是新数组，流式中 Log 每 100ms 重渲一次
  const joined = items.map((t) => t.text).join(SEP)
  // 对象一起缓存，理由同 StepText
  const inner = useMemo(
    () => ({ __html: joined.split(SEP).map(renderMarkdown).join('<hr>') }),
    [joined],
  )
  return <div className="tl-thinks markdown" dangerouslySetInnerHTML={inner} />
}
const SEP = '\u0000'
