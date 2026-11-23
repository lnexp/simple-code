import { createCardActionHandler } from './gateway-card-action.ts'
import {
  approvalCard,
  approvalResolvedCard,
  type Card,
  noticeCard,
  type Tone,
  turnEndCard,
} from './gateway-cards.ts'
import { deliveredCard, type ListRow, listCard, statusCard } from './gateway-cards-tasks.ts'
import {
  approvalMessage,
  createDedup,
  deliveryLine,
  type FeishuMsg,
  isLate,
  lateConfirmParts,
  looksLikeApprovalReply,
  parseApprovalReply,
  parseCommand,
  readGatewayState,
  readPushOn,
  stateText,
  targetName,
  turnEndMessage,
  writeGatewayState,
  writePushOn,
} from './gateway-core.ts'
import type { FeishuAdapter } from './gateway-feishu.ts'
import type { GatewayStatus } from './gateway-protocol.ts'
import { createReplyTargets } from './gateway-reply-targets.ts'
import type { GatewayServer } from './gateway-serve.ts'
import type { RobotItem } from './robot-feed.ts'

/**
 * 网关大脑（im-gateway.md §5.5–§7）：手机消息的流水线（去重 → 审批回复 →
 * 命令 → 晚到 → 送达；长按回复完成/出错卡或回执的送回原任务）、推送开关、
 * 目标选择、/列表 清单、审批绑定。
 * IO 全部注入（server 的送达、feishu 的发送）——本文件纯逻辑可直接测。
 */

type Target = { folder: string; owner: string }

export type GatewayHubDeps = {
  server: GatewayServer
  feishu: FeishuAdapter
  /** /切换 的显式目标持久化在 state.json（watermark 同文件，合并写） */
  stateFile: string
  log: (ev: Record<string, unknown>) => void
}

export function createGatewayHub(deps: GatewayHubDeps) {
  const dedup = createDedup()
  /** 晚到待执行（§5.5）：回「执行」合并送进会话，别的话丢弃它们 */
  let pendingLate: FeishuMsg[] = []
  /** /切换 的覆盖（§5.7）；null = 默认目标。重启从 state.json 读回（15:08
   * 真机踩过：网关重启丢了 /to 的目标，晚到重投落到了别处——「一直用到
   * 下次切换」的语义不该被网关重启打断） */
  let target: Target | null = readSavedTarget(deps.stateFile)
  /** /列表 时的编号映射（/切换 N 查它；没 /列表 过 /切换 无效） */
  let lastList: Target[] = []
  /** 已处理完的 message_id（最近 HANDLED_KEEP 条），持久化在 state.json——
   * 内存 dedup 重启即空，补读会把水位线回捞窗口里的旧条目当新消息（16:45
   * 真机把 15:08 已「执行」过的确认又问了一遍晚到；若重启发生在消息后
   * 2 分钟内还会直接重送进会话＝重复执行）。晚到入 pendingLate 的不记：
   * 用户没确认过的，重启后应该再问；被「执行」送走的连同确认一起记 */
  const HANDLED_KEEP = 50
  let handledIds: string[] = readHandledIds(deps.stateFile)
  for (const id of handledIds) dedup.add(id)
  const recordHandled = (ids: string[]): void => {
    if (ids.length === 0) return
    handledIds = [...handledIds, ...ids].slice(-HANDLED_KEEP)
    writeGatewayState(deps.stateFile, { handled: handledIds })
  }
  // 已推送过的 item key（完成/出错/审批三类）。持久化到 state.json 的
  // pushed（最近 100 条）：推送默认开以后，网关重启 → 内存 knownKeys/
  // pushedKeys 清空 → 窗口 status 里所有存量条目会被整批重推一遍手机
  //（默认关的年代没暴露这个坑）。代价：send 失败（飞书 API 挂）的 key
  // 也已记、重启不补——重复打扰比缺一条更糟，缺的靠 gateway_push_failed
  // 日志观察；网关停着那段时间新完成的条目 key 未记，重启后照常推（结论不丢）
  const PUSHED_KEEP = 100
  const pushedKeys = new Set<string>()
  let pushedIds: string[] = readPushedIds(deps.stateFile)
  for (const k of pushedIds) pushedKeys.add(k)
  const recordPushed = (key: string): void => {
    pushedIds = [...pushedIds, key].slice(-PUSHED_KEEP)
    writeGatewayState(deps.stateFile, { pushed: pushedIds })
  }
  /** 发出去的审批消息 message_id → 卡的绑定（A1，§6）。item 存原审批条目：
   *  点击后改结果卡要用它的 command/task（§15.3 保留命令） */
  const approvalBy = new Map<
    string,
    {
      key: string
      folder: string
      canAllow: boolean
      item: Extract<RobotItem, { kind: 'approval' }>
    }
  >()
  /** 完成/出错卡与送达回执的 message_id → 任务（长按回复送回原任务） */
  const replyTargets = createReplyTargets(deps.stateFile)
  /** 见过的 item key（重启后的重推靠持久化的 pushedKeys 挡，§5.6） */
  const knownKeys = new Set<string>()
  /** 最后有焦点的窗口 pid（默认目标 = 它的 showing，§5.5） */
  let lastFocusedPid: number | null = null

  /** 卡片发送（§15.3）：失败退回富文本——推送永不因卡片失败而丢。返回
   *  实际发出的消息 id（卡片或富文本；审批绑定按它），null = 两者都失败 */
  const sendCardOrText = (card: Card, fallback: string): Promise<string | null> =>
    deps.feishu.sendCard(card).then(async (id) => {
      if (id !== null) return id
      deps.log({ ev: 'gateway_card_fallback' })
      return deps.feishu.send(fallback)
    })

  /** 文字回复一律走通知卡（2026-11-18 用户：「手机上的样式统一」）；
   *  卡片失败退回「标题\n正文」文字 */
  const notice = (title: string, detail: string, tone: Tone): void => {
    void sendCardOrText(noticeCard(title, detail, tone), `${title}\n${detail}`).then((id) => {
      if (id === null) deps.log({ ev: 'gateway_push_failed' })
    })
  }

  /** 当前目标：/切换 覆盖 > 默认（最后有焦点窗口的 showing 主任务） */
  const currentTarget = (): Target | null => {
    if (target !== null) return target
    const wins = deps.server.windows()
    const w = wins.find((x) => x.pid === lastFocusedPid) ?? wins[0]
    const folder = w?.status.showing.folder ?? ''
    return folder === '' ? null : { folder, owner: '' }
  }

  /** deliver 等满超时回 null 时（§5.5 等 30 秒）：目标窗口不在了但别的
   * 窗口还在线时，「SC 不在线」会误导（/to 持久化的目标可能指向已关的
   * 目录窗口）——分开说，并给恢复路径 */
  const unreachableReason = (t: Target): string => {
    const wins = deps.server.windows()
    if (wins.length === 0) return '电脑上的 SC 不在线'
    const hit = wins.some(
      (w) =>
        w.status.showing.folder === t.folder || w.status.tasks.some((x) => x.folder === t.folder),
    )
    return hit
      ? '那边的 SC 没响应（等了 30 秒）'
      : '目标所在的窗口不在线（别的窗口还在线）。/列表 看清单，/切换 换目标'
  }

  /** 送进目标会话。to = 长按回复查到的原任务（不给 = 当前目标，且不改当前
   *  目标）。返回是否送达成功（确认行已发）——调用方据此记 handled */
  const sendText = async (text: string, to?: Target): Promise<boolean> => {
    const t = to ?? currentTarget()
    if (t === null) {
      notice('没送达', '电脑上的 SC 面板还没打开', 'red')
      return false
    }
    // 确认行按 deliver **前**的任务状态出：窗口侧 gatewaySend 会立刻起轮，
    // onRobotChange→refresh 的 status 比 ack 先到网关——ack 之后才查会把
    // 刚起的轮读成 running，「已开始」被报成「运行中 1 分钟，作为插话送达」
    //（17:10 真机两连抓）。插话场景同理：发送前 running 快照 →「作为插话送达」
    const before = taskOf(t) ?? null
    const ack = await deps.server.deliver(t.folder, (ref) => ({
      type: 'send',
      ref,
      folder: t.folder,
      owner: t.owner,
      text,
    }))
    deps.log({ ev: 'gateway_delivered', folder: t.folder, owner: t.owner, ok: ack?.ok })
    if (ack === null) {
      notice('没送达', unreachableReason(t), 'red')
      return false
    }
    if (!ack.ok) {
      notice('没送达', ack.reason ?? '窗口不认这个目标', 'red')
      return false
    }
    // 推送关着时提醒一句（§5.6）：回执本身是手机对话的一部分照发，
    // 但后续结论不会主动推——用户得知道轮末手机会安静。回执是卡片
    //（11-18 用户要求），发出后也记进 replyTargets：回复回执同样送回这个任务
    const pushOff = !readPushOn(deps.stateFile)
    const viaReply = to !== undefined
    const line = `${deliveryLine(before, t.folder)}${viaReply ? '（按回复送达）' : ''}`
    const name = targetName(t.folder, before?.task ?? null)
    void sendCardOrText(
      deliveredCard(name, before, { viaReply, pushOff }),
      pushOff ? `${line}（推送关着，结论不会推到手机；发 /推送 开 打开）` : line,
    ).then((id) => {
      if (id === null) deps.log({ ev: 'gateway_push_failed' })
      else replyTargets.record(id, t)
    })
    return true
  }

  /** 推 status 里的新 item（§5.6：开关开着才推，不看 seen） */
  const pushItems = (status: GatewayStatus): void => {
    // §5.6（2026-11-17 19:08 拍板改显式开关）：开关每次从 state.json 读
    // ——设置页改文件不用重启网关就生效。开：完成、出错、审批卡全推，
    // 不看 item.seen（前台正看着也推）；关：一条不推，手机发话的回执
    // 照样走。判断在 knownKeys 记录**之后**：关着期间到达的条目只记 key
    // 不推，重开后不补——「从关变开时补推积压」已随自动规则删除，
    // 推不推 = 条目到达那一刻的开关状态，时过不候
    for (const item of status.items) {
      if (knownKeys.has(item.key) || pushedKeys.has(item.key)) continue
      knownKeys.add(item.key)
      if (!readPushOn(deps.stateFile)) continue
      pushedKeys.add(item.key)
      recordPushed(item.key)
      if (item.kind === 'approval') {
        // §15.3：审批卡（卡片失败退回富文本，长按回复照样可用——绑定的
        // message_id 是实际发出的那条）
        void sendCardOrText(approvalCard(item), approvalMessage(item)).then((id) => {
          if (id === null) {
            deps.log({ ev: 'gateway_approval_push_failed', key: item.key })
            return
          }
          approvalBy.set(id, { key: item.key, folder: item.folder, canAllow: item.canAllow, item })
          if (approvalBy.size > 500) approvalBy.delete(approvalBy.keys().next().value as string)
        })
      } else {
        // §15.3：完成/出错卡
        void sendCardOrText(turnEndCard(item), turnEndMessage(item)).then((id) => {
          if (id === null) deps.log({ ev: 'gateway_push_failed', key: item.key })
          else if (item.owner !== undefined)
            replyTargets.record(id, { folder: item.folder, owner: item.owner })
        })
      }
    }
  }

  /** 审批回复（§6 A1）：回复绑定到卡才生效 */
  const handleApprovalReply = async (
    m: FeishuMsg,
    binding: {
      key: string
      folder: string
      canAllow: boolean
      item: Extract<RobotItem, { kind: 'approval' }>
    },
  ): Promise<void> => {
    if (!binding.canAllow) {
      // ask_rule 类（§6）：只通知过「需回电脑处理」，回复无效
      notice('需回电脑处理', '这张卡安全规则不允许远程批', 'grey')
      return
    }
    const r = parseApprovalReply(m.text)
    if (r === null) {
      notice('没看懂这条回复', '回复审批卡请回「批」「拒」或「拒 理由」', 'orange')
      return
    }
    const ack = await deps.server.deliver(binding.folder, (ref) => ({
      type: r.act === 'allow' ? 'allow' : 'deny',
      ref,
      key: binding.key,
      ...(r.act === 'deny' && r.reason !== undefined ? { reason: r.reason } : {}),
    }))
    deps.log({ ev: 'gateway_approval_reply', key: binding.key, act: r.act, ok: ack?.ok })
    if (ack === null)
      notice('没送达', unreachableReason({ folder: binding.folder, owner: '' }), 'red')
    else if (ack.ok)
      // 与点按钮后的改卡同一张结果卡（§15.3，保留命令）
      void sendCardOrText(
        approvalResolvedCard(binding.item, r.act, r.act === 'deny' ? r.reason : undefined),
        r.act === 'allow' ? '已批准' : r.reason === undefined ? '已拒绝' : `已拒绝：${r.reason}`,
      )
    else notice('卡已处理', ack.reason ?? '电脑上已经处理过这张卡', 'grey')
  }

  /** 手机消息入口（适配器已过身份校验） */
  const onMessage = (m: FeishuMsg): void => {
    if (dedup.hit(m.id)) return // §7.2：飞书至少投一次
    dedup.add(m.id)

    const reply = m.replyTo === undefined ? undefined : approvalBy.get(m.replyTo)
    const replyTo = m.replyTo === undefined ? undefined : replyTargets.get(m.replyTo)
    // 回复关系的观测（11-18）：回复卡片时事件带不带 reply_to 没真机验证过
    if (m.replyTo !== undefined)
      deps.log({ ev: 'gateway_reply_in', hit: reply ? 'approval' : replyTo ? 'task' : 'none' })
    if (reply !== undefined) {
      void handleApprovalReply(m, reply)
      // 审批回复宁可丢不可重放：批过的卡重启后再来一次等于重复执行审批
      recordHandled([m.id])
      return
    }
    if (looksLikeApprovalReply(m.text)) {
      // 没绑到卡的「批/拒」不算数（§6）：没带回复关系、回复的不是审批消息、
      // 或经补读丢了回复关系（主任务 2026-11-17 指示：补读条目取不到
      // reply_to）——都不进会话，「批」当普通话说出去没头没尾
      notice(
        '这条「批/拒」不算数',
        '没有对应到审批卡（卡已处理，或消息经补读丢了回复关系）。要批请长按回复审批卡',
        'orange',
      )
      recordHandled([m.id])
      return
    }

    const cmd = parseCommand(m.text)
    if (cmd !== null) {
      if (cmd.type === 'list') void listCommand()
      else if (cmd.type === 'push') pushCommand(cmd.on)
      else if (cmd.type === 'to') toCommand(cmd.n)
      else if (cmd.type === 'status') statusCommand()
      else void stopCommand()
      recordHandled([m.id])
      return
    }

    if (pendingLate.length > 0) {
      if (m.text.trim() === '执行') {
        // 合并送进会话：一次「执行」送走全部待确认（§5.5）
        const lateIds = pendingLate.map((x) => x.id)
        const text = pendingLate.map((x) => x.text).join('\n\n')
        pendingLate = []
        // 连同被送走的晚到消息一起记：重启后补读捞到它们不再问
        recordHandled([m.id, ...lateIds])
        void sendText(`〔feishu〕${text}`)
        return
      }
      const dropped = pendingLate.length
      recordHandled(pendingLate.map((x) => x.id))
      pendingLate = []
      notice(`已丢弃 ${dropped} 条待确认的晚到消息`, '这条消息照常处理', 'grey')
      // 这条消息本身继续往下走
    }

    if (isLate(m.at, Date.now())) {
      pendingLate.push(m)
      const t = currentTarget()
      const { title, detail } = lateConfirmParts(
        pendingLate,
        t === null ? '（电脑上的 SC 面板还没打开）' : targetName(t.folder, taskOf(t)?.task ?? null),
      )
      notice(title, detail, 'orange')
      return
    }
    // 晚到的（上面 pendingLate）不按回复分流：多条合并送当前目标，确认行写明了去向
    void sendText(`〔feishu〕${m.text}`, replyTo).then((ok) => {
      if (ok) recordHandled([m.id])
    })
  }

  /** /列表（§5.7）：所有窗口的所有目录与任务，标当前 */
  /** 收集列表行（/列表 与列表卡切换后重建共用，§15.3）。编号稳定：
   *  windows() 是连接到达序，两次列表顺序会漂——按目录+owner 排 */
  const collectRows = (): ListRow[] => {
    const seen = new Set<string>()
    const rows: ListRow[] = []
    for (const w of deps.server.windows()) {
      for (const t of w.status.tasks) {
        const owner = t.owner ?? ''
        if (seen.has(`${t.folder}#${owner}`)) continue
        seen.add(`${t.folder}#${owner}`)
        rows.push({
          n: 0,
          name: targetName(t.folder, t.task),
          state: t,
          folder: t.folder,
          owner,
          current: false,
        })
      }
    }
    rows.sort((a, b) =>
      `${a.folder}#${a.owner}` === `${b.folder}#${b.owner}`
        ? 0
        : `${a.folder}#${a.owner}` < `${b.folder}#${b.owner}`
          ? -1
          : 1,
    )
    rows.forEach((r, i) => {
      r.n = i + 1
    })
    const cur = currentTarget()
    if (cur !== null) {
      for (const r of rows) {
        if (r.folder === cur.folder && r.owner === cur.owner) r.current = true
      }
    }
    return rows
  }

  // 卡片点击（§15.3）：逻辑在 gateway-card-action.ts（hub 只接线）
  const deliverApproval = async (
    folder: string,
    key: string,
    act: 'allow' | 'deny',
    reason: string | undefined,
  ): Promise<{ ok: boolean | null }> => {
    const ack = await deps.server.deliver(folder, (ref) => ({
      type: act === 'allow' ? 'allow' : 'deny',
      ref,
      key,
      ...(act === 'deny' && reason !== undefined ? { reason } : {}),
    }))
    deps.log({ ev: 'gateway_approval_reply', key, act, ok: ack?.ok })
    return { ok: ack === null ? null : ack.ok }
  }

  const onCardAction = createCardActionHandler({
    approvalByGet: (id) => approvalBy.get(id),
    deliverApproval,
    updateCard: (token, card) => deps.feishu.updateCard(token, card),
    notice,
    log: deps.log,
    setTarget: (folder, owner) => {
      target = { folder, owner }
      writeGatewayState(deps.stateFile, { target })
      lastList = collectRows().map((e) => ({ folder: e.folder, owner: e.owner }))
    },
    collectRows,
    currentTargetName: () => {
      const cur = currentTarget()
      return cur === null ? null : targetName(cur.folder, taskOf(cur)?.task ?? null)
    },
    taskExists: (folder, owner) => taskOf({ folder, owner }) !== undefined,
    taskName: (folder, owner) => targetName(folder, taskOf({ folder, owner })?.task ?? null),
    unreachableReason: (folder, owner) => unreachableReason({ folder, owner }),
    readPushOn: () => readPushOn(deps.stateFile),
  })

  const listCommand = async (): Promise<void> => {
    const rows = collectRows()
    lastList = rows.map((e) => ({ folder: e.folder, owner: e.owner }))
    if (rows.length === 0) {
      notice('没有任务', '电脑上的 SC 面板还没打开', 'grey')
      return
    }
    const cur = currentTarget()
    // §15.3：列表卡（每行带「切换」按钮，value 带 folder/owner 不用编号）
    await sendCardOrText(
      listCard(
        rows,
        cur === null ? null : targetName(cur.folder, taskOf(cur)?.task ?? null),
        readPushOn(deps.stateFile),
      ),
      `推送：${readPushOn(deps.stateFile) ? '开' : '关'}\n${rows.map((e) => `${e.n} ${e.name} · ${stateText(e.state)}${e.current ? ' ← 当前' : ''}`).join('\n')}`,
    )
  }

  const toCommand = (n: number): void => {
    const e = lastList[n - 1]
    if (e === undefined) {
      notice(
        '没切换',
        lastList.length === 0 ? '先发 /列表 看编号' : `没有第 ${n} 项（共 ${lastList.length} 项）`,
        'orange',
      )
      return
    }
    target = { folder: e.folder, owner: e.owner }
    // 落盘：网关重启后 /切换 仍有效（默认目标跟着焦点走，不用存）
    writeGatewayState(deps.stateFile, { target })
    notice(
      `目标已切到 ${targetName(e.folder, taskOf(e)?.task ?? null)}`,
      '之后直接发的消息都送到这里；发 /状态 查看',
      'blue',
    )
  }

  const taskOf = (t: Target) =>
    deps.server
      .windows()
      .flatMap((w) => w.status.tasks)
      .find((x) => x.folder === t.folder && (x.owner ?? '') === t.owner)

  const stopCommand = async (): Promise<void> => {
    const t = currentTarget()
    if (t === null) {
      notice('没停', '电脑上的 SC 面板还没打开', 'grey')
      return
    }
    const ack = await deps.server.deliver(t.folder, (ref) => ({
      type: 'stop',
      ref,
      folder: t.folder,
      owner: t.owner,
    }))
    const name = targetName(t.folder, taskOf(t)?.task ?? null)
    if (ack === null) notice('没送达', unreachableReason(t), 'red')
    else if (ack.ok) notice('已停止', name, 'grey')
    else notice('没停', ack.reason ?? `${name} 没有在跑的轮`, 'grey')
  }

  /** /状态：只看当前目标与它的状态、推送开关（2026-11-17 20:09 用户：在
   *  /列表 十几行里找「← 当前」费眼）。注明目标是 /切换 指定的还是默认的 */
  const statusCommand = (): void => {
    const pushOn = readPushOn(deps.stateFile)
    const t = currentTarget()
    if (t === null) {
      // 面板没开：没有任务可显示，通知卡（11-18 起不再发纯文字）
      notice('当前：电脑上的 SC 面板还没打开', `推送：${pushOn ? '开' : '关'}`, 'grey')
      return
    }
    const task = taskOf(t)
    const state = task === undefined ? '窗口不在线' : stateText(task)
    const how = target !== null ? '/切换 指定的' : '默认：跟着电脑焦点走'
    const name = targetName(t.folder, task?.task ?? null)
    // §15.3：状态卡（header 颜色随状态）
    void sendCardOrText(
      statusCard(name, task ?? null, how, pushOn),
      `当前：${name} · ${state}（${how}）\n推送：${pushOn ? '开' : '关'}`,
    )
  }

  /** §5.6（19:08 拍板）：/推送 开|关|查询。回执是手机对话的一部分，
   *  关着推送也要回（推送开关只管完成/出错/审批卡的主动推送） */
  const pushCommand = (on: boolean | null): void => {
    if (on === null) {
      const now = readPushOn(deps.stateFile)
      notice(
        `推送：${now ? '开' : '关'}`,
        now ? '完成、出错、审批卡会推到手机；发 /推送 关 关闭' : '发 /推送 开 打开',
        now ? 'green' : 'grey',
      )
      return
    }
    writePushOn(deps.stateFile, on)
    notice(
      `推送已${on ? '开' : '关'}`,
      on ? '完成、出错、审批卡会推到手机' : '完成/出错/审批卡都不会推到手机；发 /推送 开 打开',
      on ? 'green' : 'grey',
    )
  }

  return {
    onMessage,
    onCardAction,
    /** 只读：某条已推送的审批消息是否已绑定到卡（手机回复按 message_id
     * 查）。绑定的 set 在推送子进程 close 之后，与「消息在手机可见」
     * （sent 落盘）不保证先后——给测试等绑定就位用（真实用户不可能在
     * 推送可见后毫秒级回复，只有程序化回复踩得到这个间隙） */
    hasApprovalBinding: (id: string): boolean => approvalBy.has(id),
    /** serve 的连接事件（gateway-main 里 wire） */
    onStatus: (pid: number, status: GatewayStatus): void => {
      if (status.focused) lastFocusedPid = pid
      pushItems(status)
    },
    onGone: (pid: number): void => {
      if (lastFocusedPid === pid) lastFocusedPid = null
    },
  }
}

export type GatewayHub = ReturnType<typeof createGatewayHub>

/** state.json 里读回 /切换 的显式目标（字段坏了当没有，走默认目标） */
function readSavedTarget(stateFile: string): Target | null {
  const t = readGatewayState(stateFile).target
  if (typeof t !== 'object' || t === null) return null
  const folder = (t as Record<string, unknown>).folder
  const owner = (t as Record<string, unknown>).owner
  if (typeof folder !== 'string' || typeof owner !== 'string') return null
  return { folder, owner }
}

/** state.json 里读回已处理过的 message_id（字段坏了当没有） */
function readHandledIds(stateFile: string): string[] {
  const j = readGatewayState(stateFile).handled
  return Array.isArray(j) && j.every((x) => typeof x === 'string') ? (j as string[]) : []
}

function readPushedIds(stateFile: string): string[] {
  const j = readGatewayState(stateFile).pushed
  return Array.isArray(j) && j.every((x) => typeof x === 'string') ? (j as string[]) : []
}
