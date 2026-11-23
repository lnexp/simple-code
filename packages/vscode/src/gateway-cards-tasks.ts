/** 按任务状态着色的卡（§15.3）：列表、状态、送达回执。小工具与审批/完成
 *  卡共用 gateway-cards.ts。 */

import { btn, type Card, card, header, hhmm, md } from './gateway-cards.ts'
import { stateText } from './gateway-core.ts'
import type { RobotTask } from './robot-feed.ts'

// ── 列表 / 状态卡（§15.3）────────────────────────────────────

/** 列表卡的一行数据（gateway-hub 从各窗口 status 收集） */
export type ListRow = {
  n: number
  name: string
  state: RobotTask
  folder: string
  owner: string
  current: boolean
}

const STATE_COLOR: Record<RobotTask['state'], string> = {
  running: 'blue',
  waiting: 'orange',
  error: 'red',
  done: 'green',
  idle: 'grey',
}

const stateFont = (t: RobotTask): string =>
  `<font color='${STATE_COLOR[t.state] ?? 'grey'}'>${stateText(t)}</font>`

/** 列表卡：每行 column_set（编号+名+状态+按钮），按钮 value 带 folder/owner
 *  ——不用编号（列表发出后任务可能变），点击时核对该任务还在。当前行按钮
 *  换成禁用的「当前」。单卡 ≤200 元素（§15.3：6 元素/行够 30 行）。 */
export function listCard(rows: ListRow[], currentName: string | null, pushOn: boolean): Card {
  const elements: Array<Record<string, unknown>> = rows.map((r) => ({
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [md(`**${r.n}** ${r.name} · ${stateFont(r.state)}`)],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          // type 枚举没有 grey（button.md：default/primary/danger/text/
          // primary_text/danger_text/primary_filled/danger_filled/laser）
          r.current
            ? btn('当前', 'default', null, { disabled: true, width: 'default' })
            : btn('切换', 'default', { act: 'to', folder: r.folder, owner: r.owner }),
        ],
      },
    ],
  }))
  if (elements.length === 0) elements.push(md("<font color='grey'>（没有任务）</font>"))
  return card(
    header(
      '任务列表',
      'blue',
      `当前：${currentName ?? '（电脑上的 SC 面板还没打开）'} · 推送：${pushOn ? '开' : '关'}`,
    ),
    elements,
    `任务列表 · ${rows.length} 个`,
  )
}

/** 状态卡：header 颜色随当前目标状态，一块字段 + 底部小字 */
export function statusCard(
  name: string,
  t: RobotTask | null,
  source: string,
  pushOn: boolean,
): Card {
  const st = t === null ? '空闲' : stateText(t)
  const color = t === null ? 'grey' : (STATE_COLOR[t.state] ?? 'grey')
  return card(
    header(`当前：${name}`, color, st),
    [
      md(`状态：${st}\n目标：${source}\n推送：${pushOn ? '开' : '关'}`),
      md("<font color='grey'>发 /列表 可切换</font>", { text_size: 'notation' }),
    ],
    `当前：${name} · ${st}`,
  )
}

/** 送达回执卡（2026-11-18 用户要求「→ X（已开始）」这种回执也改卡片）。
 *  before = deliver 前的任务状态（null = status 里没找到这个任务）；
 *  viaReply = 长按回复某张卡、按卡送进原任务（当前目标不变）；pushOff =
 *  推送关着，提醒结论不会推到手机（§5.6）。文字版是 deliveryLine */
export function deliveredCard(
  name: string,
  before: RobotTask | null,
  opts: { viaReply: boolean; pushOff: boolean },
): Card {
  const busy = before !== null && (before.state === 'running' || before.state === 'waiting')
  const how =
    before === null ? '已送达' : `${stateText(before)}，${busy ? '作为插话送达' : '已开始'}`
  const elements = [md(opts.viaReply ? `${how}\n按回复送达（当前目标不变）` : how)]
  if (opts.pushOff)
    elements.push(
      md("<font color='grey'>推送关着，结论不会推到手机；发 /推送 开 打开</font>", {
        text_size: 'notation',
      }),
    )
  return card(header(`→ ${name}`, busy ? 'orange' : 'blue', hhmm()), elements, `→ ${name} · ${how}`)
}
