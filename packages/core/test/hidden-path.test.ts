import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ApprovalConfig, type ApprovalVerdict, classify } from '../src/tools/approval.ts'
import { appendHidden, loadAlways } from '../src/tools/approval-always.ts'
import { warmupShellParser } from '../src/tools/shell-ast.ts'

/**
 * 隐藏路径四层规则（docs/proposals/hidden-path.md，2026-09-29 拍板）。
 * 第 2 层要真实文件：root / 另一个项目 / 假家目录都用临时目录。
 * 走 AST 路径（预热）——生产上绝大多数命令走它。
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

const base: ApprovalConfig = { hiddenAllow: [], networkAllow: [], askCommands: [], env: { HOME } }
const judge = (cmd: string, cfg: Partial<ApprovalConfig> = {}): ApprovalVerdict => classify(cmd, ROOT, { ...base, ...cfg })
const allow = (cmd: string, cfg?: Partial<ApprovalConfig>) => expect(judge(cmd, cfg), cmd).toEqual({ kind: 'allow' })
const hidden = (cmd: string, cfg?: Partial<ApprovalConfig>) => {
  const v = judge(cmd, cfg)
  expect(v.kind, cmd).toBe('ask')
  if (v.kind === 'ask') expect(v.category, cmd).toBe('hidden_path')
  return v
}

describe('第 2 层：只拦真实存在的点开头路径', () => {
  it('PWD 路径与实际当前目录同判，不沿用宿主环境的 PWD', () => {
    const cfg = { alwaysLeads: ['agent-browser'], env: { PWD: OTHER } }
    allow('agent-browser screenshot "$PWD/.simple-code/tmp/a.png"', cfg)
    allow('agent-browser screenshot "${PWD}/.simple-code/tmp/a.png"', cfg)
    allow('echo x > $PWD/.simple-code/tmp/a.log', cfg)
    allow('cd packages && echo x > "$PWD/../.simple-code/tmp/a.log"', cfg)
    hidden('cat "$PWD/.env"', cfg)
    hidden('echo x > "$PWD/.simple-code/memory/state.db"', cfg)
    expect(judge('echo x > "$PWD/../outside.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$PWD/link-out/a.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$PWD/link-out/../a.txt"', cfg).kind).toBe('ask')
  })

  it('环境变量展开保留软链接与 ..，不能借 paths 白名单逃逸', () => {
    const cfg = { env: { PROJECT: ROOT, LINK: `${ROOT}/link-out` }, alwaysPaths: [ROOT] }
    expect(judge('echo x > "$PROJECT/link-out/a.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$PROJECT/link-out/../a.txt"', cfg).kind).toBe('ask')
    expect(judge('echo x > "$LINK/../a.txt"', cfg).kind).toBe('ask')
    allow('cd packages && cat "$PROJECT/.simple-code/memory/state.db"', cfg)
  })

  it('不确定或字面量 PWD 不能借临时目录豁免', () => {
    for (const cmd of [
      'cd -; echo x > "$PWD/.simple-code/tmp/a"',
      'if true; then cd packages; fi; echo x > "$PWD/.simple-code/tmp/a"',
      'PWD=/elsewhere; echo x > "$PWD/.simple-code/tmp/a"',
      'unset PWD; echo x > "$PWD/.simple-code/tmp/a"',
      "echo x > '$PWD/.simple-code/tmp/a'",
      'echo x > "\\$PWD/.simple-code/tmp/a"',
      'echo x > "$PWD/$UNKNOWN/.simple-code/tmp/a"',
    ]) expect(judge(cmd).kind, cmd).toBe('ask')
  })

  it('不存在就放行：不是路径的点开头文字、没匹配的通配、新建隐藏文件', () => {
    allow('sqlite3 x.db ".tables"')
    allow('sqlite3 x.db ".schema turns"')
    allow('ls scripts/.feishu*')
    allow('echo x > .newfile')
    // 对照：存在的照拦（读写都拦）
    hidden('cat .env')
    hidden('echo x > .env')
    hidden('ls .gi*') // 通配匹配到 .gitignore
    // 剥了引号的代码文本当 token：含 [ ] 的也不能让判定抛错（历史重放实案）
    expect(() => judge(`python3 -c "d=json.load(open('.x/settings.json'))print(d[b-a])"`, { alwaysLeads: ['python3'] })).not.toThrow()
    expect(() => judge('cat .x/a[z-b]*')).not.toThrow()
  })
  it('跟着 cd 走：相对路径按 cd 后的目录找', () => {
    hidden('cd packages && cat .env')
    allow('cd packages && cat .gitignore') // packages/.gitignore 不存在
    // 过去 9 次 .env 里 6 次是这种写法：cd 到别的项目读。cd 目标本身是
    // 项目外路径，两处触发合并成 multi，其中必须有隐藏路径
    const v = judge(`cd ${OTHER} && cat web/.env.production`)
    expect(v).toMatchObject({ kind: 'ask', category: 'multi' })
    if (v.kind === 'ask') expect(v.reason).toContain('隐藏路径：web/.env.production')
    // 同一条命令，cd 目标已批过（alwaysPaths）时只剩隐藏路径
    hidden(`cd ${OTHER} && cat web/.env.production`, { alwaysPaths: [OTHER] })
    // 对照：不 cd 时 root 下没有 web/.env.production
    allow('cat web/.env.production')
  })
  it('cd 算不出（cd -、嵌套结构里的 cd、命令内变量）→ 按原则拦', () => {
    hidden('cd - && cat .nothing')
    hidden('if true; then cd packages; fi; cat .nothing')
    hidden('D=$(echo packages); cd $D && cat .nothing')
    // 对照：顶层 cd 到算得出的目录，不存在就放行
    allow('cd packages && cat .nothing')
    // tree-sitter 把 `cd x && a 2>/dev/null | b` 解析成
    // pipeline(redirected_statement(list(cd, a)), b)，cd 仍是顶层（真机形态）
    allow('cd packages && cat x 2>/dev/null | head; cat .nothing')
    // 同一形态、a 是 for/while 循环（真机 7 条）：循环体里的命令才是最右那条
    allow('cd packages && for f in a b; do echo $f; done 2>&1 | head; cat .nothing')
    // 对照：cd 真在管道里（list 最右那条）——bash 里是子 shell，之后算不出
    hidden('ls && cd packages | cat; cat .nothing')
  })
  it('环境变量按 spawn 的同一份环境替换', () => {
    hidden('cat $HOME/.ssh/id_rsa')
    hidden('cat "$HOME"/.ssh/id_rsa') // 引号拼接形态
    // 不存在只免隐藏路径检查；仍与绝对路径一样属于项目外，不能放行。
    expect(judge('cat $HOME/.ssh/none')).toMatchObject({ kind: 'ask', category: 'external_dir' })
    // env 里没有的、命令内定义的 → 算不出 → 拦
    hidden('cat $NOPE/.nothing')
    hidden('F=$(pwd); cat $F/.nothing')
    // 命令里覆盖了 env 已有的名字：按 env 替换会找错地方（假家目录下没有
    // web/.env.production → 误放），必须当算不出
    hidden(`HOME=${OTHER}; cat $HOME/web/.env.production`)
  })
  it('git 的 REV:path 不查磁盘，按名字判', () => {
    hidden('git show HEAD:.env')
    hidden('git show origin/main:web/.env.production')
    hidden('git show :.nothing') // 暂存区形态，磁盘上没有也拦
    allow('git show HEAD:README.md')
  })
  it('.. 逃逸先于存在检查判（.x 不存在不能把整条放掉）', () => {
    const v = judge('cat .x/../../../../../../../../etc/passwd')
    expect(v.kind).toBe('ask')
  })
  it('APPLY_PATCH 的相对路径与 bin 同口径：从 cd 后的目录往上找工作区根', () => {
    const patch = (file: string) => `"$SIMPLE_CODE_APPLY_PATCH" <<'P'\n*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\nP`
    // cd 到别的项目再打补丁：改的是那个项目的 web/.env.production（存在 → 拦）
    hidden(`cd ${OTHER} && ${patch('web/.env.production')}`, { alwaysPaths: [OTHER] })
    // 对照：不 cd，root 下没有这个文件 → 放行
    allow(patch('web/.env.production'))
    // cd 到子目录：bin 往上找到 root（有 .simple-code/memory），改的是 root/.gitignore
    hidden(`cd packages && ${patch('.gitignore')}`)
  })
})

describe('第 3 层：默认例外只有 .simple-code 的七个目录', () => {
  it('.simple-code：七个目录读写放行，其余读放行、写拦', () => {
    allow('cat >> .simple-code/notes/x.md <<\'EOF\'\nx\nEOF')
    allow('rm .simple-code/lessons/x.md')
    // principles：principle 类 note 的旧目录，与 lessons 同为 note-files.ts 兼容读的旧位置
    allow('echo x > .simple-code/principles/x.md')
    allow('mkdir -p .simple-code/skills/foo')
    allow('echo x > .simple-code/events/x.md')
    // tmp：agent 临时文件的指定落点（2026-10-22 拍板，bash 工具描述【临时文件】）
    allow('mkdir -p .simple-code/tmp/uishot')
    allow('echo x > .simple-code/tmp/uishot/a.log')
    allow('cat .simple-code/tmp/uishot/a.log')
    allow('rm -rf .simple-code/tmp/uishot')
    // diagnosis：反思自我诊断账本（2026-10-26 拍板，原放 memory/ 每次弹卡）
    allow("cat >> .simple-code/diagnosis/self-diagnosis.md <<'EOF'\n| x |\nEOF")
    hidden('echo x >> .simple-code/memory/self-diagnosis.md')
    hidden('echo x > .simple-code/tmpx/a') // 按目录名精确匹配，不是前缀
    allow('cat .simple-code/memory/state.db')
    hidden('rm .simple-code/memory/state.db')
    hidden('cp -r .simple-code/memory /tmp/x') // 带出去仍拦（2026-09-08 拍板）
  })
  it('.git 不再默认例外', () => {
    hidden('cat .git/config')
    allow('git log --oneline -3')
  })
})

describe('第 4 层：lead 不能绕过隐藏路径', () => {
  const leads = { alwaysLeads: ['cat', 'python3'] }
  it('lead 命中照查隐藏路径与 .simple-code 写', () => {
    hidden('cat .env', leads)
    hidden('cat .gitignore', leads)
    hidden('cat >> .simple-code/memory/x.md <<EOF\nx\nEOF', leads)
    hidden(`cat ${HOME}/.ssh/id_rsa`, leads) // 项目外的点开头路径也查
  })
  it('lead 只免命令名这一层；路径照判（2026-09-30 拍板：lead 与路径是 AND）', () => {
    allow('python3 script.py', leads)
    allow('cat src/a.ts', leads)
    // 对照：没有 lead 时 python3 弹（命令名这一层）
    expect(judge('python3 script.py').kind).toBe('ask')
    // 项目外路径：批过 lead 照弹，与没批过同一张卡
    const out = { kind: 'ask', category: 'external_dir' }
    expect(judge('cat /etc/hosts', leads)).toMatchObject(out)
    expect(judge('python3 /etc/x.py', leads)).toMatchObject(out)
    expect(judge('cat /etc/hosts > /tmp/sc-x.txt', leads)).toMatchObject(out)
    expect(judge('rsync -a dist/ /tmp/sc-dist/', { alwaysLeads: ['rsync'] })).toMatchObject(out)
    // 路径这道另有自己的白名单：两道都过才放行（不用 /etc——macOS 上是
    // /private/etc 的链接，真实路径对不上字面白名单）
    expect(judge('python3 /Users/sc-nowhere/a.py').kind).toBe('ask')
    allow('python3 /Users/sc-nowhere/a.py', { ...leads, alwaysPaths: ['/Users/sc-nowhere'] })
  })
})

describe('始终允许：记到第一个隐藏段为止，读写分开', () => {
  it('项目外的点开头路径不论有无 lead 都走隐藏路径卡（2026-09-30）', () => {
    // 曾经：无 lead 时报 external_dir，始终允许把 ~/.ssh 整个目录记进
    // alwaysPaths——读写全免；有 lead 时才报 hidden_path（只记读）
    // （10-29 起 .ssh 属凭据类不给始终允许，这里换成 .cache）
    expect(hidden(`cat ${HOME}/.cache/x`)).toMatchObject({
      alwaysHidden: { path: join(HOME, '.cache'), write: false },
    })
    // 批过读：读放行，写照拦
    const r = { hiddenRead: [join(HOME, '.cache')] }
    allow(`cat ${HOME}/.cache/x`, r)
    hidden(`echo x > ${HOME}/.cache/x`, r)
    // 不存在的点开头路径：隐藏这层放过，但它仍是项目外路径，照弹
    const out = { kind: 'ask', category: 'external_dir' }
    expect(judge(`echo x > ${HOME}/.newdir/f`)).toMatchObject(out)
    expect(judge(`echo x > ${HOME}/.newdir/f`, { alwaysLeads: ['echo'] })).toMatchObject(out)
  })
  it('卡上带可记的键', () => {
    expect(hidden('cat .idea/encodings.xml')).toMatchObject({ alwaysHidden: { path: '.idea', write: false } })
    expect(hidden('echo x > .gitignore')).toMatchObject({
      alwaysHidden: { path: '.gitignore', write: true },
    })
    expect(hidden('cd packages && cat .eslintrc')).toMatchObject({
      alwaysHidden: { path: 'packages/.eslintrc', write: false },
    })
    expect(hidden(`cat ${HOME}/.cache/x`, { alwaysLeads: ['cat'] })).toMatchObject({
      alwaysHidden: { path: join(HOME, '.cache'), write: false },
    })
    // 算不出/通配的不给键（无法收敛）
    expect(hidden('cat $NOPE/.x')).not.toHaveProperty('alwaysHidden')
    expect(hidden('ls .gi*')).not.toHaveProperty('alwaysHidden')
  })
  it('批读不连带批写', () => {
    allow('cat .idea/encodings.xml', { hiddenRead: ['.idea'] })
    hidden('echo x > .idea/encodings.xml', { hiddenRead: ['.idea'] })
    allow('echo x > .idea/encodings.xml', { hiddenWrite: ['.idea'] })
    // 前缀按段匹配：.idea 不沾 .idea2 的光
    touch(join(ROOT, '.idea2/x'))
    hidden('cat .idea2/x', { hiddenRead: ['.idea'] })
  })
  it('appendHidden 落盘读回，手写键原样保留', () => {
    const root = tmp('sc-hp-always-')
    mkdirSync(join(root, '.simple-code'))
    writeFileSync(join(root, '.simple-code/approval.json'), JSON.stringify({ askCommands: ['appctl deploy'] }))
    appendHidden(root, '.idea', false)
    appendHidden(root, '.idea', false) // 去重
    appendHidden(root, '.env', true)
    const d = loadAlways(root)
    expect(d.hiddenRead).toEqual(['.idea'])
    expect(d.hiddenWrite).toEqual(['.env'])
    expect(JSON.parse(readFileSync(join(root, '.simple-code/approval.json'), 'utf8')).askCommands).toEqual(['appctl deploy'])
    rmSync(root, { recursive: true, force: true })
  })
})

/** 2026-10-26 审批审计（note approval-audit-2026-10-16）：两周 98 张卡是
 * `cd packages/vscode && … ; cd ../..` 这类——`..` 曾一律当项目外 */
describe('.. 按当前目录与真实路径解析', () => {
  const outside = (cmd: string) => expect(judge(cmd).kind, cmd).toBe('ask')
  it('cd 后的 .. 落在项目内放行', () => {
    allow('cd packages && ls ..')
    allow('cd packages && npx tsc --noEmit -p . ; cd ..')
    allow('cd packages && cat ../src/x.ts')
    allow('cd packages && echo x > ../.simple-code/tmp/x.log')
  })
  it('真出项目照弹，落到存在的隐藏文件照拦', () => {
    outside('cd packages && ls ../..')
    outside('ls ..')
    hidden('cd packages && cat ../.env')
  })
  it('当前目录算不出时照旧按项目外', () => {
    outside('cd - && cat src/../x')
  })
  it('走真实路径：link/.. 是链接目标的上级，不是字面上级', () => {
    outside('cat link-out/../x') // 字面是 ROOT/x，内核实际访问 OTHER 的上级/x
  })
  it('不能借 .simple-code 豁免用 .. 逃出去', () => {
    outside('echo x > .simple-code/tmp/../../../x')
    hidden(`cat ${HOME}/.simple-code/../.ssh/id_rsa`)
  })
})

/** 2026-10-30 审批复审：某真实项目 `(cd knowledge-server && mvn -s ../settings.xml
 * … > ../.simple-code/tmp/x.log)` 这类——子 shell 里的 cd 曾一律当「之后算不出」 */
describe('子 shell、$( )、<( )、后台语句：cd 只在里面生效', () => {
  const outside = (cmd: string) => expect(judge(cmd).kind, cmd).toBe('ask')
  it('里面：相对路径按 cd 后的目录算', () => {
    allow('(cd packages && ls .. && echo x > ../.simple-code/tmp/a.log 2>&1)')
    allow('n=$(cd packages && cat ../src/x.ts 2>/dev/null | wc -l)')
    allow('diff <(cd packages && ls ..) <(ls)')
    allow('for f in a b; do (cd packages && cat ../$f); done')
  })
  it('里面的 cd 越出项目、碰到存在的隐藏文件照弹', () => {
    outside('(cd packages && echo x > ../../evil.log)')
    hidden('(cd packages && cat ../.env)')
  })
  it('出来：恢复进入前的目录', () => {
    hidden('(cd packages && ls) && cat .gitignore') // ROOT/.gitignore 存在；packages 下没有
    hidden('n=$(cd packages && pwd); cat .gitignore')
    // 后台：`a && b &` 整个在子 shell 里跑，cd 不带到 & 之后
    hidden('cd packages && ls & cat .gitignore')
    outside('(cd packages && sleep 1 & echo x > ../a.pid)')
    // 后台语句里 cd 仍在管道中：之后照旧算不出
    outside('cd packages | ls .. &')
  })
  it('花括号不是子 shell：cd 带出来；在管道里才是', () => {
    allow('{ cd packages && ls ..; } && cat .gitignore')
    hidden('{ cd packages; ls; } | cat; cat .nothing')
  })
})

/** 2026-10-29：for 循环变量曾一律「算不出」，`../x/$v` 被判隐藏路径
 * （真机 10-29 九张卡：cd .simple-code/tmp/timeline-shot 后写
 * ../bottom-options/$v-$w.png）。列表全是字面词时逐值代入 */
describe('for 循环变量逐值代入', () => {
  const outside = (cmd: string) => expect(judge(cmd).kind, cmd).toBe('ask')
  it('取值全部落在可放行处 → 放行（真机形态）', () => {
    allow(
      'cd .simple-code/memory && for v in now b1; do for w in 1024 480; do agent-browser screenshot ../tmp/$v-$w.png; done; done',
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash 的 ${var} 形态
    allow('cd packages && for pg in audit audit-light; do cat ../src/after-${pg}.png; done')
  })
  it('每个取值都判，有一个要弹就弹', () => {
    hidden('for d in src packages; do cat $d/.env; done') // packages/.env 存在
    allow('for d in src lib; do cat $d/.env; done') // 都不存在：第 2 层放行
    outside('cd packages && for d in src ..; do cat ../$d/x; done')
  })
  it('取值算不出照旧：非字面列表、循环里重新赋值、组合过多', () => {
    outside('cd packages && for v in a $(ls); do cat ../x/$v; done')
    outside('cd packages && for v in *.png; do cat ../x/$v; done')
    outside('cd packages && for v in a b; do v=../..; cat ../x/$v; done')
    const nine = '1 2 3 4 5 6 7 8 9'
    outside(`cd packages && for a in ${nine}; do for b in ${nine}; do cat ../x/$a$b; done; done`)
  })
})

/** 2026-10-31：命令里自己赋值的变量曾一律「算不出」——过去一周回放 100 条
 * 算不出里 49 条是 `W=字面; cd $W && …`（17 张卡本不该弹），反方向
 * `W=/etc; cd $W && cat passwd` 却放行。顶层、最外层作用域的字面赋值按
 * 源码顺序代入；变量有一处不确定的定义（嵌套/子 shell/函数里赋值、read、
 * for、unset）就整条命令不收 */
describe('命令内顶层字面赋值按顺序代入', () => {
  const outside = (cmd: string) => expect(judge(cmd).kind, cmd).toBe('ask')
  it('代入后按真实路径判（真机形态）', () => {
    allow('W=packages; cd $W && cat .nothing')
    allow('W=.simple-code/tmp/wt; git worktree add -q --detach $W master && cd $W && mvn -q -s ../../../settings.xml test')
    allow('d=packages; sqlite3 x.db ".backup \'$d/.nothing.db\'"') // 单引号在双引号里：$d 照样展开
    allow('export W=packages; cd $W && cat .nothing')
    allow('P=packages; D=$P; cd $D && cat .nothing')
    hidden('W=lib; W=packages; cd $W && cat .env') // 依次覆盖，取最后一次
    allow('W=packages; W=lib; cd $W && cat .env')
    allow('W=packages; W=.. true; cd $W && cat .nothing') // 前缀赋值不改 shell 变量
  })
  it('代入后越出项目照弹（原先放行）', () => {
    const v = judge(`W=${OTHER}; cd $W && ls`)
    expect(v).toMatchObject({ kind: 'ask', category: 'external_dir' })
  })
  it('值不确定照旧算不出', () => {
    hidden('cd $W && cat .nothing; W=packages') // 赋值之前
    hidden('W=$(echo packages); cd $W && cat .nothing')
    hidden('W=`echo packages`; cd $W && cat .nothing')
    hidden('W=pack; W+=ages; cd $W && cat .nothing') // 追加
    hidden('W=packages true; cd $W && cat .nothing') // 前缀赋值只给那条命令
    hidden('W=packages; read W; cd $W && cat .nothing')
    hidden('W=packages; for i in a; do W=..; done; cd $W && cat .nothing')
    hidden('f(){ W=..; }; W=packages; f; cd $W && cat .nothing') // 函数调用时才赋值
    hidden('(W=packages); cd $W && cat .nothing')
    outside('W=packages; if true; then W=../..; fi; cd $W && cat ../x')
  })
})

/** 同一审计 B 类：eval 的 JS、python -c 的代码被当路径，切出 `.test(t))`
 * 这类「隐藏段」，当前目录算不出时就拦 */
describe('代码文本不是路径', () => {
  const leads = { alwaysLeads: ['agent-browser eval', 'python3', 'zsh'] }
  it('空白加语句符号的读参数不按路径判（取自真实卡片）', () => {
    allow(`cd - ; agent-browser eval "document.body.innerText.match(/.{0,80}利率.{0,120}/g)?.slice(0,3).join(' ')"`, leads)
    allow(`cd - ; python3 -c "\nimport json;c=json.load(open('/x/.simple-code/settings.json'))\nfor k in c: print(k)"`, leads)
    allow(`cd - ; zsh -ic 'cd ${ROOT}/.simple-code/tmp && node a.js'`, leads)
  })
  it('带空格的真路径照判', () => {
    expect(judge('cat "/Library/Application Support/x (1).txt"').kind).toBe('ask')
  })
  it('写目标不吃这条豁免', () => {
    expect(judge('echo x > "/etc/a b;c"').kind).toBe('ask')
  })
})

/** 2026-10-29 拍板：隐藏路径卡「大部分能始终允许，有些肯定不能」。
 * 给：多处触发（每处都能记、≤5 项）、git 历史读、写 .simple-code 子目录。
 * 不给（已批的也不算）：算不出的路径、SC 控制文件（approval.json /
 * settings.json / memory）、凭据类（.ssh .aws .gnupg .netrc .npmrc .docker
 * .env* .zshrc .bashrc 与 shell 历史） */
describe('始终允许的给与不给（2026-10-29）', () => {
  const always = (cmd: string, cfg?: Partial<ApprovalConfig>) => {
    const v = judge(cmd, cfg)
    return v.kind === 'ask' ? v.alwaysHidden : undefined
  }
  it('凭据类：不给，已批的也不算', () => {
    expect(always(`cat ${HOME}/.ssh/id_rsa`)).toBeUndefined()
    hidden(`cat ${HOME}/.ssh/id_rsa`, { hiddenRead: [join(HOME, '.ssh')] })
    expect(always('cat .env')).toBeUndefined()
    hidden('cat .env', { hiddenRead: ['.env'] })
    expect(always('cd packages && cat .env')).toBeUndefined()
    expect(always(`ls ${HOME}/.ssh/*`)).toBeUndefined()
    // 批过的项目外目录也不连带放行它下面的凭据文件
    hidden(`cat ${OTHER}/web/.env.production`, { alwaysPaths: [OTHER] })
  })
  it('SC 控制文件：写不给，已批的也不算；其余 ~/.simple-code 写记到第二级', () => {
    expect(always(`echo x > ${HOME}/.simple-code/approval.json`)).toBeUndefined()
    hidden(`echo x > ${HOME}/.simple-code/approval.json`, {
      hiddenWrite: [join(HOME, '.simple-code')],
    })
    expect(always(`echo x > ${HOME}/.simple-code/skills/a/SKILL.md`)).toEqual({
      path: join(HOME, '.simple-code/skills'),
      write: true,
    })
  })
  it('项目 .simple-code 写其余子目录：按第二级给；memory/approval.json/settings.json 不给', () => {
    expect(always('echo x > .simple-code/scripts/a.sh')).toEqual({
      path: '.simple-code/scripts',
      write: true,
    })
    allow('echo x > .simple-code/scripts/a.sh', { hiddenWrite: ['.simple-code/scripts'] })
    hidden('echo x > .simple-code/scripts2/a.sh', { hiddenWrite: ['.simple-code/scripts'] })
    for (const f of ['memory/x', 'approval.json', 'settings.json']) {
      expect(always(`echo x > .simple-code/${f}`), f).toBeUndefined()
      hidden(`echo x > .simple-code/${f}`, { hiddenWrite: [`.simple-code/${f.split('/')[0]}`] })
    }
  })
  it('通配在最后一段、隐藏段在目录里：按目录里的隐藏段给', () => {
    expect(always('cat .github/workflows/*.yml')).toEqual({ path: '.github', write: false })
    allow('cat .github/workflows/*.yml', { hiddenRead: ['.github'] })
    expect(always('ls .gi*')).toBeUndefined() // 隐藏段本身带通配：记不成固定键
  })
  it('git 历史读：与磁盘读同一个键；.simple-code 照磁盘放行；提交说明不是路径', () => {
    expect(always('git show main:.gitignore')).toEqual({ path: '.gitignore', write: false })
    allow('git show main:.gitignore', { hiddenRead: ['.gitignore'] })
    allow('git show HEAD:.simple-code/approval.json')
    expect(always('git show HEAD:.env')).toBeUndefined()
    allow("git commit -m 'fix: 改 a/.simple-code/x 的判定'")
  })
  it('多处触发：每处都能记且 ≤5 项时批量给', () => {
    const v = judge(`cat .gitignore; cat .idea/encodings.xml; cat ${OTHER}/web/a.txt`)
    expect(v).toMatchObject({
      kind: 'ask',
      category: 'multi',
      alwaysPaths: [join(OTHER, 'web')],
      alwaysHiddens: [
        { path: '.gitignore', write: false },
        { path: '.idea', write: false },
      ],
    })
    // 掺一处不能记的（凭据 / 算不出）：整张不给
    for (const bad of ['cat .env', 'cat $NOPE/.x']) {
      const w = judge(`cat .gitignore; ${bad}`)
      expect(w, bad).toMatchObject({ kind: 'ask', category: 'multi' })
      expect(w, bad).not.toHaveProperty('alwaysHiddens')
      expect(w, bad).not.toHaveProperty('alwaysPaths')
    }
  })
})

/** 2026-10-31：算不出的路径曾挂「隐藏路径」或「项目外路径」的牌子（真机：
 * `W=.simple-code/tmp/wt; cd $W && mvn -s ../../../settings.xml` 弹「要触碰
 * 隐藏路径」，实际是项目根的 settings.xml）。用户要求如实告诉模型：是算不出、
 * 不确定在不在项目内，还是确实在项目外。照样弹、照样不给始终允许 */
describe('算不出的路径如实说算不出', () => {
  const unknown = (cmd: string) => {
    const v = judge(cmd)
    expect(v.kind, cmd).toBe('ask')
    if (v.kind !== 'ask') return
    expect(v.category, cmd).toBe('unparseable')
    expect(v.reason, cmd).toContain('算不出')
    expect(v.reason, cmd).not.toContain('隐藏路径')
    expect(v.reason, cmd).not.toContain('项目外')
    expect(v.alwaysHidden ?? v.alwaysPaths ?? v.alwaysHiddens, cmd).toBeUndefined()
  }
  it('命令里赋值、值要执行才知道的变量做 cd 目标，之后的 ../ 算不出', () => {
    // 真机原形态 `W=.simple-code/tmp/wt; …` 的字面赋值已能代入（见「命令内顶层字面赋值」）
    unknown('W=$(git rev-parse --show-toplevel)/.simple-code/tmp/wt; cd $W && cat ../../../settings.xml')
  })
  it('变量开头带 ..、当前目录未知时的 ..，读写都一样', () => {
    unknown('cat $W/../a.txt')
    unknown('echo x > $W/../a.txt')
    unknown('cd - && cat src/../x')
  })
  it('绝对路径里带算不出的变量（真机：java -cp /tmp:$CP）', () => {
    unknown('cat /opt/$X/a.txt')
  })
  it('补丁路径带 ..、cd 之后当前目录算不出（patchVerdict 不经 pathRules 改判）', () => {
    unknown(`cd - && "$SIMPLE_CODE_APPLY_PATCH" <<'P'\n*** Begin Patch\n*** Update File: ../a.txt\n@@\n-a\n+b\n*** End Patch\nP`)
  })
  it('对照：字面里有点开头段的仍按隐藏路径；算得出的项目外仍按项目外', () => {
    hidden('cat $NOPE/.nothing')
    hidden('D=$(echo packages); cd $D && cat .nothing')
    expect(judge('ls ..')).toMatchObject({ kind: 'ask', category: 'external_dir' })
  })
  it('多处合并时逐条标「无法静态判定」，不再写成隐藏路径', () => {
    const v = judge('cat $W/../a.txt; cat ../x')
    expect(v).toMatchObject({ kind: 'ask', category: 'multi' })
    if (v.kind === 'ask') {
      expect(v.reason).toContain('无法静态判定：$W/../a.txt')
      expect(v.reason).not.toContain('隐藏路径')
    }
  })
})
