#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * $SIMPLE_CODE_SKILL 的 CLI 壳（与 lesson/memory 同款形态，输出可管道
 * 组合）。只读——写入走 bash 保留审批门槛（skill 是用户指令区）：
 *
 *   "$SIMPLE_CODE_SKILL" list          # 生效清单（来源标注 + 描述）
 *   "$SIMPLE_CODE_SKILL" read <name>   # 一条 SKILL.md 全文
 */
import { listSkills, readSkill } from '@simple-code/core/src/tools/skill.ts'

const [, , sub, target] = process.argv

try {
  if (sub === 'list') {
    console.log(listSkills(process.cwd()).join('\n'))
  } else if (sub === 'read' && target) {
    console.log(readSkill(process.cwd(), target))
  } else {
    console.log('用法：skill list | skill read <name>（只读；写入走 bash 保留审批）')
    process.exitCode = sub === 'help' ? 0 : 1
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e))
  process.exitCode = 1
}
