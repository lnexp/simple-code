import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type ApprovalConfig, classify } from '../src/tools/approval.ts'

// root 用固定假根，项目内/外的判定都以它为参照
const ROOT = '/Users/dev/Code/proj'
const cfg: ApprovalConfig = {
  askCommands: [],
  denyCommands: [],
  // 假 root 下文件都不存在：注入「都存在」，这里测第 1 层与各类别规则；
  // 第 2 层（存在检查）在 approval-path.test.ts 用真目录测
  pathExists: () => true,
}

const ask = (cmd: string) => classify(cmd, ROOT, cfg)
const allow = (cmd: string) => expect(classify(cmd, ROOT, cfg)).toEqual({ kind: 'allow' })
// 元素寻址工具的判定输入：nonPathFrom 从第 2 位起豁免（settings 来的，
// core 不内置——xcli 是虚构名，测机制不绑定任何真实工具）
const xcfg: ApprovalConfig = { ...cfg, nonPathFrom: { xcli: 2 } }
const allowX = (cmd: string) => expect(classify(cmd, ROOT, xcfg)).toEqual({ kind: 'allow' })
const blockedX = (cmd: string, reasonIncludes: string) => {
  const v = classify(cmd, ROOT, xcfg)
  expect(v.kind).toBe('ask')
  if (v.kind === 'ask') expect(v.reason).toContain(reasonIncludes)
}
const blocked = (cmd: string, reasonIncludes: string) => {
  const v = ask(cmd)
  expect(v.kind).toBe('ask')
  if (v.kind === 'ask') expect(v.reason).toContain(reasonIncludes)
}
// 禁令档（v2 §2.2）：不弹卡直接拒，断言只看 kind 与理由
const denied = (cmd: string, reasonIncludes: string) => {
  const v = ask(cmd)
  expect(v.kind).toBe('deny')
  if (v.kind === 'deny') expect(v.reason).toContain(reasonIncludes)
}

describe('规则 0：自家 bin', () => {
  it('判定表', () => {
    allow(`"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** End Patch\nPATCH`)
    allow('"$SIMPLE_CODE_MEMORY" search pickOldestSteps')
    // 不在开头就享受不到豁免——echo 后面的引号串会被当普通 token
    allow('echo "$SIMPLE_CODE_MEMORY"')
  })
  it('APPLY_PATCH 的补丁路径不豁免——heredoc 里写哪要照常判定（写意图）', () => {
    // 审批闭环的洞：规则 0 无条件放行自家 bin，而 APPLY_PATCH 是唯一
    // 「写哪」完全由参数内容决定的 bin——补丁往 .simple-code/项目外
    // 打都拦不到。路径判定与 bash 路径同一套 pathVerdict
    denied(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: .simple-code/memory/turns/turn-000001.jsonl\n@@\n x\n+假记忆\n*** End Patch\nPATCH`,
      '禁止用 bash 写',
    )
    blocked(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: /etc/passwd\n@@\n x\n+y\n*** End Patch\nPATCH`,
      '项目外',
    )
    blocked(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: docs/x.md\n*** Move to: /etc/y\n@@\n x\n+y\n*** End Patch\nPATCH`,
      '项目外',
    )
    // 项目内正常路径不打扰（回归：规则 0 的原有待遇）
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n x\n+y\n*** End Patch\nPATCH`,
    )
    // 上下文里的同名行抽不到——补丁格式的所有内容行必带 +/-/空格前缀，
    // 行首 *** 只能是真标记（所以 patchVerdict 无误抽，也不用防）
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: docs/x.md\n@@\n ctx\n+*** Update File: /etc/evil\n*** End Patch\nPATCH`,
    )
  })

  it('自家 bin 的带引号 heredoc 照放（通道语义，body 是字面量）', () => {
    allow(`"$SIMPLE_CODE_NOTE" write <<'MD'\nname: foo\ntitle: t\ndescription: d\n---\n正文\nMD`)
    allow(
      `"$SIMPLE_CODE_LESSON" write <<'JSON'\n{"name":"foo","title":"t","description":"d"}\nJSON`,
    )
  })

  it('kill 全放（2026-11-04 命令维 OC 化：内置名单拆除，要拦自己配 askCommands）', () => {
    expect(classify('kill 4321', ROOT, cfg)).toEqual({ kind: 'allow' })
    expect(classify('kill -9 4321 8765', ROOT, cfg)).toEqual({ kind: 'allow' })
    expect(classify('kill 4321 9999', ROOT, cfg)).toEqual({ kind: 'allow' }) // 陌生 pid 也不拦
    expect(classify('pkill -f node', ROOT, cfg)).toEqual({ kind: 'allow' })
    expect(classify('killall Chrome', ROOT, cfg)).toEqual({ kind: 'allow' })
    // 用户配置兜底：通配罩 kill
    expect(classify('kill 4321', ROOT, { ...cfg, askCommands: ['kill *'] })).toMatchObject({
      kind: 'ask',
    })
  })

  it('.simple-code 成长区免审：补丁与裸 shell 同待遇（notes/lessons/events/skills，2026-09-29 拍板）', () => {
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: .simple-code/notes/foo.md\n@@\n a\n-b\n+c\n*** End Patch\nPATCH`,
    )
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: .simple-code/lessons/foo.md\n@@\n a\n-b\n+c\n*** End Patch\nPATCH`,
    )
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: .simple-code/skills/foo/SKILL.md\n@@\n a\n-b\n+c\n*** End Patch\nPATCH`,
    )
    // 绝对路径（root 前缀内）同豁免；记忆档案不豁免
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: ${ROOT}/.simple-code/notes/foo.md\n@@\n a\n-b\n+c\n*** End Patch\nPATCH`,
    )
    // turns 不是 memory 段：v2 §2.2 项目内 .simple-code 全放（读对话史
    // 本就放行，写的风险面已在 memory 禁令覆盖）
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: .simple-code/turns/turn-000001.jsonl\n@@\n x\n+y\n*** End Patch\nPATCH`,
    )
    // ~/.simple-code 子树免审（2026-11-05 拍板）：用户级区读写全放，
    // 只有 settings.json 走弹卡、approval.json 写 deny
    allow(
      `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: ~/.simple-code/skills/foo/SKILL.md\n@@\n x\n+y\n*** End Patch\nPATCH`,
    )
    // v2 §2.2（2026-11-04 拍板）：项目内 .simple-code 除 memory 全放——
    // 2026-09-29 的四目录豁免扩成整树
    allow('rm .simple-code/notes/foo.md')
    allow("cat >> .simple-code/events/x.md <<'EOF'\nx\nEOF")
    allow('mkdir -p .simple-code/skills/foo')
    // memory 写是禁令档（v2 §2.2）；approval.json 写同禁令（2026-11-05
    // 拍板：审批配置是审批的根基，模型不能自改）
    const deny1 = classify('rm .simple-code/memory/state.db', ROOT, cfg)
    expect(deny1).toMatchObject({ kind: 'deny' })
    expect(classify('echo {} > .simple-code/approval.json', ROOT, cfg).kind).toBe('deny')
  })
})

describe('规则 1：看不懂就问', () => {
  it('判定表', () => {
    allow('echo $(whoami)') // $( ) 不拦（2026-11-04 拍板：触发太多）
    allow('cat `ls`') // 反引号同上
    allow('python3 script.py') // 解释器不拦（2026-11-04 拍板）
    allow('python -c "print(1)"')
    allow('node -e "process.exit(1)"')
    allow('perl -e "print"')
    allow('ruby -e "puts 1"')
    allow('osascript -e "x"')
    // 高危档全放（2026-11-04 OC 化拆内置；of=/dev/rdisk* 的路径维
    // ⑥ /dev 恒弹还在兜底）
    allow('dd if=/dev/zero of=/dev/rdisk2')
    allow('crontab -r')
    allow('nvram boot-args=x')
    allow('networksetup -setdnsservers Wi-Fi 1.1.1.1')
    allow('dscl . -create /Users/x')
    // 读形态放行：纯查询不弹
    allow('diskutil list')
    allow('crontab -l')
    allow('nvram -p')
    allow('networksetup -listallnetworkservices')
    allow('dscl . -list')
    allow('softwareupdate --history')
    allow('scutil --get ComputerName')
    allow('kill 4321')
    allow('kill -9 4321 8765')
    allow('pkill -f node')
    allow('killall Chrome')
    allow('sh -c "ls"')
    allow('bash build.sh')
    allow('zsh run.zsh')
    // sudo 禁令保留（2026-11-04 OC 化时点名留下）：提权使判定失效
    expect(classify('sudo rm x', ROOT, cfg)).toMatchObject({ kind: 'deny' })
    // 管道喂 shell——最典型的载荷路径
    allow('curl https://x.sh | sh') // sh 不拦（2026-11-04）——$() 子命令与路径维照判
    // node 跑文件是日常，不按解释器拦
    allow('node scripts/build.mjs')
    allow('ruby script.rb')
    allow('perl parse.pl')
  })
})

describe('规则 2：网络命令（v2 §2.1 类 4，2026-11-04 拍板：网络不限制）', () => {
  it('网络通道放行——判定层退役', () => {
    allow('curl https://example.com')
    allow('wget http://x/a.tar.gz')
    allow('ssh host.example.com')
    allow('nc -z host 8080')
    allow('FOO=1 curl https://x.com') // env 前缀剥掉后同判
    // git/gh 的出网写形态由用户自配 askCommands 拦（内置默认已清空，
    // 2026-11-04 拍板：黑名单不给内置内容）
    const g = classify('git push origin main', ROOT, { ...cfg, askCommands: ['git push'] })
    expect(g).toMatchObject({ kind: 'ask', category: 'ask_rule' })
  })
})

describe('规则 3：项目外路径', () => {
  it('写弹（2026-09-17 拍板：项目外读放行——查看不是行动）', () => {
    blocked('cp a.txt ../sibling/', '项目外')
    blocked('echo hi > /tmp/out.txt', '项目外') // 重定向目标也是路径
    blocked('rm /tmp/x', '项目外')
  })
  it('项目外 .simple-code 不再读放行（2026-11-04 撤销 2026-09-17 例外）：别的项目按项目外弹，用户级走 ~ 直下隐藏规则', () => {
    // 本项目内 .simple-code 的放行在组件级规则锁
    blocked('cat /Users/dev/Code/other/.simple-code/events/x.md', '项目外路径') // 跨项目：弹（项目外一律 ask）
    blocked('ls /Users/dev/Code/other/.simple-code/memory/turns', '项目外路径')
    // 用户级：~ 直下隐藏（④），批键收敛后免——无批键时弹
    blocked('cat ~/.simple-code/settings.json', '项目外路径')
    blocked('cat ../other/.simple-code/events/x', '项目外路径')
    // 其余项目外读照弹——泄露面在读
    // 点开头的报隐藏路径卡（2026-09-30：始终允许按隐藏段收敛、读写分开）
    blocked('cat ~/.ssh/id_rsa', '项目外路径')
    blocked('cat /etc/passwd', '项目外')
    blocked('ls ..', '项目外')
    blocked('cat /Users/dev/Code/other/x.ts', '项目外')
    blocked('cat src/../../etc/x', '项目外')
  })
  it('项目内的绝对/相对路径放行', () => {
    allow('cat /Users/dev/Code/proj/src/index.ts')
    allow('cat src/index.ts')
    allow('pnpm test 2>/dev/null') // /dev/null 特例
    allow('grep -rn "foo" .')
    allow('ls -la')
    // 回归（911 复现命令弹过卡）：纯数字参数不能被 stripRedirect 剥掉
    // 前导数字变 .4/.5 掉进隐藏路径误判——> < 在正则里必须出现
    allow('sleep 0.4')
    allow('sleep 1.5')
    allow('seq 1 18')
  })
})

describe('规则 4：项目内隐藏路径', () => {
  it('判定表', () => {
    allow('cat .env')
    allow('cat .env.local')
    // .simple-code 读走下方读写分离规则（读放行）；其余隐藏路径照拦
    allow('cat src/.env')
    // 省略号不是路径：echo ... 打印分隔符的字面参数（2026-09-14 实案，
    // 弹「隐藏路径:...」，真报的项目外路径被抢戏）
    allow('echo ...')
    allow("echo '...'")
    // node_modules 是普通路径本来放行；.git 2026-09-29 移出默认例外
    allow('ls node_modules')
    allow('cat node_modules/vitest/dist/x.js')
    allow('cat .git/config')
    allow('git commit -m "x"')
  })
})

describe('.simple-code 读写分离（2026-09-14 拍板：读放行）', () => {
  it('读放行——grep/cat 直读不再弹卡，与 $SIMPLE_CODE_MEMORY 正门同待遇', () => {
    allow('cat .simple-code/memory/turns/turn-000001.jsonl')
    allow('grep -c python .simple-code/memory/turns/turn-000002.jsonl')
    allow('ls .simple-code/memory')
    allow('sort < .simple-code/memory/regions.jsonl') // 输入重定向是读
    allow('wc -l .simple-code/memory/summaries/x.md')
  })
  it('禁令收窄（2026-11-04 全量回放 28687 条后）：读与夹具不误伤', () => {
    // cp 的 memory 是源（后面还有目标参数）→ 读；memory 侧不再 deny，
    // 外部写目标照弹（与 v1 同——批 /tmp 目录即可积累）
    blocked('cp .simple-code/memory/state.db /tmp/backup.db', '项目外')
    // 目标也在项目内 → 全放
    allow('cp .simple-code/memory/turns/t.jsonl .simple-code/tmp/t.bak')
    blocked('ln -s .simple-code/memory/summaries /tmp/summaries-link', '项目外')
    // mv 不在收窄内——移走=破坏源文件，memory 端点不论方向都禁
    denied('mv .simple-code/memory/turns/t.jsonl /tmp/', '禁止用 bash 写')
    // 写目标位（后面没有参数）→ 禁令照 deny
    denied('cp /tmp/evil.jsonl .simple-code/memory/turns/t.jsonl', '禁止用 bash 写')
    // sqlite3 不在写动词表：直打 state.db 是读形态，放行（state.db 是可重建
    // 的派生索引，检查它是 SC 开发的日常；重定向写 memory 才触发禁令）
    allow('sqlite3 .simple-code/memory/state.db "select 1 from turns limit 1"')
    denied('sqlite3 x.db ".dump" > .simple-code/memory/dump.sql', '禁止用 bash 写')
    // /tmp 下的 .simple-code/memory 是仿真夹具，不是活记忆——落回普通弹卡
    // （不注入 pathExists 的环境走 external_dir；本套注入「都存在」走 hidden）
    const fx = classify('mkdir -p /tmp/sc-iso/.simple-code/memory', ROOT, cfg)
    expect(fx.kind).toBe('ask')
  })
  it('系统操作读形态放行（效果可恢复：查没有效果）', () => {
    allow('pmset -g log | grep Sleep | head -3')
    allow('defaults read com.apple.ncprefs apps 2>/dev/null | grep simplecode')
    allow('defaults write com.apple.dock autohide -bool true') // OC 化：系统操作全放
    allow('pmset sleep 30')
    allow('launchctl load src/x.plist')
    allow('sysctl -w kern.maxfiles=10240')
    expect(classify('sudo reboot', ROOT, cfg)).toMatchObject({ kind: 'deny' })
  })
  it('写禁（v2 §2.2 禁令档）：memory 不弹卡、直接拒绝', () => {
    denied('echo x > .simple-code/memory/turns/turn-1.jsonl', '禁止用 bash 写')
    denied('rm .simple-code/memory/state.db', '禁止用 bash 写')
    denied('cp /tmp/x .simple-code/memory/turns/t.jsonl', '禁止用 bash 写') // memory 是写目标，禁令优先于外部路径弹卡
    // 读 memory 照放：检索面不受禁令影响
    allow('cat .simple-code/memory/state.db')
    // cp 外流（memory 源 → 项目外）：弹外部写卡（读面 cat/grep 本就放行，
    // cp 不构成新增外流面）；mv 是破坏（移走原件），保持禁令
    blocked('cp .simple-code/memory/turns/t.jsonl /tmp/y', '项目外')
    denied('mv .simple-code/memory/turns/t.jsonl /tmp/', '禁止用 bash 写')
    denied('tee .simple-code/memory/x', '禁止用 bash 写')
    denied('sed -i s/a/b/ .simple-code/memory/turns/t.jsonl', '禁止用 bash 写')
    denied('mkdir .simple-code/memory/evil', '禁止用 bash 写')
  })
  it('settings.json：读写放行（v2 §2.2，2026-11-04——denylist 已禁仓库级配凭据）', () => {
    allow('cat .simple-code/settings.json')
    allow('echo x > .simple-code/settings.json')
  })
})

describe('symlink 逃逸（路径判定按真实形态）', () => {
  // 真实文件系统夹具：链接必须真存在，realpath 才有东西可解析
  const ROOT = mkdtempSync(join(tmpdir(), 'sc-symroot-'))
  const OUT = mkdtempSync(join(tmpdir(), 'sc-symout-'))
  const IN = join(ROOT, 'inside')
  mkdirSync(IN)
  symlinkSync(OUT, join(ROOT, 'escape')) // 项目内链接 → 项目外
  symlinkSync(IN, join(ROOT, 'loopback')) // 项目内链接 → 项目内
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    rmSync(OUT, { recursive: true, force: true })
  })
  // 共享 helpers 绑定顶部假 ROOT，这里链接在假 ROOT 里不存在——
  // realpath 无从展开。局部 helpers 绑真夹具 ROOT
  const vOf = (cmd: string) => classify(cmd, ROOT, cfg)
  const ok = (cmd: string) => expect(vOf(cmd)).toEqual({ kind: 'allow' })
  const askOut = (cmd: string) => {
    const v = vOf(cmd)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') expect(v.reason).toContain('项目外')
  }

  it('经项目内链接写/读项目外：按真实位置判 external', () => {
    askOut('echo pwned > escape/target.txt')
    askOut('cat escape/target.txt')
    askOut(`echo x > ${join(ROOT, 'escape')}/t`) // 绝对形式同样
  })
  it('链接指向项目内：不误伤，照常放行', () => {
    ok('cat loopback/a.txt')
    ok(`echo x > ${join(ROOT, 'loopback')}/b.txt`)
  })
})

describe('多段命令：最严档生效', () => {
  it('判定表', () => {
    blocked('ls && cat ~/.ssh/id_rsa', '项目外路径')
    blocked('ls && cat ~/Code/x', '项目外')
    blocked('cat x ; ls /etc', '项目外')
    blocked('cat x&&ls /etc', '项目外') // 控制符无空格粘连
    allow('ls && cat src/index.ts')
    allow('cat x | grep y')
    // 引号内 | 被误切成段——只影响收紧方向，这里内容无害所以仍放行
    allow('echo "a|b"')
  })
})

describe('边界', () => {
  it('判定表', () => {
    allow('ls')
    allow('git status --short')
    allow('echo hello world')
    allow('mkdir -p dist/webview')
    // heredoc 正文不扫（这个命令本身也没有危险 token）
    allow('cat <<EOF\nhello\nEOF')
  })
})

describe('bash 工具接线', () => {
  // spawn 的 cwd 得真实存在——假 ROOT 会 ENOENT。判定器视角下用哪个
  // 真实目录都一样（这些用例的路径全是 /tmp 绝对路径或裸 echo）。
  // 用独立 mkdtemp 而不是 process.cwd()：闸门每条命令读 root 下
  // approval.json——真项目根的真盘（用户真机批过的 leads/paths）会
  // 泄漏进测试，/tmp 类路径沾上用户的路径白名单，ask 用例静默变 allow
  const LIVE_ROOT = mkdtempSync(join(tmpdir(), 'sc-approval-live-'))
  const ctxOf = (over: Record<string, unknown> = {}) => ({
    root: LIVE_ROOT,
    signal: new AbortController().signal,
    ...over,
  })

  it('未注入 requestApproval：ask 级命令直接执行（core 默认不设防）', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const tool = createBashTool({
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      maxOutputChars: 1000,
      killGraceMs: 200,
      envPassthrough: ['PATH'],
    })
    const out = await tool.execute(
      {
        command: 'echo hello-from-ask-path > /tmp/sc-approval-t.txt && cat /tmp/sc-approval-t.txt',
      },
      ctxOf(),
    )
    expect(out.output).toContain('hello-from-ask-path')
    expect(out.isError).toBe(false)
  })

  it('deny：ask 级命令被拦下，不执行，错误信息含理由', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const tool = createBashTool({
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      maxOutputChars: 1000,
      killGraceMs: 200,
      envPassthrough: ['PATH'],
    })
    const asked: string[] = []
    const { mkdirSync } = await import('node:fs')
    mkdirSync(`${LIVE_ROOT}/sub`, { recursive: true })
    const out = await tool.execute(
      { command: 'echo pwned > /tmp/sc-approval-deny.txt' },
      ctxOf({
        requestApproval: async (q: { command: string; reason: string }) => {
          asked.push(q.command)
          return 'deny'
        },
      }),
    )
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('/tmp/sc-approval-deny.txt')
    expect(out.isError).toBe(true)
    expect(out.output).toContain('审批被拒绝')
    // 真没执行：目标文件不存在
    const { access } = await import('node:fs/promises')
    await expect(access('/tmp/sc-approval-deny.txt')).rejects.toThrow()
  })

  it('allow：问过之后放行执行', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const tool = createBashTool({
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      maxOutputChars: 1000,
      killGraceMs: 200,
      envPassthrough: ['PATH'],
    })
    const out = await tool.execute(
      { command: 'echo ok > /tmp/sc-approval-ok.txt' },
      ctxOf({ requestApproval: async () => 'allow' }),
    )
    expect(out.isError).toBe(false)
  })

  it('allow 级命令不打扰 requestApproval', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const tool = createBashTool({
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      maxOutputChars: 1000,
      killGraceMs: 200,
      envPassthrough: ['PATH'],
    })
    let asked = 0
    const out = await tool.execute(
      { command: 'echo fine' },
      ctxOf({
        requestApproval: async () => {
          asked++
          return 'deny'
        },
      }),
    )
    expect(asked).toBe(0)
    expect(out.isError).toBe(false)
  })

  it('审批等待中 abort → deny 兜底（宿主不响应时）', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const tool = createBashTool({
      defaultTimeoutMs: 5000,
      maxTimeoutMs: 10_000,
      maxOutputChars: 1000,
      killGraceMs: 200,
      envPassthrough: ['PATH'],
    })
    const ac = new AbortController()
    // 宿主挂起不回（模拟 UI 失联）
    const hanging = new Promise<'allow' | 'deny'>(() => {})
    const outP = tool.execute(
      { command: 'echo x > /tmp/sc-approval-abort.txt' },
      ctxOf({ signal: ac.signal, requestApproval: () => hanging }),
    )
    // 让 execute 走到 race 挂起处，再中断
    await new Promise((r) => setTimeout(r, 50))
    ac.abort()
    // abort 后 race 兜底 resolve——await 拿到结果而不是永久挂起
    const out = await Promise.race([
      outP,
      new Promise((_, rej) => setTimeout(() => rej(new Error('hung')), 1000)),
    ])
    expect((out as ToolOutput).isError).toBe(true)
  })
})

import type { ToolOutput } from '../src/tools/types.ts'

describe('审批类别（approval.md §4.2 类别化）', () => {
  it('每条 ask 都带对类别与触发物', () => {
    const cases: [string, string, string][] = [
      ['cat ~/.ssh/id_rsa', 'external_dir', '~/.ssh/id_rsa'], // 项目外（2026-11-04 简化）
      ['cat ~/Code/x', 'external_dir', '~/Code/x'],
      // realpath 后 macOS 为 /private/etc/passwd——真实形态（symlink 逃逸修复的副作用）
      ['cat /etc/passwd', 'external_dir', '/private/etc/passwd'],
      ['cd /tmp && ls', 'external_dir', '/private/tmp'], // realpath 真实形态（macOS /tmp→/private/tmp）
      ['cat ~/Code/proj/src/.env', 'external_dir', '~/Code/proj/src/.env'],
      // curl/ssh 的 network_cmd 行已删（v2 §2.1 类 4，2026-11-04）：放行
    ]
    for (const [cmd, expectCat, expectDetail] of cases) {
      const v = classify(cmd, ROOT, cfg)
      expect(v.kind, cmd).toBe('ask')
      if (v.kind === 'ask') {
        expect(v.category, cmd).toBe(expectCat)
        expect(v.detail, cmd).toBe(expectDetail)
      }
    }
  })
})

describe('nonPathFrom 采集依据（卡上「此参数位不是路径」的出处）', () => {
  it('触发位 ≥2 且 external_dir：verdict 带 { lead, from }', () => {
    const v = classify('xcli get f.pptx /slide[2]', ROOT, cfg)
    expect(v).toMatchObject({ kind: 'ask', nonPathFrom: { lead: 'xcli', from: 2 } })
    // 位 3 的触发（文件参数之后的第二列）照记 from: 3
    const v3 = classify('xcli add f.pptx x.txt /slide[2]', ROOT, cfg)
    expect(v3).toMatchObject({ kind: 'ask', nonPathFrom: { lead: 'xcli', from: 3 } })
  })
  it('位 <2 不带：cat 的参数全是路径，这个选项只是噪音', () => {
    const v = classify('cat /etc/passwd', ROOT, cfg)
    expect(v.kind).toBe('ask')
    expect('nonPathFrom' in v).toBe(false)
  })
  it('项目外路径（原 hidden_path）不带：触发物是真路径，这个选项是误导', () => {
    const v = classify('cat ~/secrets/.env', ROOT, cfg)
    expect(v.kind).toBe('ask')
    if (v.kind === 'ask') {
      expect(v.category).toBe('external_dir')
      expect('nonPathFrom' in v).toBe(false)
    }
  })
})

describe('自定义审批规则 askCommands（2026-09-27 拍板）', () => {
  const gcfg: ApprovalConfig = { ...cfg, askCommands: ['git push', 'gh'] }

  it('通配条目（2026-11-04）：* 按 glob 匹配整条命令词串，命中不给始终允许键', () => {
    const g = { ...cfg, askCommands: ['appctl workloads *', 'rm -rf *'] }
    // 命中：workloads 下一切子命令
    expect(classify('appctl workloads apply my-app', ROOT, g)).toMatchObject({
      kind: 'ask',
      category: 'ask_rule',
      detail: 'appctl workloads *',
    })
    expect(classify('appctl workloads list', ROOT, g)).toMatchObject({ kind: 'ask' })
    expect(classify('rm -rf /tmp/x', ROOT, g)).toMatchObject({ kind: 'ask' })
    // 不命中：别的子命令、别的命令形态
    expect(classify('appctl status', ROOT, g)).toEqual({ kind: 'allow' })
    expect(classify('rm src/x', ROOT, g)).toEqual({ kind: 'allow' }) // 词级不沾
    expect(classify('xrm -rf y', ROOT, g)).toEqual({ kind: 'allow' }) // 首段锚定
    // 通配命中不给键：批不了
    const v = classify('appctl workloads apply x', ROOT, g)
    if (v.kind === 'ask') expect('alwaysLead' in v).toBe(false)
  })

  it('denyCommands（2026-11-04）：点名直接拒，优先于 ask 与批过的 lead', () => {
    const g = {
      ...cfg,
      askCommands: ['git push', 'rm *'],
      denyCommands: ['rm -rf /*', 'git push *'],
    }
    // ask 与 deny 都命中 → deny
    expect(classify('git push origin main', ROOT, g)).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('denyCommands 点名拒绝'),
    })
    // deny 命中即拒（点名永不可 > 白名单；lead 豁免层已拆，无批键可沾）
    expect(classify('rm -rf /', ROOT, g)).toMatchObject({ kind: 'deny' })
    // deny 不命中、ask 命中 → 照常 ask
    expect(classify('rm x', ROOT, g)).toMatchObject({ kind: 'ask' })
    // 都不命中 → 放
    expect(classify('git status', ROOT, g)).toEqual({ kind: 'allow' })
  })

  it('内置默认为空（2026-11-04 拍板）：不配 askCommands 时 git push/gh 不弹', () => {
    expect(classify('git push origin main', ROOT, cfg)).toEqual({ kind: 'allow' })
    expect(classify('gh release create v1', ROOT, cfg)).toEqual({ kind: 'allow' })
  })

  it('用户自配 git push / gh 弹卡，git 本地操作照常自由', () => {
    expect(classify('git push origin main', ROOT, gcfg)).toMatchObject({
      kind: 'ask',
      category: 'ask_rule',
      detail: 'git push',
    })
    expect(classify('gh release create v1', ROOT, gcfg)).toMatchObject({
      kind: 'ask',
      category: 'ask_rule',
      detail: 'gh',
    })
    // 2026-09-27 v0.1.1 越权实案的回归线：发布链必须有人拦
    expect(classify('git commit -m x', ROOT, gcfg).kind).toBe('allow')
    expect(classify('git status', ROOT, gcfg).kind).toBe('allow')
    expect(classify('git log --oneline', ROOT, gcfg).kind).toBe('allow')
  })

  it('git -C/-c 的 flag 值不是子命令——fail-open 绕过防护', () => {
    // -C 的值 /tmp 会被 firstPositional 误当子命令，匹配不上就放过了
    expect(classify('git -C /tmp push', ROOT, gcfg)).toMatchObject({
      kind: 'ask',
      detail: 'git push',
    })
    expect(classify('git -c a=b push', ROOT, gcfg)).toMatchObject({
      kind: 'ask',
      detail: 'git push',
    })
    // 无关 flag 不受影响
    expect(classify('git --no-pager push', ROOT, gcfg)).toMatchObject({
      kind: 'ask',
      detail: 'git push',
    })
  })

  it('命令维无豁免层（2026-11-05 拍板拆 leads）：配了就拦，想放删配置行', () => {
    // 旧机制：卡上「始终允许」记 lead、另一文件豁免。已拆——askCommands
    // 命中即弹，没有第二条放行通道；gh 与 git push 各自独立
    expect(classify('git push origin main', ROOT, gcfg).kind).toBe('ask')
    expect(classify('gh release list', ROOT, gcfg)).toMatchObject({ kind: 'ask', detail: 'gh' })
    const acfg: ApprovalConfig = { ...cfg, askCommands: ['appctl deploy'] }
    expect(classify('appctl deploy prod', ROOT, acfg)).toMatchObject({
      kind: 'ask',
      detail: 'appctl deploy',
    })
    expect(classify('appctl status', ROOT, acfg).kind).toBe('allow')
  })

  it('私有 CLI：子命令级条目只拦该子命令，裸 lead 条目拦整个 CLI', () => {
    const sub = { ...cfg, askCommands: ['appctl deploy'] }
    expect(classify('appctl deploy prod', ROOT, sub)).toMatchObject({
      kind: 'ask',
      category: 'ask_rule',
      detail: 'appctl deploy',
    })
    expect(classify('appctl status', ROOT, sub).kind).toBe('allow')
    const whole = { ...cfg, askCommands: ['appctl'] }
    expect(classify('appctl status', ROOT, whole)).toMatchObject({ kind: 'ask', detail: 'appctl' })
  })

  it('三级条目：workloads apply 弹卡，workloads list 自由（词级匹配不误伤 deployx）', () => {
    // 2026-09-27 用户实单：apply/delete/retry/domain 弹卡、list/get 自由
    const t = {
      ...cfg,
      askCommands: ['appctl workloads apply', 'appctl workloads delete', 'appctl release create'],
    }
    expect(classify('appctl workloads apply my-app', ROOT, t)).toMatchObject({
      kind: 'ask',
      category: 'ask_rule',
      detail: 'appctl workloads apply',
    })
    expect(classify('appctl workloads list', ROOT, t).kind).toBe('allow')
    expect(classify('appctl release create v1', ROOT, t)).toMatchObject({
      kind: 'ask',
      detail: 'appctl release create',
    })
    // 词级匹配：deployx 是另一个词，不吃 deploy 的卡
    expect(
      classify('appctl deployx foo', ROOT, { ...cfg, askCommands: ['appctl deploy'] }).kind,
    ).toBe('allow')
  })

  it('多条命中取最紧的：workloads apply 与 workloads 都配时报更紧那条', () => {
    const both = { ...cfg, askCommands: ['appctl workloads', 'appctl workloads apply'] }
    expect(classify('appctl workloads apply', ROOT, both)).toMatchObject({
      kind: 'ask',
      detail: 'appctl workloads apply',
    })
    expect(classify('appctl workloads list', ROOT, both)).toMatchObject({
      kind: 'ask',
      detail: 'appctl workloads',
    })
  })

  it('带项目外路径的命中报 ask_rule 而非 external_dir——规则优先级', () => {
    const v = classify('appctl deploy /Users/dev/Code/external', ROOT, {
      ...cfg,
      askCommands: ['appctl deploy'],
    })
    expect(v).toMatchObject({ kind: 'ask', category: 'ask_rule', detail: 'appctl deploy' })
  })

  it('透传前缀包一层照拦：nohup/timeout/env/xargs … 后面才是真命令（2026-10-30 实案）', () => {
    const t = { ...gcfg, askCommands: ['git push', 'gh', 'appctl build run'] }
    // 实案原文形态：nohup 后台跑构建，发布闸曾静默放行
    expect(
      classify(
        'nohup appctl build run --workload a --env dev --wait > .simple-code/tmp/b.log 2>&1 &',
        ROOT,
        t,
      ),
    ).toMatchObject({
      kind: 'ask',
      category: 'ask_rule',
      detail: 'appctl build run',
    })
    for (const c of [
      'nohup git push origin dev',
      'nohup > .simple-code/tmp/o.log git push',
      'timeout 30 git push',
      'timeout -s KILL 30 git push',
      'time git push',
      'nice -n 10 git push',
      'env A=1 B=2 git push',
      'env -u X git push',
      'exec git push',
      'command git push',
      'stdbuf -oL git push',
      'caffeinate -i git push',
      'echo dev | xargs -I{} git push origin {}',
      'nohup timeout 5 git push',
    ])
      expect(classify(c, ROOT, t), c).toMatchObject({ kind: 'ask', detail: 'git push' })
    // 命令名规则只剩 askCommands：透传后内层照判（OC 化，内置已拆）
    expect(classify('nohup git push', ROOT, cfg)).toEqual({ kind: 'allow' }) // 不配不弹
    expect(classify('nohup git push', ROOT, { ...cfg, askCommands: ['git push'] })).toMatchObject({
      kind: 'ask',
      detail: 'git push',
    })
    expect(classify('timeout 5 curl https://x.com', ROOT, cfg)).toEqual({ kind: 'allow' })
    // 命令维无豁免层（2026-11-05 拆 leads）：包不包都照拦
    expect(classify('nohup appctl build run --env dev &', ROOT, t).kind).toBe('ask')
  })

  it('透传前缀对照：内层无害照放，查询形态与无命令不算执行', () => {
    for (const c of [
      'nohup node server.js > .simple-code/tmp/s.log 2>&1 &',
      'timeout 5 sleep 1',
      'command -v python3',
      'ls | xargs',
      'ls | xargs -I{} wc -l {}',
      'env',
      'exec > .simple-code/tmp/x.log 2>&1',
      'time git status',
    ])
      expect(classify(c, ROOT, gcfg), c).toEqual({ kind: 'allow' })
  })
})

describe('always 白名单（approval.json，两个力度）', () => {
  const cfgA = { ...cfg, alwaysLeads: ['python3'], alwaysPaths: ['/Users/dev/Code/external'] }
  it('lead 白名单：批过的解释器免审，段独立，同名前缀不沾光', () => {
    // 回退路径：lead 靠回填——白名单检查必须在回填后（有专门回归注释）
    expect(classify('python3 -c "print(1)"', ROOT, cfgA).kind).toBe('allow')
    expect(classify("python3 <<'PY'\nprint(1)\nPY", ROOT, cfgA).kind).toBe('allow')
    // 同段另一条没批过的命令照样弹：白名单按段生效
    expect(cfgA && classify('python3 -c "print(1)"; rm -rf /etc/x', ROOT, cfgA).kind).toBe('ask')
    // 解释器已不拦（2026-11-04）：python 未批也放行，lead 白名单
    // 机制由 git push 系（下面透传组）继续守护
    expect(classify('python -c "print(1)"', ROOT, cfgA).kind).toBe('allow')
    // 网络命令 lead 同机制
    allow2('curl https://example.com', cfg)
  })
  it('解释器 heredoc 不再弹卡（2026-11-04 拍板）：带不带引号同权，路径段照判', () => {
    allow2('python3 - <<EOF\nprint("$x")\nEOF', cfgA)
    // 多段命令里别的段照判：rm -rf /etc/x 是⑥路径，照弹
    expect(classify('python3 - <<EOF\nprint("$x")\nEOF; rm -rf /etc/x', ROOT, cfgA).kind).toBe(
      'ask',
    )
    // 未批也放：heredoc 展开风险已整体接受（2026-11-04 拍板）
    allow2('python3 - <<EOF\nprint("$x")\nEOF', cfg)
  })
  it('eval 不拦（2026-11-04 拍板：触发实在太多）：嵌在深处也不再是弹卡理由', () => {
    // 未批白名单：agent-browser eval 的参数无路径触发 → 放行（AST 下
    // $( ) 子命令另有枚举判定；lead 白名单粒度由 leads 自身承担）
    allow2('agent-browser eval "document.title"', cfg)
    allow2('agent-browser click @e1 eval', cfg)
    // screenshot 写项目外路径照弹（路径维，与 eval 无关）
    expect(classify('agent-browser screenshot /etc/x.png', ROOT, cfg).kind).toBe('ask')
  })
  it('agent-browser 带值全局 flag（--session/--cdp/--profile）的值不是子命令', () => {
    // 真机：某真实项目 10-22/10-26 共 28 张卡，`--session s1` 的 s1
    // 被当成子命令，已批的 agent-browser eval 对不上，卡上也没有采集键
    const cfgE = { ...cfg, alwaysLeads: ['agent-browser eval'] }
    allow2('agent-browser --session dag-m01-verify eval "document.title"', cfgE)
    allow2('agent-browser --cdp 9222 eval "document.title"', cfgE)
    allow2('agent-browser --profile Default eval "document.title"', cfgE)
    allow2('agent-browser --session s1 eval "document.title"', cfg) // eval 不拦（2026-11-04）
  })
  it('path 白名单：前缀目录免审（含 ~ 展开），邻居目录不沾光', () => {
    allow2('cat /Users/dev/Code/external/foo/src/x.ts', cfgA)
    // ~ 展开用的是本机真实 homedir——白名单同形态构造才对得上
    const cfgT = { ...cfg, alwaysPaths: [`${homedir()}/Code/external`] }
    allow2('cat ~/Code/external/foo/src/x.ts', cfgT)
    expect(classify('cat /Users/dev/Code/externalx/y', ROOT, cfgA).kind).toBe('ask') // 前缀伪造
    expect(classify('cat /Users/dev/Code/other/y', ROOT, cfgA).kind).toBe('ask') // 邻居
    // 第一级目录不存在：realpath 逐级回退到 / 时曾拼出 //sc-nowhere，白名单失配
    allow2('cat /sc-nowhere/a.py', { ...cfg, alwaysPaths: ['/sc-nowhere'] })
    expect(classify('cat /sc-nowhere/a.py', ROOT, cfg)).toMatchObject({
      detail: '/sc-nowhere/a.py',
    })
  })
  it('项目外路径的理由分读写', () => {
    expect(classify('cat /sc-nowhere/a', ROOT, cfg)).toMatchObject({
      reason: '要读项目外路径：/sc-nowhere/a',
    })
    expect(classify('echo x > /sc-nowhere/a', ROOT, cfg)).toMatchObject({
      reason: '要写项目外路径：/sc-nowhere/a',
    })
  })
  it('非路径参数位豁免：sed 地址范围 / grep pattern / awk program 不当路径（实弹回归）', () => {
    // 实弹：sed 地址范围 '/## 13/,/## 附录/p' 曾被判「要触碰项目外路径」
    allow("sed -n '/## 13/,/## 附录/p' docs/design.md")
    allow("sed -n -e '/x/,/y/p' docs/design.md") // -e 的值是 script
    allow("grep -n '/## 13/' docs/design.md") // / 开头的 pattern
    allow("awk '/^x/{print $1}' docs/design.md") // program 第一个位置参数
    allow("grep -rn --include='*.ts' 'x' packages/core/src") // --include 的 glob 值
    // 豁免的是参数位，不是命令：文件参数照常判
    blocked('sed -i /x/p /etc/hosts', '项目外')
    blocked("sed -i 's/x/y/' /etc/hosts", '项目外') // -i 写意图也在
    // -f 的值是真脚本文件路径，不豁免
    blocked('sed -f /etc/sedscript docs/design.md', '项目外')
  })

  it('纯输出工具（echo/printf）位置参数不当路径：文本不是触碰', () => {
    // 实弹：head/tail 之间 echo 省略号分隔文本，"...[中略]..." 被判
    // 隐藏路径弹卡——echo 的参数是要打印的文本，不是路径。
    // 文件用项目内相对路径（实弹里的 /tmp 文件在真项目的路径白名单里）
    allow(`head -c 1500 docs/x.txt; echo; echo "...[中略]..."; tail -c 900 docs/x.txt`)
    allow(`echo '.env 里有 key'`)
    // printf 的 /etc/passwd 是要打印的文本，不构成触碰
    allow(`printf '%s' "...[中略]..." /etc/passwd`)
    // tr 只有字符集参数，没有文件参数（2026-10-30 实弹：`tr '\t' '/'` 报「要读项目外路径：/」）
    allow(`git rev-list --count HEAD | tr '\\t' '/'`)
    allow(`echo a/b | tr -d '/'`)
    // 重定向目标不在豁免罩内：那是 echo 唯一的文件系统接触
    // （项目外点开头报隐藏路径，2026-09-30；此夹具 pathExists 恒真）
    blocked('echo pwned > /Users/dev/.zshrc', '项目外路径')
    blocked('echo x > /Users/dev/Desktop/y.txt', '项目外')
    blocked('tr a b < /Users/dev/Desktop/y.txt', '项目外')
  })

  it('nonPathFrom 豁免位：元素路径不当路径，文件参数照常判', () => {
    // 元素寻址工具的元素路径（/slide[2]、/body）以 / 开头，长得像
    // 绝对路径——不配 nonPathFrom 就会误拦「项目外路径」
    allowX('xcli add deck.pptx /slide[2] --type shape --prop fill=1E2761')
    allowX('xcli get "f.pptx" "/slide[1]/shape[@id=3]" --depth 1')
    allowX('xcli get f.pptx /body')
    // 豁免的是元素路径位，不是命令：文件参数（第一位）照常判（项目外）
    blockedX('xcli add ~/.env /slide[1]', '项目外')
    blockedX('xcli get ~/.env /body', '项目外')
  })

  it('豁免是区间不是单点：flag 值与循环骨架不占错位', () => {
    // flag 值（--from 的值）会被数进位置参数——单点豁免挡不住，
    // 得从配置位起整段豁；for/if 的骨架词不占位置参数位
    allowX('xcli add deck.pptx "/slide[8]" --type shape --from "/slide[7]/shape[@id=100083]"')
    allowX(
      'for id in 100083 100084; do xcli add deck.pptx "/slide[8]" --from "/slide[7]/shape[@id=$id]"; done',
    )
    allowX('if true; then xcli get deck.pptx /slide[1]; fi')
    // 区间豁免罩不住写意图：重定向目标照常判
    blockedX('xcli get deck.pptx /body > /Users/dev/Desktop/x.txt', '项目外')
  })

  it('nonPathFrom 子命令级条目：批 eval 的 JS 不连带批 upload 的文件参数（2026-10-15）', () => {
    // 真机实卡：agent-browser eval 的 JS 里 /…/ 正则字面量被 split('/')
    // 切出 .test( 假隐藏段反复弹卡；而 agent-browser 还有 upload/screenshot/
    // pdf/download 吃真文件路径——裸 lead 条目 {agent-browser:1} 会把
    // `upload x ~/.ssh/id_rsa` 静默放行（窃取面）。子命令级 key 只罩 eval
    // 真机场景配齐：leads 里的 'agent-browser eval' 罩住内置 eval 规则
    //（那是用户当初卡上批的），这里测的是 leads 罩不住的路径层
    const bcfg: ApprovalConfig = {
      ...cfg,
      nonPathFrom: { 'agent-browser eval': 0 },
    }
    const allowB = (cmd: string) => expect(classify(cmd, ROOT, bcfg)).toEqual({ kind: 'allow' })
    const blockedB = (cmd: string) => {
      const v = classify(cmd, ROOT, bcfg)
      expect(v.kind).toBe('ask')
      if (v.kind === 'ask') expect(v.reason).toContain('项目外')
    }
    // eval 的 JS（含正则字面量）不再当路径判
    allowB(
      `agent-browser eval "(function(){const el=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&/对比分析中国劳动合同法/.test(e.textContent||''));el&&el.click();return el?'ok':'miss'})()" 2>&1 | tail -1`,
    )
    allowB(`agent-browser eval "(function(){const t=document.body.innerText;return t.length})()"`)
    // 别的子命令吃真路径：key 不匹配，照常判（.env 读形态也拦）
    blockedB('agent-browser upload input "/Users/dev/.ssh/id_rsa"')
    blockedB('agent-browser screenshot "/Users/dev/.env"')
    // 词级匹配：'agent-browser evaluator' 不沾 'agent-browser eval' 的光
    blockedB('agent-browser evaluator "/Users/dev/.env"')
    blockedB('agent-browser upload input "/Users/dev/.ssh/id_rsa"')
  })

  it('子命令级条目的偏移与优先级：from 从子命令后起数，裸 lead 条目在前优先', () => {
    // 三段 key：'appctl workloads apply' 消耗位 0/1，from=0 → 位 2 起豁免
    const acfg: ApprovalConfig = { ...cfg, nonPathFrom: { 'appctl workloads apply': 0 } }
    expect(classify(`appctl workloads apply "/Users/dev/.env"`, ROOT, acfg)).toEqual({
      kind: 'allow',
    })
    // 位 1（apply 本身）不在豁免罩内——from=1 时 .env 仍判
    const acfg1: ApprovalConfig = { ...cfg, nonPathFrom: { 'appctl workloads apply': 1 } }
    const v = classify(`appctl workloads apply "/Users/dev/.env"`, ROOT, acfg1)
    expect(v.kind).toBe('ask')
    // 裸 lead 条目优先：写了两条时按裸的算（子命令条目被短路），
    // bare from=2 → eval 的 JS 在位 1，不在豁免罩内，照判
    const mcfg: ApprovalConfig = {
      ...cfg,
      nonPathFrom: { 'agent-browser': 2, 'agent-browser eval': 0 },
    }
    const v2 = classify(`agent-browser eval "/Users/dev/.env"`, ROOT, mcfg)
    expect(v2.kind).toBe('ask')
  })

  it('回退分词按换行分段：两行命令不粘段、豁免照常', async () => {
    // 回退分词曾把第二行命令粘进第一行末尾的管道段 → lead 换人 →
    // 豁免位整体失效 → 元素路径误弹「项目外路径」。回退路径专属，
    // AST 路径换行是语法分隔没有此病——直接测 splitSegments 不赌 wasm
    const { splitSegments } = await import('../src/tools/approval.ts')
    const segs = splitSegments(
      `xcli get "f.pptx" "/slide[4]/shape[@id=1]" --json 2>&1 | head -30
xcli get "f.pptx" "/slide[4]/shape[@id=2]" --json`,
    )
    // `2>&1` 的 & 会切出无害的独立段（既有行为，收紧方向），这里只核
    // 心点：第二行的 xcli 是**独立段的 lead**，不再粘进 head 段
    const secondLineSeg = segs.find((s) => s.includes('"/slide[4]/shape[@id=2]"'))
    expect(secondLineSeg?.[0]).toBe('xcli')
    // 元素路径仍在第三个位置参数位（get、文件、元素路径）
    expect(secondLineSeg?.[3]).toBe('"/slide[4]/shape[@id=2]"')
    // 行为级：两行 xcli+head 管道整体放行
    allowX(`xcli get "f.pptx" "/slide[4]/shape[@id=1]" --json 2>&1 | head -30
xcli get "f.pptx" "/slide[4]/shape[@id=2]" --json 2>&1 | head -30`)
  })

  const allow2 = (cmd: string, c: typeof cfg) =>
    expect(classify(cmd, ROOT, c)).toEqual({ kind: 'allow' })
})

describe('nonPathFrom 一键采集（卡上「始终允许」→ approval.json）', () => {
  it('appendNonPathFrom 落盘读回；同位不重写；更小位覆盖（收窄不并存歧义）', async () => {
    const { appendNonPathFrom, loadAlways } = await import('../src/tools/approval-always.ts')
    const root = mkdtempSync(join(tmpdir(), 'sc-approval-npf-'))
    try {
      appendNonPathFrom(root, 'xcli', 2)
      expect(loadAlways(root).nonPathFrom).toEqual({ xcli: 2 })
      appendNonPathFrom(root, 'xcli', 2) // 同位幂等
      expect(loadAlways(root).nonPathFrom).toEqual({ xcli: 2 })
      appendNonPathFrom(root, 'xcli', 3) // 更晚的位不覆盖（不放宽）
      expect(loadAlways(root).nonPathFrom).toEqual({ xcli: 2 })
      appendNonPathFrom(root, 'xcli', 1) // 更早的位覆盖（用户后拍板收窄）
      expect(loadAlways(root).nonPathFrom).toEqual({ xcli: 1 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('坏文件形状：值非整数的键丢弃，白名单其余部分照常', async () => {
    const { loadAlways } = await import('../src/tools/approval-always.ts')
    const { writeFileSync, mkdirSync: mkd } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'sc-approval-npf2-'))
    try {
      mkd(join(root, '.simple-code'), { recursive: true })
      writeFileSync(
        join(root, '.simple-code', 'approval.json'),
        JSON.stringify({
          nonPathFrom: { xcli: 2, bad: 'x', neg: -1, frac: 1.5 },
        }),
      )
      const d = loadAlways(root)
      expect(d.nonPathFrom).toEqual({ xcli: 2 })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('loadAlways 无文件时各 root 互不污染（EMPTY 共享引用回归）', async () => {
    // 真机踩过：文件缺失分支曾共享一个 EMPTY 常量，append 类函数
    // mutate 它的返回值再落盘——第一个 root 的白名单静默扩散给之后
    // 所有「无文件」的 root（同进程内免审污染）
    const { loadAlways, appendNonPathFrom } = await import('../src/tools/approval-always.ts')
    const a = mkdtempSync(join(tmpdir(), 'sc-approval-empty-a-'))
    const b = mkdtempSync(join(tmpdir(), 'sc-approval-empty-b-'))
    try {
      appendNonPathFrom(a, 'xcli', 2) // a 落盘前 loadAlways 返回「空」，被 mutate
      expect(loadAlways(b).nonPathFrom).toEqual({}) // b 必须还是空的
      expect(loadAlways(a).nonPathFrom).toEqual({ xcli: 2 })
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })
  it('端到端：always 采集 → approval.json → 下一条同类命令免审', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const { readFileSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'sc-approval-npf3-'))
    try {
      const tool = createBashTool({
        defaultTimeoutMs: 5000,
        maxTimeoutMs: 10_000,
        maxOutputChars: 1000,
        killGraceMs: 200,
        envPassthrough: ['PATH'],
      })
      const hints: unknown[] = []
      const ctx = {
        root,
        signal: new AbortController().signal,
        requestApproval: async (q: { always?: unknown }) => {
          hints.push(q.always)
          return 'always' as const
        },
      }
      await tool.execute({ command: 'xcli get f.pptx /slide[2]' }, ctx)
      expect(hints[0]).toEqual({ kind: 'nonpath', lead: 'xcli', from: 2 })
      const saved = JSON.parse(readFileSync(join(root, '.simple-code', 'approval.json'), 'utf8'))
      expect(saved.nonPathFrom).toEqual({ xcli: 2 })
      // 第二条：同 lead 的元素路径不再弹（approval.json 的采集进判定）
      await tool.execute({ command: 'xcli get f.pptx /body' }, ctx)
      expect(hints).toHaveLength(1)
      // 写意图不在豁免罩内：重定向目标照弹
      await tool.execute({ command: 'xli get f.pptx /body > /Users/dev/Desktop/x.txt' }, ctx)
      expect(hints).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('端到端：approval.json 的 askCommands 进判定（项目级）+ append 不冲掉手写规则', async () => {
    const { createBashTool } = await import('../src/tools/bash.ts')
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'sc-approval-ask-'))
    const home = mkdtempSync(join(tmpdir(), 'sc-approval-home-'))
    try {
      mkdirSync(join(root, '.simple-code'), { recursive: true })
      // 项目级：手写静态规则
      writeFileSync(
        join(root, '.simple-code', 'approval.json'),
        // 虚构 CLI 名：bash.ts 走生产的 ~/.simple-code/approval.json（真
        // home），条目名撞上真机会让断言依赖机器状态
        JSON.stringify({ askCommands: ['zz-deployctl deploy'], hiddenAllow: ['.env'] }),
      )
      // 用户级：独立文件（测试注入路径；生产是 ~/.simple-code/approval.json）
      const userFile = join(home, 'approval.json')
      writeFileSync(userFile, JSON.stringify({ askCommands: ['git commit', 'myctl deploy'] }))

      const tool = createBashTool({
        defaultTimeoutMs: 5000,
        maxTimeoutMs: 10_000,
        maxOutputChars: 1000,
        killGraceMs: 200,
        envPassthrough: ['PATH'],
      })
      const asked: string[] = []
      const ctx = {
        root,
        signal: new AbortController().signal,
        requestApproval: async (q: { reason?: string }) => {
          asked.push(q.reason ?? '')
          return 'deny' as const
        },
      }
      // monkey-patch loadAskRules 的默认路径不可行——bash.ts 里直接调用。
      // 这里走公开参数：askRulesPath 由 ctx 传入？不——直接验证项目级；
      // 用户级用 loadAskRules(userFile) 单测（见下一条）
      const { loadUserApproval } = await import('../src/tools/approval-always.ts')
      expect(loadUserApproval(userFile).askCommands).toEqual(['git commit', 'myctl deploy'])
      expect(loadUserApproval(join(home, 'absent.json'))).toEqual({
        askCommands: [],
        denyCommands: [],
        nonPathFrom: {},
      })

      // 项目级手写规则进判定：appctl deploy 弹（deny 不执行）
      await tool.execute({ command: 'zz-deployctl deploy prod' }, ctx)
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain('zz-deployctl deploy')
      // 未配的子命令自由
      // 未配的子命令不弹卡（命令本身 command-not-found 无妨——测的是
      // 「不经过审批就直奔执行」，不是执行成功）
      await tool.execute({ command: 'zz-deployctl status' }, ctx)
      expect(asked).toHaveLength(1)
      // 内置默认兜底仍在：git push 弹
      await tool.execute({ command: 'git push origin main' }, ctx)
      expect(asked).toHaveLength(2)
      expect(asked[1]).toContain('git push')

      // 项目内 .env 全放（2026-11-04 简化拍板）：不走审批
      await tool.execute({ command: 'cat .env/secret' }, ctx)
      expect(asked).toHaveLength(2) // 没弹新卡

      // 关键回归：卡上「始终允许」读改写后，手写的 askCommands 不丢
      const ctxAllow = { ...ctx, requestApproval: async () => 'always' as const }
      await tool.execute({ command: 'xcli get f.pptx /slide[2]' }, ctxAllow)
      const saved = JSON.parse(readFileSync(join(root, '.simple-code', 'approval.json'), 'utf8'))
      expect(saved.nonPathFrom).toEqual({ xcli: 2 })
      expect(saved.askCommands).toEqual(['zz-deployctl deploy'])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
