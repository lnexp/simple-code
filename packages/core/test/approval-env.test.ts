import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { classify, type ApprovalConfig } from '../src/tools/approval.ts'
import { warmupShellParser } from '../src/tools/shell-ast.ts'

const ROOT = '/sc-env-test/project'
const HOME = '/sc-env-test/home'
const cfg: ApprovalConfig = {
  hiddenAllow: [], networkAllow: [], askCommands: [], pathExists: () => true,
  env: { HOME, LOG_DIR: `${HOME}/.cache/logs`, PROJECT: ROOT },
}
const judge = (command: string, extra: Partial<ApprovalConfig> = {}) =>
  classify(command, ROOT, { ...cfg, ...extra })

function cases() {
  it('SC 日志读默认免审，不依赖用户点过始终允许', () => {
    for (const path of ['$HOME/.simple-code/logs/a', '${HOME}/.simple-code/logs/a',
      '"$HOME/.simple-code/logs/a"', '"$HOME"/.simple-code/logs/a']) {
      expect(judge(`cat ${path}`), path).toEqual({ kind: 'allow' })
    }
    expect(judge('echo x > "$HOME/.simple-code/logs/a"').kind).toBe('ask')
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
    expect(judge('echo x > $HOME/Documents/a')).toMatchObject({ kind: 'ask', category: 'external_dir' })
    expect(judge('cat $HOME/.ssh/missing', { pathExists: () => false })).toMatchObject({ kind: 'ask', category: 'external_dir' })
  })
  it('隐藏路径批读不连带批写，项目内变量路径仍保留读写边界', () => {
    // .ssh 属凭据类，10-29 起批过也不算（hidden-path.test.ts），这里用 .idea
    const extra = { hiddenRead: [`${HOME}/.idea`] }
    expect(judge('cat $HOME/.idea/a.xml', extra)).toEqual({ kind: 'allow' })
    expect(judge('echo x > $HOME/.idea/a.xml', extra).kind).toBe('ask')
    expect(judge('echo x > $PROJECT/.simple-code/tmp/a')).toEqual({ kind: 'allow' })
    expect(judge('echo x > $PROJECT/.simple-code/memory/a').kind).toBe('ask')
  })
  it('不确定、单引号、转义变量不能借 paths 白名单放行', () => {
    const extra = { alwaysPaths: [`${HOME}/.cache/logs`] }
    for (const command of [
      "cat '$HOME/.cache/logs/a'", 'cat "\\$HOME/.cache/logs/a"',
      'cat $UNKNOWN/.cache/logs/a', 'cat ${HOME:-/elsewhere}/.cache/logs/a',
      'HOME=/elsewhere; cat $HOME/.cache/logs/a',
      'unset HOME; cat $HOME/.cache/logs/a',
      'for HOME in /elsewhere; do cat $HOME/.cache/logs/a; done',
    ]) expect(judge(command, extra).kind, command).toBe('ask')
  })
  it('SC 自查文档：读 ~/.simple-code/bin 下的拷贝免审，dist 原件在 .vscode 下弹卡（2026-10-29）', () => {
    // 系统提示让 agent 在任何项目 grep "$SIMPLE_CODE_DOC"；变量指 shims.ts
    // ensureDocCopy 的拷贝。10-28 指 dist 原件时某真实项目弹了 6 张
    const grep = 'grep -n "审批" "$SIMPLE_CODE_DOC" | head'
    const copy = { ...cfg.env, SIMPLE_CODE_DOC: `${HOME}/.simple-code/bin/self.md` }
    expect(judge(grep, { env: copy })).toEqual({ kind: 'allow' })
    expect(judge('echo x > "$SIMPLE_CODE_DOC"', { env: copy }).kind).toBe('ask')
    const dist = { ...cfg.env, SIMPLE_CODE_DOC: `${HOME}/.vscode/extensions/sc-0.1.5/dist/self.md` }
    expect(judge(grep, { env: dist })).toMatchObject({ kind: 'ask', category: 'hidden_path' })
  })
}

describe('环境变量路径：正则回退', cases)
describe('环境变量路径：AST', () => {
  beforeAll(async () => { expect(await warmupShellParser()).toBe(true) })
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
    expect(j('echo x > ~/Code/proj/.simple-code/memory/a').kind).toBe('ask')
    expect(j('echo x > ~/Code/proj/.simple-code/tmp/a')).toEqual({ kind: 'allow' })
    expect(j('cat ~/Code/proj/.env')).toMatchObject({ kind: 'ask', category: 'hidden_path' })
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
