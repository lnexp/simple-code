import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Card } from './gateway-cards.ts'
import { type CardClick, cardUpdateData, parseCardAction } from './gateway-click.ts'
import {
  eventToMsg,
  type FeishuMsg,
  historyEntryToMsg,
  isFromUser,
  writeGatewayState,
} from './gateway-core.ts'
import { BACKOFF_MS, runOnce, spawnLineConsumer } from './gateway-lark-proc.ts'

/**
 * 飞书适配器（im-gateway.md §8.1、§8.2）：lark-cli 子进程收事件、补读、
 * 发消息。网关进程里唯一碰外界的模块。
 *
 * lark-cli 是 nvm 下的 node 脚本，shebang 的 node 从 PATH 找——网关进程的
 * PATH 未必有 nvm（§13），所以统一 spawn(process.execPath, [larkCli, …])：
 * 网关自己就跑在 ELECTRON_RUN_AS_NODE 的 node 上，拿它跑兄弟脚本。
 */

export type FeishuAdapterDeps = {
  larkCli: string
  chatId: string
  openId: string
  /** 补读水位线文件的路径（§5.3 state.json） */
  stateFile: string
  /** 过了身份校验的用户消息（去重、晚到判定在 hub） */
  onMessage: (m: FeishuMsg) => void
  /** 卡片点击（本人+本单聊已过滤、event_id 已去重；点击即当下不判晚到） */
  onCardAction: (c: CardClick) => void
  log: (ev: Record<string, unknown>) => void
  /** 补读一页的条数（§5.3：20；测试可调小） */
  pageSize?: number
}

export type FeishuAdapter = {
  /** 发 markdown，返回消息 id（审批回复绑定要，§6）；失败 null */
  send: (markdown: string) => Promise<string | null>
  /** 发 Card 2.0（§15：--msg-type interactive --content），返回消息 id；失败 null */
  sendCard: (card: Card) => Promise<string | null>
  /** 延迟更新卡（§15：api POST card/update --data @临时文件）；失败 false */
  updateCard: (token: string, card: Card) => Promise<boolean>
  stop: () => void
}

export function createFeishuAdapter(deps: FeishuAdapterDeps): FeishuAdapter {
  const nodeBin = process.execPath // ELECTRON_RUN_AS_NODE 已在 env（§8.2 注）
  let stopped = false
  let consumeProc: ChildProcess | null = null
  let cardConsumeProc: ChildProcess | null = null
  let backoffIdx = 0
  let sendSeq = 0

  // ── 水位线（§5.3）：补读只取它之后的 ──────────────────────────
  const readWatermark = (): number | null => {
    try {
      const j = JSON.parse(readFileSync(deps.stateFile, 'utf8')) as { watermark?: unknown }
      return typeof j.watermark === 'number' ? j.watermark : null
    } catch {
      return null
    }
  }
  let watermark: number | null = readWatermark()
  const writeWatermark = (ms: number): void => {
    // 直接 set 不取 max：取 max 会让高值水位线（如首启时刻）压住同分钟
    // 更晚到的消息时刻，水位线永远不前移、补读永远滤掉同分钟条目。
    // 回退也无妨——去重兜底，水位线只是减少重拉的粗过滤
    watermark = ms
    // 合并写：state.json 里还有 hub 的 /切换 target，全量重写会抹掉它
    writeGatewayState(deps.stateFile, { watermark })
  }
  /** 首次启动（无水位线）= 现在，不补历史（§5.3） */
  if (watermark === null) {
    watermark = Date.now()
    writeWatermark(watermark)
  }

  // ── 补读（connected 触发，§5.3）────────────────────────────────
  const catchUp = async (): Promise<void> => {
    const out = await runOnce(
      nodeBin,
      [
        deps.larkCli,
        'im',
        '+chat-messages-list',
        '--chat-id',
        deps.chatId,
        '--as',
        'bot',
        '--page-size',
        String(deps.pageSize ?? 20),
      ],
      deps.log,
    )
    if (out === null) return
    let data: unknown
    try {
      const parsed = JSON.parse(out) as { ok?: unknown; data?: unknown }
      // lark-cli 内部失败也可能 exit 0（2026-11-20 断链排查：catchUp
      // 静默空转的形态之一）——ok:false 记原始输出头再放弃
      if (parsed.ok !== true) {
        deps.log({ ev: 'gateway_catchup_rejected', head: out.slice(0, 200) })
        return
      }
      data = parsed.data
    } catch {
      deps.log({ ev: 'gateway_catchup_parse_failed' })
      return
    }
    const messages =
      typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as { messages?: unknown }).messages)
        ? ((data as { messages: unknown[] }).messages as Array<Record<string, unknown>>)
        : []
    // 新的在前（实测 message_position 降序）：按时间正序处理，水位线之后的才走
    let handled = 0
    let dropped = 0
    for (const raw of messages.reverse()) {
      const m = historyEntryToMsg(raw)
      // 只取发送人是你、create_time >= 水位线所在分钟起点的。**必须按分钟
      // 起点比**：水位线是毫秒精度（实时消息的 create_time），条目只有分钟
      // 精度——直接比 >= 会把同分钟的新消息全过滤掉。重拉的同分钟旧条目
      // 靠 message_id 去重兜底（§5.3）
      const wmMinute = Math.floor((watermark ?? 0) / 60_000) * 60_000
      if (m === null || !isFromUser(m, deps) || m.at < wmMinute) {
        dropped++
        continue
      }
      writeWatermark(m.at)
      deps.onMessage(m)
      handled++
    }
    // 结果观测（2026-11-20）：空转（listed>0 但全 dropped）此前无法从日志
    // 辨认——catchUp 静默失败的定位全靠这一行
    deps.log({ ev: 'gateway_catchup', listed: messages.length, handled, dropped })
  }

  // ── 事件子进程（§8.2 消息、§15 卡片点击）：两个 consume，同一骨架
  //（gateway-lark-proc）
  const cardEventIds = new Set<string>()
  const backoff = (): number => BACKOFF_MS[Math.min(backoffIdx++, BACKOFF_MS.length - 1)] ?? 1000

  consumeProc = spawnLineConsumer({
    nodeBin,
    args: [deps.larkCli, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    stopped: () => stopped,
    log: deps.log,
    backoff,
    onSpawn: (child) => {
      consumeProc = child
    },
    onLine: (ev) => {
      const m = eventToMsg(ev)
      // 身份校验（§7.1）：别人的、群里的丢弃不回话
      if (m === null || !isFromUser(m, deps)) return
      writeWatermark(m.at)
      deps.onMessage(m)
    },
    onConnected: () => void catchUp(),
    connectedLine: 'feishu-websocket: connected',
  })

  // 卡片点击（§15.3）：本人+本单聊才收（丢弃不回话），event_id 去重
  cardConsumeProc = spawnLineConsumer({
    nodeBin,
    args: [deps.larkCli, 'event', 'consume', 'card.action.trigger', '--as', 'bot'],
    stopped: () => stopped,
    log: deps.log,
    backoff,
    onSpawn: (child) => {
      cardConsumeProc = child
    },
    onLine: (ev) => {
      const c = parseCardAction(ev)
      if (c === null) return
      if (c.operatorId !== deps.openId || c.chatId !== deps.chatId) return
      if (cardEventIds.has(c.eventId)) return
      cardEventIds.add(c.eventId)
      if (cardEventIds.size > 1000) cardEventIds.delete(cardEventIds.keys().next().value as string)
      deps.onCardAction(c)
    },
    onConnected: () => {}, // 卡片不需要补读，点击即当下
    connectedLine: 'feishu-websocket: connected',
  })

  // 无条件补读一次（17:42 真机）：consume 连的是 lark-cli 的 event bus
  // daemon（连活的不另起），只有 daemon 自己新建 websocket 时 stderr 才打
  // "feishu-websocket: connected"——网关重启、daemon 还活着时 consume 不再
  // 打那行，connected 触发的补读永远不来，网关停着那段时间的手机消息
  // 就丢了。启动即补读（拉 chat-messages-list，不依赖 consume 的连接
  // 状态）；connected 行出现时照旧再补读一次——重复投递靠 handled + dedup
  // 挡（f62d297），水位线只是减少重拉的粗过滤，并发补读交叉写无害
  void catchUp()
  // 周期补读（2026-11-20 断链自愈，用户拍板「进程在消息不通需要解决」）：
  // daemon websocket 死了不重连时实时链路整个黑洞、connected 不再来，
  // 补读只能靠这里分钟级轮询兜底——消息 ID 去重挡重复执行。60s 意味着
  // 断链期间的消息最迟一分钟被捞起（晚到的进 pendingLate 等确认）
  const catchupTimer = setInterval(() => void catchUp(), 60_000)
  catchupTimer.unref?.()

  return {
    send: async (markdown) => {
      sendSeq++
      const out = await runOnce(
        nodeBin,
        [
          deps.larkCli,
          'im',
          '+messages-send',
          '--chat-id',
          deps.chatId,
          '--as',
          'bot',
          '--markdown',
          markdown,
          '--idempotency-key',
          `scgw-${Date.now()}-${sendSeq}`.slice(0, 50),
        ],
        deps.log,
      )
      if (out === null) return null
      try {
        const j = JSON.parse(out) as { ok?: unknown; data?: { message_id?: unknown } }
        return typeof j.data?.message_id === 'string' ? j.data.message_id : null
      } catch {
        return null
      }
    },
    sendCard: async (card) => {
      sendSeq++
      const out = await runOnce(
        nodeBin,
        [
          deps.larkCli,
          'im',
          '+messages-send',
          '--chat-id',
          deps.chatId,
          '--as',
          'bot',
          '--msg-type',
          'interactive',
          '--content',
          JSON.stringify(card),
          '--idempotency-key',
          `scgw-${Date.now()}-${sendSeq}`.slice(0, 50),
        ],
        deps.log,
      )
      if (out === null) return null
      try {
        const j = JSON.parse(out) as { data?: { message_id?: unknown } }
        return typeof j.data?.message_id === 'string' ? j.data.message_id : null
      } catch {
        return null
      }
    },
    updateCard: async (token, card) => {
      // --data - 走 stdin（21:29 dry-run 实测）：@文件受 lark-cli 白名单
      // 限制（只收 cwd、/tmp、~/files），os.tmpdir()（/var/folders/…）会被拒
      const out = await runOnce(
        nodeBin,
        [
          deps.larkCli,
          'api',
          'POST',
          '/open-apis/interactive/v1/card/update',
          '--as',
          'bot',
          '--data',
          '-',
        ],
        deps.log,
        `${JSON.stringify(cardUpdateData(token, card))}\n`,
      )
      if (out === null) return false
      try {
        return (JSON.parse(out) as { ok?: unknown }).ok === true
      } catch {
        return false
      }
    },
    stop: () => {
      stopped = true
      consumeProc?.kill('SIGTERM')
      cardConsumeProc?.kill('SIGTERM')
      consumeProc = null
      cardConsumeProc = null
    },
  }
}
