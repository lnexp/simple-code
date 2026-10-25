/** front matter 里盖章 lastRead——lesson/event 读心跳（2026-10-21 拍板，
 * memory-time-decay.md ①）。
 *
 * 与 note.ts readNote 同款语义：只有走工具的读才算使用，bash cat 不更新
 * （裸读是文件给人看的用法）。时间衰减 ② 四面收起的时间信号就是它。
 * lastRead 是独立字段，不碰 event 的 updated——那个是 progress 时间，
 * 喂 LRU 排序，混了互相干扰。 */

import { localStamp } from './timestamp.ts'

/** 有 front matter 则盖章（已有则替换、没有则插入到收尾 --- 前）并返回
 * 新文本；无 front matter 返回 null——调用方保持原文（不注入头：与 note.ts
 * 的裸文件迁移分支不同，lesson/event 无裸文件历史，遇到手写文件不强改） */
export function stampLastRead(text: string): string | null {
  if (!/^---\s*\n[\s\S]*?\n---/.test(text)) return null
  const now = localStamp()
  return text.replace(/^(---\s*\n[\s\S]*?\n---)/, (fm) =>
    /\nlastRead:/.test(fm)
      ? fm.replace(/\nlastRead:.*$/m, `\nlastRead: ${now}`)
      : fm.replace(/\n---$/, `\nlastRead: ${now}\n---`),
  )
}
