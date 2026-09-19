import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  listNoteCards,
  listNotes,
  NOTES_INDEX_LIMIT,
  parseNoteMeta,
  readNote,
  updateNote,
  writeNote,
} from '../src/tools/note.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'sc-note-'))

describe('note 库', () => {
  it('write 落盘带 name/description/created 的 front matter + # 标题', () => {
    const root = dir()
    writeNote(root, {
      name: 'deny-list',
      title: '温区配额已否决',
      description: '温区独立配额不做，列表时勿再提（t444）',
      body: '详细理由……',
    })
    const text = readNote(root, 'deny-list')
    expect(text).toContain('name: deny-list')
    expect(text).toContain('description: 温区独立配额不做，列表时勿再提（t444）')
    expect(text).toContain('created:')
    expect(text).toContain('# 温区配额已否决')
    expect(parseNoteMeta(text).name).toBe('deny-list')
  })

  it('description 缺省回落到 title——写了总比空索引强', () => {
    const root = dir()
    writeNote(root, { name: 'x', title: '只有标题', description: '', body: 'b' })
    expect(listNoteCards(root)[0]?.description).toBe('只有标题')
  })

  it('read 更新 lastRead——LRU 心跳', () => {
    const root = dir()
    writeNote(root, { name: 'a', title: 'A', description: 'a', body: 'b' })
    const before = parseNoteMeta(readNote(root, 'a'))
    expect(before.lastRead).toBeTruthy()
    expect(before.created).toBeTruthy()
  })

  it('read 对裸文件（无 front matter）补头迁移，不报错', () => {
    const root = dir()
    mkdirSync(join(root, '.simple-code', 'notes'), { recursive: true })
    writeFileSync(join(root, '.simple-code', 'notes', 'bare.md'), '# 旧格式\n\n正文', 'utf8')
    const text = readNote(root, 'bare')
    expect(text).toMatch(/^---\n/)
    expect(text).toContain('# 旧格式')
  })

  it('LRU 排序：read 过的浮到最前；索引截断在 NOTES_INDEX_LIMIT', () => {
    const root = dir()
    // 10 条，创建时间同秒——用 created 串行区分（ISO 毫秒级，循环里 sleep 0 会撞）
    for (let i = 0; i < NOTES_INDEX_LIMIT + 2; i++) {
      writeNote(root, { name: `n${i}`, title: `T${i}`, description: `d${i}`, body: 'b' })
    }
    // 最旧的 n0 读一下 → 应浮到最前
    readNote(root, 'n0')
    const cards = listNoteCards(root)
    expect(cards[0]?.name).toBe('n0')
    expect(cards.length).toBe(NOTES_INDEX_LIMIT + 2)
    // list 是全量（含被挤出索引的），索引截断只发生在 session 侧
    expect(listNotes(root)).toContain('- n0 — d0')
  })

  it('list 空库给写法提示而不是空白', () => {
    expect(listNotes(dir())).toContain('还没有 note')
  })

  it('update 给哪段改哪段：只改 description，title/正文/created 保留', () => {
    const root = dir()
    writeNote(root, { name: 'mcp', title: 'MCP 状态', description: 'ESM 崩溃未解决', body: '旧正文' })
    const before = parseNoteMeta(readNote(root, 'mcp'))
    const out = updateNote(root, 'mcp', { description: '已修好，SDK 兼容层落地' })
    expect(out).toContain('已更新')
    const after = parseNoteMeta(readNote(root, 'mcp'))
    expect(after.description).toBe('已修好，SDK 兼容层落地')
    expect(after.created).toBe(before.created) // 首次创建时间不因改写丢失
    expect(readNote(root, 'mcp')).toContain('# MCP 状态') // title 没给就保留
    expect(readNote(root, 'mcp')).toContain('旧正文') // 正文没给就保留
  })

  it('update 不存在的 note 报错指路', () => {
    expect(() => updateNote(dir(), 'nope', { description: 'x' })).toThrow('没有这条 note')
  })

  it('write 撞同名报错指路 update——静默覆盖会丢旧结论', () => {
    const root = dir()
    writeNote(root, { name: 'dup', title: 'T', description: 'd', body: 'b' })
    expect(() => writeNote(root, { name: 'dup', title: 'T2', description: 'd2', body: 'b2' })).toThrow(
      '已存在',
    )
  })
})
