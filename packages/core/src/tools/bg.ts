import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const ps = promisify(execFile)

export type BgProcessInfo = {
  pid: number
  /** ps 的 command 列原样（显示用，可能带参数） */
  command: string
  /** Date.now()，登记那一刻。展示成「5 分钟」这种粗粒度 */
  startedAt: number
  /** 超时转后台时输出接进的日志文件（孤儿进程没有——输出在它自己的重定向里） */
  logPath?: string
  /**
   * 这条登记所属的进程组。**组长自己先死、组员还在跑**是常态（t886 实测：
   * `... mvn ... & echo; sleep 55; curl` 的外层 shell 跑完就退出，mvn 被
   * init 收养继续占着端口），此时按 pid 探活会把整条记录判死、UI 上凭空
   * 消失——用户再也看不到、也关不掉。有 pgid 就能改成「组里还有活的就留着」
   */
  pgid?: number
}

/**
 * 后台残留进程的登记簿（内存态，不落盘——重载丢就丢，孤儿本身还活着，
 * 只是列表没了；用户 ps 一下也能找回来，符合「代价可恢复不加机制」）。
 *
 * 识别靠进程组：bash 工具每条命令 detached 起组（组长=bash 自己），bash
 * 退出后组里还活着的成员就是这条命令留下的后台进程——不依赖模型守姿势
 * 写 pid 文件，agent 无感。前端输入框上方显示，用户可手动 TERM。
 *
 * 死亡探活用 `kill(pid, 0)`（signal 0 只探不发）。僵尸态（Z）它探不出来，
 * 但孤儿会被 init/launchd 收养并 reap，窗口极小，不值得为此上 ps 轮询。
 */
export class BgRegistry {
  #items = new Map<number, BgProcessInfo>()
  #dirty = false

  /**
   * 抓某条命令（pgid）留下的存活进程并登记。ps 一次 ~几十 ms，只在命令
   * 文本含 `&` 时调（留孤儿几乎必含 &，见 bash.ts 的调用点）。
   */
  async collect(pgid: number): Promise<void> {
    for (const info of await findOrphans(pgid)) {
      this.#items.set(info.pid, info)
      this.#dirty = true
    }
  }

  /**
   * 组长死了但组里还有活的 → 把组长那条替换成存活组员（t886）。
   *
   * 为什么不在 snapshot 里做：snapshot 是同步的（三处调用方都同步），查
   * 进程组要 ps。放在这条异步路径上，由 bash.ts 每轮工具收尾时顺带跑一次
   * ——那正是 collect 已经在跑 ps 的时机，不额外加开销。
   */
  async reap(): Promise<void> {
    for (const info of [...this.#items.values()]) {
      if (alive(info.pid)) continue
      this.#items.delete(info.pid)
      this.#dirty = true
      // 组长死了，把还活着的组员登记上——不这么做的话整条记录凭空消失，
      // 用户看不到也关不掉（实测症状：mvn 还占着 8081，UI 上一片空白）
      if (info.pgid !== undefined) await this.collect(info.pgid)
    }
  }

  /**
   * 超时转后台时登记组长。命令文本可能极长（heredoc），截断到显示够用的长度。
   *
   * **只登记组长是不够的**——组长退出后组员常常还在（t886），所以 bash.ts
   * 在这之后还会 await collect(pgid) 把组员一并收进来。两者都登记：组长
   * 那条带 logPath（超时前的输出接在那儿），组员那条带自己的命令行
   */
  register(pid: number, command: string, logPath?: string): void {
    this.#items.set(pid, {
      pid,
      command: command.length > 80 ? `${command.slice(0, 80)}…` : command,
      startedAt: Date.now(),
      pgid: pid, // 转后台时 pid 即组长（bash.ts detached 起组）
      ...(logPath === undefined ? {} : { logPath }),
    })
    this.#dirty = true
  }

  /** 存活快照。顺手清掉已死的（模型自己 kill 了、进程自然退出） */
  snapshot(): BgProcessInfo[] {
    for (const pid of this.#items.keys()) {
      if (alive(pid)) continue
      this.#items.delete(pid)
      this.#dirty = true
    }
    return [...this.#items.values()]
  }

  /**
   * 有变化才给事件（executeTools 每个工具完都问一次，没变化的轮次
   * 不发——快照事件是全量的，重复发纯属噪音）。
   */
  drain(): { type: 'bg_processes'; items: BgProcessInfo[] } | null {
    if (!this.#dirty) return null
    this.#dirty = false
    return { type: 'bg_processes', items: this.snapshot() }
  }

  /** 只给测试用：按谓词丢掉登记，构造「组员没登记上」的初态 */
  forget(drop: (pid: number) => boolean): void {
    for (const pid of [...this.#items.keys()]) if (drop(pid)) this.#items.delete(pid)
    this.#dirty = true
  }

  /** 用户在 UI 点关闭：SIGTERM。杀不掉再点一次也还是 TERM（拍板：不做 KILL 兜底） */
  terminate(pid: number): BgProcessInfo[] {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已死（ESRCH）：本来要做的就是让它从列表消失，无碍
    }
    this.#items.delete(pid)
    this.#dirty = true
    return this.snapshot()
  }
}

/** signal 0 只探不发。僵尸态（Z）探不出来，但孤儿会被 init 收养并 reap，窗口极小 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** ps 全表里 pgid 匹配且不是组长的存活进程。ps 失败（极端）返回空——静默，别打断工具 */
async function findOrphans(pgid: number): Promise<BgProcessInfo[]> {
  let out: string
  try {
    ;({ stdout: out } = await ps('ps', ['-ax', '-o', 'pid=,pgid=,command='], { timeout: 5000 }))
  } catch {
    return []
  }
  const now = Date.now()
  const items: BgProcessInfo[] = []
  for (const line of out.split('\n')) {
    // command 里本身含空格，所以不能 split(' ') 整行切——掐头两列后剩下全是 command
    const m = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim())
    if (!m) continue
    const pidS = m[1]!
    const pgidS = m[2]!
    const command = m[3]!
    if (Number(pgidS) !== pgid || Number(pidS) === pgid) continue
    items.push({ pid: Number(pidS), command, startedAt: now })
  }
  return items
}
