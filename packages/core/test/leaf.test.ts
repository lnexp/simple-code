import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatLeaf,
  type Leaf,
  leafPath,
  listLeaves,
  parseLeaf,
  readLeaf,
  readLeavesByCovers,
  writeLeaf,
} from '../src/session/leaf.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const workspace = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-leaf-'))
  dirs.push(dir)
  return dir
}

const sample = (over: Partial<Leaf> = {}): Leaf => ({
  turn: 87,
  name: '历史懒加载方案对齐',
  coversFrom: 7330,
  coversTo: 7338,
  description: '定了按 turn id 分页的懒加载方案，作废「只回灌尾部 50 条」，未写代码',
  body: '## 用户要求\n翻历史\n\n## 实际完成\n定方案\n\n## 未完成/失败\n没写代码\n\n## 涉及文件\nstore.ts',
  ...over,
})

describe('叶子文件的读写', () => {
  it('**往返逐字相等**', () => {
    const leaf = sample()
    expect(parseLeaf(formatLeaf(leaf))).toEqual(leaf)
  })

  it('**正文里的 `---` 不能被当成 frontmatter 结束**', () => {
    // 模型很爱在 markdown 里写分隔线。用 split('---') 的实现会在这里多切一段，
    // frontmatter 和正文的边界飘掉——**不报错**，只是正文少一截、
    // description 可能变成正文的一行
    const leaf = sample({ body: '## 用户要求\n翻历史\n\n---\n\n## 实际完成\n定方案' })
    const parsed = parseLeaf(formatLeaf(leaf))

    expect(parsed).toEqual(leaf)
    expect(parsed?.body).toContain('---') // 前提：正文里确实有分隔线
    expect(parsed?.description).toBe(leaf.description)
  })

  it("**值里的半角冒号原样保留**——按第一个冒号切，不是 split(':')", () => {
    // 第一版这里用的是全角「：」，split(':') 压根切不到它，测的是空集
    // ——变异检验（把实现换成 split(':')[1]）当场存活才发现
    const leaf = sample({ description: 'ratio: 0.35, fanout: 10' })
    const parsed = parseLeaf(formatLeaf(leaf))
    expect(parsed?.description).toBe('ratio: 0.35, fanout: 10')
    expect(leaf.description).toContain(':') // 前提：值里确实有半角冒号
  })

  it('**description 里的换行在写的时候就压平**——不然 frontmatter 摊成几十行', () => {
    // 实测过一条：模型把整段跑飞的输出写进 description，原样落盘之后
    // frontmatter 变成 65 行，后面 60 行全被当成 `key: value` 解析
    const leaf = sample({ description: '第一句\n第二句\n第三句' })
    const text = formatLeaf(leaf)
    const parsed = parseLeaf(text)

    expect(leaf.description).toContain('\n') // 前提：确实有换行
    expect(text.split('\n').indexOf('---', 1)).toBe(5) // frontmatter 还是 5 行
    expect(parsed?.description).toBe('第一句 第二句 第三句')
    expect(parsed?.body).toBe(leaf.body) // 正文没被挤掉
  })

  it('**值里出现整行 `---` 也不会截断 frontmatter**', () => {
    // 压成一行之后 `---` 不可能独占一行。不压的话 indexOf('---', 1) 提前
    // 收在那里，正文和 frontmatter 的边界整个飘掉——不报错
    const parsed = parseLeaf(formatLeaf(sample({ description: '前\n---\n后' })))

    expect(parsed?.description).toBe('前 --- 后')
    expect(parsed?.body).toBe(sample().body)
  })

  it('**对照：正文里的换行一个都不能动**——四段结构全靠它', () => {
    // 压平只该作用在 frontmatter 的值上。误伤 body 的话四段正文会连成一坨，
    // 而且照样能 parse、照样进 context，只是模型读起来是一团糊
    const parsed = parseLeaf(formatLeaf(sample()))

    expect(parsed?.body).toBe(sample().body)
    expect(parsed?.body.split('\n').length).toBeGreaterThan(5)
  })

  it('**坏文件返回 null，不抛**', () => {
    // 这些文件是模型生成的，格式跑偏是常态。一个坏文件让整棵索引树构建炸掉
    // 的话，后果是「历史全都看不见」，比少一个叶子严重得多
    expect(parseLeaf('没有 frontmatter 的一段话')).toBeNull()
    expect(parseLeaf('---\nname: 只有开头没有结尾\n\n正文')).toBeNull()
    expect(parseLeaf('---\nname: 没有 turn 字段\ncovers: 1-2\n---\n\n正文')).toBeNull()
    expect(parseLeaf('---\nturn: 不是数字\ncovers: 1-2\n---\n\n正文')).toBeNull()
    // covers 缺了就不知道这个叶子盖住哪一段，定位不了文件名也接不进索引树
    expect(parseLeaf('---\nturn: 87\n---\n\n正文')).toBeNull()
    expect(parseLeaf('---\nturn: 87\ncovers: 不是区间\n---\n\n正文')).toBeNull()
  })

  it('**文件名带上 covers 起点，切了段的 turn 不会互相覆盖**', async () => {
    // 超过 segmentTokens 的 turn 会切几段（§4.3 实测 98 个 turn 出 160 个叶子）。
    // 只用 turn 号做文件名的话，后写的**静默覆盖**先写的——丢的是历史，不报错
    expect(leafPath('/w', 87, 7330)).toContain('turn-000087-s007330.md')
    expect(leafPath('/w', 1, 2)).toContain('turn-000001-s000002.md')

    const dir = await workspace()
    writeLeaf(dir, sample({ coversFrom: 1, coversTo: 3, description: '第一段' }))
    writeLeaf(dir, sample({ coversFrom: 4, coversTo: 6, description: '第二段' }))
    expect(listLeaves(dir).map((l) => l.description)).toEqual(['第一段', '第二段'])
  })

  it('写了能读回来；读不存在的返回 null 而不是抛', async () => {
    const dir = await workspace()
    expect(readLeaf(dir, 87, 7330)).toBeNull() // 前提：一开始确实没有

    writeLeaf(dir, sample())
    expect(readLeaf(dir, 87, 7330)).toEqual(sample())
    expect(readLeaf(dir, 88, 7330)).toBeNull()
  })

  it('**listLeaves 按 covers 升序，坏文件跳过而不是整批失败**', async () => {
    const dir = await workspace()
    writeLeaf(dir, sample({ turn: 9, coversFrom: 30, coversTo: 31 }))
    writeLeaf(dir, sample({ turn: 87, coversFrom: 90, coversTo: 91 }))
    writeLeaf(dir, sample({ turn: 12, coversFrom: 40, coversTo: 41 }))
    await writeFile(join(dir, 'summaries', 'turn-000099-s000999.md'), '这是个坏文件', 'utf8')
    // **文件名和 covers 字段故意错开**：零填充之后文件名的字典序和数值序天然
    // 一致，readdir 顺序碰巧就对——排不排序结果一样，测的是空集（变异检验
    // 把 .sort() 删掉照样绿）。契约写的是「按 covers 升序」，文件名骗不了它
    await writeFile(
      join(dir, 'summaries', 'turn-000002-s000002.md'),
      formatLeaf(sample({ turn: 500, coversFrom: 500, coversTo: 501 })),
      'utf8',
    )

    expect(listLeaves(dir).map((l) => l.coversFrom)).toEqual([30, 40, 90, 500])
  })

  it('**按 covers 定位时不能挑错文件**', async () => {
    // 拼 context 时手上只有 summaries.covers_from，turn 号不在那张表里，
    // 所以是按后缀在 readdir 结果里找。挑错的后果是**热区展开的是别的 turn
    // 的正文**——不报错，模型看到的是张冠李戴的历史
    const dir = await workspace()
    writeLeaf(dir, sample({ coversFrom: 1, coversTo: 3, body: '第一段的正文' }))
    writeLeaf(dir, sample({ coversFrom: 4, coversTo: 6, body: '第二段的正文' }))

    const got = readLeavesByCovers(dir, [4])
    expect(got.size).toBe(1) // 前提：只取了要的那个
    expect(got.get(4)?.body).toBe('第二段的正文')
    // 对照：不存在的 covers 不会拿别的顶上
    expect(readLeavesByCovers(dir, [99]).size).toBe(0)
  })

  it('**对照：目录还不存在时返回空数组，不抛**', async () => {
    // 第一个 turn 结束之前就是这个状态，不是异常
    expect(listLeaves(await workspace())).toEqual([])
  })
})
