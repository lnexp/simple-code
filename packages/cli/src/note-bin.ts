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
 *   "$SIMPLE_CODE_NOTE" update deny-list <<'MD'  # 改写：给哪段改哪段，
 *   description: 部分采纳了，详见正文     # 省略的段保留旧值
 *   ---
 *   （正文段省略时旧正文保留）
 *   MD
 *
 * 索引只收最近使用的 30 条 description（LRU，read/update 都喂心跳），
 * 被挤出索引的文件永远不删——list 全量可列、read 照常。
 */
import { readFileSync } from 'node:fs'
import { listNotes, readNote, updateNote, writeNote } from '@simple-code/core/src/tools/note.ts'

const usage = `用法：
  note list                          全量清单
  note read <name>                   一条全文（更新 LRU 心跳）
  note write <<'MD'（stdin 四段：name/title/description/正文，推荐）
      name: deny-list
      title: 一行标题
      description: 进 system 索引的一行描述
      ---
      正文……
  note update <name> <<'MD'（给哪段改哪段：title/description/正文皆可省）
      description: 新描述
      ---
      （正文省略时旧正文保留）`

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
  } else if (sub === 'read' && target) {
    console.log(readNote(process.cwd(), target))
  } else if (sub === 'update' && target) {
    const text = stdinText()
    const title = text.match(/^\s*title:\s*(.+)$/m)?.[1]?.trim()
    const description = text.match(/^\s*description:\s*(.+)$/m)?.[1]?.trim()
    const sep = text.search(/^---\s*$/m)
    const hasBody = sep !== -1 && text.slice(sep).replace(/^---\s*\n?/, '').trim() !== ''
    if (!title && !description && !hasBody) {
      console.error('update 至少给一段：title:/description:/---/正文（见 usage）')
      process.exit(2)
    }
    console.log(
      updateNote(process.cwd(), target, {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(hasBody ? { body: text.slice(sep).replace(/^---\s*\n?/, '') } : {}),
      }),
    )
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
