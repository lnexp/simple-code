import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  localSettingsPath,
  PROXY_PORT,
  remoteSettingsPath,
  syncRemoteSettings,
} from '../src/remote.ts'

const homes: string[] = []
const home = async (): Promise<string> => {
  const h = await mkdtemp(join(tmpdir(), 'sc-remote-'))
  homes.push(h)
  return h
}
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true })
})

describe('远端配置同步（settings.remote.json 方案）', () => {
  it('代理通了 → 远端 home 下写出 settings.remote.json，内容原样', async () => {
    const h = await home()
    const payload = {
      provider: 'p',
      model: 'm',
      providers: { p: { baseUrl: 'http://127.0.0.1:15432', apiKey: 'via-local-proxy', models: {} } },
      memory: { unloadTargetRatio: 0.25 },
    }
    const r = await syncRemoteSettings({
      home: h,
      fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    })
    expect(r.ok).toBe(true)
    expect(JSON.parse(await readFile(remoteSettingsPath(h), 'utf8'))).toEqual(payload)
  })

  it('隧道不通（fetch 拒绝/超时）→ ok:false、不抛、不写文件', async () => {
    const h = await home()
    const r = await syncRemoteSettings({
      home: h,
      fetchImpl: (async () => {
        throw new Error('fetch failed')
      }) as typeof fetch,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('fetch failed')
  })

  it('远端本地 settings.json 并进来：同名 provider 本地接管直连，其余段全量并', async () => {
    const h = await home()
    const payload = {
      provider: 'p',
      providers: {
        p: { baseUrl: 'http://127.0.0.1:15432/sc-p/p', apiKey: 'via-local-proxy' },
        q: { baseUrl: 'http://127.0.0.1:15432/sc-p/q', apiKey: 'via-local-proxy' },
      },
      memory: { unloadTargetRatio: 0.25 },
    }
    await mkdir(join(h, '.simple-code'), { recursive: true })
    await writeFile(
      localSettingsPath(h),
      JSON.stringify({
        provider: 'ollama',
        providers: { q: { baseUrl: 'http://127.0.0.1:11434', apiKey: 'ollama' } },
        mcp: { servers: { remoteOnly: { command: 'node', args: ['x.js'] } } },
      }),
      'utf8',
    )
    const r = await syncRemoteSettings({
      home: h,
      fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    })
    expect(r.ok).toBe(true)
    const out = JSON.parse(await readFile(remoteSettingsPath(h), 'utf8'))
    expect(out.provider).toBe('ollama') // 本地默认模型选择赢
    expect(out.providers.p.baseUrl).toBe('http://127.0.0.1:15432/sc-p/p') // 隧道 provider 原样
    expect(out.providers.q).toEqual({ baseUrl: 'http://127.0.0.1:11434', apiKey: 'ollama' }) // 同名本地接管
    expect(out.mcp.servers.remoteOnly.command).toBe('node') // mcp 段远端自己说了算
    expect(out.memory.unloadTargetRatio).toBe(0.25) // payload 的段保留
  })

  it('本地 settings.json 坏 JSON → 同步照成、payload 原样写、localError 可见', async () => {
    const h = await home()
    const payload = { provider: 'p', providers: { p: { baseUrl: 'x', apiKey: 'y' } } }
    await mkdir(join(h, '.simple-code'), { recursive: true })
    await writeFile(localSettingsPath(h), '{broken', 'utf8')
    const r = await syncRemoteSettings({
      home: h,
      fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.localError).toContain('没并进来')
    expect(JSON.parse(await readFile(remoteSettingsPath(h), 'utf8'))).toEqual(payload)
  })

  it('本地 settings.json 缺失或为空 → 静默跳过（纯隧道用户零变化）', async () => {
    const h = await home()
    const payload = { provider: 'p' }
    const fetchImpl = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch
    // 缺失
    const r1 = await syncRemoteSettings({ home: h, fetchImpl })
    expect(r1).toMatchObject({ ok: true })
    expect(JSON.parse(await readFile(remoteSettingsPath(h), 'utf8'))).toEqual(payload)
    // 空文件
    await mkdir(join(h, '.simple-code'), { recursive: true })
    await writeFile(localSettingsPath(h), '  \n', 'utf8')
    const r2 = await syncRemoteSettings({ home: h, fetchImpl })
    expect(r2).toMatchObject({ ok: true })
    if (r2.ok) expect(r2.localError).toBeUndefined()
  })

  it('代理回了非 200 → ok:false，reason 带状态码', async () => {
    const r = await syncRemoteSettings({
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    })
    expect(r).toMatchObject({ ok: false, reason: '代理回了 500' })
  })

  it('路径与端口是拍板的常量：~/.simple-code/settings.remote.json、15432', () => {
    expect(remoteSettingsPath('/h')).toBe('/h/.simple-code/settings.remote.json')
    expect(PROXY_PORT).toBe(15432)
  })

  it('接线：panel 的两个 session 工厂都走 remoteGlobalPath，本地路径零污染', () => {
    // 对不上的话：远端会话仍读远端 settings.json（不存在或过期），模型请求
    // 从远端直连——「以为走隧道、实际远端直连」的静默错位。任务工厂漏接
    // 的话任务会话读默认路径，同样直连
    const source = readFileSync(fileURLToPath(new URL('../src/panel.ts', import.meta.url)), 'utf8')
    const factories = source.match(
      /getSession\(f, \{[^}]*(requestApproval)[^}]*\}\)/gs,
    )
    expect(factories?.length).toBeGreaterThanOrEqual(2)
    for (const f of factories ?? [])
      expect(f).toContain('remoteGlobalPath')
    // local 会话（remoteName undefined）不传 globalPath——remote.ts 返回空对象
    expect(source).toContain('remoteName === undefined) return {}')
    // 卡片主机名的空窗口兜底：SSH_CONNECTION 第三段（sshd 注入的远端地址）
    expect(source).toContain('SSH_CONNECTION')
  })

  it('主扩展显式声明 extensionKind workspace——不声明时 VS Code 启发式两头打架', () => {
    // 2026-09-26 实测：未声明时，VSIX 在远端窗口安装被启发式判成 UI 类装到
    // 本地；运行时同一启发式又判成 workspace 类在远端窗口禁用本地那份——
    // 「装不进远端 + 本地装了也被禁」两头堵死。agent 要读远端文件、起远端
    // 进程，语义就是 workspace；显式声明后 VSIX 在远端窗口装的就是远端
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    expect(pkg.extensionKind).toEqual(['workspace'])
  })
})
