import { beforeAll, describe, expect, it } from 'vitest'
import { astSegments, warmupShellParser } from '../src/tools/shell-ast.ts'

beforeAll(async () => {
  expect(await warmupShellParser()).toBe(true)
})

describe('astSegments 供给层', () => {
  it('多段命令 → 各自 (lead, items)', () => {
    const segs = astSegments('cd /a && ls -la | grep x')
    expect(segs).toEqual([
      { lead: 'cd', items: [{ text: '/a', write: false }] },
      { lead: 'ls', items: [{ text: '-la', write: false }] },
      { lead: 'grep', items: [{ text: 'x', write: false }] },
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
})
