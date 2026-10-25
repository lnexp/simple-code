import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { checkOutPath, imagegenMain, outputFormat, parseImagegenArgs, placeImage, sniffFormat } from '../src/imagegen-bin.ts'

const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

describe('parseImagegenArgs', () => {
  test('指令+路径，flag 可在任意位置，n 默认 1', () => {
    expect(parseImagegenArgs(['猫', 'a.png'])).toEqual({ ok: true, args: { prompt: '猫', out: 'a.png', n: 1 } })
    expect(parseImagegenArgs(['--size', '1024x1024', '猫', 'a.png', '--quality', 'high', '--n', '2'])).toEqual({
      ok: true,
      args: { prompt: '猫', out: 'a.png', n: 2, size: '1024x1024', quality: 'high' },
    })
  })
  test('缺参数、多参数、n 非正整数、flag 缺值都报错', () => {
    expect(parseImagegenArgs(['猫']).ok).toBe(false)
    expect(parseImagegenArgs(['猫', 'a.png', 'b.png']).ok).toBe(false)
    expect(parseImagegenArgs(['猫', 'a.png', '--n', '0']).ok).toBe(false)
    expect(parseImagegenArgs(['猫', 'a.png', '--n', '1.5']).ok).toBe(false)
    expect(parseImagegenArgs(['猫', 'a.png', '--size']).ok).toBe(false)
  })
})

test('outputFormat：按扩展名，大小写不敏感', () => {
  expect(outputFormat('a.png')).toBe('png')
  expect(outputFormat('a.JPG')).toBe('jpeg')
  expect(outputFormat('a.jpeg')).toBe('jpeg')
  expect(outputFormat('a.webp')).toBe('webp')
  expect(outputFormat('a.gif')).toBeUndefined()
  expect(outputFormat('a')).toBeUndefined()
})

test('checkOutPath：只许项目内、非隐藏目录，.simple-code/tmp 例外', () => {
  const root = '/proj'
  expect(checkOutPath(root, 'docs/a.png')).toEqual({ ok: true, abs: '/proj/docs/a.png' })
  expect(checkOutPath(root, '.simple-code/tmp/a.png')).toEqual({ ok: true, abs: '/proj/.simple-code/tmp/a.png' })
  expect(checkOutPath(root, '../x/a.png').ok).toBe(false)
  expect(checkOutPath(root, '/etc/a.png').ok).toBe(false)
  expect(checkOutPath(root, '.git/a.png').ok).toBe(false)
  expect(checkOutPath(root, '.simple-code/memory/a.png').ok).toBe(false)
  expect(checkOutPath(root, 'docs/.hidden/a.png').ok).toBe(false)
})

describe('placeImage', () => {
  test('新文件直写；已存在另存 hash 名；同内容再来不重写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-'))
    const target = join(dir, 'sub', 'cat.png')
    const a = await placeImage(target, Buffer.from('A'))
    expect(a).toEqual({ path: target, taken: false, same: false })
    const b = await placeImage(target, Buffer.from('B'))
    // sha256('B') 前 8 位
    expect(b).toEqual({ path: join(dir, 'sub', 'cat-df7e70e5.png'), taken: true, same: false })
    expect(await readFile(target, 'utf8')).toBe('A')
    const again = await placeImage(target, Buffer.from('B'))
    expect(again).toEqual({ path: b.path, taken: true, same: true })
    expect((await readdir(join(dir, 'sub'))).sort()).toEqual(['cat-df7e70e5.png', 'cat.png'])
  })
})

/** 假代理：记下请求，按 handler 回 */
async function fakeProxy(handler: (body: Record<string, unknown>) => [number, string]): Promise<{ env: NodeJS.ProcessEnv; seen: Array<{ token: unknown; body: Record<string, unknown> }> }> {
  const seen: Array<{ token: unknown; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      seen.push({ token: req.headers['x-sc-token'], body })
      const [status, text] = handler(body)
      res.writeHead(status, { 'content-type': 'application/json' }).end(text)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = String((server.address() as AddressInfo).port)
  return { env: { SIMPLE_CODE_PROXY_PORT: port, SIMPLE_CODE_PROXY_TOKEN: 'tok' }, seen }
}

function capture(): { out: () => string; err: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return { out: () => out.mock.calls.map((c) => String(c[0])).join(''), err: () => err.mock.calls.map((c) => String(c[0])).join('') }
}

describe('imagegenMain', () => {
  test('请求体与落盘：不带 model（代理钉），output_format 由扩展名定，stdout 一行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagegen-'))
    const png = Buffer.from('fake-png')
    const { env, seen } = await fakeProxy(() => [200, JSON.stringify({ data: [{ b64_json: png.toString('base64') }], size: '1024x1024', output_format: 'png' })])
    const io = capture()
    expect(await imagegenMain(['橘猫', 'img/cat.png', '--size', '1024x1024'], env, root)).toBe(0)
    expect(seen[0]).toEqual({ token: 'tok', body: { prompt: '橘猫', n: 1, output_format: 'png', size: '1024x1024' } })
    expect(await readFile(join(root, 'img/cat.png'))).toEqual(png)
    expect(io.out()).toMatch(/^已生成 img\/cat\.png（1024x1024，png，1KB，用时 \d+s）\n$/)
    expect(io.out()).not.toContain(png.toString('base64'))
  })

  test('网关回的格式与扩展名不符：按实际格式改扩展名再存，输出写明', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagegen-'))
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('rest')])
    const { env, seen } = await fakeProxy(() => [200, JSON.stringify({ data: [{ b64_json: png.toString('base64') }], output_format: 'png' })])
    const io = capture()
    expect(await imagegenMain(['图标', 'img/logo.jpg'], env, root)).toBe(0)
    expect(seen[0]?.body.output_format).toBe('jpeg')
    expect(await readdir(join(root, 'img'))).toEqual(['logo.png'])
    expect(io.out()).toMatch(/^请求 jpeg，网关返回 png，改存 img\/logo\.png；已生成 img\/logo\.png（/)
  })

  test('sniffFormat：按文件头认 png/jpeg/webp，认不出返回 undefined', () => {
    expect(sniffFormat(Buffer.from('89504e470d0a1a0a00', 'hex'))).toBe('png')
    expect(sniffFormat(Buffer.from('ffd8ffe000', 'hex'))).toBe('jpeg')
    expect(sniffFormat(Buffer.concat([Buffer.from('RIFF'), Buffer.from('00000000', 'hex'), Buffer.from('WEBPVP8 ')]))).toBe('webp')
    expect(sniffFormat(Buffer.from('fake-png'))).toBeUndefined()
  })

  test('n=2：第一张占原名，第二张另存 hash 名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagegen-'))
    const imgs = ['A', 'B'].map((s) => ({ b64_json: Buffer.from(s).toString('base64') }))
    const { env } = await fakeProxy(() => [200, JSON.stringify({ data: imgs })])
    const io = capture()
    expect(await imagegenMain(['猫', 'cat.webp', '--n', '2'], env, root)).toBe(0)
    expect(io.out()).toContain('已生成 cat.webp')
    expect(io.out()).toContain('cat.webp 已存在，另存为 cat-df7e70e5.webp')
  })

  test('参数错不发请求：.gif、越界路径 → 3；无代理 → 2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagegen-'))
    const { env, seen } = await fakeProxy(() => [200, '{}'])
    capture()
    expect(await imagegenMain(['猫', 'a.gif'], env, root)).toBe(3)
    expect(await imagegenMain(['猫', '../a.png'], env, root)).toBe(3)
    expect(seen).toEqual([])
    expect(await imagegenMain(['猫', 'a.png'], {}, root)).toBe(2)
  })

  test('上游报错 → 1，错误原文回 stderr；响应无图 → 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'imagegen-'))
    const { env } = await fakeProxy((b) => (b.size === 'bad' ? [400, '{"error":{"message":"invalid size"}}'] : [200, '{"data":[]}']))
    const io = capture()
    expect(await imagegenMain(['猫', 'a.png', '--size', 'bad'], env, root)).toBe(1)
    expect(io.err()).toContain('HTTP 400')
    expect(io.err()).toContain('invalid size')
    expect(await imagegenMain(['猫', 'a.png'], env, root)).toBe(1)
    expect(io.err()).toContain('响应里没有图片')
  })
})
