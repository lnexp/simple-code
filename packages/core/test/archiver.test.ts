import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEventArchive } from '../src/loop/archiver.ts'
import { loadConfig } from '../src/config/load.ts'
import { appendProgress, createEvent } from '../src/tools/events.ts'

let root: string
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-archiver-'))
  dirs.push(root)
})

const CONFIG = {
  provider: 'p',
  model: 'm',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      apiKey: '${TEST_KEY}',
      models: { m: { contextWindow: 100_000 } },
    },
  },
}

async function loaded() {
  writeFileSync(join(root, 'settings.json'), JSON.stringify(CONFIG), 'utf8')
  // globalPath 指到 tmp：不读 ~/.simple-code 的真实全局配置
  return loadConfig(root, { env: { TEST_KEY: 'sk-test' }, globalPath: join(root, 'settings.json') })
}

const SUMMARY = {
  name: '窗口摘要',
  description: 'events 机制改造的一轮',
  body: '把归档 agent 换成单次归类判断，落盘走原子原语。',
  coversFrom: 8388,
  coversTo: 8390,
}

/** 单次假流：完整 anthropic SSE（分类 JSON 一个 text block） */
function fakeFetch(reply: string): typeof fetch {
  return (async () =>
    new Response(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(reply)}}}`,
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch
}

describe('runEventArchive（单次归类 + 原子落盘）', () => {
  it('match 已有事件 → 追加一行进展，正文不动', async () => {
    createEvent(root, { name: 'events-mechanism', description: '事件机制', firstProgress: '落地', stepRange: '1–2' })
    const before = readFileSync(join(root, '.simple-code/events/events-mechanism.md'), 'utf8')
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": "events-mechanism", "progress": "归档改造为单次归类"}'),
    })
    expect(out.action).toBe('append')
    const after = readFileSync(join(root, '.simple-code/events/events-mechanism.md'), 'utf8')
    // 只多一行进展；旧的那一行原样在，front matter / H1 不动
    const bullets = after.split('\n').filter((l) => l.startsWith('- '))
    expect(bullets).toHaveLength(2)
    expect(bullets[0]).toBe(before.split('\n').find((l) => l.startsWith('- ')))
    expect(bullets[1]).toMatch(/ step 8388–8390 · 归档改造为单次归类$/)
    expect(after).toContain(before.split('\n').find((l) => l.startsWith('# ')) ?? '')
  })

  it('match 带新 description → 进展追加且两处描述同步更新', async () => {
    createEvent(root, { name: 'events-mechanism', description: '旧', firstProgress: 'x' })
    await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": "events-mechanism", "progress": "战役演进", "description": "事件机制 v3"}'),
    })
    const text = readFileSync(join(root, '.simple-code/events/events-mechanism.md'), 'utf8')
    expect(text).toContain('description: 事件机制 v3')
    expect(text).toContain('# events-mechanism — 事件机制 v3')
    expect(text).toContain('战役演进')
  })

  it('match 带 rename → 先改名再追加：进展落在新名档案（2026-09-17 拍板）', async () => {
    createEvent(root, { name: 'classifier-keywords-lock', description: 'keywords 锁定', firstProgress: '发现锁定问题' })
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": "classifier-keywords-lock", "progress": "keywords 全部删除", "rename": "keywords-removed"}'),
    })
    expect(out.action).toBe('append')
    expect(existsSync(join(root, '.simple-code/events/classifier-keywords-lock.md'))).toBe(false)
    const text = readFileSync(join(root, '.simple-code/events/keywords-removed.md'), 'utf8')
    expect(text).toMatch(/^name: keywords-removed$/m)
    expect(text).toContain('keywords 全部删除') // 本批进展落在改名后的档案
    expect(text).toContain('发现锁定问题') // 历史进展随文件走
  })

  it('rename 撞重名 → 失败不阻断：进展照常落旧名档案', async () => {
    createEvent(root, { name: 'a-campaign', description: '甲', firstProgress: '开端' })
    createEvent(root, { name: 'b-campaign', description: '乙', firstProgress: '开端' })
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": "a-campaign", "progress": "推进", "rename": "b-campaign"}'),
    })
    expect(out.action).toBe('append')
    const text = readFileSync(join(root, '.simple-code/events/a-campaign.md'), 'utf8')
    expect(text).toContain('推进')
    expect(readFileSync(join(root, '.simple-code/events/b-campaign.md'), 'utf8')).not.toContain('推进')
  })

  it('match=null 且给全 name/description → 新建档案（首行带 step）', async () => {
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": null, "progress": "CLI 形态定案", "name": "sc-cli-form", "description": "sc 命令形态战役"}'),
    })
    expect(out.action).toBe('create')
    const text = readFileSync(join(root, '.simple-code/events/sc-cli-form.md'), 'utf8')
    expect(text).toContain('name: sc-cli-form')
    expect(text).toMatch(/^- \d{4}-\d{2}-\d{2} · step 8388–8390 · CLI 形态定案$/m)
  })

  it('空进展（小修小闹）→ 什么都不写', async () => {
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": null, "progress": ""}'),
    })
    expect(out.action).toBe('empty')
    expect(existsSync(join(root, '.simple-code'))).toBe(false) // 连目录都没建
  })

  it('match 拼错（不在清单）→ 跳过不新建（防碎片化）', async () => {
    createEvent(root, { name: 'events-mechanism', description: 'd', firstProgress: 'x' })
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": "events-mechanism-v9", "progress": "拼错了"}'),
    })
    expect(out.action).toBe('skip-bad-match')
    // 库里还是只有那一个事件
    const { loadEvents } = await import('../src/tools/events.ts')
    expect(loadEvents(root)).toHaveLength(1)
  })

  it('match=null 但缺 name/description → 跳过', async () => {
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": null, "progress": "有进展但没名字"}'),
    })
    expect(out.action).toBe('skip-incomplete')
  })

  it('回个围栏 JSON 也能解析（模型爱加 ```json）', async () => {
    createEvent(root, { name: 'e', description: 'd', firstProgress: 'x' })
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('```json\n{"match": "e", "progress": "围栏也认"}\n```'),
    })
    expect(out.action).toBe('append')
    expect(readFileSync(join(root, '.simple-code/events/e.md'), 'utf8')).toContain('围栏也认')
  })

  it('回复不是 JSON → 跳过不炸', async () => {
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('我覺得這批不需要歸檔。'),
    })
    expect(out.action).toBe('empty')
  })

  it('分类器重复立已有名 → 并入（append 兜底）', async () => {
    createEvent(root, { name: 'dup-event', description: 'd', firstProgress: '第一条' })
    const out = await runEventArchive({
      root,
      summary: SUMMARY,
      config: await loaded(),
      fetchImpl: fakeFetch('{"match": null, "progress": "再来一条", "name": "dup-event", "description": "d"}'),
    })
    expect(out.action).toBe('append-existing')
    const text = readFileSync(join(root, '.simple-code/events/dup-event.md'), 'utf8')
    expect(text).toContain('再来一条')
  })
})

describe('appendProgress 段尾定位', () => {
  it('进展段后还有别的段（如正文）时，插在进展段尾而非文件尾', () => {
    createEvent(root, { name: 'x', description: 'd', firstProgress: '第一条' })
    // 手工在文件尾加一个别的段，模拟老格式档案（正文段在进展段之后）
    const path = join(root, '.simple-code/events/x.md')
    const old = readFileSync(path, 'utf8')
    writeFileSync(path, old + '\n## 附注\n\n这里不该被插进进展\n', 'utf8')
    appendProgress(root, 'x', '第二条', '5–6')
    const text = readFileSync(path, 'utf8')
    const prog = text.indexOf('第二条')
    const note = text.indexOf('这里不该被插进进展')
    expect(prog).toBeGreaterThan(-1)
    expect(note).toBeGreaterThan(prog)
    expect(text.indexOf('附注')).toBeGreaterThan(prog)
  })
})
