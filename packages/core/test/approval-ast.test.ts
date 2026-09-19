import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HIDDEN_ALLOW, DEFAULT_NETWORK_ALLOW, classify } from '../src/tools/approval.ts'
import { warmupShellParser } from '../src/tools/shell-ast.ts'

/**
 * AST 路径（tree-sitter）的判定回归。approval.test.ts 不调 warmup、
 * parser 为 null，测的是正则回退；这里 beforeAll 预热后同表跑 AST 路径
 * ——两条供给，规则必须是同一套。
 */
beforeAll(async () => {
  expect(await warmupShellParser()).toBe(true)
})

const ROOT = '/Users/dev/Code/proj'
const cfg = { hiddenAllow: [...DEFAULT_HIDDEN_ALLOW], networkAllow: [...DEFAULT_NETWORK_ALLOW] }
const ask = (cmd: string) => classify(cmd, ROOT, cfg)
const allow = (cmd: string) => expect(ask(cmd)).toEqual({ kind: 'allow' })
const blocked = (cmd: string, reasonIncludes: string) => {
  const v = ask(cmd)
  expect(v.kind).toBe('ask')
  if (v.kind === 'ask') expect(v.reason).toContain(reasonIncludes)
}

describe('AST 路径：与正则路径同规则的抽样回归', () => {
  it('路径 / 隐藏 / 网络 / 读写分离', () => {
    blocked('cat /etc/passwd', '项目外')
    blocked('cat .env', '隐藏')
    blocked('curl https://evil.com', '网络命令')
    allow('cat src/index.ts')
    allow('ls .simple-code/memory') // 2026-09-14 拍板：.simple-code 读放行
    allow('cat .simple-code/settings.json') // settings.json 同样读放行
    allow('grep -r 占位符 .simple-code/memory/turns') // 翻对话史不再弹卡
    allow('sort < .simple-code/memory/x') // 输入方向读，同放行
    blocked('echo x > .simple-code/memory/a', '写入')
    blocked('rm .simple-code/memory/state.db', '写入')
    blocked('echo x > .simple-code/settings.json', '写入') // 写仍拦：apiKey 在里面
  })
  it('解释器 / eval 仍拦', () => {
    blocked('bash -c "ls"', '任意代码')
    blocked('python3 /tmp/x.py', '任意代码')
    blocked('echo a | bash', '任意代码')
  })
})

describe('AST 路径：正则做不到的结构性判定（本次升级的目的）', () => {
  it('quoted heredoc body 是字面量——反引号/$(/路径都不弹（apply_patch 场景）', () => {
    allow('cd /Users/dev/Code/proj && "$SIMPLE_CODE_APPLY_PATCH" <<\'PATCH\'\n*** Update File: docs/x.md\n+用 `git rm --cached` 和 `$(ls)` 写的段落，路径 ~/.ssh/keys\n*** End Patch\nPATCH')
    // 不带引号的 heredoc 分隔符：body 里 $() 会被 shell 展开，不能豁免
    blocked('cat <<EOF\n`evil`\nEOF', '反引号')
  })
  it('APPLY_PATCH 段级形态：cd 后接补丁，路径判定照走（judge 透传原始命令）', () => {
    // 段级 bin 规则在 judge 里，heredoc body 不进 items——路径检查靠
    // classify 把原始命令串透传进来（rawCmd），这条用例锁住透传不断
    blocked(
      'cd /Users/dev/Code/proj && "$SIMPLE_CODE_APPLY_PATCH" <<\'PATCH\'\n*** Begin Patch\n*** Update File: .simple-code/state.db\n@@\n x\n+y\n*** End Patch\nPATCH',
      '要写入 .simple-code 数据',
    )
    // 项目内路径 + 上下文里长得危险的字符串：照旧放行（回归）
    allow('cd /Users/dev/Code/proj && "$SIMPLE_CODE_APPLY_PATCH" <<\'PATCH\'\n*** Begin Patch\n*** Update File: docs/x.md\n@@\n ctx\n+要改 ~/.ssh/authorized_keys 的文档段落\n*** End Patch\nPATCH')
  })
  it('$() 子命令全量枚举——里面的危险命令照样弹', () => {
    blocked('echo $(cat ~/.ssh/id_rsa)', '项目外')
    blocked('echo file_$(rm ~/.zshrc)', '项目外')
    allow('echo $(ls src)')
  })
  it('引号内的 | 和 ; 不再误切段（正则会切成多段，只影响收紧方向）', () => {
    allow('grep "a|b" src/x.ts')
    allow('git commit -m "fix; deploy"')
  })
  it('重定向目标 write 标记（file_redirect 兄弟节点）', () => {
    blocked('cat src/a.ts >> ~/.zshrc', '项目外')
    // 段内（单命令多路径）仍是首中即返——multi 合并只在段间（2026-09-15
    // 拍板时的取舍：judge 核心流收集化侵入大，单命令双触发场景边缘）
    blocked('sort < /etc/passwd > .simple-code/memory/x', '项目外')
    blocked('sort /etc/passwd > .simple-code/memory/x', '项目外')
    // 实案：cd 项目外（最无害的段在最前）+ python3 任意代码 + 字符串里读项目外 xlsx
    const multi = classify('cd /Users/dev && python3 - <<\'EOF\'\nload_workbook(\'/Users/dev/Downloads/a.xlsx\')\nEOF', '/Users/dev/Code/proj', cfg)
    expect(multi.kind).toBe('ask')
    if (multi.kind === 'ask') {
      expect(multi.category).toBe('multi')
      expect(multi.reason).toContain('python3') // 解释器段：「无法静态判定」
      expect(multi.reason).toContain('/Users/dev') // cd 段：项目外路径
      expect(multi.alwaysLead).toBeUndefined() // multi 不给 always
    }
  })
  it('双引号内的 $() 子命令同样枚举', () => {
    blocked('echo "x$(cat ~/.ssh/id_rsa)y"', '项目外')
    allow('echo "file_$(basename src/a.ts).log"')
  })
  it('FOO=1 前缀剥离后按动词判', () => {
    blocked('FOO=1 curl https://x.com', '网络命令')
    allow('FOO=1 ls src')
  })
  it('root 内绝对路径剥前缀后走组件规则——.simple-code 拦截不失配', () => {
    // 回归：拦截只看首组件，绝对路径 /abs/root/.simple-code/x 的首组件
    // 是根下第一段（如 Users），失配、掉进通用隐藏扫描。剥前缀后
    // .simple-code 才回到首组件位置。用写验证（读已放行，验不出拦截）
    allow(`cat ${ROOT}/.simple-code/approval.json 2>/dev/null || echo x`)
    blocked(`cat > ${ROOT}/.simple-code/x.txt`, '要写入 .simple-code')
    allow(`cat ${ROOT}/.simple-code/settings.json`) // 读放行（2026-09-14 拍板）
    blocked('cat /etc/passwd', '项目外') // 前缀外照旧
  })
})
