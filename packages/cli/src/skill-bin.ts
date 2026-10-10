#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * $SIMPLE_CODE_SKILL 的 CLI 壳（与 lesson/memory 同款形态，输出可管道
 * 组合）。只读三件套；项目级 SKILL.md 的编辑走 "$SIMPLE_CODE_APPLY_PATCH"
 * （patch 子命令 2026-09-27 退役）；用户级在 ~/.simple-code，项目外写
 * 走 bash 保留审批门槛：
 *
 *   "$SIMPLE_CODE_SKILL" list          # 生效清单（来源标注 + 描述）
 *   "$SIMPLE_CODE_SKILL" read <name>   # 一条 SKILL.md 全文
 *   "$SIMPLE_CODE_SKILL" search <关键词> # name+SKILL.md 全文命中（用户级遮蔽语义同 list）
 */
import { listSkills, readSkill, searchSkills } from '@simple-code/core/src/tools/skill.ts'
import { findWorkspaceRoot } from '@simple-code/core/src/tools/workspace-root.ts'

// 工作区根：cwd 可能是子目录（workspace-root.ts）
const root = findWorkspaceRoot(process.cwd())

const [, , sub, target] = process.argv

try {
  if (sub === 'list') {
    console.log(listSkills(root).join('\n'))
  } else if (sub === 'search' && target) {
    console.log(searchSkills(root, target))
  } else if (sub === 'read' && target) {
    console.log(readSkill(root, target))
  } else {
    console.log('用法：skill list | skill read <name> | skill search <关键词>（编辑走 "$SIMPLE_CODE_APPLY_PATCH"；用户级 ~/.simple-code 写走 bash 保留审批）')
    process.exitCode = sub === 'help' ? 0 : 1
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e))
  process.exitCode = 1
}
