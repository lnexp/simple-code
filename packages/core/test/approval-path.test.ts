import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApprovalConfig, type ApprovalVerdict, classify } from '../src/tools/approval.ts'
import { warmupShellParser } from '../src/tools/shell-ast.ts'

/**
 * 路径审批（2026-11-04 简化拍板）：项目内全放（含 .env——用户要拦自己配
 * askCommands）、项目外一律 ask 且一律可「始终允许」（键=目录前缀，读写
 * 同权）、任何位置的 .simple-code/memory 写 deny、审批配置（approval.json）
 * 写 deny（2026-11-05 拍板：配置是审批的根基，压过批键）。这文件测的是
 * 「项目内/项目外怎么算出来」——位置真实性计算（cd、..、子 shell、变量
 * 代入、symlink、PWD）都在这里。走 AST 路径（预热）——生产上绝大多数
 * 命令走它。
 */
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const ROOT = tmp('sc-hp-root-')
const OTHER = tmp('sc-hp-other-')
const HOME = tmp('sc-hp-home-')
const touch = (p: string) => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, 'x')
}
beforeAll(async () => {
  expect(await warmupShellParser()).toBe(true)
  for (const f of [
    '.env',
    '.gitignore',
    '.idea/encodings.xml',
    'packages/.env',
    '.git/config',
    '.simple-code/memory/state.db',
    '.github/workflows/ci.yml',
    'packages/.eslintrc',
  ])
    touch(join(ROOT, f))
  touch(join(OTHER, 'web/.env.production'))
  for (const f of [
    '.ssh/id_rsa',
    '.ssh/x',
    '.zshrc',
    '.m2/settings.xml',
    '.m2/repository/axis-1.4.jar',
    '.nvm/x',
    '.Trash/x',
    '.idea/x',
    '.cursor/x',
    '.agent-browser/x',
    '.vscode/x',
    '.local/x',
    '.some-new-tool/x',
    '.cache/x',
    '.simple-code/approval.json',
    '.simple-code/skills/a/SKILL.md',
  ])
    touch(join(HOME, f))
  symlinkSync(OTHER, join(ROOT, 'link-out'))
})
afterAll(() => {
  for (const d of [ROOT, OTHER, HOME]) rmSync(d, { recursive: true, force: true })
})

const base: ApprovalConfig = { askCommands: [], denyCommands: [], env: { HOME } }
const judge = (cmd: string, cfg: Partial<ApprovalConfig> = {}): ApprovalVerdict =>
  classify(cmd, ROOT, { ...base, ...cfg })
const allow = (cmd: string, cfg?: Partial<ApprovalConfig>) =>
  expect(judge(cmd, cfg), cmd).toEqual({ kind: 'allow' })
// 项目外一律 ask（category=external_dir）
const external = (cmd: string, cfg?: Partial<ApprovalConfig>) => {
  const v = judge(cmd, cfg)
  expect(v.kind, cmd).toBe('ask')
  if (v.kind === 'ask') expect(v.category, cmd).toBe('external_dir')
  return v
}
// 禁令档：memory 写不弹卡直接拒
const denied = (cmd: string, cfg?: Partial<ApprovalConfig>) => {
  const v = judge(cmd, cfg)
  expect(v.kind, cmd).toBe('deny')
  return v
}
// 算不出：放行 + onUnparsed 日志（2026-11-04 拍板）
const unparsed = (cmd: string) => {
  const tokens: string[] = []
  const v = judge(cmd, { onUnparsed: (t) => tokens.push(t) })
  expect(v.kind, cmd).toBe('allow')
  expect(tokens.length, cmd).toBeGreaterThan(0)
}

describe('项目内全放（2026-11-04 拍板：.env 也不例外）', () => {
  it('.env/.git/不存在文件/通配：读写都放', () => {
    allow('cat .env')
    allow('echo x > .env')
    allow('cat packages/.env')
    allow('cat .git/config')
    allow('echo x > .git/config')
    allow('ls .gi*')
    allow('ls scripts/.feishu*')
    allow('echo x > .newfile')
    allow('cat .x/nothing')
    allow('sqlite3 x.db ".tables"')
  })
  it('.simple-code：除 memory 全放（v2 §2.2）', () => {
    allow("cat >> .simple-code/notes/x.md <<'EOF'\nx\nEOF")
    allow('rm .simple-code/lessons/x.md')
    allow('echo x > .simple-code/principles/x.md')
    allow('mkdir -p .simple-code/skills/foo')
    allow('echo x > .simple-code/events/x.md')
    allow('mkdir -p .simple-code/tmp/uishot')
    allow('echo x > .simple-code/tmp/uishot/a.log')
    allow('rm -rf .simple-code/tmp/uishot')
    allow("cat >> .simple-code/diagnosis/self-diagnosis.md <<'EOF'\n| x |\nEOF")
    allow('echo x > .simple-code/tmpx/a')
    allow('cat .simple-code/memory/state.db')
    denied('echo x >> .simple-code/memory/self-diagnosis.md')
    denied('rm .simple-code/memory/state.db')
    denied(`echo x > .simple-code/memory/${HOME}/deep`)
    denied(`echo x > ${HOME}/.simple-code/memory/x`)
    // cp 外流照弹外部卡（读面开放，非新增面）
    expect(judge('cp -r .simple-code/memory /tmp/x')).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
    })
  })
  it('git 的 REV:path：仓库相对即项目内，全放', () => {
    allow('git show HEAD:.env')
    allow('git show origin/main:web/.env.production')
    allow('git show :.nothing')
    allow('git show HEAD:README.md')
    allow('git show HEAD:.simple-code/approval.json')
    allow("git commit -m 'fix: 改 a/.simple-code/x 的判定'")
  })
  it('lead 豁免层已拆（2026-11-05）：路径判定与命令批键无关', () => {
    allow('cat .env')
    allow('python3 script.py')
    allow('cat src/a.ts')
    external('cat /etc/hosts')
    external('python3 /etc/x.py')
    external(`cat ${HOME}/.ssh/id_rsa`)
    denied('cat >> .simple-code/memory/x.md <<EOF\nx\nEOF')
    expect(judge('python3 /Users/sc-nowhere/a.py').kind).toBe('ask')
    allow('python3 /Users/sc-nowhere/a.py', { alwaysPaths: ['/Users/sc-nowhere'] })
  })
})

describe('PWD 与环境变量：按 shell 真实现场算', () => {
  it('PWD 路径与实际当前目录同判，不沿用宿主环境的 PWD', () => {
    const cfg = { alwaysLeads: ['agent-browser'], env: { PWD: OTHER } }
    // env 里的 PWD=OTHER 被无视：按真实 cwd（ROOT）算，全在项目内
    allow('agent-browser screenshot "$PWD/.simple-code/tmp/a.png"', cfg)
    allow('echo x > $PWD/.simple-code/tmp/a.log', cfg)
    allow('cat "$PWD/.env"')
    denied('echo x > "$PWD/.simple-code/memory/state.db"', cfg)
    expect(judge('echo x > "$PWD/../outside.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$PWD/link-out/a.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$PWD/link-out/../a.txt"', cfg).kind).toBe('ask')
    // cd 之后 PWD 跟着变（cd packages && $PWD/.. = root）
    allow('cd packages && echo x > "$PWD/../.simple-code/tmp/a.log"', cfg)
  })
  it('环境变量展开保留软链接与 ..，不能借 paths 白名单逃逸', () => {
    const cfg = { env: { PROJECT: ROOT, LINK: `${ROOT}/link-out` }, alwaysPaths: [ROOT] }
    expect(judge('echo x > "$PROJECT/link-out/a.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$PROJECT/link-out/../a.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$LINK/../a.txt"', cfg).kind).toBe('ask')
    allow('cd packages && cat "$PROJECT/.simple-code/memory/state.db"', cfg)
  })
  it('不确定或字面量 PWD：按项目根判，不误弹', () => {
    for (const cmd of [
      'cd -; echo x > "$PWD/.simple-code/tmp/a"',
      'if true; then cd packages; fi; echo x > "$PWD/.simple-code/tmp/a"',
      'unset PWD; echo x > "$PWD/.simple-code/tmp/a"',
      "echo x > '$PWD/.simple-code/tmp/a'",
      'echo x > "\\$PWD/.simple-code/tmp/a"',
      'echo x > "$PWD/$UNKNOWN/.simple-code/tmp/a"',
    ])
      allow(cmd)
    // 对照：命令内字面赋值 PWD=/elsewhere 能代入，落点在项目外 → 照弹
    external('PWD=/elsewhere; echo x > "$PWD/.simple-code/tmp/a"')
  })
  it('环境变量按 spawn 的同一份环境替换', () => {
    external('cat $HOME/.ssh/id_rsa')
    external('cat "$HOME"/.ssh/id_rsa')
    external('cat $HOME/.ssh/none') // 项目外不存在也弹（读面 2026-09-17）
    // env 里没有的、命令内定义的、覆盖 env 名字的 → 算不出。相对形态按
    // 项目根判不越界（无日志）；含 .. 的走算不出口径（见最后一组）
    allow('cat $NOPE/.nothing')
    allow('F=$(pwd); cat $F/.nothing')
    // 命令内顶层字面赋值 HOME=OTHER 能代入：落点在项目外 → 照弹
    external(`HOME=${OTHER}; cat $HOME/web/.env.production`)
  })
})

describe('跟着 cd 走：相对路径按 cd 后的目录算', () => {
  it('cd 到项目内子目录：相对路径照项目内判', () => {
    allow('cd packages && cat .env') // packages/.env 存在：项目内放
    allow('cd packages && cat .gitignore')
    allow('cd packages && cat web/.env.production')
  })
  it('cd 到项目外：相对路径落在外部，照弹', () => {
    // cd 目标与相对路径两处外部触发，合并成 multi，reason 带相对形态
    const v = judge(`cd ${OTHER} && cat web/.env.production`)
    expect(v).toMatchObject({ kind: 'ask', category: 'multi' })
    if (v.kind === 'ask') expect(v.reason).toContain('web/.env.production')
    // cd 目标已批（alwaysPaths）时：相对路径按 cwd 绝对化后落在 OTHER 子树内
    allow(`cd ${OTHER} && cat web/.env.production`, { alwaysPaths: [OTHER] })
  })
  it('cd 算不出（cd -、嵌套结构里的 cd、命令内变量）→ 按项目根判，不误弹', () => {
    allow('cd - && cat .nothing')
    allow('if true; then cd packages; fi; cat .nothing')
    allow('D=$(echo packages); cd $D && cat .nothing')
    allow('cd packages && cat x 2>/dev/null | head; cat .nothing')
    allow('cd packages && for f in a b; do echo $f; done 2>&1 | head; cat .nothing')
  })
})

describe('.. 按当前目录与真实路径解析', () => {
  it('cd 后的 .. 落在项目内放行', () => {
    allow('cd packages && ls ..')
    allow('cd packages && npx tsc --noEmit -p . ; cd ..')
    allow('cd packages && cat ../src/x.ts')
    allow('cd packages && cat ../.env') // ROOT/.env：项目内
    allow('cd packages && echo x > ../.simple-code/tmp/x.log')
  })
  it('真出项目照弹', () => {
    expect(judge('cd packages && ls ../..').kind).toBe('ask')
    expect(judge('ls ..').kind).toBe('ask')
    expect(judge('cat .x/../../../../../../../../etc/passwd').kind).toBe('ask')
  })
  it('走真实路径：link/.. 是链接目标的上级，不是字面上级', () => {
    expect(judge('cat link-out/../x').kind).toBe('ask') // 字面是 ROOT/x，内核实际访问 OTHER 的上级/x
  })
  it('不能借项目内路径用 .. 逃出去', () => {
    expect(judge('echo x > .simple-code/tmp/../../../x').kind).toBe('ask')
    external(`cat ${HOME}/.simple-code/../.ssh/id_rsa`)
  })
})

/** 2026-10-30 审复发端：`(cd knowledge-server && mvn … > ../.simple-code/tmp/x.log)`
 * 这类——子 shell 里的 cd 曾一律当「之后算不出」 */
describe('子 shell、$( )、<( )、后台语句：cd 只在里面生效', () => {
  it('里面：相对路径按 cd 后的目录算', () => {
    allow('(cd packages && ls .. && echo x > ../.simple-code/tmp/a.log 2>&1)')
    allow('n=$(cd packages && cat ../src/x.ts 2>/dev/null | wc -l)')
    allow('diff <(cd packages && ls ..) <(ls)')
    allow('for f in a b; do (cd packages && cat ../$f); done')
  })
  it('里面的 cd 越出项目照弹', () => {
    expect(judge('(cd packages && echo x > ../../evil.log)').kind).toBe('ask')
    allow('(cd packages && cat ../.env)')
    expect(judge('(cd packages && sleep 1 & echo x > ../a.pid)').kind).toBe('ask')
  })
  it('出来：恢复进入前的目录', () => {
    allow('(cd packages && ls) && cat .gitignore') // 项目内
    allow('n=$(cd packages && pwd); cat .gitignore')
    allow('cd packages && ls & cat .gitignore')
    allow('{ cd packages && ls ..; } && cat .gitignore')
    // 后台语句里 cd 仍在管道中：之后照旧算不出
    allow('cd packages | ls .. &') // cd 效果不确定 → .. 算不出 → 放行（2026-11-04）
  })
})

/** 2026-11-05 拍板：for 逐值代入砍掉（loopValuesOf/loopVariants 删除）——
 * 14 天回放里 for 的独立贡献 1-2 条，全落在已批目录；for 变量经
 * localVars 归「算不出 → 放行 + onUnparsed 日志」（2026-11-04 口径） */
describe('for 循环变量不再逐值代入', () => {
  it('for 变量一律算不出：放行 + onUnparsed（字面列表也一样）', () => {
    unparsed('cd packages && for d in src ..; do cat ../$d/x; done')
    unparsed(
      'cd .simple-code/memory && for v in now b1; do for w in 1024 480; do agent-browser screenshot ../tmp/$v-$w.png; done; done',
    )
  })
  it('for 变量不在 .. 路径里时：字面相对形态按项目内放行（无日志）', () => {
    allow('for d in src packages; do cat $d/.env; done')
  })
  it('for 里没有变量的部分照常判', () => {
    allow('cd packages && for f in a b; do echo $f; done 2>&1 | head; cat .nothing')
    expect(judge('for f in a; do echo x; done > /etc/passwd').kind).toBe('ask')
  })
})

/** 2026-10-31：命令里自己赋值的变量曾一律「算不出」——顶层、最外层作用域的
 * 字面赋值按源码顺序代入；变量有一处不确定的定义就整条不收 */
describe('命令内顶层字面赋值按顺序代入', () => {
  it('代入后按真实路径判（真机形态）', () => {
    allow('W=packages; cd $W && cat .nothing')
    allow(
      'W=.simple-code/tmp/wt; git worktree add -q --detach $W master && cd $W && mvn -q -s ../../../settings.xml test',
    )
    allow('d=packages; sqlite3 x.db ".backup \'$d/.nothing.db\'"') // 单引号在双引号里：$d 照样展开
    allow('export W=packages; cd $W && cat .nothing')
    allow('P=packages; D=$P; cd $D && cat .nothing')
    allow('W=lib; W=packages; cd $W && cat .env') // 依次覆盖，取最后一次：packages/.env 项目内
    allow('W=packages; W=lib; cd $W && cat .env')
    allow('W=packages; W=.. true; cd $W && cat .nothing') // 前缀赋值不改 shell 变量
  })
  it('代入后越出项目照弹（原先放行）', () => {
    expect(judge(`W=${OTHER}; cd $W && ls`)).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
    })
  })
  it('值不确定照旧算不出 → 放行（2026-11-04 拍板）', () => {
    allow('cd $W && cat .nothing; W=packages') // 赋值之前
    allow('W=$(echo packages); cd $W && cat .nothing')
    allow('W=`echo packages`; cd $W && cat .nothing')
    allow('W=pack; W+=ages; cd $W && cat .nothing') // 追加
    allow('W=packages true; cd $W && cat .nothing') // 前缀赋值只给那条命令
    allow('W=packages; read W; cd $W && cat .nothing')
    allow('W=packages; for i in a; do W=..; done; cd $W && cat .nothing')
    allow('f(){ W=..; }; W=packages; f; cd $W && cat .nothing')
    allow('(W=packages); cd $W && cat .nothing')
    allow('W=packages; if true; then W=../..; fi; cd $W && cat ../x')
  })
})

/** 同一审计 B 类：eval 的 JS、python -c 的代码被当路径切出伪 token */
describe('代码文本不是路径', () => {
  it('空白加语句符号的读参数不按路径判（取自真实卡片）', () => {
    allow(
      `cd - ; agent-browser eval "document.body.innerText.match(/.{0,80}利率.{0,120}/g)?.slice(0,3).join(' ')"`,
    )
    allow(
      `cd - ; python3 -c "\nimport json;c=json.load(open('/x/.simple-code/settings.json'))\nfor k in c: print(k)"`,
    )
    allow(`cd - ; zsh -ic 'cd ${ROOT}/.simple-code/tmp && node a.js'`)
  })
  it('带空格的真路径照判；写目标不吃这条豁免', () => {
    expect(judge('cat "/Library/Application Support/x (1).txt"').kind).toBe('ask')
    expect(judge('echo x > "/etc/a b;c"').kind).toBe('ask')
  })
})

describe('项目外一律 ask，一律可始终允许（键=目录前缀，读写同权）', () => {
  const keys = (cmd: string, cfg?: Partial<ApprovalConfig>) => {
    const v = judge(cmd, cfg)
    expect(v.kind, cmd).toBe('ask')
    return v.kind === 'ask' ? v.alwaysPaths : undefined
  }
  it('~ 直下与任意项目外：键=文件所在目录', () => {
    expect(keys(`cat ${HOME}/.ssh/id_rsa`)).toEqual([join(HOME, '.ssh')])
    expect(keys(`cat ${HOME}/.m2/repository/axis-1.4.jar`)).toEqual([join(HOME, '.m2/repository')])
    expect(keys(`ls ${HOME}/.ssh/*`)).toEqual([join(HOME, '.ssh')])
    expect(keys(`cat ${OTHER}/web/.env.production`)).toEqual([join(OTHER, 'web')])
    // 写卡不给键（写外面必须每次看着——2026-11-04 简化保留写卡的裸弹）
    expect(keys(`echo x >> ${HOME}/.zshrc`)).toBeUndefined()
    // ~/.simple-code 子树 2026-11-05 起免审（含写），例子换 ~ 下普通隐藏目录
    expect(keys(`echo x > ${HOME}/.cache/a.log`)).toBeUndefined()
  })
  it('批过键就放：读写同权（hiddenRead/hiddenWrite 已并，2026-11-05 收敛）', () => {
    allow(`cat ${HOME}/.ssh/id_rsa`, { alwaysPaths: [join(HOME, '.ssh')] })
    allow(`cat ${HOME}/.ssh/none`, { alwaysPaths: [join(HOME, '.ssh')] }) // 不存在也罩
    allow(`echo x > ${HOME}/.cache/a.log`, { alwaysPaths: [join(HOME, '.cache')] })
    denied(`echo x > ${HOME}/.simple-code/memory/x`, { alwaysPaths: [HOME] }) // 批键罩不住 memory 禁令
  })
  it('通配结尾的键=父目录（真机上等于家目录/根时被 dirHint 过滤掉不给）', () => {
    // 测试夹具的 HOME 是临时目录、不是 process 的 homedir()，过滤不了——
    // 真机上 `ls ~/.ssh*` 的键是 ~ 本身，dirHint 判过宽不给
    expect(keys(`ls ${HOME}/.ssh*`)).toEqual([HOME])
  })
  it('$SIMPLE_CODE_DOC 的拷贝（self.md）：整棵子树已免审（2026-11-05 拍板），读写都放', () => {
    allow(`cat ${HOME}/.simple-code/bin/self.md`)
    allow(`grep x "$HOME/.simple-code/bin/self.md"`)
    allow(`echo x > ${HOME}/.simple-code/bin/self.md`)
  })
  it('多处触发合并成 multi，键齐全时批量给', () => {
    const v = judge(`cat ${OTHER}/web/a.txt; cat ${HOME}/.cache/b.log; cat ${HOME}/.nvm/c`)
    expect(v).toMatchObject({
      kind: 'ask',
      category: 'multi',
      alwaysPaths: [join(OTHER, 'web'), join(HOME, '.cache'), join(HOME, '.nvm')],
    })
    // 掺一处记不成键的（键收敛到根，dirHint 判过宽）：整张不给
    const w = judge(`cat ${OTHER}/web/a.txt; ls /x`)
    expect(w).toMatchObject({ kind: 'ask', category: 'multi' })
    expect(w).not.toHaveProperty('alwaysPaths')
  })
})

describe('APPLY_PATCH 的相对路径与 bin 同口径：从 cd 后的目录往上找工作区根', () => {
  const patch = (file: string) =>
    `"$SIMPLE_CODE_APPLY_PATCH" <<'P'\n*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\nP`
  it('cd 到别的项目再打补丁：按 cwd 绝对化，批键罩住', () => {
    expect(judge(`cd ${OTHER} && ${patch('web/.env.production')}`).kind).toBe('ask')
    allow(`cd ${OTHER} && ${patch('web/.env.production')}`, { alwaysPaths: [OTHER] })
    allow(patch('web/.env.production')) // 不 cd：root 下没有这个文件
  })
  it('cd 到子目录：bin 往上找到 root，改的是 root 下文件', () => {
    allow(`cd packages && ${patch('.gitignore')}`)
  })
})

/** 2026-10-31：算不出的路径曾挂错牌子。2026-11-04 拍板：算不出不弹卡——
 * 放行 + onUnparsed 日志（带 token） */
describe('算不出的路径如实记日志', () => {
  it('命令里赋值、值要执行才知道的变量做 cd 目标，之后的 ../ 算不出', () => {
    unparsed(
      'W=$(git rev-parse --show-toplevel)/.simple-code/tmp/wt; cd $W && cat ../../../settings.xml',
    )
  })
  it('变量开头带 ..、当前目录未知时的 ..，读写都一样', () => {
    unparsed('cat $W/../a.txt')
    unparsed('echo x > $W/../a.txt')
    unparsed('cd - && cat src/../x')
  })
  it('补丁路径带 ..、cd 之后当前目录算不出 → 放行', () => {
    unparsed(
      `cd - && "$SIMPLE_CODE_APPLY_PATCH" <<'P'\n*** Begin Patch\n*** Update File: ../a.txt\n@@\n-a\n+b\n*** End Patch\nP`,
    )
  })
  it('算不出段放行后，multi 里只剩能判的段', () => {
    // $W/../a.txt 算不出 → 放行；cat ../x 照判（ROOT 上一级 → 项目外）
    expect(judge('cat $W/../a.txt; cat ../x')).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
    })
  })
  it('绝对路径里带算不出的变量：字面落点在项目外，照外部弹（真机：java -cp /tmp:$CP）', () => {
    expect(judge('cat /opt/$X/a.txt')).toMatchObject({ kind: 'ask', category: 'external_dir' })
  })
})

describe('审批配置写禁令（2026-11-05 拍板：模型不能改自己的约束）', () => {
  it('项目级 .simple-code/approval.json 写：deny（echo 重定向 / rm / mv）', () => {
    const v = denied('echo "{}" > .simple-code/approval.json')
    expect(v.kind === 'deny' && v.reason).toContain('审批规则自身的根基')
    denied('rm .simple-code/approval.json')
    denied('mv x .simple-code/approval.json')
    denied('echo "{}" > ' + join(ROOT, '.simple-code/approval.json'))
  })
  it('读保持放行（看配置不是威胁）', () => {
    allow('cat .simple-code/approval.json')
  })
  it('APPLY_PATCH 打到配置也 deny', () => {
    denied(
      '"$SIMPLE_CODE_APPLY_PATCH" <<\'P\'\n*** Update File: .simple-code/approval.json\n@@ x\n-y\n+y\n*** End of Patch',
    )
  })
  it('用户级 ~/.simple-code/approval.json 写：deny 且压过批过的目录键', () => {
    denied('echo "{}" > ~/.simple-code/approval.json')
    // 用户批过整个 ~/.simple-code 目录写也罩不住配置本身
    denied('echo "{}" > ~/.simple-code/approval.json', {
      alwaysPaths: [join(HOME, '.simple-code')],
    })
  })
  it('别的不叫 approval.json 的照常（项目内放行）', () => {
    allow('echo x > .simple-code/notes/a.md')
    allow('echo x > .simple-code/other.json')
  })
})

describe('flag 值是文本不是路径（-m/--message，2026-11-05 实弹）', () => {
  it('git commit -m 的消息以 ~ 或 / 开头：不判为路径', () => {
    expect(judge(`git commit -q -m "~/.simple-code 子树免审：只审配置文件"`).kind).toBe('allow')
    expect(judge(`git commit -m "/etc/hosts 的修复说明" && git log --oneline -1`).kind).toBe(
      'allow',
    )
  })
})

describe('~/.simple-code 子树免审（2026-11-05 拍板）', () => {
  it('notes/skills/logs 读写放行——审批卡不拦求证流程', () => {
    expect(judge(`cat ${HOME}/.simple-code/notes/lessons/x.md`).kind).toBe('allow')
    expect(judge(`echo hi > ${HOME}/.simple-code/tmp/wt/1`).kind).toBe('allow')
  })
  it('settings.json 走原判定弹卡；approval.json 写仍 deny、读放行', () => {
    expect(judge(`cat ${HOME}/.simple-code/settings.json`).kind).toBe('ask')
    expect(judge(`echo {} > ${HOME}/.simple-code/settings.json`).kind).toBe('ask')
    expect(judge(`cat ${HOME}/.simple-code/approval.json`).kind).toBe('allow')
    expect(judge(`echo {} > ${HOME}/.simple-code/approval.json`).kind).toBe('deny')
  })
  it('memory 写禁令仍压过子树免审', () => {
    expect(judge(`echo x > ${HOME}/.simple-code/memory/turns/x.jsonl`).kind).toBe('deny')
  })
})

describe('$() 命令替换的拼接串（2026-11-05 真机：git rev-parse 残片被当绝对路径弹卡）', () => {
  it('双引号串里嵌 $( )：剥掉替换后的残片不算绝对路径，归算不出', () => {
    unparsed('ls "$(git rev-parse --show-toplevel)/common/src/main/java/com/x/config/"')
    unparsed('cat "$(dirname "$0")/../x" 2>/dev/null')
  })
  it('纯字面双引号串不误伤：照常判', () => {
    external('cat "/etc/hosts"')
  })
})
