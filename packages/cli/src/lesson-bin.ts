#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * $SIMPLE_CODE_LESSON 的 CLI 壳。教训库的读写检索（与 memory 同款形态，
 * 输出可管道组合——sed 取段、grep 过滤）：
 *
 *   "$SIMPLE_CODE_LESSON" list                     # 全部教训的 name + description
 *   "$SIMPLE_CODE_LESSON" read webview-asset-cache # 一条全文
 *   "$SIMPLE_CODE_LESSON" search 缓存              # 关键词找
 *   "$SIMPLE_CODE_LESSON" write <<'JSON'        # 五段走 stdin JSON（推荐：
 *   {                                            #  多行长文没有引号/flag 笔误面）
 *     "name": "webview-asset-cache",
 *     "title": "…", "description": "…",
 *     "symptom": "…", "misjudged": "…", "rootCause": "…",
 *     "fix": "…", "verified": "…"
 *   }
 *   JSON
 *
 *   write 也保留 --name/--title/--symptom/--misjudged/--root-cause/--fix/
 *   --verified 的 flag 形态（stdin 空时生效）；stdin 有内容但不是合法
 *   JSON 会报错——不静默回退，heredoc 引号打错时给出真因
 *
 * write 的五段用单引号包多行文本（内容里有单引号就先把段文本存临时文件
 * 再 cat 拼，别跟引号搏斗）。
 *
 * patch 子命令 2026-09-27 退役：局部改走 "$SIMPLE_CODE_APPLY_PATCH"
 * （目标 .simple-code/lessons/<name>.md，免审批）。
 */
import { readFileSync } from 'node:fs'
import { type LessonWriteInput, listLessons, parseStdinLessonInput, readLesson, searchLessons, writeLesson } from '@simple-code/core/src/tools/lesson.ts'
import { findWorkspaceRoot } from '@simple-code/core/src/tools/workspace-root.ts'

// 工作区根：cwd 可能是子目录（workspace-root.ts）
const root = findWorkspaceRoot(process.cwd())

const usage = `用法：
  lesson list                                   全部教训的描述清单（文件内二级筛选）
  lesson read <name>                            一条全文
  lesson search <关键词>                         全文找，命中带窗口
  lesson write <<'JSON'（stdin 传五段，推荐）
      {"name":"kebab","title":"…","description":"…","symptom":"…",
       "misjudged":"…","rootCause":"…","fix":"…","verified":"…"}
  或 lesson write --name <kebab> --title <一句话> …（flag 形态，stdin 空时用）`

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const [sub, target] = process.argv.slice(2)

try {
  if (sub === 'list') {
    console.log(listLessons(root))
  } else if (sub === 'read' && target) {
    console.log(readLesson(root, target))
  } else if (sub === 'search' && target) {
    console.log(searchLessons(root, target))
  } else if (sub === 'write') {
    const fromStdin = stdinJsonInput() as Partial<LessonWriteInput> | null
    console.log(
      writeLesson(root, {
        // 两种形态的字段校验都交给 writeLesson（缺段/坏名同一套报错）
        ...(fromStdin ?? {
          name: arg('--name') ?? '',
          title: arg('--title') ?? '',
          description: arg('--description') ?? '',
          symptom: arg('--symptom') ?? '',
          misjudged: arg('--misjudged') ?? '',
          rootCause: arg('--root-cause') ?? '',
          fix: arg('--fix') ?? '',
          verified: arg('--verified') ?? '',
        }),
      } as LessonWriteInput),
    )
  } else {
    console.log(usage)
    process.exitCode = sub === 'help' ? 0 : 1
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e))
  process.exitCode = 1
}

/** stdin 有内容时当 JSON 五段解析（解析在 core：parseStdinLessonInput，
 * 三态可测）。TTY（交互）或读不到 stdin 返回 null 走 flag 形态；有内容
 * 但解析失败的错误直接上抛——不静默回退 */
function stdinJsonInput(): Partial<LessonWriteInput> | null {
  if (process.stdin.isTTY) return null
  let text = ''
  try {
    text = readFileSync(0, 'utf8')
  } catch {
    return null
  }
  return parseStdinLessonInput(text)
}
