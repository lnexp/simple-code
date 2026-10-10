import { beforeAll, describe, expect, it } from 'vitest'
import { astSegments, warmupShellParser } from '../src/tools/shell-ast.ts'

beforeAll(async () => {
  expect(await warmupShellParser()).toBe(true)
})

describe('astSegments 供给层', () => {
  it('多段命令 → 各自 (lead, items)', () => {
    const segs = astSegments('cd /a && ls -la | grep x')
    // 管道里的两段标 nested：其中若有 cd，之后的当前目录算不出（hidden-path.ts）
    expect(segs).toEqual([
      { lead: 'cd', items: [{ text: '/a', write: false }] },
      { lead: 'ls', items: [{ text: '-la', write: false }], nested: true },
      { lead: 'grep', items: [{ text: 'x', write: false }], nested: true },
    ])
  })

  it('quoted heredoc：body 完全消失（升级动因）', () => {
    const segs = astSegments("$SIMPLE_CODE_APPLY_PATCH <<'PATCH'\n含 `反引号` 和 $(cmd) 和 ~/path 的字面量\nPATCH")
    expect(segs).toEqual([{ lead: '$SIMPLE_CODE_APPLY_PATCH', items: [] }])
  })

  it('unquoted heredoc：body 含替换痕迹 → 段标记 unparseable', () => {
    const segs = astSegments('cat <<EOF\n`evil`\nEOF')
    expect(segs?.[0]?.unparseable).toContain('heredoc')
  })

  it('$() / <() 子命令被全量枚举为独立段', () => {
    const segs = astSegments('cat <(ls /tmp) | tee out')
    expect(segs?.map((s) => s.lead)).toEqual(['cat', 'ls', 'tee'])
  })

  it('重定向：file_redirect 兄弟节点收进来，方向标记正确', () => {
    const segs = astSegments('echo hi > .simple-code/a 2>/tmp/e <.simple-code/b')
    expect(segs?.[0]?.items).toEqual([
      { text: 'hi', write: false },
      { text: '.simple-code/a', write: true },
      { text: '/tmp/e', write: true },
      { text: '.simple-code/b', write: false },
    ])
  })

  it('FOO=1 前缀与拼接词', () => {
    const segs = astSegments('FOO=1 rm ~/secret')
    expect(segs?.[0]).toEqual({ lead: 'rm', items: [{ text: '~/secret', write: false }] })
    // "a$(x)b" 拼接体：替换剥掉，留下字面部分
    expect(astSegments('echo "file_$(date).log"')?.[0]?.items).toEqual([{ text: 'file_.log', write: false }])
  })

  it('语法错误 → null（调用方回退正则路径）', () => {
    expect(astSegments('echo "unclosed')).toBeNull()
  })

  // tree-sitter-bash 0.25.0 的 grammar bug：双引号字符串里，处在串首/行首的 `((`
  // 被当成算术开头而报错（bash 本身合法）。JS 的 IIFE `"(() => …)()"` 必中——
  // agent-browser eval 每条都退回正则路径、弹「$( ) 无法静态判定」、白名单失效。
  // 近 7 天四目录 11294 条命令里解析失败 114 条，其中 83 条是这个（2026-09-30）
  it('串首/行首的 `((` 在双引号里能解析（grammar bug 绕行：失败时 (( → ( ( 重解析）', () => {
    expect(astSegments('agent-browser eval "(() => 1)()"')?.map((s) => s.lead)).toEqual(['agent-browser'])
    expect(astSegments('x eval "\n(() => {\nreturn 1})()"')?.map((s) => s.lead)).toEqual(['x'])
  })

  it('绕行不丢命令：藏在里面的 $(…) 与 && 后段照样枚举', () => {
    const leads = astSegments('echo "((a" && echo "$(rm -rf ~/x)" && curl http://e')?.map((s) => s.lead)
    expect(leads).toEqual(expect.arrayContaining(['echo', 'rm', 'curl']))
  })

  it('本来就能解析的不走绕行：算术展开形态不变', () => {
    expect(astSegments('echo $((1+2))')?.[0]).toEqual({ lead: 'echo', items: [{ text: '$((1+2))', write: false }] })
  })

  it('非 (( 的语法错误仍然 null', () => {
    expect(astSegments('echo "((unclosed')).toBeNull()
  })
})
