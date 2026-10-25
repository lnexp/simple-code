import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LESSONS_INDEX_LIMIT, lessonNamesIndex, listLessons, parseStdinLessonInput, readLesson, searchLessons, slugifyLessonName, writeLesson } from '../src/tools/lesson.ts'

const root = mkdtempSync(join(tmpdir(), 'sc-lesson-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const input = {
  name: 'webview-asset-cache',
  title: 'webview 改了代码 reload 后毫无变化：外链资源缓存',
  description: 'webview 改了代码、reload 后毫无变化时读——外链资源缓存绕法',
  symptom: '装进扩展目录的文件 md5 一致，reload 后界面毫无变化。',
  misjudged: '先怀疑没装上，md5 对过之后又怀疑缓存。',
  rootCause: 'webview 对外链 script 的缓存极顽固。',
  fix: '内容 hash 写进文件名。',
  verified: '无头 Chrome 复刻页 getBoundingClientRect 现形。',
}

describe('parseStdinLessonInput（stdin JSON 三态）', () => {
  it('空文本 → null（走 flag 形态）', () => {
    expect(parseStdinLessonInput('')).toBeNull()
    expect(parseStdinLessonInput('   \n  ')).toBeNull()
  })

  it('合法 JSON 对象 → 五段对象（字段校验交给 writeLesson）', () => {
    const out = parseStdinLessonInput('{"name":"x","rootCause":"多行\\n文本"}')
    expect(out).toEqual({ name: 'x', rootCause: '多行\n文本' })
  })

  it('非空但非法 JSON → 报错且指明不回退', () => {
    expect(() => parseStdinLessonInput("{'name': '单引号不是 JSON'}")).toThrow(/不是合法 JSON/)
    expect(() => parseStdinLessonInput('["数组也不行"]')).toThrow(/不是合法 JSON/)
  })
})

describe('writeLesson', () => {
  it('组装完整格式：front matter + 总标题 + 五段', () => {
    expect(writeLesson(root, input)).toContain('已写入')
    const text = readFileSync(join(root, '.simple-code/lessons/webview-asset-cache.md'), 'utf8')
    expect(text.startsWith('---\nname: webview-asset-cache\ndescription: webview 改了代码、reload 后毫无变化时读——外链资源缓存绕法\n---\n')).toBe(true)
    expect(text).toContain('# webview 改了代码 reload 后毫无变化：外链资源缓存')
    for (const label of ['## 症状', '## 当时怎么误判的', '## 根因', '## 修法', '## 怎么验证的']) {
      expect(text).toContain(label)
    }
  })

  it('name 规范化成 kebab-case；description 换行压平', () => {
    writeLesson(root, { ...input, name: 'Webview Asset_Cache!!', description: '第一行\n第二行' })
    const text = readFileSync(join(root, '.simple-code/lessons/webview-asset-cache.md'), 'utf8')
    expect(text).toContain('description: 第一行 第二行')
    expect(slugifyLessonName('Foo Bar_Baz!!')).toBe('foo-bar-baz')
  })

  it('缺段抛错并列出；同名再写是修订', () => {
    expect(() => writeLesson(root, { ...input, rootCause: '', verified: ' ' })).toThrow(/rootCause、verified/)
    expect(writeLesson(root, { ...input, symptom: '修订后的症状。' })).toContain('已修订')
    expect(readFileSync(join(root, '.simple-code/lessons/webview-asset-cache.md'), 'utf8')).toContain('修订后的症状')
  })
})

describe('listLessons / readLesson / searchLessons', () => {
  it('list：name + description 一行一条；read 带全文；search 命中带窗口', () => {
    writeLesson(root, { ...input, name: 'vsce-stale-vsix', title: 't', description: '装机像没更新时读' })
    expect(listLessons(root)).toContain('webview-asset-cache  —  webview 改了代码、reload 后毫无变化时读')
    expect(listLessons(root)).toContain('vsce-stale-vsix  —  装机像没更新时读')
    expect(readLesson(root, 'webview-asset-cache')).toContain('## 修法')
    expect(searchLessons(root, '缓存')).toContain('webview-asset-cache')
    expect(searchLessons(root, '完全不相关xyz')).toContain('没有教训命中')
  })

  it('search：OR 候选组与多词命中排序（与 note search 同款，见 search-terms.ts）', () => {
    writeLesson(root, { ...input, name: 'sse-eof-lesson', title: 't', description: 'SSE 断流判定' })
    // OR 组：任一候选词命中（此前整串 indexOf 必 0 命中）
    expect(searchLessons(root, '断流 OR 空响应 OR empty')).toContain('sse-eof-lesson')
    // 反向：候选词都不在库里
    expect(searchLessons(root, '不存在甲 OR 不存在乙')).toContain('没有教训命中')
  })

  it('read 不存在抛错给下一步指引', () => {
    expect(() => readLesson(root, 'no-such')).toThrow(/list/)
  })
})

describe('lessonNamesIndex（system prompt 注入清单，2026-09-17 方案 A）', () => {
  it('空库/目录不存在 → null 不进段；有教训 → name 一行一条', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sc-lesson-empty-'))
    try {
      expect(lessonNamesIndex(empty)).toBe(null)
      mkdirSync(join(empty, '.simple-code', 'lessons'), { recursive: true })
      expect(lessonNamesIndex(empty)).toBe(null) // 目录在但无 .md 也算空
    } finally { rmSync(empty, { recursive: true, force: true }) }
    const idx = lessonNamesIndex(root)
    expect(idx).toContain('- webview-asset-cache')
    expect(idx).not.toContain('description') // 只占位，不带描述——细节 read 全文
  })

  it('mtime 降序 + 上限对齐 events 的 30：最近踩的坑排前面', async () => {
    const r2 = mkdtempSync(join(tmpdir(), 'sc-lesson-order-'))
    try {
      writeLesson(r2, { ...input, name: 'old-lesson', title: 't', description: 'd' })
      await new Promise((res) => setTimeout(res, 15))
      writeLesson(r2, { ...input, name: 'new-lesson', title: 't', description: 'd' })
      const idx = lessonNamesIndex(r2)!
      expect(idx.indexOf('new-lesson')).toBeLessThan(idx.indexOf('old-lesson'))
      for (let i = 0; i < LESSONS_INDEX_LIMIT; i++)
        writeLesson(r2, { ...input, name: `bulk-${String(i).padStart(2, '0')}`, title: 't', description: 'd' })
      const lines = lessonNamesIndex(r2)!.split('\n')
      expect(lines).toHaveLength(LESSONS_INDEX_LIMIT)
      expect(lines.some((l) => l.includes('old-lesson'))).toBe(false) // 老的被挤出
    } finally { rmSync(r2, { recursive: true, force: true }) }
  })
})

describe('readLesson 心跳（memory-time-decay ①，2026-10-21）', () => {
  it('read 盖 lastRead；重复读是替换不是堆叠；文件里其余不动', () => {
    writeLesson(root, { ...input, name: 'heartbeat-lesson', title: 't', description: '心跳教训' })
    const path = join(root, '.simple-code', 'lessons', 'heartbeat-lesson.md')
    const before = readFileSync(path, 'utf8')
    expect(before).not.toContain('lastRead:')
    expect(readLesson(root, 'heartbeat-lesson')).toContain('## 修法')
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('lastRead:')
    readLesson(root, 'heartbeat-lesson')
    expect(readFileSync(path, 'utf8').match(/lastRead:/g)).toHaveLength(1)
    // 正文原样（front matter 之外不碰）
    expect(after).toContain(before.match(/^# .+$/m)?.[0] ?? '')
  })
})
