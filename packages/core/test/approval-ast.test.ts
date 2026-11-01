import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HIDDEN_ALLOW, DEFAULT_NETWORK_ALLOW, classify } from '../src/tools/approval.ts'
import { warmupShellParser } from '../src/tools/shell-ast.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * AST 路径（tree-sitter）的判定回归。approval.test.ts 不调 warmup、
 * parser 为 null，测的是正则回退；这里 beforeAll 预热后同表跑 AST 路径
 * ——两条供给，规则必须是同一套。
 */
beforeAll(async () => {
  expect(await warmupShellParser()).toBe(true)
})

const ROOT = '/Users/dev/Code/proj'
// 假 root 下文件都不存在：注入「都存在」，这里测的是第 1 层（按名字判）
// 与各类别规则；第 2 层（存在检查）在 hidden-path.test.ts 用真目录测
const cfg = { hiddenAllow: [...DEFAULT_HIDDEN_ALLOW], networkAllow: [...DEFAULT_NETWORK_ALLOW], askCommands: [], pathExists: () => true }
const ask = (cmd: string) => classify(cmd, ROOT, cfg)
const allow = (cmd: string) => expect(ask(cmd)).toEqual({ kind: 'allow' })
const blocked = (cmd: string, reasonIncludes: string) => {
  const v = ask(cmd)
  expect(v.kind).toBe('ask')
  if (v.kind === 'ask') expect(v.reason).toContain(reasonIncludes)
}

describe('AST 路径：与正则路径同规则的抽样回归', () => {
  it('`"((` grammar bug 绕行后按普通规则判：已批的 agent-browser eval 放行，藏着的危险段照弹（2026-09-30）', () => {
    const real = `export AGENT_BROWSER_SESSION="$(agent-browser session id --scope worktree --prefix hide-menu)"; agent-browser click @e4 && sleep 6 && agent-browser eval "(() => JSON.stringify([...document.querySelectorAll('.ant-menu-item')].filter(e=>e.offsetParent).map(e=>e.textContent.trim()).filter(Boolean)))()" 2>&1 | head -2`
    expect(classify(real, ROOT, { ...cfg, alwaysLeads: ['agent-browser eval'] })).toEqual({ kind: 'allow' })
    // 没批过：是可「始终允许」的 eval 卡，不再是无键的「$( ) 无法静态判定」
    const v = ask(real)
    expect(v).toMatchObject({ kind: 'ask', detail: 'eval', alwaysLead: 'agent-browser eval' })
    blocked('agent-browser eval "(() => 1)()" && rm -rf /etc/zz', '/etc/zz')
  })

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
  it('透传前缀（nohup/timeout/env/xargs …）后面的真命令照判（2026-10-30 实案）', () => {
    const t = { ...cfg, askCommands: ['git push', 'appctl build run'] }
    expect(
      classify(
        `cd ${ROOT}\nnohup appctl build run --env dev --wait > .simple-code/tmp/b.log 2>&1 &\necho "pid=$!"`,
        ROOT,
        t,
      ),
    ).toMatchObject({ kind: 'ask', category: 'ask_rule', detail: 'appctl build run' })
    for (const c of [
      'timeout -s KILL 30 git push',
      'nice -n 10 git push',
      'env A=1 git push',
      'echo dev | xargs -I {} git push origin {}',
      'nohup timeout 5 git push',
    ])
      expect(classify(c, ROOT, t), c).toMatchObject({ kind: 'ask', detail: 'git push' })
    blocked('nohup python3 x.py', '任意代码')
    // 写动词按内层算：外层 lead 是 nohup 时 rm 的参数曾被当读
    blocked('nohup rm .simple-code/memory/state.db', '写入')
    // 对照：内层无害、查询形态、无命令
    allow('nohup node server.js > .simple-code/tmp/s.log 2>&1 &')
    allow('command -v python3')
    allow('exec > .simple-code/tmp/x.log 2>&1')
    allow('ls | xargs -I{} wc -l {}')
  })

  it('重定向写在中间 / 命令前 / heredoc 起始行后照判（2026-10-30）', () => {
    blocked('echo > /etc/passwd x', '项目外')
    blocked('> /etc/passwd echo x', '项目外')
    blocked("cat <<'E' > /etc/passwd\nhi\nE", '项目外')
    // 批过 python3 也只免命令名那一层，写项目外照弹（真机形态）
    expect(
      classify(`cd ${ROOT} && python3 - <<'PY' > /tmp/x.patch\nprint(1)\nPY`, ROOT, {
        ...cfg,
        alwaysLeads: ['python3'],
      }),
    ).toMatchObject({ kind: 'ask', category: 'external_dir' })
    const t = { ...cfg, askCommands: ['git push'] }
    for (const c of ['> o.log git push', 'nohup > .simple-code/tmp/o.log git push'])
      expect(classify(c, ROOT, t), c).toMatchObject({ kind: 'ask', detail: 'git push' })
    // 对照：目标在项目内 / /dev/null、中间重定向后面的参数不再当写目标
    allow("cat <<'E' > .simple-code/tmp/ok.txt\nhi\nE")
    allow('grep -rn a src 2>/dev/null package.json')
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
    // 项目外点开头报隐藏路径（2026-09-30）；这里要验的是子命令被枚举到
    blocked('echo $(cat ~/.ssh/id_rsa)', '隐藏路径')
    blocked('echo file_$(rm ~/.zshrc)', '隐藏路径')
    allow('echo $(ls src)')
  })
  it('tr 的字符集不是路径；读重定向 < 是真文件，不进参数位豁免（2026-10-30）', () => {
    allow(`n="$(git rev-list --left-right --count a...b | tr '\\t' '/')"`)
    allow(`echo a/b | tr -d '/'`)
    // tr 读 stdin：`< 文件` 等于把文件内容打出来
    blocked('tr a b < /Users/dev/Desktop/y.txt', '项目外')
    blocked('tr -d x < ~/.ssh/id_rsa', '隐藏路径')
    // 同一个洞也在 nonPathFrom 豁免位上（xcli 第 2 位起豁免）
    const v = classify('xcli get f.pptx /body < /Users/dev/Desktop/y.txt', ROOT, {
      ...cfg,
      nonPathFrom: { xcli: 2 },
    })
    expect(v).toMatchObject({ kind: 'ask', category: 'external_dir' })
  })
  it('引号内的 | 和 ; 不再误切段（正则会切成多段，只影响收紧方向）', () => {
    allow('grep "a|b" src/x.ts')
    allow('git commit -m "fix; deploy"')
  })
  it('重定向目标 write 标记（file_redirect 兄弟节点）', () => {
    blocked('cat src/a.ts >> ~/.zshrc', '隐藏路径')
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
    blocked('echo "x$(cat ~/.ssh/id_rsa)y"', '隐藏路径')
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

describe('AST 路径：重定向在 && / 管道 / 复合语句里不再漏扫（2026-09-21 修）', () => {
  it('外层构造不影响重定向目标的判定', () => {
    // 修前：以下全放行——tree-sitter 把重定向抬到包住整个 list/管道/复合
    // 语句的 redirected_statement 上，commandToSegment 只往上看一层而漏扫
    blocked(`cd ${ROOT} && echo x > /etc/passwd`, '项目外')
    blocked('true && echo x > /etc/passwd', '项目外')
    blocked(`cd ${ROOT} && echo x >> /etc/passwd`, '项目外')
    blocked(`cd ${ROOT} || echo x > /etc/passwd`, '项目外')
    blocked(`cd ${ROOT} && echo x > .env`, '隐藏')
    blocked(`cd ${ROOT} && cat src/a.ts > ../outside.txt`, '项目外')
    blocked('echo x | cat > /etc/passwd', '项目外')
    blocked(`cd ${ROOT} && { echo x; } > /etc/passwd`, '项目外')
    // for/case 的循环体（do_group/case_item）曾不往里找最右命令，整个
    // 重定向没人认领（2026-10-31 修）
    blocked('for f in a; do echo x; done > /etc/passwd', '项目外')
    blocked('case a in a) echo x;; esac > /etc/passwd', '项目外')
    blocked('while read l; do echo $l; done < x > /etc/passwd', '项目外')
    // 项目内照旧放行——收紧不能变成见重定向就问
    allow(`cd ${ROOT} && echo x > out.txt`)
    allow('echo x | cat > out.txt')
    allow(`cd ${ROOT} && echo x > ${ROOT}/out.txt`)
  })
  it('重定向只归最右那条命令——不牵连左命令，也不漏右命令', () => {
    // `a > f && b`：重定向归 a（a 的直接父就是 redirected_statement，回归）
    blocked('echo x > /etc/passwd && true', '项目外')
    // `a && b > f`：b 的实参照样判——左命令不受牵连
    blocked(`cd ${ROOT} && cat /etc/shadow`, '项目外')
  })
  it('不带引号的 heredoc 在 && 形状下同样拦（body 会被 shell 展开）', () => {
    blocked(`cd ${ROOT} && cat <<EOF\n\`evil\`\nEOF`, '反引号')
    blocked(
      `cd ${ROOT} && "$SIMPLE_CODE_APPLY_PATCH" <<PATCH\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+\`rm -rf /tmp/x\`\n*** End Patch\nPATCH`,
      '反引号',
    )
    // 带引号的分隔符：body 是字面量，照旧放行
    allow(`cd ${ROOT} && "$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+\`ls\` 与 $(ls) 的文档段落\n*** End Patch\nPATCH`)
  })
  it('不带引号 heredoc 的字符判定：裸括号不再误报，转义反斜杠不再漏', () => {
    // 修前：body 里只有 foo() 也弹「unquoted heredoc」——凡带函数调用的
    // 补丁全中；(` 在无引号 heredoc 里不展开，纯误报）
    allow(`cd ${ROOT} && "$SIMPLE_CODE_APPLY_PATCH" <<PATCH\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x = foo()\n+y = bar()\n*** End Patch\nPATCH`)
    // 修前：\\ 会被 shell 吃掉一个（补丁内容静默变形）却放行
    blocked(`cd ${ROOT} && cat <<EOF\nx = "a\\\\b"\nEOF`, '反斜杠')
  })
  it('规则 0（裸 apply_patch 开头）也查不带引号的 heredoc', () => {
    blocked('"$SIMPLE_CODE_APPLY_PATCH" <<PATCH\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+`rm -rf /tmp/x`\n*** End Patch\nPATCH', '反引号')
    allow('"$SIMPLE_CODE_APPLY_PATCH" <<\'PATCH\'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+`ls` 与 $(ls) 的文档段落\n*** End Patch\nPATCH')
  })
})

describe('AST 路径：自家 bin 的不带引号 heredoc 弹卡（stdin 展开旁路，2026-09-24 收口）', () => {
  // NOTE/LESSON 的 write 吃 heredoc stdin——不带引号的分隔符 body 会被
  // shell 展开（$( ) 任意命令）。SKILL 的 patch 2026-09-27 退役，但规则
  // 对任意自家 bin 的不带引号 heredoc 通用，保留一个虚构形态测机制。
  // 必须挂 wasm 测——正则回退路径看不见 heredoc 结构
  it('不带引号的分隔符 + body 含 $/反引号 → 弹卡（unparseable）', () => {
    for (const cmd of [
      `"$SIMPLE_CODE_NOTE" write <<MD\nname: $(rm -rf /)\nMD`,
      `"$SIMPLE_CODE_LESSON" write <<JSON\n{"name":"x $y"}\nJSON`,
      `"$SIMPLE_CODE_SKILL" read <<PATCH\nbody $x\nPATCH`,
      `"$SIMPLE_CODE_APPLY_PATCH" <<PATCH\nbody $x\nPATCH`,
    ]) {
      const v = ask(cmd)
      if (v.kind !== 'ask') throw new Error(`应弹卡：${cmd}`)
      if (v.category !== 'unparseable') throw new Error(`category 应为 unparseable：${cmd}`)
    }
  })
  it('采集键=bin 本体：批「始终允许」后同形态免审', () => {
    const v = ask(`"$SIMPLE_CODE_NOTE" write <<MD\n$x\nMD`)
    if (v.kind === 'ask') expect(v.alwaysLead).toBe('$SIMPLE_CODE_NOTE')
    else throw new Error('未批白名单时应弹卡')
    const cfgN = { ...cfg, alwaysLeads: ['$SIMPLE_CODE_NOTE'] }
    expect(classify(`"$SIMPLE_CODE_NOTE" write <<MD\n$x\nMD`, ROOT, cfgN)).toEqual({ kind: 'allow' })
  })
  it('带引号的分隔符（通道用法样例的形态）照放', () => {
    allow(`"$SIMPLE_CODE_NOTE" write <<'MD'\nname: foo\ntitle: t\ndescription: d\n---\n正文\nMD`)
    allow(`"$SIMPLE_CODE_LESSON" write <<'JSON'\n{"name":"x"}\nJSON`)
  })
})

describe('multi 同质 external_dir 的批量 always（2026-09-21 方案 1）', () => {
  // 真目录（mkdtemp）：dirHint 对存在的目录记本身——非存在路径会记父
  // 目录，断言就测不准「记各目录」了。转成真实形态（/var→/private/var）：
  // classify 的 detail 走链接解析，alwaysPaths 记的是真实路径
  const mk = () => realpathSync(mkdtempSync(join(tmpdir(), 'sc-multi-always-')))
  const rm = (d: string) => rmSync(d, { recursive: true, force: true })

  it('触发点全是项目外目录：alwaysPaths 记各目录', () => {
    const a = mk()
    const b = mk()
    try {
      const v = ask(`ls ${a}; ls ${b}`)
      expect(v.kind).toBe('ask')
      if (v.kind === 'ask') {
        expect(v.category).toBe('multi')
        expect(v.alwaysPaths).toEqual([a, b])
      }
    } finally {
      rm(a)
      rm(b)
    }
  })

  it('同一目录两处触发：去重成一条', () => {
    const a = mk()
    try {
      const v = ask(`ls ${a}; cat ${a}/f.md`)
      expect(v.kind).toBe('ask')
      if (v.kind === 'ask') expect(v.alwaysPaths).toEqual([a])
    } finally {
      rm(a)
    }
  })

  it('掺了解释器：维持两键（无 alwaysPaths）', () => {
    const v = ask('cd /Users/dev && python3 -c "print(1)"')
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.category).toBe('multi')
      expect(v.alwaysPaths).toBeUndefined()
      expect(v.alwaysLead).toBeUndefined()
    }
  })

  it('multi 带各段类别：桌面机器人据此判「git push 混在 && 里」只能回窗口处理', () => {
    const v = classify('cd /Users/dev && git push origin main', ROOT, { ...cfg, askCommands: ['git push'] })
    expect(v).toMatchObject({ kind: 'ask', category: 'multi' })
    if (v.kind === 'ask') expect([...(v.parts ?? [])].sort()).toEqual(['ask_rule', 'external_dir'])
    // 单一触发不是 multi，类别本身就是答案，不带 parts
    const one = classify('git push origin main', ROOT, { ...cfg, askCommands: ['git push'] })
    expect(one).toMatchObject({ kind: 'ask', category: 'ask_rule' })
    if (one.kind === 'ask') expect(one.parts).toBeUndefined()
  })

  it('含过宽目录（家目录直下的文件）：不给批量 always', () => {
    // ~/.zshrc 的 dirHint 是家目录本身——过宽防线返回 null，这张卡里
    // 混进了一个不能记的触发点，一键全记就成了谎话
    const a = mk()
    try {
      const v = ask(`ls ${a}; cat ~/.zshrc`)
      expect(v.kind).toBe('ask')
      if (v.kind === 'ask') expect(v.alwaysPaths).toBeUndefined()
    } finally {
      rm(a)
    }
  })

  it('去重后超过 5 个目录：不给（一笔大账逼你分开看）', () => {
    const base = mk()
    const dirs = [1, 2, 3, 4, 5, 6].map((i) => join(base, `d${i}`))
    try {
      for (const d of dirs) mkdirSync(d)
      const v = ask(dirs.map((d) => `ls ${d}`).join(';'))
      expect(v.kind).toBe('ask')
      if (v.kind === 'ask') expect(v.alwaysPaths).toBeUndefined()
      // 恰好 5 个：给
      const v5 = ask(dirs.slice(0, 5).map((d) => `ls ${d}`).join(';'))
      expect(v5.kind).toBe('ask')
      if (v5.kind === 'ask') expect(v5.alwaysPaths).toHaveLength(5)
    } finally {
      rm(base)
    }
  })

  it('单触发 external_dir 不带 alwaysPaths（走原有的单目录卡）', () => {
    const a = mk()
    try {
      const v = ask(`ls ${a}`)
      expect(v.kind).toBe('ask')
      if (v.kind === 'ask') {
        expect(v.category).toBe('external_dir')
        expect(v.alwaysPaths).toBeUndefined()
      }
    } finally {
      rm(a)
    }
  })
})
