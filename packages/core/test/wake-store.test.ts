/** 闹钟持久层（wake-store.ts）：文件真源、任务级取消校验、owner 视野 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dropWakeAlarm,
  loadWakeAlarms,
  newWakeId,
  renderWakeList,
  saveWakeAlarms,
  takeWakeAlarm,
  wakeStorePath,
} from '../src/session/wake-store.ts'

const roots: string[] = []
function root() {
  mkdirSync('.simple-code/tmp/wake-store-tests', { recursive: true })
  const r = mkdtempSync(resolve('.simple-code/tmp/wake-store-tests/case-'))
  roots.push(r)
  return r
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('闹钟持久层', () => {
  it('save/load 往返；空目录 load 为空', () => {
    const r = root()
    expect(loadWakeAlarms(r)).toEqual([])
    saveWakeAlarms(r, [
      { id: newWakeId(), owner: '', kind: 'after', dueAt: 123, note: '备忘' },
      { id: newWakeId(), owner: 'task-a', kind: 'until', cmd: 'curl x', everyMs: 60_000, note: '' },
    ])
    const alarms = loadWakeAlarms(r)
    expect(alarms).toHaveLength(2)
    expect(alarms[0]).toMatchObject({ kind: 'after', dueAt: 123 })
    expect(alarms[1]).toMatchObject({ kind: 'until', cmd: 'curl x' })
  })

  it('take：在则摘除返回，不在返回 null（已取消的 fire 被拦）', () => {
    const r = root()
    const id = newWakeId()
    saveWakeAlarms(r, [{ id, owner: '', kind: 'after', dueAt: 123, note: '' }])
    expect(takeWakeAlarm(r, 'no-such')).toBeNull()
    expect(takeWakeAlarm(r, id)).toMatchObject({ id })
    expect(loadWakeAlarms(r)).toHaveLength(0)
  })

  it('drop：任务只能取消自己的；不存在报没有', () => {
    const r = root()
    const id = newWakeId()
    saveWakeAlarms(r, [{ id, owner: 'task-a', kind: 'after', dueAt: 123, note: '' }])
    expect(dropWakeAlarm(r, id, 'task-b')).toContain('别的任务')
    expect(loadWakeAlarms(r)).toHaveLength(1) // 没删
    expect(dropWakeAlarm(r, id, 'task-a')).toBeNull()
    expect(dropWakeAlarm(r, id, 'task-a')).toContain('没有这条闹钟')
  })

  it('render：只列 owner 相同的；主任务视角与任务互不可见', () => {
    const r = root()
    const a = newWakeId()
    const b = newWakeId()
    saveWakeAlarms(r, [
      { id: a, owner: '', kind: 'after', dueAt: Date.now() + 60_000, note: '主的' },
      { id: b, owner: 'task-a', kind: 'after', dueAt: Date.now() + 60_000, note: '任务的' },
    ])
    expect(renderWakeList(r, '')).toContain('主的')
    expect(renderWakeList(r, '')).not.toContain('任务的')
    expect(renderWakeList(r, 'task-a')).toContain('任务的')
    expect(renderWakeList(r, 'task-a')).not.toContain('主的')
    expect(renderWakeList(r, 'task-zzz')).toContain('没有闹钟')
  })

  it('损坏的 wake.json：改名 .broken- 留档，按空处理', () => {
    const r = root()
    mkdirSync(resolve(r, '.simple-code'), { recursive: true })
    writeFileSync(wakeStorePath(r), '{oops', 'utf8')
    expect(loadWakeAlarms(r)).toEqual([])
    saveWakeAlarms(r, [{ id: 'w1', owner: '', kind: 'after', dueAt: 1, note: '' }])
    expect(loadWakeAlarms(r)).toHaveLength(1) // 坏档不阻塞后续写入
  })
})
