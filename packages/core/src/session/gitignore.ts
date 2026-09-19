import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * 把 `.simple-code/` 排除出 git——「记忆存项目内」方案的欠账。
 *
 * 记忆（turns/*.jsonl）全量落盘了会话读过的所有文件内容，忘加忽略时
 * 一发 `git add -A && git push` 就是不可逆泄露（force push 收不回已
 * clone 的副本）。所以排除不能指望用户记得，启动时自动做。
 *
 * 为什么写 `.git/info/exclude` 而不是 `.gitignore`：后者是版本库内容，
 * 替用户改会被提交/分发；前者仓库本地生效、不进版本库，是工具类软件
 * 的标准做法。
 *
 * 失败一律静默（非 git 仓库、git 不在、没权限）——这是锦上添花逻辑，
 * 不能挡会话启动。例外：已被 track 时必须响（静默剥离会让用户困惑
 * 半天，CLAUDE.md §1.2）。
 */
export function ensureGitIgnored(root: string): void {
  try {
    // git -C 在非 git 目录上退出码非 0——普通目录打开项目是正常情况
    let gitDir = execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
      timeout: 2000,
      // execFileSync 不显式设 stdio 时子进程 stderr 直通终端——非 git 目录
      // 每次启动都打一行 fatal，纯属噪音（错误已走 catch 分支）
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (!isAbsolute(gitDir)) gitDir = join(root, gitDir) // 相对输出是相对 root 的

    // 已被忽略（.gitignore / exclude / 配置，任意来源盖住即算）：完成
    try {
      execFileSync('git', ['-C', root, 'check-ignore', '-q', '.simple-code'], {
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return
    } catch {
      /* 未忽略 → 继续 */
    }

    // 已被 track：不动用户的索引（git rm --cached 是用户的决定），
    // 只警告——这时 exclude 写了也不生效，写了反而掩盖问题
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '.simple-code'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    if (tracked !== '') {
      console.warn(
        '[memory] .simple-code 已被 git 跟踪——记忆含会话读过的全部文件内容，' +
          '建议尽快 `git rm -r --cached .simple-code` 并检查远端历史',
      )
      return
    }

    // 追加 exclude，按行去重（用户可能手写过变体）
    const excludePath = join(gitDir, 'info', 'exclude')
    let existing = ''
    try {
      existing = readFileSync(excludePath, 'utf8')
    } catch {
      /* 不存在 → 空 */
    }
    const alreadyThere = existing
      .split('\n')
      .some((l) => l.trim() === '.simple-code' || l.trim() === '.simple-code/')
    if (!alreadyThere) {
      mkdirSync(join(gitDir, 'info'), { recursive: true })
      const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
      appendFileSync(excludePath, `${prefix}.simple-code/\n`)
    }
  } catch {
    /* git 缺席/超时/无权限：不值得为它打断启动 */
  }
}
