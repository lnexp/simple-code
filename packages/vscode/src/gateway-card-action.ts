/** 卡片点击处理（§15.3）——从 hub 拆出来（hub 只留接线）。审批按
 *  message_id 查 approvalBy（与长按回复同一张表）；结果改卡（改卡成功
 *  不另推文字，不重复）；列表「切换」核对任务还在当前 status 里。
 *  updateCard 失败退回推一张通知卡（§15.3，同列表切换那支）。 */
import {
  approvalResolvedCard,
  approvalStaleCard,
  approvalTakenCard,
  type Card,
  type Tone,
} from './gateway-cards.ts'
import { type ListRow, listCard } from './gateway-cards-tasks.ts'
import type { CardClick } from './gateway-click.ts'
import type { RobotItem } from './robot-feed.ts'

export type ApprovalBinding = {
  key: string
  folder: string
  canAllow: boolean
  item: Extract<RobotItem, { kind: 'approval' }>
}

export type CardActionDeps = {
  /** 审批绑定查询（message_id → 卡） */
  approvalByGet: (id: string) => ApprovalBinding | undefined
  /** 执行审批（与长按回复同一条 deliver，§6）→ ok: true/false/null（窗口不在线） */
  deliverApproval: (
    folder: string,
    key: string,
    act: 'allow' | 'deny',
    reason: string | undefined,
  ) => Promise<{ ok: boolean | null }>
  updateCard: (token: string, card: Card) => Promise<boolean>
  /** 通知卡（hub 的 notice：卡片失败退文字） */
  notice: (title: string, detail: string, tone: Tone) => void
  log: (ev: Record<string, unknown>) => void
  /** 列表切换（§15.3）：核对任务在 → 落盘并重建列表卡改卡 */
  setTarget: (folder: string, owner: string) => void
  collectRows: () => ListRow[]
  currentTargetName: () => string | null
  taskExists: (folder: string, owner: string) => boolean
  taskName: (folder: string, owner: string) => string
  /** 送达失败原因（窗口三态：全不在线/没响应/别的窗口在线，hub 的 unreachableReason） */
  unreachableReason: (folder: string, owner: string) => string
  readPushOn: () => boolean
}

export function createCardActionHandler(deps: CardActionDeps): (c: CardClick) => void {
  return (c: CardClick): void => {
    if (c.action.kind === 'approval') {
      const binding = deps.approvalByGet(c.messageId)
      if (binding === undefined) {
        // 网关重启过（approvalBy 在内存）：卡改成已失效
        void deps.updateCard(c.token, approvalStaleCard())
        return
      }
      if (!binding.canAllow) return // ask_rule 卡不带按钮，防御
      void (async () => {
        const { ok } = await deps.deliverApproval(
          binding.folder,
          binding.key,
          c.action.kind === 'approval' ? c.action.act : 'allow',
          c.action.kind === 'approval' ? c.action.reason : undefined,
        )
        if (ok === null) {
          // 窗口不在线：卡不改、按钮留着可重试，推通知（三态提示）
          deps.notice('没送达', deps.unreachableReason(binding.folder, ''), 'red')
          return
        }
        if (ok) {
          const act = c.action.kind === 'approval' ? c.action.act : 'allow'
          const reason = c.action.kind === 'approval' ? c.action.reason : undefined
          // 改卡成功不另推；失败退回推一条（§15.3）
          const updated = await deps.updateCard(
            c.token,
            approvalResolvedCard(binding.item, act, reason),
          )
          if (!updated)
            deps.notice(
              act === 'allow' ? '已批准' : reason === undefined ? '已拒绝' : `已拒绝：${reason}`,
              binding.item.command,
              act === 'allow' ? 'green' : 'red',
            )
        } else {
          // 电脑上先处理了（用户选 2A）：卡改成「已在电脑上处理」
          const updated = await deps.updateCard(c.token, approvalTakenCard(binding.item))
          if (!updated) deps.notice('已在电脑上处理', '这张卡在电脑上先处理了', 'grey')
        }
      })()
      return
    }
    // 列表「切换」（到这 c.action 已收窄为 to，取局部过闭包）
    const a = c.action
    if (!deps.taskExists(a.folder, a.owner)) {
      deps.notice('这个任务已不在了', '发 /列表 重新看', 'orange')
      return
    }
    deps.setTarget(a.folder, a.owner)
    const rows = deps.collectRows()
    void deps
      .updateCard(c.token, listCard(rows, deps.currentTargetName(), deps.readPushOn()))
      .then((ok) => {
        // 改卡失败退通知（§15.3：updateCard 失败退回推一条）
        if (!ok)
          deps.notice(
            `目标已切到 ${deps.taskName(a.folder, a.owner)}`,
            '之后直接发的消息都送到这里；发 /状态 查看',
            'blue',
          )
      })
  }
}
