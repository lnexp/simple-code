import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  for (const f of ['.env', '.gitignore', '.idea/encodings.xml', 'packages/.env', '.git/config', '.simple-code/memory/state.db'])
    touch(join(ROOT, f))
  touch(join(OTHER, 'web/.env.production'))
  touch(join(HOME, '.ssh/id_rsa'))
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
    hidden('(cd packages && ls) && cat .nothing')
    hidden('D=packages; cd $D && cat .nothing')
    // 对照：顶层 cd 到算得出的目录，不存在就放行
    allow('cd packages && cat .nothing')
    // tree-sitter 把 `cd x && a 2>/dev/null | b` 解析成
    // pipeline(redirected_statement(list(cd, a)), b)，cd 仍是顶层（真机形态）
    allow('cd packages && cat x 2>/dev/null | head; cat .nothing')
    // 对照：cd 真在管道里（list 最右那条）——bash 里是子 shell，之后算不出
    hidden('ls && cd packages | cat; cat .nothing')
  })
  it('环境变量按 spawn 的同一份环境替换', () => {
    hidden('cat $HOME/.ssh/id_rsa')
    hidden('cat "$HOME"/.ssh/id_rsa') // 引号拼接形态
    allow('cat $HOME/.ssh/none')
    // env 里没有的、命令内定义的 → 算不出 → 拦
    hidden('cat $NOPE/.nothing')
    hidden('F=x; cat $F/.nothing')
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

describe('第 3 层：默认例外只有 .simple-code 的四个目录', () => {
  it('.simple-code：四个目录读写放行，其余读放行、写拦', () => {
    allow('cat >> .simple-code/notes/x.md <<\'EOF\'\nx\nEOF')
    allow('rm .simple-code/lessons/x.md')
    allow('mkdir -p .simple-code/skills/foo')
    allow('echo x > .simple-code/events/x.md')
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
    expect(hidden(`cat ${HOME}/.ssh/id_rsa`)).toMatchObject({
      alwaysHidden: { path: join(HOME, '.ssh'), write: false },
    })
    // 批过读：读放行，写照拦
    const r = { hiddenRead: [join(HOME, '.ssh')] }
    allow(`cat ${HOME}/.ssh/id_rsa`, r)
    hidden(`echo x > ${HOME}/.ssh/id_rsa`, r)
    // 不存在的点开头路径：隐藏这层放过，但它仍是项目外路径，照弹
    const out = { kind: 'ask', category: 'external_dir' }
    expect(judge(`echo x > ${HOME}/.newdir/f`)).toMatchObject(out)
    expect(judge(`echo x > ${HOME}/.newdir/f`, { alwaysLeads: ['echo'] })).toMatchObject(out)
  })
  it('卡上带可记的键', () => {
    expect(hidden('cat .idea/encodings.xml')).toMatchObject({ alwaysHidden: { path: '.idea', write: false } })
    expect(hidden('echo x > .env')).toMatchObject({ alwaysHidden: { path: '.env', write: true } })
    expect(hidden('cd packages && cat .env')).toMatchObject({ alwaysHidden: { path: 'packages/.env', write: false } })
    expect(hidden(`cat ${HOME}/.ssh/id_rsa`, { alwaysLeads: ['cat'] })).toMatchObject({
      alwaysHidden: { path: join(HOME, '.ssh'), write: false },
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
