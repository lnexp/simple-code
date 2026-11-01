import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isRobotProcess,
  plan,
  readEnabled,
  readRunning,
  robotPaths,
  writeEnabled,
} from '../src/control.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'robot-home-'))
  dirs.push(d)
  return robotPaths(d)
}

describe('enabled（默认开，用户定 2026-10-31）', () => {
  it('文件不存在 / 写坏了 / 没有这一项：都算开', () => {
    const p = home()
    expect(readEnabled(p.config)).toBe(true)
    writeEnabled(p.config, true) // 顺带建出目录
    writeFileSync(p.config, '{坏的')
    expect(readEnabled(p.config)).toBe(true)
    writeFileSync(p.config, '{"skin":"mycat"}')
    expect(readEnabled(p.config)).toBe(true)
  })

  it('关闭只改 enabled，机器人写的皮肤与位置原样保留', () => {
    const p = home()
    writeEnabled(p.config, true)
    writeFileSync(p.config, JSON.stringify({ skin: 'mycat', position: { x: 1, y: 2 } }))
    writeEnabled(p.config, false)
    expect(readEnabled(p.config)).toBe(false)
    expect(JSON.parse(readFileSync(p.config, 'utf8'))).toEqual({
      skin: 'mycat',
      position: { x: 1, y: 2 },
      enabled: false,
    })
  })
})

describe('拉起判断', () => {
  it('关着不拉；没在跑就拉；同版本不动；版本不同换掉', () => {
    expect(plan(false, null, '0.1.0')).toBe('none')
    expect(plan(true, null, '0.1.0')).toBe('launch')
    expect(plan(true, { pid: 1, version: '0.1.0' }, '0.1.0')).toBe('none')
    expect(plan(true, { pid: 1, version: '0.0.9' }, '0.1.0')).toBe('replace')
  })

  it('pid 文件里的进程不是机器人（崩溃残留、pid 被复用）：当没在跑，不会去杀它', () => {
    const p = home()
    mkdirSync(dirname(p.pid), { recursive: true })
    writeFileSync(p.pid, JSON.stringify({ pid: process.pid, version: '0.1.0' }))
    // 前提：pid 文件本身读得出来——换成「认」的判断就能拿到
    expect(readRunning(p.pid, () => true)).toEqual({ pid: process.pid, version: '0.1.0' })
    // 真判断：本进程是 node，不是 SimpleCodeRobot
    expect(isRobotProcess(process.pid)).toBe(false)
    expect(readRunning(p.pid)).toBeNull()
    expect(readRunning(join(p.pid, '不存在'))).toBeNull()
  })
})
