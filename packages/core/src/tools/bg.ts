import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const ps = promisify(execFile)

/**
 * 一条 bash 命令留下的后台进程 = 一组 = UI 一行（2026-10-28 用户拍板）。
 *
 * 原先按进程各占一行、显示 ps 的 command 列：一次 headless Chrome 截图摊成
 * 10 行（主进程 + 8 个 helper + 1 个 <defunct>），行内是 `--seatbelt-client=26`
 * 这种无信息的参数尾巴，中文被 ps 转义成 `M-eM-7M-2`，真正有用的行被挤到
 * 最底。改成按进程组聚合、标签用 agent 写的 desc、命令用 agent 写的原文
 */
export type BgProcessInfo = {
  /** 进程组号（= 起这条命令的 bash 的 pid，bash.ts detached 起组）。× 按组 TERM */
  pgid: number
  /** 组里还活着的成员（ps 查到的，不含僵尸）。UI 显示个数，悬停列出 */
  pids: number[]
  /** 行标签：agent 写的 desc；漏写时取命令首行 */
  label: string
  /** agent 写的原命令（截断到显示够用），行内灰字 + 悬停全文 */
  command: string
  /** 命令开始执行的时刻（bash.ts spawn 时打的钟）。UI 显示「09:41 起」 */
  startedAt: number
  /** 超时转后台时输出接进的日志文件（& 留下的没有——输出在它自己的重定向里） */
  logPath?: string
}

/** bash.ts 登记时给的元信息 */
export type BgMeta = {
  desc?: string
  command: string
  startedAt: number
  logPath?: string
}

/**
 * 后台残留进程的登记簿（内存态，不落盘——重载丢就丢，孤儿本身还活着，
 * 只是列表没了；用户 ps 一下也能找回来，符合「代价可恢复不加机制」）。
 *
 * 识别靠进程组：bash 工具每条命令 detached 起组（组长=bash 自己），bash
 * 退出后组里还活着的成员就是这条命令留下的后台进程——不依赖模型守姿势
 * 写 pid 文件，agent 无感。前端输入框上方显示，用户可手动 TERM 整组。
 *
 * 死亡探活用 `kill(pid, 0)`（signal 0 只探不发）。它探不出僵尸，所以 ps
 * 扫描时按 stat 剔除 Z 态：父进程还活着不收尸时（Chrome 主进程之于它的
 * helper）<defunct> 会一直挂着，不是「窗口极小」（2026-10-28 截图推翻）
 */
export class BgRegistry {
  #groups = new Map<number, BgProcessInfo>()
  #dirty = false

  /**
   * 抓某条命令（pgid）组里的存活进程并登记。ps 一次 ~几十 ms，只在命令
   * 文本含 `&` 时、或转后台时调（见 bash.ts 的调用点）。已登记的组
   * （转后台时 register 过）只并入成员，元信息不动
   */
  async collect(pgid: number, meta: BgMeta): Promise<void> {
    const members = (await scanGroups())?.get(pgid) ?? []
    const cur = this.#groups.get(pgid)
    if (cur) {
      const pids = [...new Set([...cur.pids, ...members])]
      if (pids.length === cur.pids.length) return
      this.#groups.set(pgid, { ...cur, pids })
    } else if (members.length > 0) {
      this.#groups.set(pgid, entryOf(pgid, members, meta))
    } else return
    this.#dirty = true
  }

  /**
   * 按 pgid 重扫全部组成员（一次 ps）：组长死了但组员还在（t886：`... mvn
   * ... & echo; sleep 55; curl` 的外层 shell 跑完就退出，mvn 被 init 收养
   * 继续占着 8081），或转后台那一刻组员还没起来——都靠这里把活着的成员
   * 补进来，否则整条记录凭空消失，用户看不到也关不掉。
   *
   * 为什么不在 snapshot 里做：snapshot 是同步的（三处调用方都同步），查
   * 进程组要 ps。由 bash.ts 在转后台的组长退出时调一次
   */
  async reap(): Promise<void> {
    if (this.#groups.size === 0) return
    const scan = await scanGroups()
    if (!scan) return // ps 失败：宁可留着旧账，别把整表清空
    for (const [pgid, g] of this.#groups) {
      const pids = scan.get(pgid) ?? []
      if (pids.length === 0) this.#groups.delete(pgid)
      else if (pids.length !== g.pids.length || pids.some((p) => !g.pids.includes(p)))
        this.#groups.set(pgid, { ...g, pids })
      else continue
      this.#dirty = true
    }
  }

  /**
   * 超时转后台时登记整组（组长此刻还活着）。组长退出后组员常常还在
   * （t886），所以 bash.ts 在这之后还会 collect 一次把组员并进来
   */
  register(pgid: number, meta: BgMeta): void {
    this.#groups.set(pgid, entryOf(pgid, [pgid], meta))
    this.#dirty = true
  }

  /** 存活快照。顺手清掉已死的成员和全死的组（模型自己 kill 了、进程自然退出） */
  snapshot(): BgProcessInfo[] {
    for (const [pgid, g] of this.#groups) {
      const pids = g.pids.filter(alive)
      if (pids.length === g.pids.length) continue
      if (pids.length === 0) this.#groups.delete(pgid)
      else this.#groups.set(pgid, { ...g, pids })
      this.#dirty = true
    }
    return [...this.#groups.values()]
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
  forget(drop: (pgid: number) => boolean): void {
    for (const pgid of [...this.#groups.keys()]) if (drop(pgid)) this.#groups.delete(pgid)
    this.#dirty = true
  }

  /**
   * 用户在 UI 点关闭：整组 SIGTERM（`kill(-pgid)`，组长已死也送得到组员）。
   * 杀不掉再点一次也还是 TERM（拍板：不做 KILL 兜底）
   */
  terminate(pgid: number): BgProcessInfo[] {
    try {
      process.kill(-pgid, 'SIGTERM')
    } catch {
      // 已死（ESRCH）：本来要做的就是让它从列表消失，无碍
    }
    this.#groups.delete(pgid)
    this.#dirty = true
    return this.snapshot()
  }
}

/** 命令可能极长（heredoc），截到悬停看得完的长度 */
const COMMAND_MAX = 500

function entryOf(pgid: number, pids: number[], meta: BgMeta): BgProcessInfo {
  const command = meta.command.trim()
  return {
    pgid,
    pids,
    label: meta.desc?.trim() || (command.split('\n')[0] ?? ''),
    command: command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX)}…` : command,
    startedAt: meta.startedAt,
    ...(meta.logPath === undefined ? {} : { logPath: meta.logPath }),
  }
}

/** signal 0 只探不发。僵尸态（Z）探不出来——ps 扫描那一步已剔除 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * ps 全表按 pgid 归组存活成员，僵尸（stat 以 Z 开头）剔除。ps 失败（极端）
 * 返回 null——静默，别打断工具
 */
async function scanGroups(): Promise<Map<number, number[]> | null> {
  let out: string
  try {
    ;({ stdout: out } = await ps('ps', ['-ax', '-o', 'pid=,pgid=,stat='], { timeout: 5000 }))
  } catch {
    return null
  }
  const groups = new Map<number, number[]>()
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(\d+)\s+(\S+)/.exec(line.trim())
    if (!m || m[3]!.startsWith('Z')) continue
    const pgid = Number(m[2])
    const list = groups.get(pgid) ?? []
    list.push(Number(m[1]))
    groups.set(pgid, list)
  }
  return groups
}
