import { createHash } from 'node:crypto'
import type { ImagePart, Part } from './types'

/** 原样放行的标记——存它而不存旧 part，理由见下 */
const PASS = 'pass'

/**
 * 发送侧压缩结果缓存（resizer.ts 用）：原图 sha1 → shrinkPart 的结果。
 *
 * 「库里存原图、每次请求现压」的设计不变，只是同一张图只压一次。photon
 * 是同步 wasm：没有缓存时，带 20 张 Retina 截图的任务每次请求都把宿主主
 * 线程卡 6–13s，面板切目录跟着卡（2026-11-17，note
 * resize-every-request-loop-lag）。命中只付一次 sha1（MB 级几毫秒）。
 *
 * 原样放行存 PASS、命中时还**本次传进来的** part：调用方靠
 * `result === part` 判「没改」并保住消息引用（regions 按引用圈保底区），
 * 还缓存里的旧对象会让整条消息被当成改过。压过的图同理只取 data/mimeType，
 * 其余字段（detail）跟本次的 part 走。
 *
 * Map 按插入序迭代：命中删了重插 = 移到最近；超上限丢头部（最久没用）
 */
export function createShrinkCache(max: number) {
  const map = new Map<string, Part | typeof PASS>()
  return async (part: ImagePart, shrink: () => Promise<Part>): Promise<Part> => {
    const key = createHash('sha1').update(part.data).digest('base64')
    const hit = map.get(key)
    if (hit !== undefined) {
      map.delete(key)
      map.set(key, hit)
      if (hit === PASS) return part
      return hit.type === 'image' ? { ...part, data: hit.data, mimeType: hit.mimeType } : hit
    }
    const result = await shrink()
    map.set(key, result === part ? PASS : result)
    if (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
    return result
  }
}
