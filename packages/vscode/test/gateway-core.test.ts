import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approvalMessage,
  createDedup,
  deliveryLine,
  eventToMsg,
  type FeishuMsg,
  gatewayStateFile,
  historyEntryToMsg,
  isFromUser,
  isLate,
  lateConfirmParts,
  looksLikeApprovalReply,
  parseApprovalReply,
  parseCommand,
  readPushOn,
  replyTargetOf,
  stateText,
  turnEndMessage,
  writePushOn,
} from '../src/gateway-core.ts'
import type { RobotItem, RobotTask } from '../src/robot-feed.ts'

// 2026-11-17 第 0 期存档的真实事件（.simple-code/tmp/lark-ev-redeliver.ndjson）：
// 补投的 hi。字段形态以它为准——手写 fixture 想不到的切法才是坑（CLAUDE §6.2）
const REAL_EVENT = {
  type: 'im.message.receive_v1',
  event_id: '50b8b185b90deed1450555acf32e0d94',
  timestamp: '1794881239111',
  id: 'om_x100b608f23ab0880de6b2ca9455d3ef',
  message_id: 'om_x100b608f23ab0880de6b2ca9455d3ef',
  create_time: '1794881238573',
  chat_id: 'oc_d4945b82bc20bacd27c1d081e8744aff',
  chat_type: 'p2p',
  message_type: 'text',
  sender_id: 'ou_b838587e53692159d71f74db54247a4d',
  sender_type: 'user',
  content: 'hi',
}

// 同日 chat-messages-list 的真实条目（second，2026-11-17 10:18 本地）
const REAL_HISTORY = {
  chat_id: 'oc_d4945b82bc20bacd27c1d081e8744aff',
  content: 'second',
  create_time: '2026-11-17 10:18',
  deleted: false,
  message_id: 'om_x100b608fdb6b4ca4c0e6d11427d4a49',
  message_position: '1',
  msg_type: 'text',
  sender: {
    id: 'ou_b838587e53692159d71f74db54247a4d',
    id_type: 'open_id',
    sender_type: 'user',
  },
  updated: false,
}

describe('事件与补读条目解析', () => {
  it('真实事件：字段齐全，create_time 原样进 at', () => {
    const m = eventToMsg(REAL_EVENT)
    expect(m).toEqual({
      chat: 'oc_d4945b82bc20bacd27c1d081e8744aff',
      from: 'ou_b838587e53692159d71f74db54247a4d',
      id: 'om_x100b608f23ab0880de6b2ca9455d3ef',
      text: 'hi',
      at: 1794881238573,
    })
  })

  it('带 reply_to 的事件进 replyTo；replyTargetOf 只认字符串', () => {
    expect(replyTargetOf({ reply_to: 'om_parent' })).toBe('om_parent')
    expect(replyTargetOf({ reply_to: 3 })).toBeUndefined()
    expect(replyTargetOf({})).toBeUndefined()
    expect(eventToMsg({ ...REAL_EVENT, reply_to: 'om_x' })?.replyTo).toBe('om_x')
  })

  it('补读条目：sender 嵌套、create_time 分钟精度解析为本地时刻', () => {
    const m = historyEntryToMsg(REAL_HISTORY)
    expect(m?.id).toBe('om_x100b608fdb6b4ca4c0e6d11427d4a49')
    expect(m?.from).toBe('ou_b838587e53692159d71f74db54247a4d')
    expect(m?.text).toBe('second')
    // 本地时区的 10:18，与 UTC epoch 无关（测试机时区不定，取时分断言）
    const d = new Date(m?.at ?? 0)
    expect([d.getHours(), d.getMinutes()]).toEqual([10, 18])
  })

  it('补读条目不带回复关系：没有 replyTo 字段就不猜', () => {
    expect(historyEntryToMsg(REAL_HISTORY)?.replyTo).toBeUndefined()
    expect(historyEntryToMsg({ ...REAL_HISTORY, create_time: '乱写' })).toBeNull()
    expect(historyEntryToMsg({ message_id: 'x' })).toBeNull()
  })

  it('缺字段的实时事件丢掉', () => {
    expect(eventToMsg({ ...REAL_EVENT, content: undefined })).toBeNull()
    expect(eventToMsg({ ...REAL_EVENT, create_time: 'abc' })).toBeNull()
  })
})

describe('身份与去重', () => {
  const cfg = { openId: 'ou_me', chatId: 'oc_chat' }
  const msg = (over: Partial<FeishuMsg> = {}): FeishuMsg => ({
    chat: 'oc_chat',
    from: 'ou_me',
    id: 'om_1',
    text: 'hi',
    at: Date.now(),
    ...over,
  })
  it('只认这个人这个单聊', () => {
    expect(isFromUser(msg(), cfg)).toBe(true)
    expect(isFromUser(msg({ from: 'ou_other' }), cfg)).toBe(false)
    expect(isFromUser(msg({ chat: 'oc_group' }), cfg)).toBe(false)
  })
  it('message_id 去重 + 容量淘汰', () => {
    const d = createDedup(2)
    d.add('a')
    d.add('b')
    expect(d.hit('a')).toBe(true) // add 过 = 见过（重投丢弃）
    d.add('c') // 容量 2：a 被淘汰
    expect(d.hit('a')).toBe(false)
    expect(d.hit('c')).toBe(true)
    d.add('b') // 命中时重插不淘汰
    expect(d.hit('b')).toBe(true)
  })
  it('晚到判定：2 分钟界', () => {
    const now = Date.now()
    expect(isLate(now - 3 * 60_000, now)).toBe(true)
    expect(isLate(now - 60_000, now)).toBe(false)
  })
})

describe('命令与审批回复', () => {
  it('命令全匹配', () => {
    expect(parseCommand('/列表')).toEqual({ type: 'list' })
    expect(parseCommand(' /停止 ')).toEqual({ type: 'stop' })
    expect(parseCommand('/状态')).toEqual({ type: 'status' })
    expect(parseCommand('/切换 3')).toEqual({ type: 'to', n: 3 })
    expect(parseCommand('/切换12')).toEqual({ type: 'to', n: 12 }) // 中文后不打空格
    expect(parseCommand('/切换列表')).toBeNull()
    expect(parseCommand('/切换 x')).toBeNull()
    // 20:09 统一中文：旧英文命令不再认，当普通话送进会话
    expect(parseCommand('/list')).toBeNull()
    expect(parseCommand('/to 3')).toBeNull()
    expect(parseCommand('/stop')).toBeNull()
    expect(parseCommand('跑一下测试')).toBeNull()
  })
  it('批 / 拒 / 拒 理由', () => {
    expect(parseApprovalReply('批')).toEqual({ act: 'allow' })
    expect(parseApprovalReply('拒')).toEqual({ act: 'deny', reason: undefined })
    expect(parseApprovalReply('拒 理由是x')).toEqual({ act: 'deny', reason: '理由是x' })
    expect(parseApprovalReply('批量生成')).toBeNull()
    expect(parseApprovalReply('拒绝加班')).toBeNull()
    expect(looksLikeApprovalReply('批')).toBe(true)
    expect(looksLikeApprovalReply('批量生成')).toBe(false)
  })
})

describe('推送开关（§5.6 显式开关，19:08 拍板）', () => {
  it('readPushOn：缺键/文件不存在/坏 JSON 都默认开；writePushOn 落盘往返', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-push-'))
    const f = join(dir, 'state.json')
    // 文件不存在 → 开
    expect(readPushOn(f)).toBe(true)
    // 缺键 → 开
    writeFileSync(f, '{"watermark":123}\n')
    expect(readPushOn(f)).toBe(true)
    // 坏 JSON → 开
    writeFileSync(f, '{oops')
    expect(readPushOn(f)).toBe(true)
    // 往返
    writePushOn(f, false)
    expect(readPushOn(f)).toBe(false)
    writePushOn(f, true)
    expect(readPushOn(f)).toBe(true)
    // 合并写不抹别的键（坏 JSON 阶段过去之后，正常内容里的键要保得住）
    writeFileSync(f, '{"watermark":123}\n')
    writePushOn(f, false)
    expect(JSON.parse(readFileSync(f, 'utf8')).watermark).toBe(123)
    expect(readPushOn(f)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
  it('gatewayStateFile：默认在 ~/.simple-code，SC_GATEWAY_HOME 可覆盖', () => {
    expect(gatewayStateFile()).toBe(join(homedir(), '.simple-code/gateway/state.json'))
    process.env.SC_GATEWAY_HOME = '/tmp/sc-gw-home'
    try {
      expect(gatewayStateFile()).toBe('/tmp/sc-gw-home/gateway/state.json')
    } finally {
      delete process.env.SC_GATEWAY_HOME
    }
  })
  it('/推送 开/关/查询三种形态；参数不合法当普通消息', () => {
    expect(parseCommand('/推送')).toEqual({ type: 'push', on: null })
    expect(parseCommand('/推送 开')).toEqual({ type: 'push', on: true })
    expect(parseCommand('/推送 关')).toEqual({ type: 'push', on: false })
    expect(parseCommand('/推送 1')).toBeNull()
    expect(parseCommand('/推送开')).toBeNull()
  })
})

describe('文案', () => {
  const task = (
    state: RobotTask['state'],
    since: string | null,
    task2: string | null = null,
  ): RobotTask => ({
    folder: '/Users/xx/Code/simple-code',
    task: task2,
    state,
    since,
  })
  it('状态与确认行', () => {
    expect(stateText(task('idle', null))).toBe('空闲')
    expect(stateText(task('waiting', null))).toBe('等审批')
    expect(stateText(task('running', new Date(Date.now() - 12 * 60_000).toISOString()))).toContain(
      '运行中 12 分钟',
    )
    expect(
      deliveryLine(task('running', new Date().toISOString()), '/Users/xx/Code/simple-code'),
    ).toBe(
      '→ simple-code 主任务（运行中 1 分钟，作为插话送达）', // max(1,…) 不显示 0 分钟
    )
    expect(deliveryLine(task('idle', null), '/Users/xx/Code/simple-code')).toBe(
      '→ simple-code 主任务（空闲，已开始）',
    )
    expect(deliveryLine(null, '/Users/xx/Code/simple-code')).toBe('→ simple-code 主任务')
  })
  it('审批消息：可批的带操作说明，ask_rule 只通知', () => {
    const a: Extract<RobotItem, { kind: 'approval' }> = {
      kind: 'approval',
      key: 'toolu_x',
      folder: '/Users/xx/Code/simple-code',
      task: null,
      command: 'grep -rn "x" ~/Code',
      reason: '项目外路径',
      expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
      canAllow: true,
      seen: false,
    }
    const lines = approvalMessage(a).split('\n')
    expect(lines[0]).toMatch(/^等你批准 · simple-code 主任务（\d\d:\d\d 前有效）$/)
    expect(lines[1]).toBe('grep -rn "x" ~/Code')
    expect(lines[3]).toBe('回复这条消息：批 / 拒 / 拒 理由')
    const askRule = approvalMessage({ ...a, canAllow: false })
    expect(askRule.split('\n')[0]).toMatch(
      /^需回电脑处理 · simple-code 主任务（\d\d:\d\d 前有效）$/,
    )
    expect(askRule).not.toContain('回复这条消息')
  })
  it('轮末推送：4000 字截断', () => {
    const d: Extract<RobotItem, { kind: 'done' | 'error' }> = {
      kind: 'done',
      key: 'k',
      folder: '/Users/xx/Code/simple-code',
      task: null,
      headline: 'h',
      detail: '',
      text: 'x'.repeat(5000),
      seen: false,
    }
    expect(turnEndMessage(d).startsWith('已完成 · simple-code 主任务\n')).toBe(true)
    expect(turnEndMessage(d)).toContain('（超出 4000 字，全文在面板）')
    const e: Extract<RobotItem, { kind: 'done' | 'error' }> = {
      kind: 'error',
      key: 'k',
      folder: '/Users/xx/Code/simple-code',
      task: '修复',
      headline: 'h',
      detail: '',
      text: '炸了',
      seen: false,
    }
    expect(turnEndMessage(e)).toBe('出错 · simple-code 修复\n炸了')
  })
  it('晚到确认文案：写明送到哪', () => {
    const { title, detail } = lateConfirmParts([{ ...REAL_EVENT_BYHand }], 'simple-code 主任务')
    expect(title).toBe('收到 1 条晚到消息')
    expect(detail).toContain('hi')
    expect(detail).toContain('回「执行」把它们送进「simple-code 主任务」')
  })
})

const REAL_EVENT_BYHand: FeishuMsg = {
  chat: 'oc_d4945b82bc20bacd27c1d081e8744aff',
  from: 'ou_b838587e53692159d71f74db54247a4d',
  id: 'om_x100b608f23ab0880de6b2ca9455d3ef',
  text: 'hi',
  at: Date.now() - 5 * 60_000,
}
