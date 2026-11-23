import { readGatewayState, writeGatewayState } from './gateway-core.ts'

export type ReplyTarget = { folder: string; owner: string }

/** 长按回复送回原任务（2026-11-18 用户：「按住消息回复时不能回复到原来的
 *  任务上」）。发出去的完成/出错卡与送达回执记 message_id → 任务；回复
 *  这些消息的话送进那个任务，当前目标不变。落盘 state.json 的
 *  replyTargets（网关重启后回复旧卡照样认），留最近 KEEP 条。审批卡不在
 *  这张表——「批/拒」走 approvalBy（§6） */
export function createReplyTargets(stateFile: string, keep = 200) {
  const map = new Map<string, ReplyTarget>()
  const raw = readGatewayState(stateFile).replyTargets
  if (Array.isArray(raw))
    for (const e of raw as Array<Record<string, unknown>>) {
      if (typeof e?.id === 'string' && typeof e.folder === 'string' && typeof e.owner === 'string')
        map.set(e.id, { folder: e.folder, owner: e.owner })
    }
  return {
    get: (id: string): ReplyTarget | undefined => map.get(id),
    record: (id: string, t: ReplyTarget): void => {
      map.set(id, { folder: t.folder, owner: t.owner })
      while (map.size > keep) map.delete(map.keys().next().value as string)
      const replyTargets = [...map].map(([k, v]) => ({ id: k, folder: v.folder, owner: v.owner }))
      writeGatewayState(stateFile, { replyTargets })
    },
  }
}
