import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkLarkCli } from '../src/gateway-control.ts'

/** checkLarkCli 用真子进程跑：假 lark-cli 按 argv 演两种形态（正常 /
 *  登录态读不到），外加一个真不存在的路径。 */
describe('checkLarkCli（设置页「飞书推送」检测按钮）', () => {
  const fake = (authJson: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-lark-'))
    const script = join(dir, 'fake-lark-cli.mjs')
    writeFileSync(
      script,
      `import process from 'node:process'
const args = process.argv.slice(2)
if (args.at(-1) === '--version') { console.log('lark-cli version 9.9.9'); process.exit(0) }
if (args.includes('status')) { console.log(${JSON.stringify(authJson)}); process.exit(0) }
process.exit(3)
`,
    )
    return script
  }
  const NODE = process.execPath

  it('装好且登录：installed + version + auth=ready', async () => {
    const script = fake('{"identities":{"bot":{"status":"ready"}}}')
    const r = await checkLarkCli(NODE, script)
    expect(r).toEqual({
      larkCli: script,
      installed: true,
      version: 'lark-cli version 9.9.9',
      auth: 'ready',
    })
  })

  it('装了但登录态读不到（输出不是 JSON / 字段缺）：auth=null，不算失败', async () => {
    const r = await checkLarkCli(NODE, fake('not-json'))
    expect(r.installed).toBe(true)
    expect(r.auth).toBeNull()
  })

  it('路径悬空：installed=false 带原因', async () => {
    const r = await checkLarkCli(NODE, '/definitely/not/here/lark-cli')
    expect(r.installed).toBe(false)
    expect(r.error).toBeTruthy()
  })
})
