import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clip,
  findMemoryRoot,
  runLog,
  parseLines,
  parseStepRange,
  renderTurn,
  runSearch,
  runShow,
  splitSteps,
  windowAround,
} from '../src/tools/memory.ts'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sc-memory-'))
  await mkdir(join(root, '.simple-code', 'memory', 'turns'), { recursive: true })
  await mkdir(join(root, '.simple-code', 'memory', 'summaries'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const jline = (role: string, parts: unknown[]): string => JSON.stringify({ role, parts })

describe('splitSteps（store.ts:1137 的复刻：首行或 assistant 开新 step）', () => {
  it('user 开 turn、assistant 开新 step、tool_result 归前一个 step', () => {
    const lines = parseLines(
      [
        jline('user', [{ type: 'text', text: '问' }]),
        jline('assistant', [{ type: 'text', text: '答1' }]),
        jline('user', [{ type: 'tool_result', toolCallId: 'c1', output: 'r1', isError: false }]),
        jline('user', [{ type: 'tool_result', toolCallId: 'c2', output: 'r2', isError: false }]),
        jline('assistant', [{ type: 'text', text: '答2' }]),
      ].join('\n'),
    )
    const steps = splitSteps(lines)
    expect(steps).toHaveLength(3)
    expect(steps[0]?.map((l) => l.role)).toEqual(['user'])
    expect(steps[1]?.map((l) => l.role)).toEqual(['assistant', 'user', 'user'])
    expect(steps[2]?.map((l) => l.role)).toEqual(['assistant'])
  })

  it('坏 JSON 行跳过，不炸整盘', () => {
    expect(parseLines('{"role":"user"}\nnot-json\n')).toHaveLength(1)
  })
})

describe('clip / windowAround（codepoint 安全——中文 emoji 不碎）', () => {
  it('clip 长文头尾保留 + 计数', () => {
    const out = clip('开头。' + 'x'.repeat(1000) + '。结尾')
    expect(out).toMatch(/^开头。/)
    expect(out).toMatch(/。结尾$/)
    expect(out).toContain('共 1006 字符')
  })

  // 孤立代理才是乱码的真身（U+FFFD 是显示层兜底）——按码点结构检测
  const hasLoneSurrogate = (s: string): boolean =>
    [...s].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)

  it('clip 不会把 emoji 切成乱码（split+slice 会产生孤代理，Array.from 不会）', () => {
    const out = clip('x' + '😀'.repeat(700))
    expect(hasLoneSurrogate(out)).toBe(false)
    expect(out.endsWith('😀')).toBe(true)
  })

  it('windowAround：窗口含命中词、两侧省略号', () => {
    const text = `前文${'甲'.repeat(400)}pickOldestSteps${'乙'.repeat(400)}后文`
    const at = text.indexOf('pickOldestSteps')
    const w = windowAround(text, at, 20)
    expect(w).toContain('pickOldestSteps')
    expect(w.startsWith('…') && w.endsWith('…')).toBe(true)
    expect(Array.from(w).length).toBeLessThanOrEqual(20 + 14 + 20 + 2)
    expect(w).not.toContain('\u{FFFD}')
  })
})

describe('renderTurn / parseStepRange', () => {
  const lines = parseLines(
    [
      jline('user', [{ type: 'text', text: '问' }]),
      jline('assistant', [
        { type: 'reasoning', text: '思考'.repeat(400) },
        { type: 'tool_call', name: 'bash', input: { command: 'cat a.ts'.repeat(60) } },
      ]),
      jline('user', [{ type: 'tool_result', toolCallId: 'c1', output: 'o'.repeat(5000), isError: true }]),
    ].join('\n'),
  )

  it('渲染：四种 part 各归位，长内容裁剪带计数，step 序号 1 起', () => {
    const out = renderTurn(lines)
    expect(out).toContain('2 steps')
    expect(out).toContain('── step 1')
    expect(out).toContain('── step 2')
    expect(out).toContain('text      问')
    expect(out).toContain('reasoning 思考')
    expect(out).toContain('共 800 字符')
    expect(out).toContain('tool_call bash')
    expect(out).toContain('output（错误）')
    expect(out).toContain('共 5000 字符')
  })

  it('range 过滤只留目标 step；full 不裁剪', () => {
    expect(renderTurn(lines, { range: { from: 1, to: 1 } })).not.toContain('step 2')
    expect(renderTurn(lines, { full: true })).toContain('o'.repeat(5000))
  })

  it('parseStepRange："3" 单步、"3-5" 区间、垃圾拒绝', () => {
    expect(parseStepRange('3')).toEqual({ from: 3, to: 3 })
    expect(parseStepRange('3-5')).toEqual({ from: 3, to: 5 })
    expect(parseStepRange('x')).toBeUndefined()
  })
})

describe('runShow / runSearch（真文件）', () => {
  beforeEach(async () => {
    const t1 = [
      jline('user', [{ type: 'text', text: '当时聊了 pickOldestSteps 的粒度' }]),
      jline('assistant', [{ type: 'tool_call', name: 'bash', input: { command: 'grep pickOldestSteps run.ts' } }]),
      jline('user', [{ type: 'tool_result', toolCallId: 'c', output: 'function pickOldestSteps(){}', isError: false }]),
    ].join('\n')
    await writeFile(join(root, '.simple-code/memory/turns/turn-000001.jsonl'), t1)
    const t2 = [
      jline('user', [{ type: 'text', text: '另一件事' }]),
      jline('assistant', [{ type: 'reasoning', text: 'PICKOLDESTSTEPS 大写也在检索范围' }]),
    ].join('\n')
    await writeFile(join(root, '.simple-code/memory/turns/turn-000002.jsonl'), t2)
    await writeFile(
      join(root, '.simple-code/memory/summaries/turn-000001-s000001.md'),
      '---\nname: t1\n---\n这里提到 pickOldestSteps 的决策\n',
    )
  })

  it('runShow：turn 号定位 + step 过滤；不存在报错', async () => {
    const out = await runShow(root, '1')
    expect(out).toContain('turn 1')
    expect(out).toContain('当时聊了')
    expect(out).toContain('function pickOldestSteps(){}')
    const one = await runShow(root, '1', { steps: '2' })
    expect(one).not.toContain('当时聊了')
    await expect(runShow(root, '99')).rejects.toThrow(/不存在/)
    await expect(runShow(root, '1', { steps: 'zz' })).rejects.toThrow(/--steps/)
  })

  it('runShow last：取最大 turn 号，省一次 ls', async () => {
    const out = await runShow(root, 'last')
    expect(out).toContain('turn 2')
    expect(out).toContain('另一件事')
  })

  it('runLog：每 turn 一行、首条用户消息压平做标题、-n 截尾留最新', async () => {
    const lines = (await runLog(root)).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('turn   1')
    expect(lines[0]).toContain('当时聊了 pickOldestSteps 的粒度')
    expect(lines[1]).toContain('turn   2')
    expect(lines[1]).toContain('另一件事')
    // -n 1 只留最新的
    const one = await runLog(root, { n: 1 })
    expect(one).toContain('另一件事')
    expect(one).not.toContain('当时聊了')
  })

  it('runSearch：跨 jsonl/summary 命中、带 step 定位、大小写不敏感', async () => {
    const hits = await runSearch(root, 'pickoldeststeps')
    const wheres = hits.map((h) => h.where)
    expect(wheres).toContain('turn-000001:step1')
    expect(wheres).toContain('turn-000002:step2')
    expect(wheres).toContain('summaries/turn-000001-s000001.md:4')
    const textHit = hits.find((h) => h.kind === 'text')
    expect(textHit?.excerpt).toContain('粒度')
  })

  it('runSearch --ctx：命中附所在 step 的渲染，排版与 show 同款', async () => {
    const hits = await runSearch(root, 'pickoldeststeps', { ctx: true })
    const inTurn1Step1 = hits.find((h) => h.where === 'turn-000001:step1')
    // assistant 行开新 step（splitSteps 规则）：step1 只有 user 首行，
    // tool_call 落 step2 并带着它的 tool_result——所以命令命中是 step2
    expect(inTurn1Step1?.context?.[0]).toBe('── step 1（1 行，user）')
    expect(inTurn1Step1?.context?.join('\n')).toContain('当时聊了')
    const inStep2 = hits.find((h) => h.where === 'turn-000001:step2')
    expect(inStep2?.context?.[0]).toBe('── step 2（2 行，assistant/user）')
    // 命中的命令、同 step 的输出都在——看前后文不用再跑一次 show
    expect(inStep2?.context?.join('\n')).toContain('grep pickOldestSteps run.ts')
    expect(inStep2?.context?.join('\n')).toContain('function pickOldestSteps(){}')
    // summary 命中没有 step 概念，context 为空（bin 层 ?? [] 跳过）
    const inSummary = hits.find((h) => h.kind === 'summary')
    expect(inSummary?.context).toBeUndefined()
  })

  it('runSearch：perFile 上限 + 无命中空数组', async () => {
    await writeFile(
      join(root, '.simple-code/memory/turns/turn-000003.jsonl'),
      [
        jline('user', [{ type: 'text', text: 'a token b token c token' }]),
        jline('assistant', [{ type: 'text', text: 'token token' }]),
      ].join('\n'),
    )
    const hits = await runSearch(root, 'token', { perFile: 1 })
    expect(hits.filter((h) => h.where.startsWith('turn-000003'))).toHaveLength(1)
    expect(await runSearch(root, '绝不存在的词')).toEqual([])
  })

  it('findMemoryRoot：从深层子目录向上冒泡找到', async () => {
    const deep = join(root, '.simple-code', 'memory', 'turns')
    expect(findMemoryRoot(deep)).toBe(join(root, '.simple-code', 'memory'))
    expect(findMemoryRoot(tmpdir())).toBeUndefined()
  })
})
