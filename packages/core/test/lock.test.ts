import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireLock, LOCK_RELATIVE, LockHeldError } from '../src/session/lock.ts'

const dirs: string[] = []
const make = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sc-lock-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const lockPath = (dir: string) => join(dir, LOCK_RELATIVE)

/** acquireLock 才会建父目录，先手写锁文件的用例得自己建 */
async function writeLock(dir: string, content: string) {
  await mkdir(dirname(lockPath(dir)), { recursive: true })
  await writeFile(lockPath(dir), content, 'utf8')
}

describe('acquireLock', () => {
  it('第一个拿到锁，第二个被拒', async () => {
    const dir = await make()
    const first = await acquireLock(dir)

    // waitMs 0：持锁者活着就直接拒。默认值会先等 5s，那是下面两条用例的事
    // 报错要教用户怎么办：Remote-SSH 断线重连后旧扩展宿主残留握锁最长 3 小时
    // （2026-09-26 实测：reload 后撞上，用户只知道 pid 不知道下一步）
    const err = await acquireLock(dir, { waitMs: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LockHeldError)
    expect((err as Error).message).toContain('kill')
    expect((err as Error).message).toContain('3 小时')

    await first.release()
    // 释放后能再拿——否则一次崩溃就要用户手工删文件
    await (await acquireLock(dir)).release()
  })

  it('持锁者很快释放 → 等待后接管，不报错', async () => {
    const dir = await make()
    const first = await acquireLock(dir)

    // 真实场景：目录移出工作区时旧 session 的 close 异步排队（等 interrupt +
    // 落盘要几秒），马上加回来时新 acquire 撞的就是这几秒的窗口
    setTimeout(() => void first.release(), 300)
    const second = await acquireLock(dir)

    expect(second).toBeTruthy()
    await second.release()
  })

  it('等到头还不释放 → 照旧报错（真冲突：另一个窗口开着这个目录）', async () => {
    const dir = await make()
    const first = await acquireLock(dir)

    await expect(acquireLock(dir, { waitMs: 200 })).rejects.toBeInstanceOf(LockHeldError)

    await first.release()
  })

  it('锁文件记的是自己的 pid', async () => {
    const dir = await make()
    const lock = await acquireLock(dir)

    const raw = JSON.parse(await readFile(lockPath(dir), 'utf8'))
    expect(raw.pid).toBe(process.pid)
    expect(raw.startedAt).toBeTypeOf('string') // 前提：这个平台取得到启动时刻

    await lock.release()
  })

  it('进程已经死了的陈旧锁被接管', async () => {
    const dir = await make()
    // 一个几乎不可能存在的 pid。用 kill(pid,0) 先确认它确实不存在
    await writeLock(dir, JSON.stringify({ pid: 999_999, startedAt: 'Mon Jan  1 00:00:00 2024' }))
    expect(() => process.kill(999_999, 0)).toThrow() // 前提：这个 pid 确实不存在

    await (await acquireLock(dir)).release()
  })

  it('pid 被复用时按启动时刻识破 —— 只看 pid 会永远锁死', async () => {
    const dir = await make()
    // 拿一个确定活着的 pid（自己），但写一个对不上的启动时刻，
    // 模拟「崩溃后 pid 被别的程序复用」
    await writeLock(
      dir,
      JSON.stringify({ pid: process.pid, startedAt: 'Mon Jan  1 00:00:00 2024' }),
    )

    await (await acquireLock(dir)).release()
  })

  it('对照组：pid 活着且启动时刻对得上时不接管', async () => {
    // 上一条如果实现写成「永远接管」也会过。这条锁住反向
    const dir = await make()
    const lock = await acquireLock(dir)

    await expect(acquireLock(dir, { waitMs: 0 })).rejects.toBeInstanceOf(LockHeldError)
    await lock.release()
  })

  it('锁文件内容坏掉时接管，不让目录永久锁死', async () => {
    const dir = await make()
    await writeLock(dir, '{ 这不是 JSON')

    await (await acquireLock(dir)).release()
  })

  it('release 不会删掉别人接管后的锁', async () => {
    const dir = await make()
    const mine = await acquireLock(dir)
    // 模拟：我们被认为死了，别人接管
    await writeFile(lockPath(dir), JSON.stringify({ pid: 4242, startedAt: 'x' }), 'utf8')

    await mine.release()

    const still = JSON.parse(await readFile(lockPath(dir), 'utf8'))
    expect(still.pid).toBe(4242)
  })
})
