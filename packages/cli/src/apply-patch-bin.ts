#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * apply_patch 的 CLI 形态（web-tools §10 的同路注入）。用法：
 *   "$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'
 *   *** Begin Patch
 *   *** Update File: src/a.ts
 *   @@
 *    ctx
 *   -old
 *   +new
 *   *** End Patch
 *   PATCH
 *
 * 相对路径按工作区根解析（从 cwd 往上找，workspace-root.ts）——bash 的 cwd
 * 可能是子目录，工具描述承诺的是「相对工作区根」。补丁是
 * 原子的：任何一个文件操作失败，全部不落盘。stdout 出摘要（+N/-M），
 * 错误进 stderr、exit 1——配合 bash 的输出合并，模型一眼能看到失败原因。
 */
import { applyPatch, parsePatch } from '@simple-code/core/src/tools/applypatch.ts'
import { scanNoteFiles } from '@simple-code/core/src/tools/note-files.ts'
import { lintReport, wikiRootsOf } from '@simple-code/core/src/tools/wiki.ts'
import { findWorkspaceRoot } from '@simple-code/core/src/tools/workspace-root.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const USAGE =
  "用法：apply_patch <<'PATCH' … PATCH（补丁文本从 stdin 读，须以 *** Begin Patch 开头、*** End Patch 结尾）"

const arg = process.argv[2]
if (arg === '--help' || arg === '-h') {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}
const raw = arg ?? (await readStdin())
if (raw.trim() === '') {
  process.stderr.write(`${USAGE}\n`)
  process.exit(2)
}
const root = findWorkspaceRoot(process.cwd())
try {
  const summary = await applyPatch(root, raw)
  process.stdout.write(`${summary}\n`)
} catch (err) {
  process.stderr.write(`apply_patch 失败：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
// 改到词条目录（含别的项目的绝对路径）就跟一份检查——补丁已落盘，检查只提示；
// 检查自身出错也不能让上面已成功的补丁看起来失败
try {
  const paths = parsePatch(raw).flatMap((h) =>
    h.kind === 'update' && h.moveTo ? [h.path, h.moveTo] : [h.path],
  )
  for (const wikiRoot of wikiRootsOf(root, paths)) {
    const where = wikiRoot === root ? '' : `（${wikiRoot}）`
    process.stdout.write(`${where}${lintReport(wikiRoot, scanNoteFiles(wikiRoot, 'wiki'))}\n`)
  }
} catch (err) {
  process.stdout.write(`wiki 检查没跑完：${err instanceof Error ? err.message : String(err)}\n`)
}
