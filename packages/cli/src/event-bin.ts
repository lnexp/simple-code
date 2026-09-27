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
 *   "$SIMPLE_CODE_EVENT" progress <name> <一句话> # 追加一笔进展/订正
 *   "$SIMPLE_CODE_EVENT" describe <name> <描述>   # 改描述（description + H1）
 *
 * **没有自由 write，只有点状订正**（2026-09-20 拍板）。提案 §5.4 当初
 * 连订正一起否了，理由是「手写会被下轮整文件重写冲掉」——那是 v1/v2
 * 归档 agent 自由重写时代的事实；v3 去 agent 化后落盘只走原子原语，
 * 重写路径不存在了，理由随之失效，遂开 progress/describe 两个订正口
 * （rename 此前已开）。开的不是 write：正文大段仍不维护（v3 的取舍，
 * 档案是状态板，过程细节在 turns/git），写歪了追一笔订正、描述跑偏了
 * 改一行，而不是整篇重写——那正是 v1/v2 丢信息/塞旧文/格式漂移的来源。
 * 正常产出仍归 archiver：归档漏了等下个摘要批次自然补。
 */
import {
  appendProgress,
  listEvents,
  readEvent,
  renameEvent,
  searchEvents,
  updateDescription,
} from '@simple-code/core/src/tools/events.ts'

const usage = `用法：
  event list                       全量清单（name — description）
  event search <关键词>             按 name/description 匹配（更细的词 read 全文）
  event read <name>                一条全文
  event read <name> --desc        只看一行描述
  event rename <old> <new>        改名：name 与战役实质矛盾时（文件名/front matter 同步）
  event progress <name> <一句话>   追加进展/订正到进展段末尾（带日期，原文不动）
  event describe <name> <描述>     改描述：front matter 的 description 与 H1 两处同步

订正用 progress/describe 点状改，不重写正文——档案是活跃战役的状态板。`

/** 可测入口（对齐 lsp-bin 的 lspMain）：argv 从外传，cwd 从外传 */
export function eventMain(argv: string[], cwd = process.cwd()): number {
  const [sub, target, flag] = argv
  try {
    if (sub === 'list') {
      console.log(listEvents(cwd))
    } else if (sub === 'search' && target) {
      console.log(searchEvents(cwd, target))
    } else if (sub === 'read' && target) {
      console.log(readEvent(cwd, target, flag === '--desc' ? 'desc' : undefined))
    } else if (sub === 'rename' && target && flag) {
      console.log(renameEvent(cwd, target, flag))
    } else if (sub === 'progress' && target && flag) {
      // 句子没引号时被空格拆开——从句首词（argv[2]）起全拼回来，不然
      // 只记半句。stepRange 不传：手动订正不属任何摘要批次，只带日期
      console.log(appendProgress(cwd, target, argv.slice(2).join(' ')))
    } else if (sub === 'describe' && target && flag) {
      console.log(updateDescription(cwd, target, argv.slice(2).join(' ')))
    } else {
      console.log(usage)
      return sub === 'help' || sub === '--help' ? 0 : 1
    }
    return 0
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  }
}

// 直接执行时（bin 形态）跑 main；被 import（测试）时不跑
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  process.exit(eventMain(process.argv.slice(2)))
}
