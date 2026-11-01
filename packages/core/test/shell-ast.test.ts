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
      { text: '.simple-code/a', write: true, redirect: true },
      { text: '/tmp/e', write: true, redirect: true },
      { text: '.simple-code/b', write: false, redirect: true },
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

  it('grammar 把一个词切成两个紧挨的节点时拼回（`$v-$w.png`，2026-10-29）', () => {
    // tree-sitter-bash 0.25：concatenation«x/$v-$» + word«w.png»，中间无空白
    expect(astSegments('a x/$v-$w.png y >o')?.[0]).toEqual({
      lead: 'a',
      items: [
        { text: 'x/$v-$w.png', write: false },
        { text: 'y', write: false },
        { text: 'o', write: true, redirect: true },
      ],
    })
    // 重定向紧贴参数不拼（`cat x>o` 的 o 是写目标）
    expect(astSegments('cat x>o')?.[0]?.items).toEqual([
      { text: 'x', write: false },
      { text: 'o', write: true, redirect: true },
    ])
  })

  it('heredoc 起始行后面跟 `;` 或「重定向 + |」：grammar 报错，挪到行尾重解析（2026-10-29）', () => {
    // tree-sitter-bash 0.25：bash 合法，grammar 报 ERROR。真机两条：commit 后接
    // 装机与 kill，python3 heredoc 后接 2>/dev/null | head
    const commit =
      "git commit -q -F - <<'MSG' && git log -3 | tail -2; kill $(cat x.pid)\n标题 $(不展开)\nMSG"
    expect(astSegments(commit)?.map((s) => s.lead)).toEqual(['git', 'git', 'tail', 'kill', 'cat'])
    const py = "python3 - <<'PY' 2>/dev/null | head -60\nprint(1)\nPY"
    // 单个 `-` 本来就不出 token（不挪的 `python3 - <<'PY'` 同样 items 为空）
    expect(astSegments(py)?.map((s) => [s.lead, s.items.map((i) => i.text)])).toEqual([
      ['python3', ['/dev/null']],
      ['head', ['-60']],
    ])
    // 不带引号的不挪：body 展开标记挂在宿主命令上，挪了 alwaysLead 会记错命令
    expect(astSegments('cat <<E; c\n$x\nE')).toBeNull()
  })

  it('重定向目标只取操作符后第一个词，其余是参数；写在命令前不当 lead（2026-10-30）', () => {
    // 0.25 grammar 把 `> f x` 的 x 也挂进 file_redirect，原来取最后一个词：f 丢、x 成写目标
    expect(astSegments('echo > /etc/passwd x')?.[0]).toEqual({
      lead: 'echo',
      items: [
        { text: 'x', write: false },
        { text: '/etc/passwd', write: true, redirect: true },
      ],
    })
    expect(astSegments('grep a 2>/dev/null b')?.[0]?.items.map((i) => [i.text, i.write])).toEqual([
      ['a', false],
      ['b', false],
      ['/dev/null', true],
    ])
    expect(astSegments('cat < in.txt x')?.[0]?.items).toEqual([
      { text: 'x', write: false },
      { text: 'in.txt', write: false, redirect: true },
    ])
    // 写在命令前：file_redirect 排在 command_name 前，原来被当 lead
    expect(astSegments('> o.log git push')?.[0]).toEqual({
      lead: 'git',
      items: [
        { text: 'push', write: false },
        { text: 'o.log', write: true, redirect: true },
      ],
    })
    // 目标被 grammar 切成紧挨的碎片时拼回一个词（原来只取最后一片 `l.properties`）
    expect(astSegments('cat x > $T/final_$l.properties')?.[0]?.items).toEqual([
      { text: 'x', write: false },
      { text: '$T/final_$l.properties', write: true, redirect: true },
    ])
  })

  it("heredoc 起始行后面的重定向收进来（`cat <<'E' > f`，2026-10-30）", () => {
    // file_redirect 挂在 heredoc_redirect 里面，原来整个漏扫
    expect(astSegments("cat <<'E' > /tmp/x\nhi\nE")?.[0]).toEqual({
      lead: 'cat',
      items: [{ text: '/tmp/x', write: true, redirect: true }],
    })
    expect(astSegments("python3 - <<'PY' 2>/dev/null >out.txt\nprint(1)\nPY")?.[0]?.items).toEqual([
      { text: '/dev/null', write: true, redirect: true },
      { text: 'out.txt', write: true, redirect: true },
    ])
  })
})
