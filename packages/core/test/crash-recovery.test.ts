import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../src/session/store.ts'

const run = promisify(execFile)

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const STORE = fileURLToPath(new URL('../src/session/store.ts', import.meta.url))

/**
 * 在**另一个进程**里写几条消息，然后 `kill -9` 自己。
 *
 * 同进程 close/open 证明不了崩溃恢复——close() 会把 WAL 刷干净，
 * 那测的是「正常关闭能恢复」。design.md §13 的验收标准原话是
 * 「跑一段对话，`kill -9`，重启，context 与 kill 前一致」，
 * 必须真的 SIGKILL：不跑 close、不跑 finally、不刷缓冲区。
 */
async function writeThenSuicide(dir: string, count: number): Promise<void> {
  const script = join(dir, 'writer.mjs')
  await writeFile(
    script,
    `import { openStore } from ${JSON.stringify(STORE)}
const store = openStore(${JSON.stringify(dir)})
const messages = []
for (let i = 0; i < ${count}; i++) {
  messages.push({ role: 'user', parts: [{ type: 'text', text: '第' + i + '条' }] })
  store.save(messages)
}
// 不 close，不刷盘，直接原地暴毙
process.kill(process.pid, 'SIGKILL')
`,
    'utf8',
  )

  await run('node', ['--disable-warning=ExperimentalWarning', script]).then(
    () => {
      throw new Error('子进程本该被 SIGKILL 杀掉，却正常退出了')
    },
    (error: { signal?: string; code?: number }) => {
      // 前提断言：确认真的是被 KILL 的。不验的话，子进程因为
      // 语法错误退出也会走到这个分支，测试照样"通过"
      expect(error.signal).toBe('SIGKILL')
    },
  )
}

describe('崩溃恢复（design.md §13 第 2 步验收）', () => {
  it('kill -9 之后重启，context 与 kill 前一致', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-crash-'))
    dirs.push(dir)

    await writeThenSuicide(dir, 5)

    const store = openStore(dir)
    const recovered = store.load()
    expect(recovered).toHaveLength(5)
    expect(recovered[0]).toEqual({ role: 'user', parts: [{ type: 'text', text: '第0条' }] })
    expect(recovered[4]).toEqual({ role: 'user', parts: [{ type: 'text', text: '第4条' }] })
    store.close()
  }, 20_000)

  it('对照组：子进程一条都没写时，恢复出来是空的', async () => {
    // 没有这条的话，「load 返回上一个测试残留的数据」这种串台也能让上面绿
    const dir = await mkdtemp(join(tmpdir(), 'sc-crash-'))
    dirs.push(dir)

    await writeThenSuicide(dir, 0)

    const store = openStore(dir)
    expect(store.load()).toEqual([])
    store.close()
  }, 20_000)
})
