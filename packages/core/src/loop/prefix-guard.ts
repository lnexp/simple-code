/**
 * 前缀不变式（2026-09-23 用户定死的规则）：**除了触发上下文压缩，请求前缀
 * 绝对不能变。** 相邻两次请求，后一次必须以前一次为前缀——system、tools
 * 逐字相同，messages 逐条相同、只许在末尾追加。
 *
 * 为什么要代码守：前缀中段一改，改动点之后的缓存全作废，要全价重算。这类
 * bug 不报错、功能照常，只在账单和延迟上体现——实测 request1/request2：
 * 合并在两次卸载之间提前生效，20 条 L0 换成 2 条 L1，113 条消息里只有
 * 前 18 条命中缓存。靠人看 diff 发现一次算一次，守卫把它变成当场报错。
 *
 * 合法的改写点只有一种：压缩点（卸载触发——预算超线、缓存过期、context
 * 超限自救）。那一刻缓存横竖要破，前缀的所有改写（卸载、合并生效、摘要
 * 进场、system 重读）都在那儿搭车。压缩点调 `allowRewrite`，下一次 check
 * 放行一次。
 *
 * 另一种不算违规：请求参数变了（换模型、换推理档位、改 maxTokens）——这是
 * 用户的选择，缓存本来就按这些分桶，基线静默重置。
 *
 * 基线跨进程持久化（每个 owner 一行）：reload 后缓存还热的话，前缀也必须
 * 接得上——这恰好能抓「落盘 → 重新 load」这条路径上的渲染差异。
 */
import { createHash } from 'node:crypto'
import type { Request } from '../llm/types.ts'

/** 一次请求的前缀指纹。只存哈希：基线每请求落盘一次，存原文是写放大 */
export type PrefixFingerprint = {
  /**
   * 模型与请求参数（system/tools/messages 之外的一切），外加调用方给的
   * 配置键。变了 = 用户换了配置，基线静默重置。配置键是必须的：system
   * prompt 里写着模型名和窗口大小，只改 settings 里的 contextWindow 时
   * request 参数一个没变、system 却变了——不算进来就会把「用户改配置」
   * 误报成违规（2026-09-23 测试实测）
   */
  params: string
  system: string
  tools: string
  messages: string[]
}

export type PrefixBaselineStore = {
  read(): PrefixFingerprint | null
  write(fp: PrefixFingerprint): void
}

/**
 * 上一次请求的**原文**（跨会话重建存活）。基线只存哈希是刻意的（每请求落
 * 一次盘，存原文是写放大），但代价是 2026-09-23 实测过的：守卫实例随会话
 * 重建而弃（轮结束 closeSession → 下次惰性重建），违规现场的 `prev` 只剩
 * null，两条请求没法 diff，定位只能靠倒推。所以原文单独落一份每 owner
 * 一个的文件——只在违规落现场时才被读，平时就是静默覆盖写
 */
export type PrevRequestStore = {
  read(): Request | null
  write(request: Request): void
}

export type PrefixBreak = {
  /** 哪一块变了 */
  part: 'system' | 'tools' | 'messages'
  /** messages：第一条不同的下标；前一次比这次长时 = 这次的长度 */
  index: number
  prevLength: number
  nextLength: number
}

export class PrefixBrokenError extends Error {
  constructor(
    message: string,
    readonly detail: PrefixBreak & { dumpPath: string | null },
  ) {
    super(message)
    this.name = 'PrefixBrokenError'
  }
}

export type PrefixGuard = {
  /** 压缩点：下一次 check 允许改写前缀（只放行一次） */
  allowRewrite(): void
  /**
   * 发请求前核对。违规抛 `PrefixBrokenError`。**过不过都把这次记为新基线**：
   * 违规这一轮停下报错，用户再发一句能接着用——卡死在同一个违规上没意义，
   * 现场已经落盘
   */
  check(request: Request, configKey?: string): void
}

const hash = (value: unknown): string =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex')

export function fingerprint(request: Request, configKey?: string): PrefixFingerprint {
  const { system, tools, messages, ...params } = request
  return {
    params: hash([params, configKey ?? null]),
    system: hash(system),
    tools: hash(tools),
    messages: messages.map(hash),
  }
}

/** 找第一处违规；前缀完好返回 null */
export function findBreak(prev: PrefixFingerprint, next: PrefixFingerprint): PrefixBreak | null {
  const base = { prevLength: prev.messages.length, nextLength: next.messages.length }
  if (prev.system !== next.system) return { part: 'system', index: 0, ...base }
  if (prev.tools !== next.tools) return { part: 'tools', index: 0, ...base }
  const n = Math.min(prev.messages.length, next.messages.length)
  for (let i = 0; i < n; i++) {
    if (prev.messages[i] !== next.messages[i]) return { part: 'messages', index: i, ...base }
  }
  // 变短也是改写：前一次的末尾几条被删了
  if (next.messages.length < prev.messages.length) return { part: 'messages', index: n, ...base }
  return null
}

export function createPrefixGuard(deps: {
  baseline: PrefixBaselineStore
  /** 上一次请求原文的持久化。没传 = 违规现场里 prev 可能是 null（只剩指纹） */
  prev?: PrevRequestStore
  /** 违规现场落盘（前后两次请求）。返回文件路径；null = 没落成 */
  dump: (info: { break: PrefixBreak; prev: Request | null; next: Request }) => string | null
}): PrefixGuard {
  let allowed = false
  /** 同进程里上一次的完整请求——现场文件要用。跨进程只有指纹 */
  let prevRequest: Request | null = null
  return {
    allowRewrite: () => {
      allowed = true
    },
    check: (request, configKey) => {
      const next = fingerprint(request, configKey)
      const prev = deps.baseline.read()
      // 先读后写：读到的才是「上一次」，写进去的是这一次
      const prevReq = prevRequest ?? deps.prev?.read() ?? null
      deps.baseline.write(next)
      deps.prev?.write(request)
      prevRequest = request
      const pass = allowed
      allowed = false
      if (prev === null || pass || prev.params !== next.params) return
      const found = findBreak(prev, next)
      if (found === null) return
      const dumpPath = deps.dump({ break: found, prev: prevReq, next: request })
      const where =
        found.part === 'messages'
          ? `messages 第 ${found.index} 条起不同（上次 ${found.prevLength} 条，这次 ${found.nextLength} 条）`
          : `${found.part} 变了`
      throw new PrefixBrokenError(
        `上下文前缀在非压缩点被改写：${where}。这会让缓存从改动点起全部失效——是 bug，请排查` +
          (dumpPath ? `（现场：${dumpPath}）` : '') +
          '。本轮已停止，再发一条可继续。',
        { ...found, dumpPath },
      )
    },
  }
}
