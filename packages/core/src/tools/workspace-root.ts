import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * $SIMPLE_CODE_* 这几个 bin（apply-patch/note/lesson/event/skill）认工作区根
 * 用的：从 cwd 往上找第一个带 `.simple-code/memory` 的目录。bash 工具有 cwd
 * 参数、命令里也常先 cd，直接拿 process.cwd() 当根，一进子目录就全找不到
 * （2026-09-29 实案：在 packages/vscode 下打补丁报「不存在」、event read
 * 报「可能已改名」）。
 *
 * 标记用 memory 子目录而不是 `.simple-code` 本身：~/.simple-code 是用户级
 * 配置，同名但没有 memory——只认 `.simple-code` 的话，家目录下任何没开过
 * SC 的路径都会被认成工作区。与 memory.ts findMemoryRoot 同一判据。
 *
 * 一路找不到（没开过 SC 的目录、终端里手敲）退回 cwd，保持原行为。
 */
export function findWorkspaceRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; ) {
    if (existsSync(join(dir, '.simple-code', 'memory'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return cwd
    dir = parent
  }
}
