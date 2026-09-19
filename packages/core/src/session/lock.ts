import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const LOCK_RELATIVE = join('.simple-code', 'memory', '.lock')

type LockFile = {
  pid: number
  /**
   * 持锁进程的启动时刻。判断陈旧锁光看 pid 不够，见 isAlive。
   * null 表示当时没取到（平台不支持 / 权限不够）
   */
  startedAt: string | null
}

export class LockHeldError extends Error {
  readonly path: string
  readonly holder: number

  constructor(path: string, holder: number) {
    super(`该目录已被另一个 simple-code 进程占用（pid ${holder}）：${path}`)
    this.name = 'LockHeldError'
    this.path = path
    this.holder = holder
  }
}

export type Lock = { release(): Promise<void> }

/** 撞上活锁先等多久（每 250ms 轮询一次）。见 acquireLock 注释 */
const WAIT_MS = 5_000
const POLL_MS = 250

/**
 * 文件夹级独占锁。
 *
 * CLI 和扩展是两个进程，同时打开同一个文件夹会让两份内存态 context 分叉——
 * 各自卸载、各自写库，历史就乱了。SQLite 的锁防得住数据损坏，防不住逻辑上
 * 的分叉（design.md §7）。
 *
 * 撞上「持锁者还活着」的锁不立即报错，先等 WAIT_MS：真实场景里短命的活锁
 * 常见——目录移出工作区时旧 session 的 close 是异步排队的（要等 interrupt +
 * 落盘），马上加回来时新 acquire 就会撞上自己几秒前放的锁；reload window
 * 时新旧扩展宿主交接同理。等不到释放才是真冲突（另一个窗口开着这个目录），
 * 那时再报错，文案和原来一样
 */
export async function acquireLock(folderPath: string, opts: { waitMs?: number } = {}): Promise<Lock> {
  const path = join(folderPath, LOCK_RELATIVE)
  const deadline = Date.now() + (opts.waitMs ?? WAIT_MS)
  let existing: LockFile | null
  do {
    await mkdir(dirname(path), { recursive: true })
    existing = await readLock(path)
    if (!(existing && isAlive(existing))) break
    if (Date.now() >= deadline) throw new LockHeldError(path, existing.pid)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  } while (true)

  const mine: LockFile = { pid: process.pid, startedAt: processStartedAt(process.pid) }
  await writeFile(path, JSON.stringify(mine), 'utf8')

  return {
    release: async () => {
      // 只删自己的。别人接管过之后我们再 release，会把人家的锁删掉
      const current = await readLock(path)
      if (current?.pid === mine.pid && current.startedAt === mine.startedAt) {
        await rm(path, { force: true })
      }
    },
  }
}

async function readLock(path: string): Promise<LockFile | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null // 没有锁文件是正常的
  }
  try {
    const raw = JSON.parse(text) as Partial<LockFile>
    if (typeof raw.pid !== 'number') return null
    return { pid: raw.pid, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null }
  } catch {
    // 内容坏了当没有锁。宁可多接管一次，也不能让一个坏文件把目录永久锁死
    return null
  }
}

/**
 * 持锁进程还活着吗。
 *
 * **不能只看 `kill(pid, 0)`。** pid 会被系统复用——崩溃后留下的锁记着 4242，
 * 过一阵别的程序恰好也拿到 4242，这个锁就永远解不开了。现象是「打开项目提示
 * 被占用」，用户根本不知道该杀谁。
 *
 * 所以再比一次启动时刻。两边都用同一个 `ps -o lstart=` 取值，字符串直接比，
 * 不做时间解析——解析引入格式和时区问题，而我们只需要判等。
 *
 * 任一边取不到就按「活着」处理：误判成活着只是让用户多关一个窗口，误判成
 * 死了会让两个进程同时写同一份历史。
 */
function isAlive(lock: LockFile): boolean {
  try {
    process.kill(lock.pid, 0)
  } catch {
    return false // ESRCH：没这个进程。EPERM 也当不存活——不是我们能管的进程
  }
  const current = processStartedAt(lock.pid)
  if (lock.startedAt === null || current === null) return true
  return current === lock.startedAt
}

/**
 * 进程启动时刻，原样返回 ps 的输出。取不到返回 null。
 *
 * 用 ps 而不是 /proc：macOS 没有 /proc。同步调用——它只在获取锁时执行两次。
 */
function processStartedAt(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}
