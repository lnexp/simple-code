import { describe, expect, it } from 'vitest'
import { indexRepo, indexTouchEntries, matchTouch, renderTouch } from '../src/session/touch-cue.ts'

// 例子取自真实历史（note file-touch-recall-replay）：t19410 grep openai-chat.ts
// 本该撞到 deepseek-v4-reasoning-replay；cli/src/run.ts 撞 loop/run.ts 是回放里的主噪声
const repo = indexRepo([
  'packages/core/src/llm/protocols/openai-chat.ts',
  'packages/core/src/loop/run.ts',
  'packages/cli/src/run.ts',
  'packages/core/src/tools/approval.ts',
  'scripts/deploy.mjs',
])
const entries = indexTouchEntries([
  { kind: 'note', name: 'deepseek-v4-reasoning-replay', text: '改 openai-chat.ts 的 reasoning 回传/序列化前读' },
  { kind: 'lesson', name: 'loop-run-only', text: '改 loop/run.ts 的截断续写前读' },
  { kind: 'note', name: 'release-needs-explicit-approval', text: 'git push、gh release 前必看——须用户明确批准' },
  { kind: 'note', name: 'cat-in-desc', text: '提到 cat 和 grep 的条目' },
  { kind: 'lesson', name: 'webview-tsc-two-configs', text: 'webview 有两份 tsc 配置，只跑一份会漏' },
  { kind: 'note', name: 'generic-only', text: '改 package.json 前读' },
])
const names = (cmd: string, exclude: ReadonlySet<string> = new Set()): string[] =>
  matchTouch([cmd], entries, repo, exclude).map((h) => h.c.name)

describe('文件联想', () => {
  it('命令里出现仓库真实文件，撞 description 点名该文件的条目', () => {
    expect(names('grep -n reasoning packages/core/src/llm/protocols/openai-chat.ts')).toEqual(['deepseek-v4-reasoning-replay'])
    // 只写文件名、全仓唯一也算
    expect(names('sed -n 1,20p openai-chat.ts')).toEqual(['deepseek-v4-reasoning-replay'])
  })
  it('description 写了目录就按路径后缀认：cli 的 run.ts 不撞 loop/run.ts', () => {
    expect(names('cat packages/cli/src/run.ts')).toEqual([])
    expect(names('cat packages/core/src/loop/run.ts')).toEqual(['loop-run-only'])
    expect(names('cat /Users/x/Code/simple-code/packages/core/src/loop/run.ts')).toEqual(['loop-run-only'])
  })
  it('只写文件名但全仓不唯一：认不出是哪个，不撞', () => {
    expect(names('vim run.ts')).toEqual([])
  })
  it('不在仓库里的文件、通用文件名、commit/log/show、读库命令都不算', () => {
    expect(names('cat ~/other/openai-chat-x.ts')).toEqual([])
    expect(names('cat packages/core/package.json')).toEqual([])
    expect(names('git commit -m "fix packages/core/src/llm/protocols/openai-chat.ts"')).toEqual([])
    expect(names('cd packages && git log -- core/src/llm/protocols/openai-chat.ts')).toEqual([])
    expect(names('"$SIMPLE_CODE_NOTE" read deepseek-v4-reasoning-replay # openai-chat.ts')).toEqual([])
  })
  it('apply_patch 的文件头算触及', () => {
    const patch = `"$SIMPLE_CODE_APPLY_PATCH" <<'PATCH'\n*** Begin Patch\n*** Update File: packages/core/src/llm/protocols/openai-chat.ts\n@@\n-a\n+b\n*** End Patch\nPATCH`
    expect(names(patch)).toEqual(['deepseek-v4-reasoning-replay'])
  })
})

describe('命令名联想', () => {
  it('程序名或「程序 子命令」整词出现在 description 里就撞', () => {
    expect(names('git push origin main v0.1.4')).toEqual(['release-needs-explicit-approval'])
    expect(names('cd x && gh release create v0.1.4 a.vsix')).toEqual(['release-needs-explicit-approval'])
    expect(names('npx tsc -p packages/vscode/webview')).toEqual(['webview-tsc-two-configs'])
  })
  it('通用命令（cat/grep/git 单独）不撞；git 只认带子命令', () => {
    expect(names('cat a.txt | grep x')).toEqual([])
    expect(names('git status')).toEqual([])
  })
  it('整词边界：名字里的 -tsc- 不算，heredoc 正文不当命令', () => {
    const e2 = indexTouchEntries([{ kind: 'lesson', name: 'x', text: '见 webview-tsc-two-configs' }])
    expect(matchTouch(['tsc --noEmit'], e2, repo, new Set())).toEqual([])
    expect(names("cat > a.md <<'EOF'\ngit push 之前要问\nEOF")).toEqual([])
    // 引号里换行后的词不是命令
    expect(names('python3 -c "import x\ngh = 1\nprint(gh)"')).toEqual([])
    expect(names("git commit -q -m 'feat: x\n\ngit push 要批准'")).toEqual([])
  })
})

describe('去重与上限', () => {
  it('已在场（exclude）的不再提；每次调用最多 2 条', () => {
    expect(names('git push origin main', new Set(['note:release-needs-explicit-approval']))).toEqual([])
    const many = indexTouchEntries(
      ['a', 'b', 'c'].map((n) => ({ kind: 'note', name: n, text: `改 approval.ts 前读 ${n}` })),
    )
    expect(matchTouch(['cat packages/core/src/tools/approval.ts'], many, repo, new Set())).toHaveLength(2)
  })
  it('同一步多条命令撞同一条目只提一次', () => {
    const hits = matchTouch(['git push origin main', 'gh release view v1'], entries, repo, new Set())
    expect(hits.map((h) => h.c.name)).toEqual(['release-needs-explicit-approval'])
  })
  it('成品行带触及物，标记同〔recall·async〕', () => {
    const [line] = renderTouch(matchTouch(['git push origin main'], entries, repo, new Set()))
    expect(line).toBe('〔recall·async〕note release-needs-explicit-approval — git push、gh release 前必看——须用户明确批准（触及: git push）')
  })
})
