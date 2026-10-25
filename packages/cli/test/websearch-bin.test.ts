import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 2026-10-23：终端直接跑 websearch、无凭据代理、websearch.json 引用的
 * 变量没设——报错前面挂一大段堆栈（源码行 + \u 转义的文案）。配置错是
 * 环境问题：一行中文、退出码 2（同 mcp/lsp 的环境类错误）。
 */
const repo = resolve(import.meta.dirname, '../../..')
const home = mkdtempSync(join(tmpdir(), 'sc-wsbin-'))
mkdirSync(join(home, '.simple-code'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const run = (config: string) => {
  writeFileSync(join(home, '.simple-code', 'websearch.json'), config)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env.SIMPLE_CODE_PROXY_PORT
  delete env.SIMPLE_CODE_PROXY_TOKEN
  delete env.SC_TEST_MISSING_KEY
  return spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(repo, 'packages/cli/src/websearch-bin.ts'), '查询'],
    { encoding: 'utf8', env },
  )
}

describe('websearch bin：配置错只报一行', () => {
  it('引用的环境变量没设', () => {
    const r = run('{"exaApiKey": "${SC_TEST_MISSING_KEY}"}')
    expect(r.status).toBe(2)
    expect(r.stderr.trim()).toBe('websearch 配置错误（~/.simple-code/websearch.json）：配置引用了环境变量 SC_TEST_MISSING_KEY，但它没有设置（或为空）')
  }, 30_000)

  it('JSON 写坏', () => {
    const r = run('{not json')
    expect(r.status).toBe(2)
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
    expect(r.stderr).toContain('websearch 配置错误')
  }, 30_000)
})
