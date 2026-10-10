/**
 * ssh config 的 RemoteForward 自动配置（伴生扩展的第二个职责）。
 *
 * 连上 SSH 远端时（extension.ts 的接线层判定）检查本机 ~/.ssh/config：该
 * 主机的 Host 块里没有 RemoteForward 就弹确认框，确认后自动追加。这就是
 * 用户要的「连接远端时让我确认」——以前要手动粘一行。
 *
 * 追加的是**独立的 Host 块**而不是改写用户的既有块：ssh 的每个选项取**第
 * 一次匹配**的值，既有块没写 RemoteForward 时，追加块里的就是第一个——
 * 生效；hostname/端口等其它选项不受影响。不碰用户的块 = 不破坏手写配置。
 *
 * 本模块不 import vscode：路径注入、纯函数，测试直接跑。
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LLM_PROXY_PORT, forwardBlock } from '@simple-code/core/src/remote.ts'

export const sshConfigPath = (home = homedir()): string => join(home, '.ssh', 'config')

/** 转发行的文本搬进了 core（remote.ts）——主扩展指引卡的「复制配置块」
 * 与这里共用同一份，两处各写一份必漂移 */
export { forwardLine } from '@simple-code/core/src/remote.ts'

/** Host 指令按行首匹配（缩进的 Host 是别的关键字的值，不算开块） */
const HOST_LINE = /^Host\s+(.+?)\s*$/

type Block = { patterns: string[]; body: string }

/** 拆 Host 块。Include 指令不展开——绝大多数用户的转发都写在主文件里 */
function blocks(text: string): Block[] {
  const out: Block[] = []
  let cur: Block = { patterns: [], body: '' }
  for (const line of text.split('\n')) {
    const m = HOST_LINE.exec(line)
    if (m) {
      if (cur.patterns.length > 0) out.push(cur)
      cur = { patterns: (m[1] ?? '').split(/\s+/).filter(Boolean), body: '' }
    } else if (cur.patterns.length > 0) cur.body += line + '\n'
  }
  if (cur.patterns.length > 0) out.push(cur)
  return out
}

/** ssh 的 Host 模式匹配（* 和 ? 通配）。只做这两个——ssh 也主要就这两个 */
function patternMatch(pattern: string, host: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
  )
  return re.test(host)
}

/**
 * 该主机的 Host 块里是否已有 RemoteForward <port>。
 *
 * - 本主机的匹配块里有 → true（已配置）
 * - 文件里没有任何转发 → false（正常路径，该弹框）
 * - 有转发但不在本主机的块里：本主机没有匹配块时**看有没有 Include**——
 *   Include 进来的文件这里看不见，宁可不弹也不加重复的 RemoteForward
 *   （重复转发 ssh 会报 port already in use，每次连接都烦一次）；没有
 *   Include 就是真没配 → false
 */
export function hasForwardForHost(text: string, host: string): boolean {
  const fwd = new RegExp(`RemoteForward\\s+${LLM_PROXY_PORT}\\b`, 'i')
  if (!fwd.test(text)) return false
  const mine = blocks(text).filter((b) => b.patterns.some((p) => patternMatch(p, host)))
  if (mine.length === 0) return /(^|\n)\s*Include\s/.test(text)
  return mine.some((b) => fwd.test(b.body))
}

/**
 * 追加转发块。幂等性由调用方保证（hasForwardForHost 为真时不该走到这）。
 * 文件不存在则创建（~/.ssh 已是 0700 的常规形态，config 补 0600）。
 */
export function appendForwardBlock(host: string, home = homedir()): string {
  const path = sshConfigPath(home)
  const block = forwardBlock(host)
  if (!existsSync(path)) {
    mkdirSync(join(home, '.ssh'), { recursive: true, mode: 0o700 })
    writeFileSync(path, block, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  }
  appendFileSync(path, `\n${block}`)
  return path
}
