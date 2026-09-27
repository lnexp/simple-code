import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendForwardBlock, forwardLine, hasForwardForHost, sshConfigPath } from '../src/ssh-config.ts'

const homes: string[] = []
const home = (): string => {
  const h = mkdtempSync(join(tmpdir(), 'sc-ssh-'))
  homes.push(h)
  return h
}
afterEach(() => {
  for (const h of homes.splice(0)) {
    try {
      chmodSync(join(h, '.ssh', 'config'), 0o644)
    } catch {
      /* 没建过文件 */
    }
  }
})

describe('ssh config 的 RemoteForward 检测与追加', () => {
  it('主机自己的 Host 块里有转发 → true；只有别的机器有 → false；全文没有 → false', () => {
    const mine = `Host myserver\n  HostName 1.2.3.4\n  ${forwardLine()}\n`
    const other = `Host otherserver\n  HostName 5.6.7.8\n  ${forwardLine()}\n`
    expect(hasForwardForHost(mine, 'myserver')).toBe(true)
    expect(hasForwardForHost(other, 'myserver')).toBe(false)
    expect(hasForwardForHost('Host myserver\n  HostName 1.2.3.4\n', 'myserver')).toBe(false)
  })

  it('通配 Host 块（my-remote-*）也算数', () => {
    expect(
      hasForwardForHost(`Host my-remote-*\n  ${forwardLine()}\n`, 'my-remote-1'),
    ).toBe(true)
    expect(hasForwardForHost(`Host my-remote-*\n  User x\n`, 'my-remote-1')).toBe(false)
  })

  it('行首才算 Host 指令：缩进的 Host 是别的关键字的值', () => {
    const text = `Host myserver\n  # Host not-a-block\n  ${forwardLine()}\n`
    expect(hasForwardForHost(text, 'myserver')).toBe(true)
  })

  it('有转发但主机没有匹配块：有 Include → 保守跳过；没有 Include → 真没配（false）', () => {
    // Include 的文件这里看不见——可能有本主机的转发，宁可不弹
    const includeStyle = `Include ~/.ssh/work\nHost other\n  ${forwardLine()}\n`
    expect(hasForwardForHost(includeStyle, 'myserver')).toBe(true)
    // 没有 Include：转发全在看得见的块里，都是别人的——本主机确实没配
    expect(hasForwardForHost(`Host other\n  ${forwardLine()}\n`, 'myserver')).toBe(false)
  })

  it('追加：文件不存在则创建，0600，块内容正确', () => {
    const h = home()
    const path = appendForwardBlock('myserver', h)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('Host myserver')
    expect(text).toContain(forwardLine())
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('追加：已有文件原样保留、块追加在末尾', () => {
    const h = home()
    const path = sshConfigPath(h)
    mkdirSync(join(h, '.ssh'), { recursive: true })
    writeFileSync(path, 'Host existing\n  User root\n', { mode: 0o600 })
    appendForwardBlock('myserver', h)
    const text = readFileSync(path, 'utf8')
    expect(text.startsWith('Host existing\n  User root\n')).toBe(true)
    expect(text).toContain(`Host myserver\n  ${forwardLine()}`)
    // 幂等判据：追加后检测应为 true
    expect(hasForwardForHost(text, 'myserver')).toBe(true)
  })
})
