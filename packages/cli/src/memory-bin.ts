#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * $SIMPLE_CODE_MEMORY 的 CLI 壳。历史记忆的下钻检索（方案 A 第一期）：
 *
 *   "$SIMPLE_CODE_MEMORY" show 12                # 整个 turn，step 分组、长内容裁剪
 *   "$SIMPLE_CODE_MEMORY" show 12 --steps 3-5    # 只看第 3~5 步
 *   "$SIMPLE_CODE_MEMORY" show 12 --steps 3 --full   # 某一步的完整原文
 *   "$SIMPLE_CODE_MEMORY" search "pickOldestSteps"  # 跨 turns+summaries，窗口命中
 *   "$SIMPLE_CODE_MEMORY" search "卸载" -n 40     # 放宽全局命中上限
 *   "$SIMPLE_CODE_MEMORY" search "卸载" --ctx     # 命中带所在 step 的完整渲染
 *   "$SIMPLE_CODE_MEMORY" show last               # 最新一个 turn（省一次 ls）
 *   "$SIMPLE_CODE_MEMORY" log -n 10               # 每 turn 一行的总览（先扫再下钻）
 *
 * 输出定位格式 turn-000012:step4 与 show 的 step 号同口径，可二跳。
 */
import { runLog, runSearch, runShow } from '@simple-code/core/src/tools/memory.ts'

const usage = `用法：
  memory show <turn> [--steps 3|-5] [--full]   读某个 turn（step 分组、裁剪长内容）
  memory search <关键词> [-n 上限] [--ctx]      跨 turns+summaries 检索（--ctx 附所在 step 渲染）
  memory log [-n 条数]                          每 turn 一行总览（首条用户消息做标题）`

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const [sub, target, ...rest] = process.argv.slice(2)

if (sub === 'show' && target) {
  try {
    const out = await runShow(process.cwd(), target, {
      steps: arg('--steps'),
      full: process.argv.includes('--full'),
    })
    process.stdout.write(out)
  } catch (err) {
    process.stderr.write(`memory show 失败：${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
} else if (sub === 'search' && target) {
  try {
    const hits = await runSearch(process.cwd(), target, {
      max: arg('-n') === undefined ? undefined : Number(arg('-n')),
      ctx: process.argv.includes('--ctx'),
    })
    if (hits.length === 0) {
      process.stderr.write(`没有命中「${target}」\n`)
      process.exit(1)
    }
    for (const h of hits) {
      process.stdout.write(`${h.where}  ${h.kind.padEnd(10)} ${h.excerpt}\n`)
      for (const c of h.context ?? []) process.stdout.write(`    ${c}\n`)
    }
    process.stdout.write(`（${hits.length} 处命中）\n`)
  } catch (err) {
    process.stderr.write(`memory search 失败：${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
  } else {
    try {
      if (sub === 'log') {
        process.stdout.write(`${await runLog(process.cwd(), { n: arg('-n') === undefined ? undefined : Number(arg('-n')) })}\n`)
        process.exit(0)
      }
    } catch (err) {
      process.stderr.write(`memory log 失败：${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
    process.stderr.write(`${usage}\n`)
  process.exit(2)
}
