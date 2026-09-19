#!/usr/bin/env node
/**
 * $SIMPLE_CODE_EVENT 的 CLI 壳。事件档案（v3 可控式归档，archiver.ts）：
 * 活跃战役状态板（.simple-code/events/，front matter + H1 + 进展时间序），
 * 归档=单次归类判断+原子落盘。
 *
 *   "$SIMPLE_CODE_EVENT" list                    # 全量清单（name — description）
 *   "$SIMPLE_CODE_EVENT" search <关键词>          # 匹配 name/description
 *   "$SIMPLE_CODE_EVENT" read <name>              # 一条全文
 *   "$SIMPLE_CODE_EVENT" read <name> --desc      # 只看一行描述
 *   "$SIMPLE_CODE_EVENT" rename <old> <new>      # 改名（name 与战役实质矛盾时）
 *
 * 没有 write：档案由机制产出。归档漏了等下个摘要批次自然补。
 */
import { listEvents, readEvent, renameEvent, searchEvents } from '@simple-code/core/src/tools/events.ts'

const usage = `用法：
  event list                       全量清单（name — description）
  event search <关键词>             按 name/description 匹配（更细的词 read 全文）
  event read <name>                一条全文
  event read <name> --desc        只看一行描述
  event rename <old> <new>        改名：name 与战役实质矛盾时（文件名/front matter 同步）`

const [sub, target, flag] = process.argv.slice(2)

try {
  if (sub === 'list') {
    console.log(listEvents(process.cwd()))
  } else if (sub === 'search' && target) {
    console.log(searchEvents(process.cwd(), target))
  } else if (sub === 'read' && target) {
    console.log(readEvent(process.cwd(), target, flag === '--desc' ? 'desc' : undefined))
  } else if (sub === 'rename' && target && flag) {
    console.log(renameEvent(process.cwd(), target, flag))
  } else {
    console.log(usage)
    process.exitCode = sub === 'help' || sub === '--help' ? 0 : 1
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
