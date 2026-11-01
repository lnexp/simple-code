#!/usr/bin/env node
/**
 * $SIMPLE_CODE_NOTE 的 CLI 壳。四类型统一操作，新文件在 notes 下归类，
 * 历史 lessons/principles 仍原位读取，不要求用户先迁移。
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
 *   改（update/patch 子命令 2026-09-27 退役）："$SIMPLE_CODE_APPLY_PATCH"
 *   改 .simple-code/notes/<name>.md；write 撞同名拒绝，不覆盖
 *
 * 文件是否进常驻由 session 预算决定；list/search/read 不以常驻与否限制可达性。
 */
import { readFileSync } from 'node:fs'
import {
  type NoteType,
  parseNoteType,
  readNoteFile,
} from '@simple-code/core/src/tools/note-files.ts'
import {
  listTypedNotes,
  searchTypedNotes,
  writeTypedNote,
} from '@simple-code/core/src/tools/note-library.ts'
import { findWorkspaceRoot } from '@simple-code/core/src/tools/workspace-root.ts'
import { logSearchText } from './search-log.ts'

// 工作区根：cwd 可能是子目录（workspace-root.ts）
const root = findWorkspaceRoot(process.cwd())

const usage = `用法：
  note list [--type general|lesson|principle|goal] [--all]
  note search <关键词> [--type 类型] [--all]
  note read <name> [--type 类型]      一条全文（更新实际文件的 LRU 心跳）
  note write [--type 类型] <<'MD'（默认 general；stdin 如下）
      name: deny-list
      title: 一行标题
      description: 进 system 索引的一行描述
      ---
      正文……
  lesson 正文五节：症状／当时怎么误判的／根因／修法／怎么验证的。
  principle 正文：判断／适用边界／依据（新写默认为 candidate）。
  goal 正文：这件事是什么／目标／当前范围与边界／怎样算达到目标。
  每节用 ## 标题；改内容用 "$SIMPLE_CODE_APPLY_PATCH" 改实际路径。
  新文件在 notes/ 下按类型归类；旧 lessons/principles 可读，不自动搬迁或覆盖。`

function parseArgs(args: string[]) {
  const positional: string[] = []
  let type: NoteType | undefined
  let all = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--all') all = true
    else if (arg === '--type') {
      if (type || !args[i + 1] || args[i + 1]!.startsWith('--'))
        throw new Error('--type 需要且只能指定一个类型：general/lesson/principle/goal')
      type = parseNoteType(args[++i]!)
    } else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    else positional.push(arg)
  }
  if (positional.length > 2) throw new Error('参数过多；search 多词查询请用引号包成一个参数。')
  return { sub: positional[0], target: positional[1], options: { all, ...(type ? { type } : {}) } }
}
const stdinText = () => {
  try {
    return process.stdin.isTTY ? '' : readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

try {
  const { sub, target, options } = parseArgs(process.argv.slice(2))
  if (sub === 'list') {
    console.log(listTypedNotes(root, options))
  } else if (sub === 'search' && target) {
    const out = searchTypedNotes(root, target, options)
    logSearchText('note', root, target, out)
    console.log(out)
  } else if (sub === 'read' && target) {
    console.log(readNoteFile(root, target, options.type))
  } else if (sub === 'write') {
    const text = stdinText()
    if (!text) {
      console.error(usage)
      process.exit(2)
    }
    const m = text.match(/^\s*name:\s*(.+)\ntitle:\s*(.+)\ndescription:\s*(.+)\n---\n?([\s\S]*)$/)
    if (!m) {
      console.error(
        'stdin 要逐行写 name:/title:/description:（单行），再一行 ---，其后是正文（见 usage），开头几行是：\n' +
          text.split('\n').slice(0, 5).join('\n'),
      )
      process.exit(2)
    }
    console.log(
      writeTypedNote(
        root,
        {
          name: m[1]!.trim(),
          title: m[2]!.trim(),
          description: m[3]!.trim(),
          body: m[4] ?? '',
        },
        options.type,
      ),
    )
  } else {
    console.error(usage)
    process.exit(2)
  }
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
}
