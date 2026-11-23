/** 卡片构造（§15，2026-11-17 20:51–54 用户拍板）：审批/完成/出错/列表/状态
 *  五种消息改 Card 2.0。纯函数，出 Card JSON 字面量；发送/更新/回调解析在
 *  适配器与 gateway-click.ts，hub 只接线。
 *
 *  结构参照真机已发过的样例（.simple-code/tmp/cards/card1-5.json，主任务
 *  20:43/20:58 用 bot 发过）；table 列 width 下限 80px（写 60 报 230099）；
 *  button 的 type 枚举没有 grey。form 内按钮不用 behaviors、用
 *  form_action_type: 'submit'（20:58 真机跑通的 card5）。
 *  列表/状态/送达回执三种按任务状态着色的卡在 gateway-cards-tasks.ts。 */

import { TURN_TEXT_MAX, targetName } from './gateway-core.ts'
import type { RobotItem } from './robot-feed.ts'

export type Card = Record<string, unknown>

// ── 小工具 ────────────────────────────────────────────────────

export const md = (
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  tag: 'markdown',
  content,
  ...extra,
})

/** 按钮（Card 2.0）：behaviors.callback.value 是点击事件 action_value 的来源 */
export const btn = (
  content: string,
  type: string,
  value: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  tag: 'button',
  text: { tag: 'plain_text', content },
  type,
  width: 'fill',
  ...(value === null ? {} : { behaviors: [{ type: 'callback', value }] }),
  ...extra,
})

export const hhmm = (): string =>
  `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`

export const header = (
  title: string,
  template: string,
  subtitle?: string,
  tag?: { text: string; color: string },
): Record<string, unknown> => ({
  title: { tag: 'plain_text', content: title },
  ...(subtitle === undefined ? {} : { subtitle: { tag: 'plain_text', content: subtitle } }),
  template,
  ...(tag === undefined
    ? {}
    : {
        text_tag_list: [
          { tag: 'text_tag', text: { tag: 'plain_text', content: tag.text }, color: tag.color },
        ],
      }),
})

export const card = (
  head: Record<string, unknown>,
  elements: Array<Record<string, unknown>>,
  summary: string,
): Card => ({
  schema: '2.0',
  config: { width_mode: 'default', summary: { content: summary } },
  header: head,
  body: {
    direction: 'vertical',
    padding: '12px 12px 16px 12px',
    vertical_spacing: '12px',
    elements,
  },
})

/** 代码块（灰底单列） */
const codeBlock = (command: string): Record<string, unknown> => ({
  tag: 'column_set',
  flex_mode: 'none',
  background_style: 'grey-50',
  columns: [
    {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      padding: '8px',
      elements: [md(`\`\`\`\n${command}\n\`\`\``)],
    },
  ],
})

/** 通知卡的颜色（header template） */
export type Tone = 'green' | 'blue' | 'orange' | 'red' | 'grey'

/** 一句话通知（2026-11-18 用户：「手机上的样式统一」——推送卡与回执之外的
 *  文字回复也全改卡片）：标题进 header，正文必有（只有 header 的卡没真机
 *  发过）。卡片失败时 hub 退回「标题\n正文」文字 */
export function noticeCard(title: string, detail: string, tone: Tone): Card {
  const first = detail.split('\n')[0] ?? ''
  return card(header(title, tone, hhmm()), [md(detail)], `${title} · ${first}`.slice(0, 60))
}

// ── 审批卡（§15.3）───────────────────────────────────────────

/** 审批卡：canAllow 带 form（input reason + 批准/拒绝按钮）；ask_rule
 *  （canAllow=false）无按钮，只通知。点击处理按 message_id 查卡（不信
 *  action_value 带的值），按钮 value 只带 act。 */
export function approvalCard(a: Extract<RobotItem, { kind: 'approval' }>): Card {
  const until = new Date(a.expiresAt)
  const untilHm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`
  if (!a.canAllow) {
    return card(
      header(`需回电脑处理 · ${targetName(a.folder, a.task)}`, 'grey', `${untilHm} 前有效`),
      [
        md('**要执行这条命令，是否允许？**'),
        codeBlock(a.command),
        // 空 reason 不放空 markdown 元素（服务端收不收未验证，别发）
        ...(a.reason === '' ? [] : [md(`<font color='grey'>${a.reason}</font>`)]),
        md("<font color='grey'>安全规则不允许远程批</font>", { text_size: 'notation' }),
      ],
      `需回电脑处理 · ${targetName(a.folder, a.task)}`,
    )
  }
  // form 内按钮不用 behaviors、用 form_action_type: 'submit'（20:58 真机
  // 跑通的 card5.json：两列并排）。提交事件按 name（allow/deny）区分
  const formBtn = (name: string, label: string, type: string): Record<string, unknown> => ({
    tag: 'button',
    name,
    text: { tag: 'plain_text', content: label },
    type,
    width: 'fill',
    form_action_type: 'submit',
  })
  return card(
    header(`等你批准 · ${targetName(a.folder, a.task)}`, 'orange', `${untilHm} 前有效`),
    [
      md('**要执行这条命令，是否允许？**'),
      codeBlock(a.command),
      ...(a.reason === '' ? [] : [md(`<font color='grey'>${a.reason}</font>`)]),
      {
        tag: 'form',
        name: 'approve_form',
        vertical_spacing: '8px',
        elements: [
          {
            tag: 'input',
            name: 'reason',
            placeholder: { tag: 'plain_text', content: '拒绝理由（可不填）' },
            width: 'fill',
            max_length: 200,
          },
          {
            tag: 'column_set',
            flex_mode: 'none',
            horizontal_spacing: '8px',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [formBtn('allow', '批准', 'primary_filled')],
              },
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [formBtn('deny', '拒绝', 'danger')],
              },
            ],
          },
        ],
      },
      md("<font color='grey'>也可长按回复：批 / 拒 / 拒 理由</font>", { text_size: 'notation' }),
    ],
    `等审批 · ${targetName(a.folder, a.task)}`,
  )
}

/** 审批结果改卡（整张新卡、无按钮、保留命令）。act：allow/deny。 */
export function approvalResolvedCard(
  a: Extract<RobotItem, { kind: 'approval' }>,
  act: 'allow' | 'deny',
  reason: string | undefined,
): Card {
  const done = act === 'allow' ? '已批准' : `已拒绝${reason === undefined ? '' : `：${reason}`}`
  return card(
    header(
      `${done} · ${targetName(a.folder, a.task)}`,
      act === 'allow' ? 'green' : 'red',
      `手机 ${hhmm()}`,
    ),
    [codeBlock(a.command)],
    `${done} · ${targetName(a.folder, a.task)}`,
  )
}

/** 电脑上先处理了（ack.ok=false，用户选 2A）或卡已失效（网关重启过） */
export function approvalTakenCard(a: Extract<RobotItem, { kind: 'approval' }>): Card {
  const line = '已在电脑上处理'
  return card(
    header(`${line} · ${targetName(a.folder, a.task)}`, 'grey', `手机 ${hhmm()}`),
    [codeBlock(a.command)],
    `${line} · ${targetName(a.folder, a.task)}`,
  )
}

/** 卡已失效（网关重启过，approvalBy 在内存里查不到）：不知道原命令，纯文字 */
export function approvalStaleCard(): Card {
  return card(
    header('已失效：网关重启过，回电脑处理', 'grey', `手机 ${hhmm()}`),
    [],
    '已失效：网关重启过，回电脑处理',
  )
}

// ── 完成 / 出错卡（§15.3）────────────────────────────────────

/** body = turnEndMessage 的正文（≤4000 字同规则），summary 取首行截 50 字 */
export function turnEndCard(item: Extract<RobotItem, { kind: 'done' | 'error' }>): Card {
  const head = item.kind === 'done' ? '已完成' : '出错'
  const name = targetName(item.folder, item.task)
  const text = item.text ?? item.detail
  const clipped = text.length > TURN_TEXT_MAX
  const body = clipped ? `${text.slice(0, TURN_TEXT_MAX)}\n\n（超出 4000 字，全文在面板）` : text
  // §15.3：summary = 正文首行截 50 字（会话列表预览）
  const summary = (text.split('\n')[0] ?? '').slice(0, 50)
  return card(
    header(`${head} · ${name}`, item.kind === 'done' ? 'green' : 'red', hhmm()),
    [md(body)],
    summary,
  )
}
