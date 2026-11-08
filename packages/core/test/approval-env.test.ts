import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type ApprovalConfig, classify } from '../src/tools/approval.ts'
import { warmupShellParser } from '../src/tools/shell-ast.ts'

const ROOT = '/sc-env-test/project'
const HOME = '/sc-env-test/home'
const cfg: ApprovalConfig = {
  askCommands: [],
  denyCommands: [],
  pathExists: () => true,
  env: { HOME, LOG_DIR: `${HOME}/.cache/logs`, PROJECT: ROOT },
}
const judge = (command: string, extra: Partial<ApprovalConfig> = {}) =>
  classify(command, ROOT, { ...cfg, ...extra })

function cases() {
  it('~/.simple-code 子树免审（2026-11-05 拍板）：logs 读写放，例外只有配置文件', () => {
    for (const path of [
      '$HOME/.simple-code/logs/a',
      '${HOME}/.simple-code/logs/a',
      '"$HOME/.simple-code/logs/a"',
      '"$HOME"/.simple-code/logs/a',
    ]) {
      expect(judge(`cat ${path}`), path).toMatchObject({ kind: 'allow' })
    }
    expect(judge('echo x > "$HOME/.simple-code/logs/a"').kind).toBe('allow')
    // settings.json 例外：走原判定弹卡（2026-11-05 拍板只审配置文件）
    expect(judge('cat "$HOME/.simple-code/settings.json"').kind).toBe('ask')
    // 用户点名例外（2026-11-04）：$SIMPLE_CODE_DOC 指向的拷贝读不拦
    const copy = { ...cfg.env, SIMPLE_CODE_DOC: `${HOME}/.simple-code/bin/self.md` }
    expect(judge('grep -n "审批" "$SIMPLE_CODE_DOC"', { env: copy })).toEqual({ kind: 'allow' })
  })
  it('变量 paths 白名单读写同权，未批的邻居不能沾光', () => {
    const extra = { alwaysPaths: [`${HOME}/.cache/logs`] }
    for (const path of ['$HOME/.cache/logs/a', '${HOME}/.cache/logs/a', '$LOG_DIR/a']) {
      expect(judge(`cat ${path}`, extra)).toEqual({ kind: 'allow' })
      expect(judge(`echo x > ${path}`, extra)).toEqual({ kind: 'allow' })
    }
    expect(judge('cat $HOME/.cache/logs-other/a', extra).kind).toBe('ask')
    expect(judge('cat $HOME/.cache/logs/../secret', extra).kind).toBe('ask')
  })
  it('普通项目外变量路径照拦，不存在也不能误当项目内', () => {
    expect(judge('cat $HOME/Documents/a')).toMatchObject({ kind: 'ask', category: 'external_dir' })
    expect(judge('echo x > $HOME/Documents/a')).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
    })
    expect(judge('cat $HOME/.ssh/missing', { pathExists: () => false })).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
    })
  })
  it('隐藏路径读写同权（2026-11-04 拍板：始终允许就是始终允许）', () => {
    // .ssh 属⑤黑名单，批过也不算（real-path.test.ts（已并入 approval-path.test.ts）），这里用 .idea
    const extra = { alwaysPaths: [`${HOME}/.idea`] }
    expect(judge('cat $HOME/.idea/a.xml', extra)).toEqual({ kind: 'allow' })
    expect(judge('echo x > $HOME/.idea/a.xml', extra)).toEqual({ kind: 'allow' }) // 批读连带放写
    expect(judge('echo x > $PROJECT/.simple-code/tmp/a')).toEqual({ kind: 'allow' })
    expect(judge('echo x > $PROJECT/.simple-code/memory/a').kind).toBe('deny') // v2 §2.2 禁令档
  })
  it('不确定变量按项目根判不误弹；能代入的越界照弹（2026-11-04 简化）', () => {
    const extra = { alwaysPaths: [`${HOME}/.cache/logs`] }
    // 算不出/字面的相对 token 按项目根判，不出项目 → 放
    for (const command of [
      "cat '$HOME/.cache/logs/a'",
      'cat "\\$HOME/.cache/logs/a"',
      'cat $UNKNOWN/.cache/logs/a',
      'cat ${HOME:-/elsewhere}/.cache/logs/a',
      'unset HOME; cat $HOME/.cache/logs/a',
    ])
      expect(judge(command, extra).kind, command).toBe('allow')
    // for 变量不再逐值代入（2026-11-05 拍板砍掉）：in 列表字面路径是否弹
    // 两组分歧（AST 下 for 列表不产 token → 放；回退把它当普通段 → 弹），
    // 不在共用 cases 断言——真机几乎全走 AST，与上面 HOME=/elsewhere
    // 赋值代入的分歧同因
  })
  it('SC 自查文档：读 ~/.simple-code/bin 下的拷贝免审，dist 原件在 .vscode 下弹卡（2026-10-29）', () => {
    // 系统提示让 agent 在任何项目 grep "$SIMPLE_CODE_DOC"；变量指 shims.ts
    // ensureDocCopy 的拷贝。10-28 指 dist 原件时某真实项目弹了 6 张
    const grep = 'grep -n "审批" "$SIMPLE_CODE_DOC" | head'
    const copy = { ...cfg.env, SIMPLE_CODE_DOC: `${HOME}/.simple-code/bin/self.md` }
    expect(judge(grep, { env: copy })).toEqual({ kind: 'allow' })
    // 子树免审（2026-11-05）：写拷贝也放——源头在 git 仓库，改拷贝可恢复
    expect(judge('echo x > "$SIMPLE_CODE_DOC"', { env: copy }).kind).toBe('allow')
    const dist = { ...cfg.env, SIMPLE_CODE_DOC: `${HOME}/.vscode/extensions/sc-0.1.5/dist/self.md` }
    expect(judge(grep, { env: dist })).toMatchObject({ kind: 'ask', category: 'external_dir' })
  })
}

describe('环境变量路径：正则回退', () => {
  cases()
  it('for 的 in 列表字面路径照判（分词不知道 for 语法；AST 下不产 token）', () => {
    const extra = { alwaysPaths: [`${HOME}/.cache/logs`] }
    expect(judge('for HOME in /elsewhere; do cat $HOME/.cache/logs/a; done', extra).kind).toBe(
      'ask',
    )
  })
})
describe('环境变量路径：AST', () => {
  beforeAll(async () => {
    expect(await warmupShellParser()).toBe(true)
  })
  it('for 变量不代入（2026-11-05 砍掉逐值）：AST 下 in 列表不产 token，放行', () => {
    const extra = { alwaysPaths: [`${HOME}/.cache/logs`] }
    expect(judge('for HOME in /elsewhere; do cat $HOME/.cache/logs/a; done', extra).kind).toBe(
      'allow',
    )
    expect(judge('for HOME in a b; do cat $HOME/.cache/logs/a; done', extra).kind).toBe('allow')
  })
  cases()
})

/** `~` 展开后落在项目内的，与绝对路径同判（2026-10-29：`cd ~/Code/<项目>`
 * 被当项目外，两周弹 24 张，有两个项目只好把自己记进 paths 白名单） */
function tildeCases() {
  const P = `${HOME}/Code/proj`
  const j = (command: string) => classify(command, P, cfg)
  beforeAll(() => {
    vi.stubEnv('HOME', HOME)
  }) // expandTilde 用 os.homedir()，它读 HOME
  afterAll(() => {
    vi.unstubAllEnvs()
  })
  it('~ 指回项目自身：按项目内判', () => {
    for (const c of [
      'cd ~/Code/proj && grep -n x src/a.java',
      'grep -n x ~/Code/proj/src/a.java',
      'echo x > ~/Code/proj/src/a.java',
      'ls ~/Code/proj',
    ])
      expect(j(c), c).toEqual({ kind: 'allow' })
  })
  it('项目内 .simple-code 与隐藏路径规则照旧；邻居目录和其他 ~ 路径仍是项目外', () => {
    expect(j('echo x > ~/Code/proj/.simple-code/memory/a').kind).toBe('deny') // v2 §2.2 禁令档
    // ~ 展开后在项目内（P 是根）：.simple-code 与 .env 都按项目内放
    // （2026-11-04 简化拍板：项目内全放）
    expect(j('echo x > ~/Code/proj/.simple-code/tmp/a').kind).toBe('allow')
    expect(j('cat ~/Code/proj/.env').kind).toBe('allow')
    expect(j('cat ~/Code/proj-other/a')).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
      detail: '~/Code/proj-other/a',
    })
    expect(j('cat ~/Documents/a')).toMatchObject({
      kind: 'ask',
      category: 'external_dir',
      detail: '~/Documents/a',
    })
  })
}
describe('~ 路径：正则回退', tildeCases)
describe('~ 路径：AST', () => {
  beforeAll(async () => {
    expect(await warmupShellParser()).toBe(true)
  })
  tildeCases()
})
