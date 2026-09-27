#!/usr/bin/env node
/**
 * $SIMPLE_CODE_NOTE 的 CLI 壳。结论记忆（决策/约定/一次性事实，一笔记一事，
 * 与教训库 lesson 同目录形态：.simple-code/notes/）：
 *
 *   "$SIMPLE_CODE_NOTE" list                     # 全量清单（含被挤出索引的）
 *   "$SIMPLE_CODE_NOTE" read deny-list           # 一条全文（顺带喂 LRU 心跳）
 *   "$SIMPLE_CODE_NOTE" write <<'MD'             # heredoc 传四段（推荐）
 *   name: deny-list
 *   title: 温区配额已否决
 *   description: 温区独立配额不做，热超软顶才降级——列表时勿再提
 *   ---
 *   正文……
 *   MD
 *   改（update/patch 子命令 2026-09-27 退役）：同名 write 整条重写，
 *   或 "$SIMPLE_CODE_APPLY_PATCH" 局部改 .simple-code/notes/<name>.md
 *
 * 索引只收最近使用的 20 条 description（LRU，read 喂心跳），
 * 被挤出索引的文件永远不删——list 全量可列、read 照常。
 */
import { readFileSync } from 'node:fs'
import {
  listNotes,
  readNote,
  searchNotes,
  writeNote,
} from '@simple-code/core/src/tools/note.ts'

const usage = `用法：
  note list                          全量清单
  note read <name>                   一条全文（更新 LRU 心跳）
  note write <<'MD'（stdin 四段：name/title/description/正文，推荐）
      name: deny-list
      title: 一行标题
      description: 进 system 索引的一行描述
      ---
      正文……
  改内容：同名 write 整条重写，或 "$SIMPLE_CODE_APPLY_PATCH" 局部改（免审批）`

const [sub, target] = process.argv.slice(2)
const stdinText = () => {
  try {
    return process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

try {
  if (sub === 'list') {
    console.log(listNotes(process.cwd()))
  } else if (sub === 'search' && target) {
    console.log(searchNotes(process.cwd(), target))
  } else if (sub === 'read' && target) {
    console.log(readNote(process.cwd(), target))
  } else if (sub === 'write') {
    const text = stdinText()
    if (!text) {
      console.error(usage)
      process.exit(2)
    }
    const m = text.match(/^\s*name:\s*(.+)\ntitle:\s*(.+)\ndescription:\s*(.+)\n---\n?([\s\S]*)$/)
    if (!m) {
      console.error('stdin 需要 name:/title:/description:/---/正文 五段（见 usage），开头几行是：\n' + text.split('\n').slice(0, 5).join('\n'))
      process.exit(2)
    }
    console.log(
      writeNote(process.cwd(), {
        name: m[1]!.trim(),
        title: m[2]!.trim(),
        description: m[3]!.trim(),
        body: m[4] ?? '',
      }),
    )
  } else {
    console.error(usage)
    process.exit(2)
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
}
