import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type FromRobot, parseFromRobot, startRobotClient } from '../src/robot-client.ts'

/**
 * 真 unix socket（CLAUDE.md §6.3：进程/网络行为 mock 不出来）。假机器人
 * 记下每条连接收到的行，能主动发消息、能整个关掉再起（模拟机器人重启）。
 */
function fakeRobot(path: string) {
  const lines: string[][] = []
  const conns: net.Socket[] = []
  let server: net.Server | null = null
  const start = (): Promise<void> =>
    new Promise((res) => {
      server = net.createServer((c) => {
        const mine: string[] = []
        lines.push(mine)
        conns.push(c)
        let buf = ''
        c.setEncoding('utf8')
        c.on('data', (d: string) => {
          buf += d
          for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
            mine.push(buf.slice(0, i))
            buf = buf.slice(i + 1)
          }
        })
      })
      server.listen(path, () => res())
    })
  const stop = (): Promise<void> =>
    new Promise((res) => {
      for (const c of conns.splice(0)) c.destroy()
      if (server === null) return res()
      server.close(() => res())
      server = null
    })
  return { start, stop, lines, conns }
}

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('等不到条件成立')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const dirs: string[] = []
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'robot-'))
  dirs.push(dir)
  const path = join(dir, 'r.sock')
  const robot = fakeRobot(path)
  cleanups.push(robot.stop)
  const got: FromRobot[] = []
  const client = startRobotClient({
    sockPath: path,
    hello: () => ({ type: 'hello', pid: 42 }),
    onMessage: (m, reply) => {
      got.push(m)
      if (m.type === 'allow') reply({ type: 'ack', ref: m.ref, ok: true })
    },
    retryMs: [10, 30],
  })
  cleanups.push(client.dispose)
  return { robot, client, got }
}

describe('robot-client', () => {
  it('先连上：hello 打头，再发 status；一样的 status 不重发，变了才发', async () => {
    const { robot, client } = setup()
    await robot.start()
    await until(() => robot.lines.length === 1 && robot.lines[0]!.length >= 1)
    client.send({ type: 'status', items: [] })
    client.send({ type: 'status', items: [] })
    client.send({ type: 'status', items: [1] })
    await until(() => robot.lines[0]!.length >= 3)
    await new Promise((r) => setTimeout(r, 30))
    expect(robot.lines[0]!.map((l) => JSON.parse(l).type)).toEqual(['hello', 'status', 'status'])
    expect(JSON.parse(robot.lines[0]![2]!).items).toEqual([1])
  })

  it('机器人还没起：先存着最新一份；机器人起来后自动连上补发', async () => {
    const { robot, client } = setup()
    client.send({ type: 'status', items: ['a'] })
    client.send({ type: 'status', items: ['b'] })
    await new Promise((r) => setTimeout(r, 40)) // 已经重试过几次
    expect(robot.lines).toEqual([])
    await robot.start()
    await until(() => (robot.lines[0]?.length ?? 0) >= 2)
    expect(robot.lines[0]!.map((l) => JSON.parse(l))).toEqual([
      { type: 'hello', pid: 42 },
      { type: 'status', items: ['b'] },
    ])
  })

  it('机器人重启：重连后再发一次 hello 和整份 status（没变也要发——新进程什么都不知道）', async () => {
    const { robot, client } = setup()
    await robot.start()
    client.send({ type: 'status', items: ['x'] })
    await until(() => (robot.lines[0]?.length ?? 0) >= 2)
    await robot.stop()
    await robot.start()
    await until(() => (robot.lines[1]?.length ?? 0) >= 2)
    expect(robot.lines[1]!.map((l) => JSON.parse(l).type)).toEqual(['hello', 'status'])
  })

  it('收机器人的消息：allow 回调后沿同一条连接回 ack；坏行、未知类型丢掉', async () => {
    const { robot, got } = setup()
    await robot.start()
    await until(() => robot.conns.length === 1)
    const c = robot.conns[0]!
    c.write(
      '不是 json\n{"type":"nope"}\n{"type":"allow","ref":7,"key":"toolu_1"}\n{"type":"focus","folder":"/w/a",',
    )
    c.write('"task":null}\n')
    await until(() => got.length === 2)
    expect(got).toEqual([
      { type: 'allow', ref: 7, key: 'toolu_1' },
      { type: 'focus', folder: '/w/a', task: null },
    ])
    await until(() => robot.lines[0]!.some((l) => l.includes('"ack"')))
    expect(JSON.parse(robot.lines[0]!.find((l) => l.includes('"ack"'))!)).toEqual({
      type: 'ack',
      ref: 7,
      ok: true,
    })
  })

  it('parseFromRobot：字段类型不对的丢掉', () => {
    expect(parseFromRobot('{"type":"allow","ref":"7","key":"k"}')).toBeNull()
    expect(parseFromRobot('{"type":"dismiss","key":3}')).toBeNull()
    expect(parseFromRobot('{"type":"dismiss","key":"k"}')).toEqual({ type: 'dismiss', key: 'k' })
  })
})
