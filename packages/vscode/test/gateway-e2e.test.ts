import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writePushOn } from '../src/gateway-core.ts'
import { createFeishuAdapter } from '../src/gateway-feishu.ts'
import { createGatewayHub } from '../src/gateway-hub.ts'
import { type FromGateway, type GatewayStatus, parseFromGateway } from '../src/gateway-protocol.ts'
import { createGatewayServer } from '../src/gateway-serve.ts'

/**
 * 假 lark-cli + 真 unix socket 的集成测试（任务书验收 3）：网关的三个模块
 * （serve/hub/feishu）同进程组装——真进程冒烟（dist/gateway.js）另做。
 * 时序全部用轮询等（until），不用 fake timer——子进程与 socket 的真实
 * 行为 mock 不出来（CLAUDE.md §6.3）。
 */

// 默认 10s：全量并发跑时 spawn 假 lark-cli 满载会慢到 5s+（本机实测偶发），
// 单跑时各步都只花几十 ms，放宽只影响失败时的等待
const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等不到条件成立')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 假 lark-cli（node 脚本）：收事件轮询文件、发送记录文件、补读吐夹具 */
const FAKE_LARK = `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2).join(' ')
if (argv.includes('event consume')) {
  // FAKE_NO_CONNECTED=1：模拟 consume 挂到已活着的 lark-cli 总线 daemon
  //（真机 17:42：daemon 复用时不打 connected 行，connected 触发的补读不来）
  if (!process.env.FAKE_NO_CONNECTED) process.stderr.write('[source] feishu-websocket: connected\\n')
  // card.action.trigger 是第二个 consume（§15）：读卡片点击事件文件
  const SRC = argv.includes('card.action.trigger')
    ? process.env.FAKE_CARD_EVENTS_FILE
    : process.env.FAKE_EVENTS_FILE
  let offset = 0
  setInterval(() => {
    try {
      const st = fs.statSync(SRC)
      if (st.size > offset) {
        const fd = fs.openSync(SRC, 'r')
        const buf = Buffer.alloc(st.size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        offset += buf.length
        for (const line of buf.toString().split('\\n')) if (line.trim()) process.stdout.write(line + '\\n')
      }
    } catch {}
  }, 30)
} else if (argv.includes('messages-send')) {
  // §15：--msg-type interactive --content <json> 走卡片；FAKE_CARD_FAIL=1
  // 模拟卡片发送失败（hub 退回富文本的 fallback 路径）
  const mi = process.argv.indexOf('--msg-type')
  const ci = process.argv.indexOf('--content')
  const i = process.argv.indexOf('--markdown')
  if (mi >= 0 && ci >= 0) {
    if (process.env.FAKE_CARD_FAIL) process.exit(1)
    fs.appendFileSync(process.env.FAKE_SENT_FILE, JSON.stringify({ card: JSON.parse(process.argv[ci + 1]) }) + '\\n')
  } else {
    fs.appendFileSync(process.env.FAKE_SENT_FILE, JSON.stringify({ markdown: process.argv[i + 1] }) + '\\n')
  }
  const f = process.env.FAKE_SEQ_FILE
  const n = (parseInt(fs.readFileSync(f, 'utf8') || '0', 10) || 0) + 1
  fs.writeFileSync(f, String(n))
  process.stdout.write(JSON.stringify({ ok: true, data: { chat_id: 'oc_chat', message_id: 'om_fake_' + n } }) + '\\n')
} else if (argv.includes('/open-apis/interactive/v1/card/update')) {
  // §15：延迟更新。--data - 走 stdin；@文件受白名单限制（21:29 真机：
  // 只收 cwd、/tmp、~/files，os.tmpdir() 的 /var/folders 会被拒）
  const di = process.argv.indexOf('--data')
  const dv = process.argv[di + 1]
  let raw = ''
  if (dv === '-') {
    raw = fs.readFileSync(0, 'utf8')
  } else if (dv.startsWith('@')) {
    const f = dv.slice(1)
    const allowed =
      f.startsWith(process.cwd() + '/') || f.startsWith('/tmp/') ||
      f.startsWith(process.env.HOME + '/files/')
    if (!allowed) {
      process.stderr.write('--data: invalid file path "' + f + '": is outside the built-in allowlist')
      process.exit(1)
    }
    raw = fs.readFileSync(f, 'utf8')
  }
  fs.appendFileSync(process.env.FAKE_UPDATES_FILE, raw + '\\n')
  process.stdout.write(JSON.stringify({ ok: true, data: {} }) + '\\n')
} else if (argv.includes('chat-messages-list')) {
  try {
    process.stdout.write(fs.readFileSync(process.env.FAKE_HISTORY_FILE, 'utf8') + '\\n')
  } catch {
    process.stdout.write(JSON.stringify({ ok: true, data: { has_more: false, messages: [] } }) + '\\n')
  }
}`

const FOLDER = '/Users/xx/Code/simple-code'

type Rig = ReturnType<typeof setup>

function setup(opts?: {
  state?: string
  target?: { folder: string; owner: string }
  history?: Record<string, unknown>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'sc-gw-'))
  const files = {
    lark: join(dir, 'lark-cli'),
    events: join(dir, 'events.ndjson'),
    sent: join(dir, 'sent.ndjson'),
    seq: join(dir, 'seq'),
    history: join(dir, 'history.json'),
    sock: join(dir, 'gateway.sock'),
    state: opts?.state ?? join(dir, 'state.json'),
    cardEvents: join(dir, 'card-events.ndjson'),
    updates: join(dir, 'card-updates.ndjson'),
  }
  writeFileSync(files.lark, FAKE_LARK)
  chmodSync(files.lark, 0o755)
  writeFileSync(files.events, '')
  writeFileSync(files.cardEvents, '')
  writeFileSync(files.updates, '')
  writeFileSync(files.sent, '')
  writeFileSync(files.seq, '0')
  writeFileSync(
    files.history,
    JSON.stringify(opts?.history ?? { ok: true, data: { has_more: false, messages: [] } }),
  )

  // 假 lark-cli 靠这些 env 找文件（网关 spawn 它时 env 继承本进程）
  process.env.FAKE_EVENTS_FILE = files.events
  process.env.FAKE_CARD_EVENTS_FILE = files.cardEvents
  process.env.FAKE_UPDATES_FILE = files.updates
  process.env.FAKE_SENT_FILE = files.sent
  process.env.FAKE_SEQ_FILE = files.seq
  process.env.FAKE_HISTORY_FILE = files.history
  if (opts?.target !== undefined)
    writeFileSync(files.state, `${JSON.stringify({ target: opts.target })}\n`)

  const server = createGatewayServer({
    sockPath: files.sock,
    log: () => {},
    waitMs: 600,
    tickMs: 50,
  })
  const feishu = createFeishuAdapter({
    larkCli: files.lark,
    chatId: 'oc_chat',
    openId: 'ou_user',
    stateFile: files.state,
    onMessage: (m) => hub.onMessage(m),
    onCardAction: (c) => hub.onCardAction(c),
    log: () => {},
  })
  const hub = createGatewayHub({ server, feishu, stateFile: files.state, log: () => {} })
  server.onHub({
    onHello: () => {},
    onStatus: (pid, st) => hub.onStatus(pid, st),
    onAck: () => {},
    onGone: (pid) => hub.onGone(pid),
  })

  /** 手机收到的卡片与改卡记录（§15） */
  const cards = (): Array<Record<string, unknown>> => {
    try {
      return readFileSync(files.sent, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((j) => j.card !== undefined)
        .map((j) => j.card as Record<string, unknown>)
    } catch {
      return []
    }
  }
  /** 卡片内容的全文检索（断言用：header/body/按钮 value 都 stringify 在内） */
  const cardHas = (s: string): boolean => cards().some((c) => JSON.stringify(c).includes(s))
  /** 送达回执卡（11-18 起回执是卡片，标题「→ 任务名」），每张 stringify 成一条 */
  const receipts = (): string[] =>
    cards()
      .map((c) => JSON.stringify(c))
      .filter((s) => s.includes('"content":"→ '))

  const updates = (): Array<{ token: string; card: Record<string, unknown> }> => {
    try {
      return readFileSync(files.updates, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { token: string; card: Record<string, unknown> })
    } catch {
      return []
    }
  }

  /** 手机收到的（sent.ndjson） */
  const phone = (): string[] => {
    try {
      return readFileSync(files.sent, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { markdown?: string })
        .filter((j) => typeof j.markdown === 'string')
        .map((j) => j.markdown as string)
    } catch {
      return []
    }
  }
  /** 手机发的最后一条审批消息 id（om_fake_N）——回复绑定用 */
  /** 按内容找消息 id：sent 第 N 行 = om_fake_N（假 lark-cli 先写 sent 再写
   * seq，行号即序号）。不能读「最新 seq」——并发推送的子进程完成顺序不定，
   * 满载时慢的先落 seq，读到的是别人的 id（3g 偶发超时的根因：绑错卡，
   * 「批」走裸词拦截，永远等不到审批回执） */
  const idOf = (content: string): string => {
    // §15 后 sent 里混有卡片行（{card}）——按原始行全文匹配（markdown 或
    // 卡片 JSON.stringify 都含命令文本），seq 序号对 om_fake_N 的映射不变
    const msgs = readFileSync(files.sent, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
    let at = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.includes(content)) {
        at = i
        break
      }
    }
    if (at < 0) throw new Error(`sent 里没有含「${content}」的消息`)
    return `om_fake_${at + 1}`
  }

  /** 手机上看到的话：纯文字 + 每张卡的「标题\n正文 markdown」（11-18 起文字
   *  回复全是通知卡，标题\n正文 = 卡片失败时退回的文字） */
  const said = (): string[] => {
    const mds = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.flatMap(mds)
      if (v === null || typeof v !== 'object') return []
      const o = v as Record<string, unknown>
      const own = o.tag === 'markdown' && typeof o.content === 'string' ? [o.content] : []
      return [...own, ...Object.values(o).flatMap(mds)]
    }
    const flat = cards().map((c) => {
      const title = (c.header as { title?: { content?: string } } | undefined)?.title?.content
      return [title ?? '', ...mds(c.body)].join('\n')
    })
    return [...phone(), ...flat]
  }

  return { dir, files, server, feishu, hub, phone, idOf, cards, updates, cardHas, receipts, said }
}

/** 假窗口（真 socket）：发 hello/status，收四种下发；ack 策略可注入 */
function fakeWindow(sockPath: string) {
  const got: FromGateway[] = []
  let buf = ''
  const sock = net.createConnection(sockPath)
  /** 测试控制的 ack 策略：收到消息时回什么（默认全 ok） */
  let acker: (m: FromGateway) => { ok: boolean; reason?: string } | null = () => ({ ok: true })
  sock.setEncoding('utf8')
  sock.on('data', (d: string) => {
    buf += d
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const m = parseFromGateway(line)
      if (m === null) continue
      got.push(m)
      const a = acker(m)
      if (a !== null)
        sock.write(
          JSON.stringify({
            type: 'ack',
            ref: m.ref,
            ok: a.ok,
            ...(a.reason !== undefined ? { reason: a.reason } : {}),
          }) + '\n',
        )
    }
  })
  return {
    got,
    hello: (pid: number) =>
      sock.write(JSON.stringify({ type: 'hello', protocol: 1, pid, version: 'test' }) + '\n'),
    status: (st: GatewayStatus) => sock.write(JSON.stringify(st) + '\n'),
    ackWith: (fn: (m: FromGateway) => { ok: boolean; reason?: string } | null) => {
      acker = fn
    },
    close: () => sock.destroy(),
  }
}

const statusOf = (over: Partial<GatewayStatus> = {}): GatewayStatus => ({
  type: 'status',
  items: [],
  tasks: [{ folder: FOLDER, task: null, owner: '', state: 'idle', since: null }],
  showing: { folder: FOLDER, task: null },
  focused: true,
  ...over,
})

let evSeq = 0
const ev = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'im.message.receive_v1',
    message_id: `om_ev_${++evSeq}`,
    create_time: String(Date.now()),
    chat_id: 'oc_chat',
    chat_type: 'p2p',
    sender_id: 'ou_user',
    content: 'hi',
    ...over,
  })

let cbSeq = 0
/** 卡片点击事件（§15：真实形状照 .simple-code/tmp/card-cb.ndjson 与
 * card-form.ndjson——timestamp 16 位微秒、form 提交无 action_value） */
const cardClick = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'card.action.trigger',
    event_id: `cb_${++cbSeq}`,
    timestamp: String(Date.now() * 1000),
    operator_id: 'ou_user',
    message_id: 'om_unknown',
    chat_id: 'oc_chat',
    host: 'im_message',
    token: 'c-faketoken',
    action_tag: 'button',
    ...over,
  })

const rigs: Rig[] = []
const windoz: Array<ReturnType<typeof fakeWindow>> = []
afterEach(async () => {
  for (const w of windoz.splice(0)) w.close()
  for (const r of rigs.splice(0)) {
    r.feishu.stop()
    r.server.close()
  }
  // lark-cli 子进程是网关杀的，等一下再删目录（macOS 异步 unlink 会撞 EBUSY）
  await new Promise((r) => setTimeout(r, 150))
  for (const r of rigs.splice(0)) rmSync(r.dir, { recursive: true, force: true })
})

describe('收发与身份', () => {
  it('3a 用户单聊 → send 进窗口（〔feishu〕前缀），回确认行；别人的、群聊的丢弃', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(101)
    w.status(statusOf())

    appendFileSync(r.files.events, `${ev({ content: '把 bug 修了' })}\n`)
    await until(() => w.got.some((m) => m.type === 'send'))
    const sent = w.got.find((m) => m.type === 'send') as Extract<FromGateway, { type: 'send' }>
    expect(sent.text).toBe('〔feishu〕把 bug 修了')
    expect(sent.folder).toBe(FOLDER)
    expect(sent.owner).toBe('')
    await until(() => r.receipts().some((t) => t.includes('→ simple-code 主任务')))
    expect(r.receipts()[0]).toContain('已开始')

    // 别人发的：丢弃（窗口无 send、手机无回话）
    const before = w.got.length
    appendFileSync(r.files.events, `${ev({ sender_id: 'ou_other', content: 'x' })}\n`)
    // 群聊：别的 chat
    appendFileSync(r.files.events, `${ev({ chat_id: 'oc_group', content: 'x' })}\n`)
    await new Promise((res) => setTimeout(res, 400))
    expect(w.got.length).toBe(before)
  })

  it('3b 同一 message_id 第二次（重投/补读重叠）丢弃', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf())
    const line = ev({ content: '只发一次' })
    appendFileSync(r.files.events, `${line}\n`)
    await until(() => w.got.some((m) => m.type === 'send'))
    appendFileSync(r.files.events, `${line}\n`) // 同一条重投
    await new Promise((res) => setTimeout(res, 400))
    expect(w.got.filter((m) => m.type === 'send')).toHaveLength(1)
  })
})

describe('晚到确认', () => {
  it('3c 晚于 2 分钟先确认，「执行」才送进会话；别的话丢弃它们', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf())

    const late = ev({ content: '跑一下全量测试', create_time: String(Date.now() - 5 * 60_000) })
    appendFileSync(r.files.events, `${late}\n`)
    await until(() => r.said().some((t) => t.includes('晚到消息')))
    expect(w.got.filter((m) => m.type === 'send')).toHaveLength(0) // 没直接进会话
    expect(r.said().find((t) => t.includes('晚到'))).toContain('跑一下全量测试')

    appendFileSync(r.files.events, `${ev({ content: '执行' })}\n`)
    await until(() => w.got.some((m) => m.type === 'send'))
    expect(
      (w.got.find((m) => m.type === 'send') as Extract<FromGateway, { type: 'send' }>).text,
    ).toBe('〔feishu〕跑一下全量测试')

    // 再来一条晚到的，然后说别的话 → 丢弃
    appendFileSync(
      r.files.events,
      `${ev({ content: '第二条', create_time: String(Date.now() - 3 * 60_000) })}\n`,
    )
    await until(() => r.said().filter((t) => t.includes('晚到消息')).length >= 2)
    appendFileSync(r.files.events, `${ev({ content: '算了' })}\n`)
    await until(() => r.said().some((t) => t.includes('已丢弃 1 条')))
    const sends = w.got.filter((m) => m.type === 'send').length
    await new Promise((res) => setTimeout(res, 300))
    // 「算了」是普通消息照常进会话，「第二条」没进
    expect(w.got.filter((m) => m.type === 'send')).toHaveLength(sends)
  })
})

describe('补读', () => {
  it('3d connected 后补读：只取水位线后、发送人是用户的；首次启动不补历史', {
    timeout: 30000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf())

    // 首次启动已把水位线设成 now：history 里放一条更早的 → 不补
    writeFileSync(
      r.files.history,
      JSON.stringify({
        ok: true,
        data: {
          has_more: false,
          messages: [
            {
              chat_id: 'oc_chat',
              content: '旧消息',
              create_time: '2026-11-17 09:00',
              message_id: 'om_h_old',
              sender: { id: 'ou_user', sender_type: 'user' },
            },
          ],
        },
      }),
    )
    await new Promise((res) => setTimeout(res, 500))
    expect(w.got.filter((m) => m.type === 'send')).toHaveLength(0)

    // 先来一条实时消息把水位线拉到「刚才」（首启把水位线设在本分钟末，
    // 同分钟的历史本来就该排除——「不补历史」的另一面）。之后补读当前
    // 分钟的新消息才能进来，这才是真实场景（跑了一阵 → 断线 → 补读）
    appendFileSync(r.files.events, `${ev({ content: '在线' })}\n`)
    await until(() => w.got.some((m) => m.type === 'send' && m.text.includes('在线')))

    // 新消息（水位线之后、用户发的）经补读进来
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    writeFileSync(
      r.files.history,
      JSON.stringify({
        ok: true,
        data: {
          has_more: false,
          messages: [
            {
              chat_id: 'oc_chat',
              content: '补读进来的',
              create_time: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${hh}:${mm}`,
              message_id: 'om_h_new',
              sender: { id: 'ou_user', sender_type: 'user' },
            },
            {
              chat_id: 'oc_chat',
              content: '别人补读的',
              create_time: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${hh}:${mm}`,
              message_id: 'om_h_other',
              sender: { id: 'ou_other', sender_type: 'user' },
            },
          ],
        },
      }),
    )
    // 触发一次 connected（重启 lark-cli 子进程做不到——直接看水位线过滤逻辑：
    // 造一个「网关重启」的 rig 太重。改为验证：feishu 适配器还在跑时 connected
    // 只出现一次。这里用 stop+重建适配器模拟重启）
    r.feishu.stop()
    const feishu2 = createFeishuAdapter({
      larkCli: r.files.lark,
      chatId: 'oc_chat',
      openId: 'ou_user',
      stateFile: r.files.state,
      onCardAction: () => {},
      onMessage: (m) => r.hub.onMessage(m),
      log: () => {},
    })
    rigs.push({ ...r, feishu: feishu2 }) // afterEach 杀新的
    await until(() => w.got.some((m) => m.type === 'send' && m.text.includes('补读进来的')), 8000)
    expect(w.got.some((m) => m.type === 'send' && m.text.includes('别人补读的'))).toBe(false)
    expect(w.got.some((m) => m.type === 'send' && m.text.includes('旧消息'))).toBe(false)
  })
})

describe('推送开关与轮末推送', () => {
  it('3e 显式推送开关（19:08 拍板）：默认开推轮末；/推送 关→不推且回执带提醒；/推送 开恢复；查询回状态', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)

    const done = (key: string, text: string): GatewayStatus['items'][number] => ({
      kind: 'done',
      key,
      folder: FOLDER,
      task: null,
      headline: 'h',
      detail: '',
      text,
      seen: false,
    })

    // 默认开：没人发过手机消息、电脑上没打过字，轮末照样推
    const d1 = done('k1', '第一轮的结论')
    w.status({ ...st, items: [d1] })
    await until(() => r.cardHas('第一轮的结论'))

    // 手机发话：回执正常（开着，无提醒）
    appendFileSync(r.files.events, `${ev({ content: 'hi' })}\n`)
    await until(() => r.receipts().some((t) => t.includes('已开始')))
    expect(r.receipts().some((t) => t.includes('推送关着'))).toBe(false)

    // /推送 关
    appendFileSync(r.files.events, `${ev({ content: '/推送 关' })}\n`)
    await until(() => r.said().some((t) => t.includes('推送已关')))
    // 11-18：命令回执是通知卡，不再发纯文字
    expect(r.cardHas('推送已关')).toBe(true)
    expect(r.phone().some((t) => t.includes('推送已关'))).toBe(false)

    // 关着：轮末不推
    const d2 = done('k2', '第二轮的结论')
    w.status({ ...st, items: [d1, d2] })
    await new Promise((res) => setTimeout(res, 400))
    expect(r.said().some((t) => t.includes('第二轮的结论'))).toBe(false)

    // 关着：手机发话照送进会话，回执带提醒
    appendFileSync(r.files.events, `${ev({ content: '还在吗' })}\n`)
    await until(() => w.got.some((m) => m.type === 'send' && m.text.includes('还在吗')))
    await until(() =>
      r.receipts().some((t) => t.includes('推送关着，结论不会推到手机；发 /推送 开 打开')),
    )

    // 查询
    appendFileSync(r.files.events, `${ev({ content: '/推送' })}\n`)
    await until(() => r.said().some((t) => t.startsWith('推送：关\n')))

    // /推送 开：恢复推
    appendFileSync(r.files.events, `${ev({ content: '/推送 开' })}\n`)
    await until(() => r.said().some((t) => t.includes('推送已开')))

    // 开回来之后：新一轮结束 → 推（k2 不补推——推送时机过了就是过了）
    const d3 = done('k3', '第三轮的结论')
    w.status({ ...st, items: [d1, d2, d3] })
    await until(() => r.cardHas('第三轮的结论'))
    expect(r.cards().some((c) => JSON.stringify(c).includes('第二轮的结论'))).toBe(false)
  })

  it('3m 开着时 seen=true（前台正看着）的条目也推；多份窗口 status 不关推送', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)

    const d1: GatewayStatus['items'][number] = {
      kind: 'done',
      key: 'km1',
      folder: FOLDER,
      task: null,
      headline: 'h',
      detail: '',
      text: '看着的那条',
      seen: true, // 前台正看着：照样推（不看 seen）
    }
    w.status({ ...st, items: [d1] })
    await until(() => r.cardHas('看着的那条'))

    // 模拟面板活动（手打后的 refresh 就是新 status）：不影响后续推送
    w.status({ ...st, items: [d1] })
    w.status({ ...st, items: [d1] })
    const d2 = { ...d1, key: 'km2', text: '活动之后的结论' }
    w.status({ ...st, items: [d1, d2] })
    await until(() => r.cardHas('活动之后的结论'))
    expect(r.cards().filter((c) => JSON.stringify(c).includes('看着的那条'))).toHaveLength(1)
  })

  it('3n 设置页直接写文件（模拟）不重启网关：push:false 立即不推，改回 true 立即推', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)

    // 设置页关掉：直接改 state.json（网关每次判断都从文件读）
    writePushOn(r.files.state, false)
    const d1: GatewayStatus['items'][number] = {
      kind: 'done',
      key: 'kn1',
      folder: FOLDER,
      task: null,
      headline: 'h',
      detail: '',
      text: '关掉之后的结论',
      seen: false,
    }
    w.status({ ...st, items: [d1] })
    await new Promise((res) => setTimeout(res, 400))
    expect(r.cards().some((c) => JSON.stringify(c).includes('关掉之后的的结果'))).toBe(false)

    // 设置页开回来：改回文件，不重启，立即恢复
    writePushOn(r.files.state, true)
    const d2 = { ...d1, key: 'kn2', text: '开回来的结论' }
    w.status({ ...st, items: [d1, d2] })
    await until(() => r.cardHas('开回来的结论'))
    expect(r.cards().some((c) => JSON.stringify(c).includes('关掉之后的结论'))).toBe(false)
  })

  it('3o 网关重启后不重推已推过的条目；停机期间完成的照常推（默认开暴露的重启坑）', async () => {
    // 网关 A：推过 k1
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    const d1: GatewayStatus['items'][number] = {
      kind: 'done',
      key: 'ko1',
      folder: FOLDER,
      task: null,
      headline: 'h',
      detail: '',
      text: '重启前的结论',
      seen: false,
    }
    w.status({ ...st, items: [d1] })
    await until(() => r.cardHas('重启前的结论'))

    // 同一份 state.json 起新网关（内存 knownKeys/pushedKeys 全空，只有
    // 持久化的 pushed 在）——等价于网关重启
    const r2 = setup({ state: r.files.state })
    rigs.push(r2)
    await r2.server.listen()
    const w2 = fakeWindow(r2.files.sock)
    windoz.push(w2)
    w2.hello(1)
    const st2 = statusOf()
    w2.status(st2)

    // 重启后第一份 status 带着存量 k1 + 停机期间完成的 k2：
    // k1 不重推，k2 照推
    const d2 = { ...d1, key: 'ko2', text: '停机期间的结论' }
    w2.status({ ...st2, items: [d1, d2] })
    await until(() => r2.cards().some((c) => JSON.stringify(c).includes('停机期间的结论')))
    expect(r2.cards().some((c) => JSON.stringify(c).includes('重启前的结论'))).toBe(false)
  })

  it('3p /列表 第一行显示推送状态', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf())

    appendFileSync(r.files.events, `${ev({ content: '/列表' })}\n`)
    await until(() => r.cardHas('推送：开'))

    appendFileSync(r.files.events, `${ev({ content: '/推送 关' })}\n`)
    await until(() => r.said().some((t) => t.includes('推送已关')))
    appendFileSync(r.files.events, `${ev({ content: '/列表' })}\n`)
    await until(() => r.cards().some((c) => JSON.stringify(c).includes('推送：关')))
  })
})

describe('网关命令', () => {
  it('3f /列表 列清单带编号与当前标记；/状态 只看当前；/切换 N 切换；/停止 停', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(
      statusOf({
        tasks: [
          {
            folder: FOLDER,
            task: null,
            owner: '',
            state: 'running',
            since: new Date(Date.now() - 12 * 60_000).toISOString(),
          },
          { folder: FOLDER, task: '修复', owner: 'task-1', state: 'waiting', since: null },
        ],
      }),
    )
    appendFileSync(r.files.events, `${ev({ content: '/列表' })}\n`)
    // §15：列表卡——每行「编号 名 状态」，当前行按钮换成禁用的「当前」
    await until(() => r.cardHas('任务列表'))
    await until(() => r.cardHas('**1** simple-code 主任务'))
    await until(() => r.cardHas('运行中 12 分钟'))
    await until(() => r.cardHas('**2** simple-code 修复'))
    await until(() => r.cardHas('等审批'))
    expect(r.cards().some((c) => JSON.stringify(c).includes('disabled'))).toBe(true)

    // /状态：没 /切换 过 → 默认目标；状态卡（§15）
    appendFileSync(r.files.events, `${ev({ content: '/状态' })}\n`)
    await until(() => r.cardHas('当前：simple-code 主任务'))
    await until(() => r.cardHas('运行中 12 分钟'))
    await until(() => r.cardHas('默认：跟着电脑焦点走'))
    await until(() => r.cardHas('推送：开'))

    appendFileSync(r.files.events, `${ev({ content: '/切换 2' })}\n`)
    await until(() => r.said().some((t) => t.includes('目标已切到')))
    expect(r.said().find((t) => t.includes('目标已切到'))).toContain('修复')
    appendFileSync(r.files.events, `${ev({ content: '/状态' })}\n`)
    await until(() => r.cardHas('当前：simple-code 修复'))
    await until(() => r.cardHas('等审批'))
    await until(() => r.cardHas('/切换 指定的'))

    appendFileSync(r.files.events, `${ev({ content: '/停止' })}\n`)
    await until(() => w.got.some((m) => m.type === 'stop'))
    const stop = w.got.find((m) => m.type === 'stop') as Extract<FromGateway, { type: 'stop' }>
    expect(stop.owner).toBe('task-1')
    await until(() => r.said().some((t) => t.startsWith('已停止\n')))
  })

  it('3h /切换 的目标写进 state.json，网关重启后仍有效（15:08 真机：重启丢目标、晚到重投落错处）', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(
      statusOf({
        tasks: [
          { folder: FOLDER, task: null, owner: '', state: 'idle', since: null },
          { folder: FOLDER, task: '修复', owner: 'task-1', state: 'idle', since: null },
        ],
      }),
    )
    appendFileSync(r.files.events, `${ev({ content: '/列表' })}\n`)
    await until(() => r.cardHas('当前'))
    appendFileSync(r.files.events, `${ev({ content: '/切换 2' })}\n`)
    await until(() => r.said().some((t) => t.includes('目标已切到')))

    // 目标落盘（与 watermark 同文件、互不抹）
    const st = JSON.parse(readFileSync(r.files.state, 'utf8')) as Record<string, unknown>
    expect(st.target).toEqual({ folder: FOLDER, owner: 'task-1' })
    expect(typeof st.watermark).toBe('number')

    // 模拟网关重启：同一个 stateFile 起新 hub，/切换 的目标还在
    const r2 = setup({ state: r.files.state })
    rigs.push(r2)
    await r2.server.listen()
    const w2 = fakeWindow(r2.files.sock)
    windoz.push(w2)
    w2.hello(1)
    w2.status(
      statusOf({
        tasks: [
          { folder: FOLDER, task: null, owner: '', state: 'idle', since: null },
          { folder: FOLDER, task: '修复', owner: 'task-1', state: 'idle', since: null },
        ],
      }),
    )
    appendFileSync(r2.files.events, `${ev({ content: '重启后这句应进「修复」' })}\n`)
    await until(() => w2.got.some((m) => m.type === 'send' && m.owner === 'task-1'))
    const sent = w2.got.find((m) => m.type === 'send' && m.owner === 'task-1') as Extract<
      FromGateway,
      { type: 'send' }
    >
    expect(sent.text).toBe('〔feishu〕重启后这句应进「修复」')
  })

  it('3i 目标窗口不在但别的在线：提示带恢复路径；窗口在但不响应是另一句；全不在线才是「SC 不在线」', {
    timeout: 20000,
  }, async () => {
    // /切换 持久化的目标指向已关的目录窗口：state.json 预置（绕开 /列表 的
    // 编号依赖——那是 3f 的职责），hub 创建时读回
    const r = setup({ target: { folder: '/w/b', owner: '' } })
    rigs.push(r)
    await r.server.listen()
    const wa = fakeWindow(r.files.sock)
    windoz.push(wa)
    wa.hello(1)
    wa.status(statusOf()) // FOLDER 的窗口在线（focused），目标 /w/b 没有窗口

    appendFileSync(r.files.events, `${ev({ content: '在吗' })}\n`)
    await until(() => r.said().some((t) => t.includes('没送达')))
    expect(r.said().find((t) => t.includes('没送达'))).toContain('/切换 换目标')

    // 窗口在但不回 ack（deliver 等满）：是「没响应」，不是「不在线」
    const wb = fakeWindow(r.files.sock)
    windoz.push(wb)
    wb.hello(2)
    wb.status(
      statusOf({
        showing: { folder: '/w/b', task: null },
        tasks: [{ folder: '/w/b', task: '乙', owner: 'task-b', state: 'idle', since: null }],
      }),
    )
    wb.ackWith(() => null) // 连上但不应答
    appendFileSync(r.files.events, `${ev({ content: '还在吗' })}\n`)
    await until(() => r.said().some((t) => t.includes('没响应')))
    wb.close()

    // 全部窗口都不在线：才是「SC 不在线」
    wa.close()
    appendFileSync(r.files.events, `${ev({ content: '人呢' })}\n`)
    await until(() => r.said().some((t) => t.includes('SC 不在线')))
  })

  it('3j 送达确认按 deliver 前快照：ack 前到的 running status 不把新轮报成插话（17:10 真机）', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf()) // 主任务 idle——手机消息送达前它确实是空闲的
    // 假窗口收到 send 先回一份 running 的 status 再 ack：模拟窗口侧
    // gatewaySend 立刻起轮、onRobotChange→refresh 的 status 抢在 ack 之前
    w.ackWith((m) => {
      if (m.type === 'send') {
        w.status(
          statusOf({
            tasks: [
              {
                folder: FOLDER,
                task: null,
                owner: '',
                state: 'running',
                since: new Date().toISOString(),
              },
            ],
          }),
        )
      }
      return { ok: true }
    })
    appendFileSync(r.files.events, `${ev({ content: '继续验收' })}\n`)
    await until(() => r.receipts().some((t) => t.includes('已开始')))
    const line = r.receipts().find((t) => t.includes('已开始'))
    expect(line).not.toContain('插话')
  })

  it('3k 已处理的 message_id 持久化：重启后补读捞回同一批不再送也不再问（16:45 真机）；「执行」带走的晚到消息一起记', async () => {
    // 第一段：送达成功的消息，id 落进 state.json 的 handled
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf())
    const first = ev({ content: '第一条' })
    appendFileSync(r.files.events, `${first}\n`)
    await until(() => w.got.some((m) => m.type === 'send'))
    await until(() => r.receipts().some((t) => t.includes('已开始')))
    await until(() => {
      const j = JSON.parse(readFileSync(r.files.state, 'utf8')) as { handled?: string[] }
      return (j.handled ?? []).includes(JSON.parse(first).message_id)
    })

    // 第二段：网关 B 用同一份 state.json，补读（history）返回同一批里——
    // 已处理的丢弃；未处理的（对照组）照常问晚到——证明是 dedup 挡的，
    // 不是补读路径坏了
    const min = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const stale = new Date(Date.now() - 3 * 60_000) // 补读条目只有分钟精度
    const old = new Date(Date.now() - 5 * 60_000) // 水位线：让两条都在回捞窗口内
    const hist = {
      ok: true,
      data: {
        has_more: false,
        messages: [
          {
            message_id: 'om_hist_done',
            chat_id: 'oc_chat',
            content: '已被处理的那条',
            create_time: min(stale),
            sender: { id: 'ou_user' },
          },
          {
            message_id: 'om_hist_new',
            chat_id: 'oc_chat',
            content: '没处理过的那条',
            create_time: min(stale),
            sender: { id: 'ou_user' },
          },
        ],
      },
    }
    // state.json 必须在 hub 创建前就位（创建时预热 dedup）——先写好再 setup
    const stateB = join(r.dir, 'state-b.json')
    writeFileSync(
      stateB,
      `${JSON.stringify({
        watermark: old.getTime(),
        handled: ['om_hist_done'],
      })}\n`,
    )
    const r2 = setup({ state: stateB, history: hist })
    rigs.push(r2)
    await r2.server.listen()
    const w2 = fakeWindow(r2.files.sock)
    windoz.push(w2)
    w2.hello(1)
    w2.status(statusOf())
    await until(() => r2.said().some((t) => t.includes('晚到消息')))
    // 对照：未处理的那条被问晚到（只有它）
    const confirm = r2.said().find((t) => t.includes('晚到消息'))
    expect(confirm).toContain('没处理过的那条')
    expect(confirm).not.toContain('已被处理的那条')
    // 已处理的那条没有送进会话
    expect(w2.got.filter((m) => m.type === 'send')).toHaveLength(0)

    // 第三段：手机回「执行」→ 未处理那条送走，晚到消息的 id 也进 handled
    const midExec = ev({ content: '执行' })
    appendFileSync(r2.files.events, `${midExec}\n`)
    await until(() => w2.got.some((m) => m.type === 'send' && m.text.includes('没处理过')))
    await until(() => {
      const j = JSON.parse(readFileSync(r2.files.state, 'utf8')) as { handled?: string[] }
      return (
        (j.handled ?? []).includes('om_hist_new') &&
        (j.handled ?? []).includes(JSON.parse(midExec).message_id)
      )
    })
  })

  it('3l consume 不打 connected 行（总线 daemon 复用）也照样补读：启动即无条件补读（17:42 真机）', async () => {
    // 假 lark-cli 不打 connected；state 预置水位线在 5 分钟前，history 里放
    // 一条水位线之后、晚到阈值（2 分钟）内的消息——只有「启动即补读」才
    // 捞得到它，且不触发晚到确认、直接送进会话
    const min = (d: Date): string =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const stale = new Date(Date.now() - 30_000)
    const hist = {
      ok: true,
      data: {
        has_more: false,
        messages: [
          {
            message_id: 'om_hist_unconditional',
            chat_id: 'oc_chat',
            content: '网关停着时手机发的',
            create_time: min(stale),
            sender: { id: 'ou_user' },
          },
        ],
      },
    }
    const stateFile = join(tmpdir(), `sc-gw-state-${Date.now()}.json`)
    writeFileSync(
      stateFile,
      `${JSON.stringify({ watermark: new Date(Date.now() - 5 * 60_000).getTime() })}\n`,
    )
    process.env.FAKE_NO_CONNECTED = '1'
    try {
      const r = setup({ state: stateFile, history: hist })
      rigs.push(r)
      await r.server.listen()
      const w = fakeWindow(r.files.sock)
      windoz.push(w)
      w.hello(1)
      w.status(statusOf())
      // 不写任何实时事件：送进来的只能来自补读
      await until(() =>
        w.got.some((m) => m.type === 'send' && m.text.includes('网关停着时手机发的')),
      )
    } finally {
      delete process.env.FAKE_NO_CONNECTED
    }
  })
})
describe('长按回复送回原任务（11-18）', () => {
  it('3l 回复完成卡 → 送进卡所属任务、当前目标不变；回复回执同样认；不认识的回复走当前目标；网关重启后旧卡照样认', async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf({
      tasks: [
        { folder: FOLDER, task: null, owner: '', state: 'idle', since: null },
        { folder: FOLDER, task: '网关任务', owner: 'task-gw', state: 'done', since: null },
      ],
    })
    w.status(st)
    const d: GatewayStatus['items'][number] = {
      kind: 'done',
      key: 'kr1',
      folder: FOLDER,
      task: '网关任务',
      owner: 'task-gw',
      headline: 'h',
      detail: '',
      text: '网关任务的结论',
      seen: false,
    }
    w.status({ ...st, items: [d] })
    await until(() => r.cardHas('网关任务的结论'))
    const sends = (got: FromGateway[]) =>
      got.filter((m): m is Extract<FromGateway, { type: 'send' }> => m.type === 'send')
    // message_id → 任务在 send 返回后才记（state.json 落盘为准）
    const recorded = (id: string) => readFileSync(r.files.state, 'utf8').includes(`"${id}"`)
    const mid = r.idOf('网关任务的结论')
    await until(() => recorded(mid))

    // 回复完成卡 → task-gw，回执写「按回复送达」
    appendFileSync(r.files.events, `${ev({ content: '接着改', reply_to: mid })}\n`)
    await until(() => sends(w.got).length === 1)
    expect(sends(w.got)[0]?.owner).toBe('task-gw')
    await until(() => r.receipts().some((t) => t.includes('按回复送达')))
    expect(r.receipts().find((t) => t.includes('按回复送达'))).toContain('→ simple-code 网关任务')

    // 不回复直接发 → 当前目标（主任务）没被改
    appendFileSync(r.files.events, `${ev({ content: '普通一句' })}\n`)
    await until(() => sends(w.got).length === 2)
    expect(sends(w.got)[1]?.owner).toBe('')

    // 回复「按回复送达」那张回执 → 还是 task-gw
    const rid = r.idOf('按回复送达')
    await until(() => recorded(rid))
    appendFileSync(r.files.events, `${ev({ content: '回复回执', reply_to: rid })}\n`)
    await until(() => sends(w.got).length === 3)
    expect(sends(w.got)[2]?.owner).toBe('task-gw')

    // 回复不认识的消息（列表卡、自己的话）→ 当前目标
    appendFileSync(r.files.events, `${ev({ content: '回复别的', reply_to: 'om_unknown' })}\n`)
    await until(() => sends(w.got).length === 4)
    expect(sends(w.got)[3]?.owner).toBe('')

    // 同一份 state.json 起新网关（= 重启）：回复重启前的完成卡照样送 task-gw
    const r2 = setup({ state: r.files.state })
    rigs.push(r2)
    await r2.server.listen()
    const w2 = fakeWindow(r2.files.sock)
    windoz.push(w2)
    w2.hello(1)
    w2.status(st)
    appendFileSync(r2.files.events, `${ev({ content: '重启后回复', reply_to: mid })}\n`)
    await until(() => sends(w2.got).length === 1)
    expect(sends(w2.got)[0]?.owner).toBe('task-gw')
  })
})

describe('审批（第 2 期 A1）', () => {
  it('3g 推卡、回复批/拒带理由；ask_rule 只通知；面板先答回「卡已处理」；裸「批」不算数', {
    timeout: 30000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)

    // 手机先发话开推送
    appendFileSync(r.files.events, `${ev({ content: 'hi' })}\n`)
    await until(() => r.receipts().length > 0)

    // 弹一张可批的卡
    const approval: GatewayStatus['items'][number] = {
      kind: 'approval',
      key: 'toolu_1',
      folder: FOLDER,
      task: null,
      command: 'grep -rn x ~/Code/claude-code-main/src',
      reason: '项目外路径',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      canAllow: true,
      seen: false,
    }
    w.status({ ...st, items: [approval] })
    // §15：审批卡（form + 批准/拒绝按钮 + 底部小字）
    await until(() => r.cardHas('等你批准'))
    await until(() => r.cardHas('拒绝理由（可不填）'))
    await until(() => r.cardHas('也可长按回复：批 / 拒 / 拒 理由'))
    const mid = r.idOf('grep -rn x ~/Code/claude-code-main/src')
    await until(() => r.hub.hasApprovalBinding(mid))

    // 回复「批」→ allow 到窗口
    appendFileSync(r.files.events, `${ev({ content: '批', reply_to: mid })}\n`)
    await until(() => w.got.some((m) => m.type === 'allow'))
    expect(
      (w.got.find((m) => m.type === 'allow') as Extract<FromGateway, { type: 'allow' }>).key,
    ).toBe('toolu_1')
    await until(() => r.said().some((t) => t.startsWith('已批准')))

    // 回复「拒 理由」→ deny 带理由
    const approval2 = { ...approval, key: 'toolu_2', command: 'grep -rn y ~/外部一' }
    w.status({ ...st, items: [approval2] })
    await until(() => r.cards().filter((c) => JSON.stringify(c).includes('等你批准')).length >= 2)
    const mid2 = r.idOf('grep -rn y ~/外部一')
    await until(() => r.hub.hasApprovalBinding(mid2))
    appendFileSync(r.files.events, `${ev({ content: '拒 太危险了', reply_to: mid2 })}\n`)
    await until(() => w.got.some((m) => m.type === 'deny'))
    const deny = w.got.find((m) => m.type === 'deny') as Extract<FromGateway, { type: 'deny' }>
    expect(deny.key).toBe('toolu_2')
    expect(deny.reason).toBe('太危险了')
    await until(() => r.said().some((t) => t.startsWith('已拒绝：太危险了')))

    // ask_rule：只推「需回电脑处理」，回复无效
    const askRule = {
      ...approval,
      key: 'toolu_3',
      canAllow: false,
      command: 'git push origin local',
    }
    w.status({ ...st, items: [askRule] })
    await until(() => r.cardHas('需回电脑处理'))
    // ask_rule 卡（§15.3）：无 form 无按钮，只有「安全规则不允许远程批」小字
    const askRuleCard = r.cards().find((c) => JSON.stringify(c).includes('需回电脑处理'))
    expect(JSON.stringify(askRuleCard)).not.toContain('"form"')
    expect(JSON.stringify(askRuleCard)).toContain('安全规则不允许远程批')
    const mid3 = r.idOf('git push origin local')
    await until(() => r.hub.hasApprovalBinding(mid3))
    const sendsBefore = w.got.filter((m) => m.type === 'send').length
    appendFileSync(r.files.events, `${ev({ content: '批', reply_to: mid3 })}\n`)
    await until(() => r.said().some((t) => t.includes('安全规则不允许远程批')))
    expect(w.got.filter((m) => m.type === 'send')).toHaveLength(sendsBefore) // 没进会话

    // 面板先答复：窗口回 ok:false → 手机收到「卡已处理」
    const approval4 = { ...approval, key: 'toolu_4', command: 'grep -rn w ~/外部三' }
    w.status({ ...st, items: [approval4] })
    await until(() => r.cards().filter((c) => JSON.stringify(c).includes('等你批准')).length >= 3)
    const mid4 = r.idOf('grep -rn w ~/外部三')
    await until(() => r.hub.hasApprovalBinding(mid4))
    w.ackWith((m) => (m.type === 'allow' ? { ok: false, reason: '卡已处理' } : { ok: true }))
    appendFileSync(r.files.events, `${ev({ content: '批', reply_to: mid4 })}\n`)
    await until(() => r.said().some((t) => t.startsWith('卡已处理\n')))

    // 不是回复审批消息的「批」不算数：回提示、不进会话
    const before = w.got.filter((m) => m.type === 'send').length
    appendFileSync(r.files.events, `${ev({ content: '批' })}\n`)
    await until(() => r.said().some((t) => t.includes('没有对应到审批卡')))
    expect(w.got.filter((m) => m.type === 'send')).toHaveLength(before)
  })
})

describe('卡片点击（§15）', () => {
  const approvalItem = (key: string, command: string): GatewayStatus['items'][number] => ({
    kind: 'approval',
    key,
    folder: FOLDER,
    task: null,
    command,
    reason: '项目外路径',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    canAllow: true,
    seen: false,
  })

  it('4a 审批卡点「批准」按钮：form 提交（action_name，无 action_value）→ allow 到窗口 → 改卡「已批准」', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    w.status({ ...st, items: [approvalItem('toolu_a', 'grep -rn a ~/外部一')] })
    await until(() => r.cardHas('grep -rn a ~/外部一'))
    const mid = r.idOf('grep -rn a ~/外部一')
    await until(() => r.hub.hasApprovalBinding(mid))
    appendFileSync(
      r.files.cardEvents,
      `${cardClick({ message_id: mid, action_name: 'allow', form_value: JSON.stringify({ reason: '' }) })}\n`,
    )
    await until(() => w.got.some((m) => m.type === 'allow'))
    expect(
      (w.got.find((m) => m.type === 'allow') as Extract<FromGateway, { type: 'allow' }>).key,
    ).toBe('toolu_a')
    // 改卡（§15.3：改卡成功不再另推文字）
    await until(() => r.updates().some((u) => u.token === 'c-faketoken'))
    expect(JSON.stringify(r.updates().find((u) => u.token === 'c-faketoken')?.card)).toContain(
      '已批准',
    )
    await new Promise((res) => setTimeout(res, 300))
    expect(r.said().some((t) => t.startsWith('已批准'))).toBe(false)
  })

  it('4b 审批卡点「拒绝」按钮带理由：form_value.reason → deny 带理由 → 改卡「已拒绝：理由」', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    w.status({ ...st, items: [approvalItem('toolu_b', 'grep -rn b ~/外部二')] })
    await until(() => r.cardHas('grep -rn b ~/外部二'))
    const mid = r.idOf('grep -rn b ~/外部二')
    await until(() => r.hub.hasApprovalBinding(mid))
    appendFileSync(
      r.files.cardEvents,
      `${cardClick({ message_id: mid, action_name: 'deny', form_value: JSON.stringify({ reason: '太危险了' }) })}\n`,
    )
    await until(() => w.got.some((m) => m.type === 'deny'))
    const deny = w.got.find((m) => m.type === 'deny') as Extract<FromGateway, { type: 'deny' }>
    expect(deny.key).toBe('toolu_b')
    expect(deny.reason).toBe('太危险了')
    await until(() => r.updates().some((u) => JSON.stringify(u.card).includes('已拒绝：太危险了')))
  })

  it('4c 网关重启后点旧卡（approvalBy 在内存）：改卡「已失效：网关重启过」', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    w.status({ ...st, items: [approvalItem('toolu_c', 'grep -rn c ~/外部三')] })
    await until(() => r.cardHas('grep -rn c ~/外部三'))
    const mid = r.idOf('grep -rn c ~/外部三')
    await until(() => r.hub.hasApprovalBinding(mid))
    // 同 state 起新网关（内存 approvalBy 空）
    const r2 = setup({ state: r.files.state })
    rigs.push(r2)
    await r2.server.listen()
    const w2 = fakeWindow(r2.files.sock)
    windoz.push(w2)
    w2.hello(1)
    w2.status(statusOf())
    appendFileSync(r2.files.cardEvents, `${cardClick({ message_id: mid, action_name: 'allow' })}\n`)
    await until(() =>
      r2.updates().some((u) => JSON.stringify(u.card).includes('已失效：网关重启过')),
    )
    expect(w2.got.some((m) => m.type === 'allow' || m.type === 'deny')).toBe(false)
  })

  it('4d 列表卡点「切换」：value 带 folder/owner → 切换落盘 → 用最新 status 重建列表卡改卡', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(
      statusOf({
        tasks: [
          { folder: FOLDER, task: null, owner: '', state: 'idle', since: null },
          { folder: FOLDER, task: '修复', owner: 'task-9', state: 'waiting', since: null },
        ],
      }),
    )
    appendFileSync(r.files.events, `${ev({ content: '/列表' })}\n`)
    await until(() => r.cardHas('**2** simple-code 修复'))
    appendFileSync(
      r.files.cardEvents,
      `${cardClick({ message_id: 'om_list_1', action_value: JSON.stringify({ act: 'to', folder: FOLDER, owner: 'task-9' }) })}\n`,
    )
    await until(() => {
      const j = JSON.parse(readFileSync(r.files.state, 'utf8')) as { target?: { owner?: string } }
      return j.target?.owner === 'task-9'
    })
    // 重建的列表卡（改卡）：第 2 行成了当前行（disabled）
    await until(() => r.updates().some((u) => JSON.stringify(u.card).includes('任务列表')))
    const rebuilt = r.updates().find((u) => JSON.stringify(u.card).includes('任务列表'))?.card
    expect(JSON.stringify(rebuilt)).toContain('disabled')
  })

  it('4e 列表点了已不在的任务：推文字「这个任务已不在了」，不改卡', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    w.status(statusOf())
    appendFileSync(
      r.files.cardEvents,
      `${cardClick({ action_value: JSON.stringify({ act: 'to', folder: FOLDER, owner: 'task-gone' }) })}\n`,
    )
    await until(() => r.said().some((t) => t.startsWith('这个任务已不在了\n')))
    await new Promise((res) => setTimeout(res, 300))
    expect(r.updates().length).toBe(0)
  })

  it('4f 卡片发送失败退回富文本：推送永不因卡片失败而丢（§15.3）', { timeout: 20000 }, async () => {
    process.env.FAKE_CARD_FAIL = '1'
    try {
      const r = setup()
      rigs.push(r)
      await r.server.listen()
      const w = fakeWindow(r.files.sock)
      windoz.push(w)
      w.hello(1)
      const st = statusOf()
      w.status(st)
      w.status({ ...st, items: [approvalItem('toolu_f', 'grep -rn f ~/外部六')] })
      // 卡片失败 → 富文本（approvalMessage：含「等你批准」与命令）
      await until(() =>
        r.phone().some((t) => t.includes('等你批准') && t.includes('grep -rn f ~/外部六')),
      )
      // 绑定照样可用（长按回复路径不受影响）
      const mid = r.idOf('grep -rn f ~/外部六')
      await until(() => r.hub.hasApprovalBinding(mid))
    } finally {
      delete process.env.FAKE_CARD_FAIL
    }
  })

  it('4h 点击时电脑上先处理了（ack.ok=false，用户选 2A）：卡改「已在电脑上处理」，不改成已批准', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    w.status({ ...st, items: [approvalItem('toolu_h', 'grep -rn h ~/外部八')] })
    await until(() => r.cardHas('grep -rn h ~/外部八'))
    const mid = r.idOf('grep -rn h ~/外部八')
    await until(() => r.hub.hasApprovalBinding(mid))
    // 窗口对 allow 回 ok:false（面板已处理）
    w.ackWith((m) => (m.type === 'allow' ? { ok: false, reason: '卡已处理' } : { ok: true }))
    appendFileSync(r.files.cardEvents, `${cardClick({ message_id: mid, action_name: 'allow' })}\n`)
    await until(() => r.updates().some((u) => JSON.stringify(u.card).includes('已在电脑上处理')))
    // 不是「已批准」（主任务的变异就是把它换成了 resolved allow）
    expect(r.updates().some((u) => JSON.stringify(u.card).includes('已批准'))).toBe(false)
    expect(r.said().some((t) => t.startsWith('已批准'))).toBe(false)
  })

  it('4i 点击时窗口不在线（ack=null）：卡不改（按钮留着可重试）、推三态文字', {
    timeout: 20000,
  }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    w.status({ ...st, items: [approvalItem('toolu_i', 'grep -rn i ~/外部九')] })
    await until(() => r.cardHas('grep -rn i ~/外部九'))
    const mid = r.idOf('grep -rn i ~/外部九')
    await until(() => r.hub.hasApprovalBinding(mid))
    w.close() // 窗口断开：deliver 等满超时回 null
    appendFileSync(r.files.cardEvents, `${cardClick({ message_id: mid, action_name: 'allow' })}\n`)
    await until(() => r.said().some((t) => t.includes('没送达')))
    // 卡没改、窗口也没收到
    expect(r.updates().length).toBe(0)
    // 手机上按钮还在（原卡未被 update 覆盖）
  })

  it('4g 别人的/别的群的点击丢弃不回话（§15.3）', { timeout: 20000 }, async () => {
    const r = setup()
    rigs.push(r)
    await r.server.listen()
    const w = fakeWindow(r.files.sock)
    windoz.push(w)
    w.hello(1)
    const st = statusOf()
    w.status(st)
    w.status({ ...st, items: [approvalItem('toolu_g', 'grep -rn g ~/外部七')] })
    await until(() => r.cardHas('grep -rn g ~/外部七'))
    const mid = r.idOf('grep -rn g ~/外部七')
    await until(() => r.hub.hasApprovalBinding(mid))
    // 别人点的
    appendFileSync(
      r.files.cardEvents,
      `${cardClick({ message_id: mid, action_name: 'allow', operator_id: 'ou_someone_else' })}\n`,
    )
    // 别的群的
    appendFileSync(
      r.files.cardEvents,
      `${cardClick({ message_id: mid, action_name: 'allow', chat_id: 'oc_other_chat' })}\n`,
    )
    await new Promise((res) => setTimeout(res, 500))
    expect(w.got.some((m) => m.type === 'allow' || m.type === 'deny')).toBe(false)
    expect(r.updates().length).toBe(0)
  })
})
