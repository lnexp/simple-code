import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config/schema.ts'

/**
 * 仓库根 `settings.example.json` 与 `packages/cli/settings.example.json`
 * 必须真的能通过 schema 校验。（原先指向 docs/ 下的副本——docs/ 被
 * gitignore，公开仓库里没有那份文件，干净克隆跑测试直接 ENOENT；而
 * 真正发出去的两份示例没人测，0.1.2 前夕查出都已与 schema 漂移）
 *
 * 它是用户唯一的配置模板——**写错了没有任何人会发现**，直到某个用户照抄之后
 * 启动报错，而他会以为是自己抄错了。schema 是 strictObject（拼错字段名要报错，
 * CLAUDE.md §6.4），示例里多一个字段、少一个必填、类型写错，这里都会红。
 */
describe('示例配置', () => {
  it('能通过 schema 校验', async () => {
    const raw = await readFile(
      new URL('../../../settings.example.json', import.meta.url),
      'utf8',
    )
    const parsed = configSchema.safeParse(JSON.parse(raw))

    // 直接比 issues 而不是 success：红的时候要能一眼看到是哪个字段错了
    expect(parsed.error?.issues ?? 'ok').toBe('ok')
  })

  it('cli 包的示例也能通过 schema 校验', async () => {
    const raw = await readFile(
      new URL('../../cli/settings.example.json', import.meta.url),
      'utf8',
    )
    expect(configSchema.safeParse(JSON.parse(raw)).error?.issues ?? 'ok').toBe('ok')
  })

  it('对照：多一个不认识的字段会被 schema 拒绝', async () => {
    // 证明上一条不是空过的——schema 如果不 strict，示例里写什么都能过
    const raw = await readFile(
      new URL('../../../settings.example.json', import.meta.url),
      'utf8',
    )
    const withTypo = { ...(JSON.parse(raw) as object), memroy: {} }

    expect(configSchema.safeParse(withTypo).success).toBe(false)
  })
})
