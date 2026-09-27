import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MEMORY_RELATIVE } from '../session/store.ts'

/**
 * visionRelay 转述缓存的盘上层（方案 B，2026-09-24 用户拍板）。
 *
 * session 里的 relayCache（图 data → 转述文本）是纯内存 Map——session 一重建
 * （reload、压缩、切目录、settings 变更）就清零，live 窗口里的旧图每回都要
 * 重新转述一遍（2026-09-24 实测：每张图 24s+，gemini 通道不稳时挂满 120s
 * idle 超时，拖慢整轮启动）。这一层把转述结果按图内容的 sha256 落在
 * `<memoryRoot>/.simple-code/memory/relay-cache.json`，重建后命中盘缓存零调用。
 *
 * 键用内容 hash 而不是原文 base64：同一张图重发（replaceLive 的复制行、任务
 * 继承副本）天然命中；JSON 键也不会被 250KB 的 base64 撑爆。
 *
 * **失败（''）不落盘**：内存层存 '' 是「这个 session 内别再试」，落盘会把
 * 一次瞬时的 gemini 超时变成永久占位符——下个 session 该重试就重试。
 */
const file = (root: string) => join(root, MEMORY_RELATIVE, 'relay-cache.json')

export function relayKey(imageData: string): string {
  return createHash('sha256').update(imageData).digest('hex')
}

/** 进程内 per-root 热缓存：一次读盘，之后纯内存命中 */
const hot = new Map<string, Map<string, string>>()

function diskLayer(root: string): Map<string, string> {
  let m = hot.get(root)
  if (m === undefined) {
    try {
      const raw = JSON.parse(readFileSync(file(root), 'utf8'))
      m = new Map(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'))
    } catch {
      m = new Map() // 没建过/损坏都当空——可选文件缺失是正常情况，静默跳过
    }
    hot.set(root, m)
  }
  return m
}

/** 盘上有这张图的转述吗——有就返回成品文本 */
export function relayHit(root: string, imageData: string): string | undefined {
  return diskLayer(root).get(relayKey(imageData))
}

/**
 * 追加写（先并盘上现值再落盘）：主任务和任务两个 session 并发各写各的新图，
 * 后写的不能把先写的吞掉。tmp+rename 原子替换，半截写不会留脏 JSON。
 */
export function relaySave(root: string, imageData: string, text: string): void {
  if (text === '') return // 失败不落盘，见文件头注释
  const disk = diskLayer(root)
  disk.set(relayKey(imageData), text)
  const target = file(root)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(disk), null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}
