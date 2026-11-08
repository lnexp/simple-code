import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, rootOf, taskMain } from '../src/task-bin.ts'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  vi.restoreAllMocks()
})

/** 假桥：记下收到的请求头与体，回固定结果 */
async function fakeBridge(
  reply: unknown,
): Promise<{ port: string; got: { token: unknown; body: unknown }[]; paths: string[] }> {
  const got: { token: unknown; body: unknown }[] = []
  const paths: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      paths.push(req.url ?? '')
      got.push({
        token: req.headers['x-sc-token'],
        body: JSON.parse(Buffer.concat(chunks).toString()),
      })
      res.end(JSON.stringify(reply))
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { port: String((server.address() as AddressInfo).port), got, paths }
}

const quiet = () => {
  const out: string[] = []
  const sink = (s: unknown): boolean => {
    out.push(String(s))
    return true
  }
  vi.spyOn(process.stdout, 'write').mockImplementation(sink)
  vi.spyOn(process.stderr, 'write').mockImplementation(sink)
  return out
}

describe('task-bin', () => {
  it('stdin 任务书 + 会话身份（root 取 SIMPLE_CODE_ROOTS 首项、owner）带 token 发给桥，打印任务名', async () => {
    const b = await fakeBridge({ ok: true, name: '调研某库' })
    const out = quiet()
    const code = await taskMain(
      [],
      {
        SIMPLE_CODE_TASK_PORT: b.port,
        SIMPLE_CODE_TASK_TOKEN: 'tok',
        SIMPLE_CODE_ROOTS: JSON.stringify(['/w/a', '/extra']),
        SIMPLE_CODE_OWNER: 'task-ab12',
      },
      async () => '调研某库\n细节\n',
    )
    expect(code).toBe(0)
    expect(b.got).toEqual([
      { token: 'tok', body: { brief: '调研某库\n细节', root: '/w/a', owner: 'task-ab12' } },
    ])
    expect(out.join('')).toContain('已派出任务「调研某库」')
  })

  it("参数形态也行；owner 缺省 = 主任务 ''", async () => {
    const b = await fakeBridge({ ok: true, name: 'x' })
    quiet()
    await taskMain(
      ['做', '这件事'],
      { SIMPLE_CODE_TASK_PORT: b.port, SIMPLE_CODE_TASK_TOKEN: 'tok' },
      async () => '',
    )
    expect(b.got[0]?.body).toMatchObject({ brief: '做 这件事', owner: '' })
  })

  it('无桥（终端 sc）→ 2；任务书为空 → 3；宿主拒绝 → 1', async () => {
    const out = quiet()
    expect(await taskMain(['x'], {}, async () => '')).toBe(2)
    expect(out.join('')).toContain('无任务桥')
    expect(
      await taskMain(
        [],
        { SIMPLE_CODE_TASK_PORT: '1', SIMPLE_CODE_TASK_TOKEN: 't' },
        async () => '  ',
      ),
    ).toBe(3)
    const b = await fakeBridge({ ok: false, error: '本窗口没有打开「/w/x」的 SC 会话' })
    expect(
      await taskMain(
        ['x'],
        { SIMPLE_CODE_TASK_PORT: b.port, SIMPLE_CODE_TASK_TOKEN: 't' },
        async () => '',
      ),
    ).toBe(1)
  })

  it('rootOf：ROOTS 缺或坏退回 cwd', () => {
    expect(rootOf({}, '/cwd')).toBe('/cwd')
    expect(rootOf({ SIMPLE_CODE_ROOTS: 'oops' }, '/cwd')).toBe('/cwd')
  })

  const env = (port: string) => ({ SIMPLE_CODE_TASK_PORT: port, SIMPLE_CODE_TASK_TOKEN: 't' })

  it('--model <名>：从参数里拆出来随请求带上，任务书照旧取 stdin（规则 14）；不写就不带（对照）', async () => {
    const b = await fakeBridge({ ok: true, name: '查' })
    quiet()
    expect(await taskMain(['--model', 'glm-x'], env(b.port), async () => '查\n细节')).toBe(0)
    expect(await taskMain([], env(b.port), async () => '查')).toBe(0)
    expect(b.got.map((g) => (g.body as { model?: string }).model)).toEqual(['glm-x', undefined])
    expect(b.got[0]?.body).toMatchObject({ brief: '查\n细节' })
    expect(b.paths).toEqual(['/dispatch', '/dispatch'])
  })

  it('--models：POST /models，按行列出（名字照 --model 能认的写）；--model 后没名字 → 3', async () => {
    const b = await fakeBridge({
      ok: true,
      models: [
        { provider: 'gw', model: 'org-x', effort: 'high', use: '改代码' },
        { provider: 'gw-openai', model: 'glm-x', use: '只读查询' },
      ],
      defaultModel: 'gw-openai/glm-x',
    })
    const out = quiet()
    expect(await taskMain(['--models'], env(b.port), async () => '不该读')).toBe(0)
    expect(b.paths).toEqual(['/models'])
    expect(b.got[0]?.body).toEqual({ root: process.cwd() })
    expect(out.join('')).toContain('配置默认 gw-openai/glm-x')
    expect(out.join('')).toContain('- gw/org-x（effort high）：改代码')
    expect(await taskMain(['--model'], env(b.port), async () => 'x')).toBe(3)
    expect(parseArgs(['--model', 'a', '做', '事'])).toEqual({
      model: 'a',
      list: false,
      rest: ['做', '事'],
    })
    expect(parseArgs(['--lean', '做', '事'])).toEqual({
      list: false,
      rest: ['做', '事'],
      lean: true,
    })
    expect(parseArgs(['做', '事'])).toEqual({ list: false, rest: ['做', '事'] })
  })
})
