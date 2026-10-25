import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { matchTerms, splitSearchTerms } from './search-terms.ts'
/**
 * skill 库的只读检索（$SIMPLE_CODE_SKILL 的内核）。
 *
 * 和 lesson 的分工：lesson 是模型的自助成长区（可写），skill 是**用户
 * 指令区**：本工具只读（list/read/search）。编辑出口只有一个——
 * $SIMPLE_CODE_APPLY_PATCH（2026-09-27 拍板：编辑方言收敛，通道豁免见
 * approval.ts；2026-09-24 的 patch 子命令同批退役）。**用户级
 * （~/.simple-code）在项目外**，APPLY_PATCH 够不着，项目外写保留 bash
 * 审批门槛；同名时用户级覆盖项目级，改项目级等于改了个被遮住的文件。
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
  // 尾行挂钩（2026-09-26 拍板，替代 system prompt 常驻）：可选组件的装机
  // 指南在 self.md 第 11 节——list 是「不确定该怎么做时」的自然落点，
  // 在这指路 = 零常驻成本。searchSkills 按行首 [项目|用户] 匹配，尾行
  // 无此标记自动跳过，不会误进搜索结果
  out.push(
    '可选组件（未随包）：agent-browser 浏览器自动化 / opencli 登录态浏览器 /' +
      ' officecli Office 文档 / cua-driver 桌面 App——任务命中未装时问用户再装，' +
      '装法见 grep 可选能力 "$SIMPLE_CODE_DOC"',
  )
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

/** 全文搜索（lesson/note search 同款格式）。可见性沿 listSkills 的覆盖
 *  语义：用户级同名遮项目级——被遮住的项目级不进结果（搜到改不了的
 *  文件是误导）。2026-09-24 补的缺口：skill 曾只有 list/read 没有 search */
export function searchSkills(root: string, query: string): string {
  const terms = splitSearchTerms(query)
  if (terms.length === 0) throw new Error('search 需要 query，如 skill search 截图')
  const hits: { n: number; line: string }[] = []
  for (const line of listSkills(root)) {
    if (line.startsWith('没有已装的 skill')) break
    // listSkills 的行格式：name  [项目|用户]  description
    const m = /^(\S+)\s+\[(项目|用户)\]/.exec(line)
    if (!m) continue
    const name = m[1] as string
    const src = m[2] as '项目' | '用户'
    const text = readFileSync(fileOf(root, name, src), 'utf8')
    const tm = matchTerms(`${name} ${text}`, terms)
    if (!tm) continue
    const window = text.slice(Math.max(0, tm.at - 40), tm.at + 80).replace(/\s+/g, ' ')
    hits.push({ n: tm.count, line: `  ${name}  [${src}]\n    …${window}…` })
  }
  if (hits.length === 0) return `没有 skill 命中「${query}」。list 看全量清单。`
  const ranked = hits.map((h, i) => ({ h, i })).sort((a, b) => b.h.n - a.h.n || a.i - b.i)
  return `${hits.length} 条命中：\n${ranked.map((r) => r.h.line).join('\n')}`
}

function fileOf(root: string, name: string, src: '项目' | '用户'): string {
  const base = src === '用户' ? join(homedir(), '.simple-code') : join(root, '.simple-code')
  return join(base, 'skills', name, 'SKILL.md')
}
