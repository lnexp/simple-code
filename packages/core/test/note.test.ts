import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  activeNoteCards,
  listNoteCards,
  listNotes,
  NOTES_INDEX_LIMIT,
  parseNoteMeta,
  readNote,
  searchNotes,
  writeNote,
} from '../src/tools/note.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'sc-note-'))
const readFileSyncText = (root: string, name: string) => readFileSync(join(root, '.simple-code', 'notes', `${name}.md`), 'utf8')

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

  it('已有 lastRead 的再读一次也刷新（2026-09-30 修：正则没带 m，$ 只认串尾，旧值永远换不掉）', () => {
    const root = dir()
    mkdirSync(join(root, '.simple-code', 'notes'), { recursive: true })
    const head = '---\nname: a\ndescription: d\ncreated: 2026-01-01 00:00:00\nlastRead: 2026-01-02 00:00:00\n---\n\n# t\n'
    writeFileSync(join(root, '.simple-code', 'notes', 'a.md'), head, 'utf8')
    const meta = parseNoteMeta(readNote(root, 'a'))
    expect(meta.lastRead).not.toBe('2026-01-02 00:00:00')
    expect(readNote(root, 'a').match(/lastRead:/g)).toHaveLength(1) // 换不是加
  })

  it('作废标记：activeNoteCards 剔除；list/read/search 标注「已作废」与接替者', () => {
    const root = dir()
    mkdirSync(join(root, '.simple-code', 'notes'), { recursive: true })
    const w = (n: string, extra: string) =>
      writeFileSync(join(root, '.simple-code', 'notes', `${n}.md`), `---\nname: ${n}\ndescription: 关于压缩${n}\n${extra}---\n\n# ${n}\n`, 'utf8')
    w('new', '')
    w('old', 'status: superseded\nby: new\n')
    expect(parseNoteMeta(readFileSyncText(root, 'old'))).toMatchObject({ status: 'superseded', by: 'new' })
    expect(activeNoteCards(root).map((c) => c.name)).toEqual(['new'])
    expect(listNoteCards(root)).toHaveLength(2) // 全量照旧，不删
    expect(listNotes(root)).toMatch(/- old — .*（已作废，现行见 new）/)
    expect(readNote(root, 'old').startsWith('【已作废，现行见 new】')).toBe(true)
    expect(readFileSyncText(root, 'old').startsWith('---')).toBe(true) // 提示只在输出，不写进文件
    expect(searchNotes(root, '压缩')).toMatch(/old（已作废，现行见 new）/)
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

  it('write 撞同名报错——改内容走 APPLY_PATCH 或显式删（静默覆盖会丢旧结论）', () => {
    const root = dir()
    writeNote(root, { name: 'dup', title: 'T', description: 'd', body: 'b' })
    expect(() => writeNote(root, { name: 'dup', title: 'T2', description: 'd2', body: 'b2' })).toThrow(
      '已存在',
    )
  })

  it('search：全文命中（含暗区），格式对齐 lesson search', () => {
    const root = dir()
    writeNote(root, { name: 'panel-fix', title: '面板', description: '面板串台修法', body: '正文里写了 regions 过滤' })
    writeNote(root, { name: 'other', title: '无关', description: '别的', body: '别的正文' })
    // 命中描述行
    expect(searchNotes(root, '串台')).toContain('panel-fix')
    // 命中正文（list 看不到正文——search 补的就是这个盲区）
    expect(searchNotes(root, 'regions')).toContain('panel-fix')
    // 不命中给明确文案
    expect(searchNotes(root, '不存在词')).toContain('没有 note 命中')
    expect(() => searchNotes(root, '')).toThrow('search 需要 query')
  })

  it('search：OR 候选组与多词排序——照 memory search 用法带 OR 不再静默 0 命中', () => {
    const root = dir()
    writeNote(root, { name: 'cache-ttl', title: '缓存', description: '缓存时长', body: '正文 cache_control 断点' })
    writeNote(root, { name: 'unrelated', title: '无关', description: '别的', body: 'only for or-ing English words' })
    // OR 组：任一候选词命中即候选（此前整串 indexOf 必 0 命中——2026-10-19 真实日志 23 次全落空）
    expect(searchNotes(root, 'ttl OR 1h OR cache_control')).toContain('cache-ttl')
    // 命中词多的排前：两个候选都命中的排在只中一词的前面
    writeNote(root, { name: 'both-hit', title: '双中', description: 'ttl 与 cache_control 都有', body: 'ttl cache_control' })
    const out = searchNotes(root, 'ttl OR cache_control')
    expect(out.indexOf('both-hit')).toBeLessThan(out.indexOf('cache-ttl'))
    // 反向：OR 分隔符不参与匹配，纯 OR 查不出东西
    expect(searchNotes(root, '不存在甲 OR 不存在乙')).toContain('没有 note 命中')
  })
})