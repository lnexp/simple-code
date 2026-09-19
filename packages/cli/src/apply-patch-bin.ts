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
 * 相对路径按当前工作目录解析（bash 工具的 cwd 就是工作区根）。补丁是
 * 原子的：任何一个文件操作失败，全部不落盘。stdout 出摘要（+N/-M），
 * 错误进 stderr、exit 1——配合 bash 的输出合并，模型一眼能看到失败原因。
 */
import { applyPatch } from '@simple-code/core/src/tools/applypatch.ts'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const raw = process.argv[2] ?? (await readStdin())
if (raw.trim() === '') {
  process.stderr.write('用法：apply_patch <<\'PATCH\' … PATCH（补丁文本从 stdin 读）\n')
  process.exit(2)
}
try {
  const summary = await applyPatch(process.cwd(), raw)
  process.stdout.write(`${summary}\n`)
} catch (err) {
  process.stderr.write(`apply_patch 失败：${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
