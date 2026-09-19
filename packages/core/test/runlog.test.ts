import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { logRunTo } from '../src/runlog.ts'

/**
 * 运行日志的写入契约（runlog.ts）。接线（谁在什么时候调）在
 * retry.test.ts 的「重试会写运行日志」里各管一段。
 *
 * 写是 fire-and-forget 的（appendFile 不 await）——测试里等一小拍
 * 让微任务队列跑完，这也是产品行为：日志慢不慢不关调用方的事。
 */
const tick = () => new Promise((r) => setTimeout(r, 20))

describe('runlog', () => {
  it('一行一个 JSON，带 at 和 pid，目录不存在也能写', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'runlog-')), 'logs')
    const log = logRunTo(dir)
    log({ ev: 'llm', model: 'm1', ms: 123 })
    log({ ev: 'error', message: '炸了', retryable: false })
    await tick()

    const files = await readdir(dir)
    expect(files).toHaveLength(1) // 同一天写同一个文件
    const lines = (await readFile(join(dir, files[0]!), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2) // 追加，不覆盖
    const first = JSON.parse(lines[0]!)
    expect(first).toMatchObject({ ev: 'llm', model: 'm1', ms: 123 })
    expect(typeof first.at).toBe('string')
    expect(first.pid).toBe(process.pid)
    expect(JSON.parse(lines[1]!).retryable).toBe(false)
  })

  // 2026-09-18：文件名曾用本地时区（getFullYear/getMonth/getDate）而行内
  // at 用 toISOString()，东八区早上的事件会写进「明天」的文件里——读日志的
  // 人把 UTC 当本地看，定位缓存过期问题时直接被带偏一轮
  it('**文件名与行内 at 同一把尺子（都是 UTC）**', async () => {
    // 必须把时钟固定在「本地与 UTC 不同天」的时刻，否则本地时区写法也能蒙对
    // ——东八区 07:30 对应 UTC 前一天 23:30，正是当初出错的那种时刻
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-18T07:30:00+08:00'))
    const dir = join(await mkdtemp(join(tmpdir(), 'runlog-tz-')), 'logs')
    const log = logRunTo(dir)
    log({ ev: 'llm', model: 'm1' })
    vi.useRealTimers() // 放开定时器，让 appendFile 的 promise 链能跑完
    await tick()

    const [file] = await readdir(dir)
    const at = JSON.parse((await readFile(join(dir, file!), 'utf8')).trim()) as { at: string }
    // 文件名的日期段 === at 的 UTC 日期段。本地时区跟 UTC 差几小时都不影响
    expect(file!.slice(0, 10)).toBe(at.at.slice(0, 10))
    expect(at.at.endsWith('Z')).toBe(true) // 带 Z：读的人不会当成本地时间
  })

  it('清掉 14 天前的旧日志，10 天内的留着，别的文件不碰', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runlog-'))
    const day = (offset: number) => {
      const d = new Date(Date.now() - offset * 24 * 3600_000)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`
    }
    await writeFile(join(dir, day(20)), 'old')
    await writeFile(join(dir, day(10)), 'recent')
    await writeFile(join(dir, '手放的视频清单.txt'), 'keep me')

    logRunTo(dir)({ ev: 'llm' }) // 第一次写才触发清理
    await tick()

    const left = await readdir(dir)
    expect(left).toContain(day(10))
    expect(left).toContain('手放的视频清单.txt')
    expect(left).not.toContain(day(20))
  })

  it('写失败绝不抛——目录路径是个文件也照样静默', async () => {
    const occupied = join(await mkdtemp(join(tmpdir(), 'runlog-')), 'occupied')
    await writeFile(occupied, '')
    const log = logRunTo(occupied) // mkdir/appendFile 都会 ENOTDIR
    expect(() => log({ ev: 'llm' })).not.toThrow()
    await tick()
  })
})
