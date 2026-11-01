/**
 * 派任务桥（task-bridge.ts，task-trunk 规则 11）：token 挡跨站/他进程，
 * 请求校验后原样交给 dispatcher（面板 → 路由 → 文件夹 bridge → tasks 中心）。
 */

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TaskDispatchRequest } from '@simple-code/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskBridge, pickTaskModel } from '../src/task-bridge.ts'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

async function bridge(): Promise<{ url: string; got: TaskDispatchRequest[]; base: string }> {
  const got: TaskDispatchRequest[] = []
  const server = createTaskBridge({
    token: 'tok',
    dispatch: async (req) => {
      got.push(req)
      return { ok: true, name: req.brief.split('\n')[0] ?? '' }
    },
    models: async ({ root }) => ({
      ok: true,
      models: [{ provider: 'p', model: root === '/w/a' ? 'm2' : 'x', use: '查东西' }],
      defaultModel: 'p/m',
    }),
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url: `${base}/dispatch`, got, base }
}

const post = (url: string, body: unknown, token: string | null = 'tok') =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-sc-token': token }),
    },
    body: JSON.stringify(body),
  })

describe('派任务桥', () => {
  it('带对 token：交给 dispatcher，回任务名', async () => {
    const b = await bridge()
    const res = await post(b.url, { brief: '调研某库\n细节', root: '/w/a', owner: 'task-ab12' })
    expect(await res.json()).toEqual({ ok: true, name: '调研某库' })
    expect(b.got).toEqual([{ brief: '调研某库\n细节', root: '/w/a', owner: 'task-ab12' }])
  })

  it('token 缺失或不对 → 401，不派（对照：网页跨站 POST 拿不到 token）', async () => {
    const b = await bridge()
    expect((await post(b.url, { brief: 'x', root: '/w', owner: '' }, null)).status).toBe(401)
    expect((await post(b.url, { brief: 'x', root: '/w', owner: '' }, 'tok2')).status).toBe(401)
    expect(b.got).toEqual([])
  })

  it('任务书为空、owner 非法 → 400，不派', async () => {
    const b = await bridge()
    expect((await post(b.url, { brief: '  ', root: '/w', owner: '' })).status).toBe(400)
    expect((await post(b.url, { brief: 'x', root: '/w', owner: "x'; DROP" })).status).toBe(400)
    expect(b.got).toEqual([])
  })

  it('被拒的请求记 runlog（task_bridge_reject），受理的不记', async () => {
    const calls: Record<string, unknown>[] = []
    const mod = await import('../../core/src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => void calls.push(ev))
    try {
      const b = await bridge()
      await post(b.url, { brief: 'x', root: '/w', owner: '' }, null)
      await post(b.url, { brief: 'x', root: '/w/a', owner: "x'; DROP" })
      await post(b.url, { brief: '好的', root: '/w/a', owner: '' })
    } finally {
      spy.mockRestore()
    }
    expect(calls).toMatchObject([
      { ev: 'task_bridge_reject', status: 401, folder: null },
      {
        ev: 'task_bridge_reject',
        status: 400,
        folder: '/w/a',
        error: expect.stringContaining('非法 owner'),
      },
    ])
    expect(calls).toHaveLength(2)
  })

  it('--model 原文透传给 dispatcher；空的 → 400 不派（规则 14）', async () => {
    const b = await bridge()
    await post(b.url, { brief: 'x', root: '/w/a', owner: '', model: 'p/m2' })
    expect(b.got).toEqual([{ brief: 'x', root: '/w/a', owner: '', model: 'p/m2' }])
    expect((await post(b.url, { brief: 'x', root: '/w/a', owner: '', model: '' })).status).toBe(400)
    expect(b.got).toHaveLength(1)
  })

  it('/models：按 root 交给 lister；token 照样要（对照：没 token 401）', async () => {
    const b = await bridge()
    const res = await post(`${b.base}/models`, { root: '/w/a' })
    expect(await res.json()).toEqual({
      ok: true,
      models: [{ provider: 'p', model: 'm2', use: '查东西' }],
      defaultModel: 'p/m',
    })
    expect((await post(`${b.base}/models`, { root: '/w/a' }, null)).status).toBe(401)
  })
})

describe('pickTaskModel（规则 14）', () => {
  const list = [
    { provider: 'a', model: 'opus', effort: 'high', use: '改代码' },
    { provider: 'b', model: 'glm', use: '查询' },
    { provider: 'c', model: 'glm', use: '查询（另一个网关）' },
  ]
  it('认 model 与 provider/model；撞名要写全；不在列表拒绝并列出可选', () => {
    expect(pickTaskModel(list, 'opus')).toBe(list[0])
    expect(pickTaskModel(list, 'b/glm')).toBe(list[1])
    expect(pickTaskModel(list, 'glm')).toContain('写成 provider/model')
    const miss = pickTaskModel(list, 'gpt')
    expect(miss).toContain('不在 taskModels 里')
    expect(miss).toContain('a/opus、b/glm、c/glm')
    expect(pickTaskModel([], 'opus')).toContain('没配 taskModels')
  })
})
