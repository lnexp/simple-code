import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendProgress,
  createEvent,
  EVENTS_INDEX_LIMIT,
  eventSection,
  eventsDir,
  listEvents,
  loadEvents,
  mergeEvents,
  parseEventMeta,
  readEvent,
  readEventsIndex,
  renameEvent,
  searchEvents,
  updateDescription,
} from '../src/tools/events.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sc-events-'))
  return () => rmSync(root, { recursive: true, force: true })
})

describe('三个写入原语', () => {
  it('createEvent 落新格式（front matter + H1 + 进展段 + 首行带日期/step）', () => {
    createEvent(root, {
      name: 'LSP 桥落地',
      description: 'VS Code 宿主语言服务桥接为命令行工具',
      firstProgress: '随机端口 + env 注入 + 四命令',
      stepRange: '100–120',
    })
    const text = readEvent(root, 'lsp-桥落地')
    expect(text).toContain('name: lsp-桥落地')
    expect(text).toContain('# lsp-桥落地 — VS Code 宿主语言服务桥接为命令行工具')
    expect(text).toContain('## 进展')
    expect(text).toMatch(/^- \d{4}-\d{2}-\d{2} · step 100–120 · /m)
    expect(text).toContain('随机端口 + env 注入 + 四命令')
  })

  it('createEvent 拒绝覆盖已有事件——延续走 appendProgress', () => {
    createEvent(root, { name: 'e1', description: 'd', firstProgress: 'v1' })
    expect(() => createEvent(root, { name: 'e1', description: 'd', firstProgress: 'v2' })).toThrow(
      '已存在',
    )
  })

  it('appendProgress 原子追加：插在进展段尾，其他内容一个字不碰', () => {
    createEvent(root, { name: 'e2', description: 'd', firstProgress: '第一条' })
    appendProgress(root, 'e2', '第二条：修复部署洞', '8307–8320')
    const text = readEvent(root, 'e2')
    const lines = text.split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(2)
    expect(text).toContain('第二条：修复部署洞')
    // front matter 的 created 不被动
    expect(text).toContain('created:')
  })

  it('appendProgress 对无进展段的手写档自动补段头', () => {
    mkdirSync(join(root, '.simple-code/events'), { recursive: true })
    writeFileSync(
      join(root, '.simple-code/events/hand-made.md'),
      '---\nname: hand-made\ndescription: 手写\ncreated: 2026-09-17T00:00:00Z\nupdated: 2026-09-17T00:00:00Z\n---\n\n# hand-made — 手写\n\n旧正文。\n',
      'utf8',
    )
    const out = appendProgress(root, 'hand-made', '补一条', '1–2')
    expect(out).toContain('已追加')
    const text = readEvent(root, 'hand-made')
    expect(text).toContain('## 进展')
    expect(text).toContain('旧正文。')
    expect(text).toContain('补一条')
  })

  it('updateDescription 只碰 description 行与 H1 行', () => {
    createEvent(root, { name: 'e3', description: '旧描述', firstProgress: 'x' })
    updateDescription(root, 'e3', '新描述：机制落地完成')
    const text = readEvent(root, 'e3')
    expect(text).toContain('description: 新描述：机制落地完成')
    expect(text).toContain('# e3 — 新描述：机制落地完成')
    expect(text).not.toContain('旧描述')
  })

  it('name 中文化和空格归一为 slug；description 单行化', () => {
    createEvent(root, {
      name: 'LSP 桥 落地',
      description: '一行\n换行  空白',
      firstProgress: '一句进展',
    })
    expect(readEvent(root, 'lsp-桥-落地')).toContain('name: lsp-桥-落地')
    expect(readEvent(root, 'lsp-桥-落地')).toContain('description: 一行 换行 空白')
  })
})

describe('解析与兜底', () => {
  it('parseEventMeta 解析五段头', () => {
    const meta = parseEventMeta(
      `---\nname: a\ndescription: 描述\ncreated: T1\nupdated: T2\n---\n\n# a — 描述\n\n## contents\n\n正文`,
    )
    expect(meta.name).toBe('a')
    expect(meta.description).toBe('描述')
  })

  it('手改坏的残档（无 front matter）从首行标题兜底', () => {
    mkdirSync(eventsDir(root), { recursive: true })
    writeFileSync(join(eventsDir(root), 'broken.md'), '# orphan-event — 孤儿描述\n\n正文', 'utf8')
    const cards = loadEvents(root)
    expect(cards[0]?.name).toBe('orphan-event')
    expect(cards[0]?.description).toBe('孤儿描述')
  })

  it('eventSection 抽节，缺失返回 undefined', () => {
    const text = '# a\n\n## 进展\n\n- 第一条\n\n## 附注\n\n别的'
    expect(eventSection(text, '进展')).toBe('- 第一条')
    expect(eventSection(text, '不存在的节')).toBeUndefined()
  })
})

describe('list / search / read 分段', () => {
  beforeEach(() => {
    createEvent(root, {
      name: 'lsp-bridge',
      description: 'LSP 桥',
      firstProgress: '一句进展',
    })
    createEvent(root, {
      name: 'approval-chain',
      description: '审批连锁',
      firstProgress: '一句进展',
    })
  })

  it('list 一行式带 description', () => {
    const out = listEvents(root)
    expect(out).toContain('- lsp-bridge — LSP 桥')
    expect(out).toContain('- approval-chain — 审批连锁')
  })

  it('search 命中 description 而不只 name', () => {
    expect(searchEvents(root, 'LSP')).toContain('lsp-bridge')
    expect(searchEvents(root, '审批')).toContain('approval-chain')
    // keywords 已删——name/description 之外的词不再命中（要细词 read 全文）
    expect(searchEvents(root, 'LocationLink')).toContain('没有命中')
    expect(searchEvents(root, '不存在词')).toContain('没有命中')
    // OR 候选组：与 note/lesson/skill search 同款（见 search-terms.ts）
    expect(searchEvents(root, '审批 OR approval OR 弹卡')).toContain('approval-chain')
    expect(searchEvents(root, '不存在甲 OR 不存在乙')).toContain('没有命中')
  })

  it('read --desc 一行；不存在的给提示不抛', () => {
    expect(readEvent(root, 'lsp-bridge', 'desc')).toBe('lsp-bridge — LSP 桥')
    expect(readEvent(root, 'nope', 'desc')).toContain('不存在')
  })

  it('空目录 list 有友好提示', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sc-events-empty-'))
    try {
      expect(listEvents(empty)).toContain('为空')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('merge 原语（memory-time-decay ③，2026-10-21 拍板）', () => {
  it('两个事件合并：正文全保留、前身行、created 取最早、旧文件移除', () => {
    createEvent(root, {
      name: 'cache-probe-a',
      description: '缓存探针甲',
      firstProgress: '探针 A 结论',
      stepRange: '1–2',
    })
    createEvent(root, {
      name: 'cache-probe-b',
      description: '缓存探针乙',
      firstProgress: '探针 B 结论',
      stepRange: '3–4',
    })
    const msg = mergeEvents(root, 'cache-probe', ['cache-probe-a', 'cache-probe-b'])
    expect(msg).toContain('cache-probe-a + cache-probe-b → cache-probe')
    expect(existsSync(join(eventsDir(root), 'cache-probe-a.md'))).toBe(false)
    expect(existsSync(join(eventsDir(root), 'cache-probe-b.md'))).toBe(false)
    const text = readFileSync(join(eventsDir(root), 'cache-probe.md'), 'utf8')
    // 正文全在（不丢任何一块）
    expect(text).toContain('探针 A 结论')
    expect(text).toContain('探针 B 结论')
    // 前身行：旧 name 的 grep 命中文件头，引用不断链
    expect(text).toMatch(/^前身: cache-probe-a、cache-probe-b$/m)
    // front matter 并集语义
    expect(text).toMatch(/^name: cache-probe$/m)
    expect(text).toMatch(/^description: 缓存探针甲；缓存探针乙$/m)
    // 合并后可继续点状订正（appendProgress 落进最新一节）
    expect(appendProgress(root, 'cache-probe', '合并后的第一笔')).toContain('已追加')
  })
  it('旧名缺失：整体拒绝，已读的不落盘', () => {
    createEvent(root, {
      name: 'merge-live-a',
      description: '甲',
      firstProgress: '开端',
      stepRange: '1',
    })
    const msg = mergeEvents(root, 'merge-x', ['merge-live-a', 'no-such-event'])
    expect(msg).toContain('没有 no-such-event')
    expect(existsSync(join(eventsDir(root), 'merge-live-a.md'))).toBe(true)
    expect(existsSync(join(eventsDir(root), 'merge-x.md'))).toBe(false)
  })
  it('appendProgress 落进最新一节（新→旧排）+ 重复旧名拒绝', () => {
    mkdirSync(eventsDir(root), { recursive: true })
    writeFileSync(join(eventsDir(root), 'older-camp.md'), '---\nname: older-camp\ndescription: 旧段\ncreated: 2026-08-01 10:00:00\nupdated: 2026-08-05 10:00:00\n---\n\n# older-camp — 旧段\n\n## 进展\n\n- 2026-08-01 · 旧的进展\n', 'utf8')
    writeFileSync(join(eventsDir(root), 'newer-camp.md'), '---\nname: newer-camp\ndescription: 新段\ncreated: 2026-09-01 10:00:00\nupdated: 2026-09-05 10:00:00\n---\n\n# newer-camp — 新段\n\n## 进展\n\n- 2026-09-01 · 新的进展\n', 'utf8')
    // 重复旧名（slug 相同）拒绝，不落任何文件
    expect(mergeEvents(root, 'm2', ['older-camp', 'OLDER_CAMP'])).toContain('旧事件重复')
    expect(existsSync(join(eventsDir(root), 'm2.md'))).toBe(false)
    mergeEvents(root, 'camp-merged', ['older-camp', 'newer-camp'])
    appendProgress(root, 'camp-merged', '合并后的进展')
    const text = readFileSync(join(eventsDir(root), 'camp-merged.md'), 'utf8')
    const atProgress = text.indexOf('合并后的进展')
    const atOldSection = text.indexOf('# older-camp —')
    // 新段在前：追加的进展落在最新一节（older-camp 的 H1 之前）
    expect(atProgress).toBeGreaterThan(-1)
    expect(atProgress).toBeLessThan(atOldSection)
  })
  it('少于两个旧事件拒绝；新名撞旧名拒绝', () => {
    createEvent(root, {
      name: 'merge-one',
      description: '单',
      firstProgress: '开端',
      stepRange: '1',
    })
    expect(mergeEvents(root, 'merge-y', ['merge-one'])).toContain('至少要两个')
    expect(mergeEvents(root, 'merge-one', ['merge-one', 'merge-one'])).toContain(
      '新名不能与旧名相同',
    )
  })
})

describe('rename 原语（2026-09-17 拍板：name 随战役演化，单一事实源）', () => {
  it('成功改名：文件名 / front matter name / updated 三处同步，旧文件消失', () => {
    createEvent(root, {
      name: 'classifier-keywords-lock',
      description: 'keywords 锁定问题',
      firstProgress: '发现 keywords 不更新',
      stepRange: '1–3',
    })
    const msg = renameEvent(root, 'classifier-keywords-lock', 'keywords-removed')
    expect(msg).toBe('已改名 classifier-keywords-lock → keywords-removed')
    expect(existsSync(join(eventsDir(root), 'classifier-keywords-lock.md'))).toBe(false)
    const text = readFileSync(join(eventsDir(root), 'keywords-removed.md'), 'utf8')
    expect(text).toMatch(/^name: keywords-removed$/m)
    // 进展与描述随档案走，不丢
    expect(text).toContain('发现 keywords 不更新')
  })
  it('重名不覆盖：目标已存在时拒绝', () => {
    createEvent(root, {
      name: 'a-campaign',
      description: '甲',
      firstProgress: '开端',
      stepRange: '1–2',
    })
    createEvent(root, {
      name: 'b-campaign',
      description: '乙',
      firstProgress: '开端',
      stepRange: '3–4',
    })
    const msg = renameEvent(root, 'a-campaign', 'b-campaign')
    expect(msg).toContain('已存在')
    // 原档案原样
    expect(existsSync(join(eventsDir(root), 'a-campaign.md'))).toBe(true)
  })
  it('旧名 read：提示可能已改名', () => {
    createEvent(root, { name: 'old-name', description: 'x', firstProgress: 'y', stepRange: '1–2' })
    renameEvent(root, 'old-name', 'new-name')
    const out = readEvent(root, 'old-name')
    expect(out).toContain('可能已改名')
  })
})

describe('read 心跳（memory-time-decay ①，2026-10-21）', () => {
  beforeEach(() => {
    createEvent(root, { name: 'heartbeat-ev', description: '心跳事件', firstProgress: '一句' })
  })

  it('全文读盖 lastRead；--desc 元数据偷看不盖；created/updated 不动', () => {
    const path = join(eventsDir(root), 'heartbeat-ev.md')
    const before = readFileSync(path, 'utf8')
    expect(before).not.toContain('lastRead:')
    // --desc 是元数据偷看，不算使用
    readEvent(root, 'heartbeat-ev', 'desc')
    expect(readFileSync(path, 'utf8')).toBe(before)
    // 全文读盖心跳
    expect(readEvent(root, 'heartbeat-ev')).toContain('## 进展')
    const after = readFileSync(path, 'utf8')
    expect(after).toContain('lastRead:')
    // 重复读是替换不是堆叠（note.ts readNote 同款）
    readEvent(root, 'heartbeat-ev')
    expect(readFileSync(path, 'utf8').match(/lastRead:/g)).toHaveLength(1)
    // created/updated 原样——updated 是 progress 时间，喂 LRU，不混
    expect(after).toContain(before.match(/^created:.*$/m)?.[0] ?? '')
    expect(after).toContain(before.match(/^updated:.*$/m)?.[0] ?? '')
  })

  it('progress 追加不丢 lastRead（行级替换共存）', () => {
    readEvent(root, 'heartbeat-ev')
    appendProgress(root, 'heartbeat-ev', '新进展')
    const out = readFileSync(join(eventsDir(root), 'heartbeat-ev.md'), 'utf8')
    expect(out).toContain('lastRead:')
    expect(out).toContain('新进展')
  })
})

describe('readEventsIndex：名称占位 + LRU 封顶', () => {
  it('空库 null；条数内全量 name 一行一条', () => {
    expect(readEventsIndex(root)).toBeNull()
    createEvent(root, { name: 'a', description: '描述', firstProgress: 'p', stepRange: '1–2' })
    expect(readEventsIndex(root)).toBe('- a')
  })
  it('超上限：只留最近活跃的前 30 条 + 兜底行', () => {
    for (let i = 0; i < EVENTS_INDEX_LIMIT + 5; i++)
      createEvent(root, {
        name: `ev-${String(i).padStart(3, '0')}`,
        description: 'd',
        firstProgress: 'p',
        stepRange: `${i}-${i}`,
      })
    const idx = readEventsIndex(root)!
    const lines = idx.split('\n')
    expect(lines).toHaveLength(EVENTS_INDEX_LIMIT + 1)
    // 同秒创建下 updated 无区分度（秒粒度是真实边界），只验形态与条数；
    // 「updated 降序」由 loadEvents 的排序职责保证
    expect(lines[0]).toMatch(/^- ev-\d{3}$/)
    expect(lines.at(-1)).toBe('- ……另有 5 条较早事件（"$SIMPLE_CODE_EVENT" list --all 全量）')
  })
})
