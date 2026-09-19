import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bucketedRel,
  bucketOf,
  ensureBucketFile,
  listBucketFiles,
  migrateToBuckets,
  resolveBucketFile,
  turnBucket,
} from '../src/session/buckets.ts'

let dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs = []
})

async function memoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sc-bkt-'))
  dirs.push(root)
  await mkdir(join(root, 'turns'), { recursive: true })
  await mkdir(join(root, 'summaries'), { recursive: true })
  await mkdir(join(root, 'raw'), { recursive: true })
  return root
}

describe('桶名规则', () => {
  it('turn 千位分桶：312 → 000，1234 → 001，1000000 → 1000', () => {
    expect(turnBucket(312)).toBe('000')
    expect(turnBucket(999)).toBe('000')
    expect(turnBucket(1000)).toBe('001')
    expect(turnBucket(1234)).toBe('001')
    expect(turnBucket(1_000_000)).toBe('1000')
  })

  it('bucketOf 从文件名解析：归档、叶子、raw 尾部两位；认不出归 000', () => {
    expect(bucketOf('turn-000312.jsonl')).toBe('000')
    expect(bucketOf('turn-001234-s000567.md')).toBe('001')
    // raw：取倒数第 6、5 字符（去掉 .log 后的尾部 hex/字符）
    expect(bucketOf('call_00149ba0c5bb46c18205dd2a.log')).toBe('2a')
    expect(bucketOf('toolu_x1.log')).toBe('x1') // sanitize 字符集，不限 hex
    // bucketOf 是纯函数：对任何 ≥6 字符名字都给桶（'me'），「哪些文件归
    // 我们管」由 migrate 的扩展名表把关，两层不混——readme.txt 根本不会
    // 被写进 raw/，也就轮不到它挑桶
  })

  it('bucketedRel 拼出带桶相对路径', () => {
    expect(bucketedRel('turns', 'turn-000312.jsonl')).toBe(
      join('turns', '000', 'turn-000312.jsonl'),
    )
  })
})

describe('写侧 ensureBucketFile', () => {
  it('返回桶内绝对路径并建目录，两个 turn 同桶复用', async () => {
    const root = await memoryRoot()
    const a = ensureBucketFile(root, 'turns', 'turn-000001.jsonl')
    const b = ensureBucketFile(root, 'turns', 'turn-000002.jsonl')
    expect(a).toBe(join(root, 'turns', '000', 'turn-000001.jsonl'))
    expect(b).toBe(join(root, 'turns', '000', 'turn-000002.jsonl'))
    await writeFile(a, 'x')
    expect(await readdir(join(root, 'turns', '000'))).toEqual(['turn-000001.jsonl'])
  })
})

describe('读侧 resolveBucketFile 双探测', () => {
  it('桶里有→桶；只有平铺→平铺（老库兼容）；都没有→平铺形状（报错路径可读）', async () => {
    const root = await memoryRoot()
    // 老库形状：只有平铺
    await writeFile(join(root, 'turns', 'turn-000001.jsonl'), 'old')
    expect(resolveBucketFile(root, 'turns', 'turn-000001.jsonl')).toBe(
      join(root, 'turns', 'turn-000001.jsonl'),
    )
    // 桶里出现同名（迁移后）：桶优先
    await writeFile(ensureBucketFile(root, 'turns', 'turn-000001.jsonl'), 'new')
    expect(resolveBucketFile(root, 'turns', 'turn-000001.jsonl')).toBe(
      join(root, 'turns', '000', 'turn-000001.jsonl'),
    )
    // 都没有：平铺形状，调用方 existsSync 报错时给出模型熟悉的路径
    expect(resolveBucketFile(root, 'turns', 'turn-000009.jsonl')).toBe(
      join(root, 'turns', 'turn-000009.jsonl'),
    )
  })
})

describe('listBucketFiles 两层合并', () => {
  it('平铺 + 桶 + 非 hex 的 raw 桶都列出，按文件名排序', async () => {
    const root = await memoryRoot()
    await writeFile(join(root, 'turns', 'turn-000002.jsonl'), '') // 平铺老文件
    await writeFile(ensureBucketFile(root, 'turns', 'turn-000001.jsonl'), '') // 桶内
    await writeFile(ensureBucketFile(root, 'raw', 'toolu_x1.log'), '') // sanitize 字符桶名
    const turns = listBucketFiles(root, 'turns', '.jsonl')
    expect(turns).toHaveLength(2)
    expect(turns[0]).toContain('turn-000001.jsonl')
    const raws = listBucketFiles(root, 'raw', '.log')
    expect(raws).toHaveLength(1)
    expect(raws[0]).toContain(join('x1', 'toolu_x1.log'))
  })

  it('人手工放的子目录不递归', async () => {
    const root = await memoryRoot()
    await mkdir(join(root, 'turns', 'backup'))
    await writeFile(join(root, 'turns', 'backup', 'notes.jsonl'), '')
    expect(listBucketFiles(root, 'turns', '.jsonl')).toEqual([])
  })
})

describe('migrateToBuckets 迁移', () => {
  it('三个子目录的平铺归档挪进桶，非归档扩展名不动，幂等', async () => {
    const root = await memoryRoot()
    await writeFile(join(root, 'turns', 'turn-000001.jsonl'), 't1')
    await writeFile(join(root, 'summaries', 'turn-000001-s000001.md'), 's1')
    await writeFile(join(root, 'raw', 'call_00149ba0c5bb46c18205dd2a.log'), 'r1')
    await writeFile(join(root, 'turns', 'notes.txt'), 'keep') // 不认识的扩展名

    expect(migrateToBuckets(root)).toBe(3)
    expect(await readdir(join(root, 'turns'))).toEqual(['000', 'notes.txt'])
    expect(await readdir(join(root, 'turns', '000'))).toEqual(['turn-000001.jsonl'])
    expect(await readdir(join(root, 'summaries'))).toEqual(['000'])
    expect(await readdir(join(root, 'raw'))).toEqual(['2a'])

    // 幂等：再跑 0 个
    expect(migrateToBuckets(root)).toBe(0)
    // 迁移后内容没丢
    const t = await import('node:fs/promises').then((m) => m.readFile)
    expect(await t(join(root, 'turns', '000', 'turn-000001.jsonl'), 'utf8')).toBe('t1')
  })
})
