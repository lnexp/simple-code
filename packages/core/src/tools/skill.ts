import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * skill 库的只读检索（$SIMPLE_CODE_SKILL 的内核）。
 *
 * 和 lesson 的分工：lesson 是模型的自助成长区（可写），skill 是**用户
 * 指令区**——用户点名才触发、模型只有读的份（写入走 bash 保留审批门槛，
 * 这是 turn 318 拍的板）。所以这里只有 list/read，没有 write。
 *
 * 两级目录、同名覆盖（system prompt 的约定原样落进代码）：
 * - 项目 `.simple-code/skills/<name>/SKILL.md`
 * - 用户 `~/.simple-code/skills/<name>/SKILL.md`（**同名时盖过项目级**）
 *
 * 目录缺失是正常情况（一个 skill 都没装过），list 给空态提示而不是错。
 */

/** front matter 可选：有 description 用它（lesson 同款一行式），没有则
 * 取正文首个非空行截断——list 的筛选价值不能因为没有 front matter 就丢 */
function describe(file: string): string {
  const text = readFileSync(file, 'utf8')
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  if (m) {
    const d = /^description:\s*(.+)$/m.exec(m[1] ?? '')
    if (d?.[1]) return d[1].trim()
  }
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#') && l !== '---')
  return (first ?? '').slice(0, 60)
}

/** 生效清单：项目级打底，用户级同名覆盖。返回按名字排序 */
export function listSkills(root: string): string[] {
  const out: string[] = []
  const seen = new Map<string, '项目' | '用户'>()
  const roots: Array<[string, '项目' | '用户']> = [
    [join(root, '.simple-code', 'skills'), '项目'],
    [join(homedir(), '.simple-code', 'skills'), '用户'],
  ]
  for (const [dir, src] of roots) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(file)) continue
      seen.set(entry.name, src) // 后进的（用户级）盖先前的
    }
  }
  for (const [name, src] of [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`${name}  [${src}]  ${describe(fileOf(root, name, src))}`)
  }
  if (out.length === 0) {
    out.push(
      '没有已装的 skill。位置：项目 .simple-code/skills/<name>/SKILL.md 或' +
        ' ~/.simple-code/skills/<name>/SKILL.md（用户级同名覆盖项目级）。',
    )
  }
  return out
}

/** read：用户级优先（覆盖语义）。都找不到时报错并给出两个候选路径 */
export function readSkill(root: string, name: string): string {
  for (const src of ['用户', '项目'] as const) {
    const file = fileOf(root, name, src)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  throw new Error(
    `skill ${name} 不存在。看了：${fileOf(root, name, '用户')} 和 ${fileOf(root, name, '项目')}。` +
      '可用清单：skill list。',
  )
}

function fileOf(root: string, name: string, src: '项目' | '用户'): string {
  const base = src === '用户' ? join(homedir(), '.simple-code') : join(root, '.simple-code')
  return join(base, 'skills', name, 'SKILL.md')
}
