#!/usr/bin/env node
/**
 * "$SIMPLE_CODE_WAKE" --after 30m                     到点响（相对时长）
 * "$SIMPLE_CODE_WAKE" --at 08:00 --note "晨醒汇总"     到点响（绝对时刻，已过则明天）
 * "$SIMPLE_CODE_WAKE" --until-ok "curl -sf <网关>"    条件满足响（宿主层每
 *                                                     --every 间隔跑命令，退出 0
 *                                                     那次唤醒；默认 30m）
 *
 * 闹钟（docs/loop-interrupt.md §5，实现项 3）：唤醒 = turn 的中断——到点给
 * **设闹钟的这个会话**（root+owner）发〔wake〕消息，跑着=插话、停着=开新 turn。
 * --note 是自己留给自己的备忘（不是 --say——闹钟不是用户说话）。
 * 不持久化：重启即丢。周期靠醒来自己设下一个，不做原生周期闹钟（拍板）。
 *
 * 退出码：0 已设；1 宿主拒绝（参数错/超上限）；2 无桥；3 时间写法错。
 */
import {
  TASK_PORT_ENV,
  TASK_TOKEN_ENV,
  TASK_TOKEN_HEADER,
  type WakeResponse,
} from '@simple-code/core/src/session/task-endpoint.ts'

const USAGE =
  `用法："$SIMPLE_CODE_WAKE" --after 30m [--note "备忘"]，或 --at 08:00，或 --until-ok "命令" [--every 30m]\n` +
  `时长写法：30s / 5m / 2h / 1h30m。唤醒回到设闹钟的这个会话\n`

/** "30s"/"5m"/"2h"/"1h30m" → 毫秒。null = 写法不认识 */
export function parseDuration(text: string): number | null {
  let ms = 0
  let rest = text.trim()
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g
  let matched = false
  for (const m of rest.matchAll(re)) {
    matched = true
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    ms += n * (m[2] === 'h' ? 3_600_000 : m[2] === 'm' ? 60_000 : 1_000)
    rest = rest.replace(m[0], '')
  }
  if (!matched || rest.trim() !== '') return null
  return ms > 0 ? ms : null
}

export async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let after: number | undefined
  let at: string | undefined
  let untilOk: string | undefined
  let every: number | undefined
  let note: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    const next = args[i + 1]
    if (a === '--after') {
      const ms = next === undefined ? null : parseDuration(next)
      if (ms === null) {
        process.stdout.write(USAGE)
        return 3
      }
      after = ms
      i++
    } else if (a === '--at') {
      if (next === undefined || !/^\d{1,2}:\d{2}$/.test(next)) {
        process.stdout.write(USAGE)
        return 3
      }
      at = next
      i++
    } else if (a === '--until-ok') {
      if (next === undefined || next.trim() === '') {
        process.stdout.write(USAGE)
        return 3
      }
      untilOk = next
      i++
    } else if (a === '--every') {
      const ms = next === undefined ? null : parseDuration(next)
      if (ms === null || ms < 60_000) {
        process.stdout.write('--every 最小 1m（宿主层探测别太密）\n')
        return 3
      }
      every = ms
      i++
    } else if (a === '--note') {
      if (next === undefined) {
        process.stdout.write(USAGE)
        return 3
      }
      note = next
      i++
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE)
      return 0
    } else {
      process.stdout.write(USAGE)
      return 3
    }
  }
  const port = process.env[TASK_PORT_ENV]
  const token = process.env[TASK_TOKEN_ENV]
  if (port === undefined || token === undefined) {
    process.stdout.write('无任务桥：不在 VS Code 宿主里（或宿主已关闭）\n')
    return 2
  }
  let roots: unknown = []
  try {
    roots = JSON.parse(process.env.SIMPLE_CODE_ROOTS ?? '[]')
  } catch {
    // 退 cwd
  }
  const root = Array.isArray(roots) && typeof roots[0] === 'string' ? roots[0] : process.cwd()
  const owner = process.env.SIMPLE_CODE_OWNER ?? ''
  try {
    const res = await fetch(`http://127.0.0.1:${port}/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TASK_TOKEN_HEADER]: token },
      body: JSON.stringify({
        root,
        owner,
        ...(after !== undefined ? { afterMs: after } : {}),
        ...(at !== undefined ? { at } : {}),
        ...(untilOk !== undefined ? { untilOk } : {}),
        ...(every !== undefined ? { everyMs: every } : {}),
        ...(note !== undefined ? { note } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json()) as WakeResponse
    if (!body.ok) {
      process.stdout.write(`${body.error}\n`)
      return 1
    }
    const desc =
      after !== undefined
        ? `${Math.round(after / 60000)} 分钟后`
        : at !== undefined
          ? at
          : '条件满足时'
    process.stdout.write(`闹钟已设（${desc}，id ${body.id}）——回到设它的这个会话唤醒\n`)
    return 0
  } catch (error) {
    process.stdout.write(
      `任务桥不可达：${error instanceof Error ? error.message : String(error)}（宿主关闭或端口失效）\n`,
    )
    return 2
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().then((code) => process.exit(code))
}
