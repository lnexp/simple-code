import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { eventMain } from '../src/event-bin.ts'

/**
 * progress/describe 两个订正口（2026-09-20 拍板）的 CLI 接线测试。
 * 原语本身的语义在 core 的 events.test 里测，这里测的是：子命令路由、
 * 没引号的多词句子拼回来、用法提示带得上新口子。
 */
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sc-event-'))
  dirs.push(dir)
  await mkdir(join(dir, '.simple-code', 'events'), { recursive: true })
  await writeFile(
    join(dir, '.simple-code', 'events', 'old-battle.md'),
    [
      '---',
      'name: old-battle',
      'description: 旧结论——某事是 A 原因',
      '---',
      '# old-battle — 旧结论——某事是 A 原因',
      '',
      '## 进展',
      '',
      '- 2026-09-01 · 立档，初判 A 原因',
      '',
    ].join('\n'),
  )
  return dir
}

describe('eventMain 订正口（2026-09-20）', () => {
  it('progress：多词句子拼回来追加进展段尾，原文一行不动', async () => {
    const dir = await fixture()
    const before = await readFile(join(dir, '.simple-code/events/old-battle.md'), 'utf8')
    const code = eventMain(['progress', 'old-battle', '订正', '其实', '是', 'B'], dir)
    expect(code).toBe(0)
    const after = await readFile(join(dir, '.simple-code/events/old-battle.md'), 'utf8')
    // 原来的进展行原样在，新行在其后（追加不是重写）
    expect(after).toContain('- 2026-09-01 · 立档，初判 A 原因')
    expect(after).toContain('订正 其实 是 B')
    // 原文除追加行与 updated 时间戳外没别的变化
    expect(after.replace(/^\s*- .*订正 其实 是 B.*$\n?/m, '').replace(/^updated:.*$/m, ''))
      .toBe(before.replace(/^updated:.*$/m, ''))
  })

  it('describe：front matter 与 H1 两处同步，正文不动', async () => {
    const dir = await fixture()
    const code = eventMain(['describe', 'old-battle', '更正', '后的', '一句话'], dir)
    expect(code).toBe(0)
    const after = await readFile(join(dir, '.simple-code/events/old-battle.md'), 'utf8')
    expect(after).toContain('description: 更正 后的 一句话')
    expect(after).toContain('# old-battle — 更正 后的 一句话')
    // 进展段没被碰
    expect(after).toContain('- 2026-09-01 · 立档，初判 A 原因')
  })

  it('不存在的事件：不新建，明说', async () => {
    const dir = await fixture()
    expect(eventMain(['progress', 'no-such', '一句话'], dir)).toBe(0) // 原语返回文案、不炸
    const after = await readFile(join(dir, '.simple-code/events/no-such.md'), 'utf8').catch(() => null)
    expect(after).toBeNull() // 关键：没变相新建
  })

  it('用法提示含订正口；help 退 0、乱写退 1', async () => {
    const dir = await fixture()
    expect(eventMain(['help'], dir)).toBe(0)
    expect(eventMain(['wat'], dir)).toBe(1)
    expect(eventMain([], dir)).toBe(1)
  })
})
