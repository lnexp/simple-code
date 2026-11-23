import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approvalCard,
  approvalResolvedCard,
  approvalStaleCard,
  approvalTakenCard,
  type Card,
  noticeCard,
  turnEndCard,
} from '../src/gateway-cards.ts'
import { deliveredCard, listCard, statusCard } from '../src/gateway-cards-tasks.ts'
import { cardUpdateData, parseCardAction } from '../src/gateway-click.ts'

const FOLDER = '/Users/xx/Code/simple-code'
const approval = {
  kind: 'approval' as const,
  key: 'toolu_1',
  folder: FOLDER,
  task: null,
  command: 'grep -rn x ~/外部',
  reason: '项目外路径',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  canAllow: true,
  seen: false,
}

const findTag = (c: Card, tag: string): Array<Record<string, unknown>> =>
  (c.body as { elements: Array<Record<string, unknown>> }).elements.filter((e) => e.tag === tag)

describe('卡片构造（§15.3）', () => {
  it('审批卡（canAllow）：橙 header + form（input reason + 批准/拒绝按钮）+ 底部小字', () => {
    const c = approvalCard(approval)
    const head = c.header as Record<string, Record<string, unknown>>
    expect((head.title as { content: string }).content).toContain('等你批准 · simple-code 主任务')
    expect(head.template).toBe('orange')
    expect((head.subtitle as { content: string }).content).toContain('前有效')
    const forms = findTag(c, 'form')
    expect(forms).toHaveLength(1)
    // 20:58 真机跑通的 card5 结构：按钮在 column_set 里、form_action_type
    // submit、无 behaviors（点击事件按 name 区分）
    const els = forms[0]?.elements as Array<Record<string, unknown>>
    const input = els.find((e) => e.tag === 'input') as Record<string, Record<string, unknown>>
    expect(input?.name).toBe('reason')
    const formSet = els.find((e) => e.tag === 'column_set') as {
      columns: Array<{ elements: Array<Record<string, unknown>> }>
    }
    const buttons = formSet.columns.flatMap((c) => c.elements.filter((e) => e.tag === 'button'))
    const allow = buttons.find((b) => b.name === 'allow') as Record<string, unknown>
    const deny = buttons.find((b) => b.name === 'deny') as Record<string, unknown>
    expect(allow.type).toBe('primary_filled')
    expect(deny.type).toBe('danger')
    expect(allow.form_action_type).toBe('submit')
    expect(deny.form_action_type).toBe('submit')
    expect(allow.behaviors).toBeUndefined()
    expect(deny.behaviors).toBeUndefined()
    expect(JSON.stringify(c)).toContain('也可长按回复：批 / 拒 / 拒 理由')
  })

  it('审批卡（ask_rule）：灰 header、无 form 无按钮、小字「安全规则不允许远程批」', () => {
    const c = approvalCard({ ...approval, canAllow: false })
    expect((c.header as { template: string }).template).toBe('grey')
    expect((c.header as { title: { content: string } }).title.content).toContain('需回电脑处理')
    expect(findTag(c, 'form')).toHaveLength(0)
    expect(JSON.stringify(c)).not.toContain('"form"')
    expect(JSON.stringify(c)).toContain('安全规则不允许远程批')
  })

  it('完成/出错卡：title、正文、summary 首行截 50 字、超 4000 截断提示', () => {
    const done = turnEndCard({
      kind: 'done',
      key: 'k1',
      folder: FOLDER,
      task: null,
      headline: 'h',
      detail: '',
      text: '第一行的结论\n第二行',
      seen: false,
    })
    expect((done.header as { title: { content: string } }).title.content).toBe(
      '已完成 · simple-code 主任务',
    )
    expect((done.header as { template: string }).template).toBe('green')
    expect(JSON.stringify(done)).toContain('第一行的结论')
    expect((done.config as { summary: { content: string } }).summary.content).toContain(
      '第一行的结论',
    )
    const long = turnEndCard({
      kind: 'error',
      key: 'k2',
      folder: FOLDER,
      task: null,
      headline: 'h',
      detail: '',
      text: 'x'.repeat(5000),
      seen: false,
    })
    expect((long.header as { template: string }).template).toBe('red')
    expect(JSON.stringify(long)).toContain('超出 4000 字，全文在面板')
    expect(
      (long.config as { summary: { content: string } }).summary.content.length,
    ).toBeLessThanOrEqual(50)
  })

  it('列表卡：行按钮 value 带 folder/owner；当前行按钮禁用；空列表占位', () => {
    const rows = [
      {
        n: 1,
        name: 'simple-code 主任务',
        state: { folder: FOLDER, task: null, owner: '', state: 'running' as const, since: null },
        folder: FOLDER,
        owner: '',
        current: true,
      },
      {
        n: 2,
        name: 'simple-code 修复',
        state: {
          folder: FOLDER,
          task: '修复',
          owner: 'task-1',
          state: 'idle' as const,
          since: null,
        },
        folder: FOLDER,
        owner: 'task-1',
        current: false,
      },
    ]
    const c = listCard(rows, 'simple-code 主任务', true)
    const json = JSON.stringify(c)
    expect(json).toContain('{"act":"to","folder":"/Users/xx/Code/simple-code","owner":"task-1"}')
    expect(json).toContain('当前：simple-code 主任务 · 推送：开')
    // 当前行按钮禁用
    const sets = findTag(c, 'column_set')
    const firstRowCols = sets[0]?.columns as Array<{ elements: Array<Record<string, unknown>> }>
    const curBtn = firstRowCols[1]?.elements[0]
    expect(curBtn?.disabled).toBe(true)
    expect((curBtn as Record<string, unknown>).type).toBe('default') // type 枚举没有 grey（button.md）
    const empty = listCard([], null, false)
    expect(JSON.stringify(empty)).toContain('（没有任务）')
  })

  it('状态卡：三字段 + 底部小字', () => {
    const c = statusCard(
      'simple-code 主任务',
      { folder: FOLDER, task: null, owner: '', state: 'waiting', since: null },
      '/切换 指定的',
      true,
    )
    expect((c.header as { template: string }).template).toBe('orange')
    const json = JSON.stringify(c)
    expect(json).toContain('状态：等审批')
    expect(json).toContain('目标：/切换 指定的')
    expect(json).toContain('推送：开')
    expect(json).toContain('发 /列表 可切换')
  })

  it('送达回执卡（11-18）：空闲蓝「已开始」；在跑橙「作为插话送达」；按回复与推送关着各加一行；找不到任务「已送达」', () => {
    const t = (state: 'idle' | 'running') =>
      ({ folder: FOLDER, task: null, owner: '', state, since: null }) as const
    const idle = deliveredCard('simple-code 主任务', t('idle'), { viaReply: false, pushOff: false })
    expect(idle.header).toMatchObject({
      title: { content: '→ simple-code 主任务' },
      template: 'blue',
    })
    expect(JSON.stringify(idle)).toContain('空闲，已开始')
    expect(JSON.stringify(idle)).not.toContain('按回复送达')
    expect(findTag(idle, 'markdown')).toHaveLength(1)

    const busy = deliveredCard('simple-code 主任务', t('running'), {
      viaReply: true,
      pushOff: true,
    })
    expect((busy.header as { template: string }).template).toBe('orange')
    const json = JSON.stringify(busy)
    expect(json).toContain('作为插话送达')
    expect(json).toContain('按回复送达（当前目标不变）')
    expect(json).toContain('推送关着，结论不会推到手机；发 /推送 开 打开')

    const gone = deliveredCard('simple-code 主任务', null, { viaReply: false, pushOff: false })
    expect(JSON.stringify(gone)).toContain('已送达')
  })

  it('通知卡（11-18）：标题进 header、颜色随 tone、正文一个 markdown、summary 截 60 字', () => {
    const c = noticeCard('没送达', '电脑上的 SC 不在线', 'red')
    expect(c.header).toMatchObject({ title: { content: '没送达' }, template: 'red' })
    expect(findTag(c, 'markdown')).toEqual([{ tag: 'markdown', content: '电脑上的 SC 不在线' }])
    expect((c.config as { summary: { content: string } }).summary.content).toBe(
      '没送达 · 电脑上的 SC 不在线',
    )
    const long = noticeCard(
      '收到 1 条晚到消息',
      `- 09:00：${'长'.repeat(100)}\n\n回「执行」…`,
      'orange',
    )
    expect((long.config as { summary: { content: string } }).summary.content).toHaveLength(60)
  })

  it('审批结果卡：已批准绿 / 已拒绝红带理由；已在电脑上处理灰保留命令；已失效灰纯文字', () => {
    const ok = approvalResolvedCard(approval, 'allow', undefined)
    expect((ok.header as { template: string }).template).toBe('green')
    expect((ok.header as { title: { content: string } }).title.content).toContain('已批准')
    expect(JSON.stringify(ok)).not.toContain('"form"')
    const denied = approvalResolvedCard(approval, 'deny', '太危险了')
    expect((denied.header as { template: string }).template).toBe('red')
    expect((denied.header as { title: { content: string } }).title.content).toContain(
      '已拒绝：太危险了',
    )
    const taken = approvalTakenCard(approval)
    expect((taken.header as { template: string }).template).toBe('grey')
    expect(JSON.stringify(taken)).toContain('grep -rn x ~/外部')
    const stale = approvalStaleCard()
    expect((stale.header as { template: string }).template).toBe('grey')
    expect((stale.header as { title: { content: string } }).title.content).toContain(
      '已失效：网关重启过',
    )
  })
})

describe('卡片点击解析（§15.2 实测形状）', () => {
  const fixture = (name: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(join(__dirname, 'fixtures', name), 'utf8').split('\n')[0] ?? '{}',
    ) as Record<string, unknown>

  it('form 提交（20:58 实测）：action_name 判 allow/deny、form_value.reason 取理由、无 action_value', () => {
    const c = parseCardAction(fixture('card-form.ndjson'))
    expect(c).not.toBeNull()
    expect(c?.action).toEqual({ kind: 'approval', act: 'deny', reason: '测试理由' })
    expect(c?.token).toBe('c-TOKEN-MASKED')
    expect(c?.messageId).toBe('om_x100b60f0b8dc78acde6fb883959dc4f')
  })

  it('独立按钮（20:53 实测样本卡）：字段齐全但 act 非 to → null（设计的审批卡走 form，不走这形状）', () => {
    const c = parseCardAction(fixture('card-cb.ndjson'))
    expect(c).toBeNull()
  })

  it('列表「切换」按钮（构造）：action_value JSON 串 → {act to, folder, owner}', () => {
    const c = parseCardAction({
      type: 'card.action.trigger',
      event_id: 'cb_1',
      timestamp: '1794920000241580',
      operator_id: 'ou_user',
      message_id: 'om_list',
      chat_id: 'oc_chat',
      token: 'c-t',
      action_tag: 'button',
      action_value: JSON.stringify({ act: 'to', folder: '/w/a', owner: 'task-2' }),
    })
    expect(c?.action).toEqual({ kind: 'to', folder: '/w/a', owner: 'task-2' })
  })

  it('坏形状：缺 token / form_value 坏 JSON 当没填理由', () => {
    expect(
      parseCardAction({
        type: 'card.action.trigger',
        event_id: 'x',
        operator_id: 'o',
        chat_id: 'c',
        message_id: 'm',
        action_name: 'allow',
      }),
    ).toBeNull()
    const c = parseCardAction({
      type: 'card.action.trigger',
      event_id: 'x2',
      operator_id: 'o',
      chat_id: 'c',
      message_id: 'm',
      token: 't',
      action_name: 'deny',
      form_value: '{oops',
    })
    expect(c?.action).toEqual({ kind: 'approval', act: 'deny', reason: undefined })
  })

  it('cardUpdateData：{token, card}（--data @临时文件的内容）', () => {
    expect(cardUpdateData('c-t', { schema: '2.0' })).toEqual({
      token: 'c-t',
      card: { schema: '2.0' },
    })
  })
})
