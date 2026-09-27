import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { deepMerge, LLM_PROXY_PORT as PROXY_PORT } from '@simple-code/core'

/**
 * Remote-SSH 的远端配置同步（settings.remote.json 方案，2026-09-25 拍板）。
 *
 * 网络必须走本机（key 只在本机）：远端 exthost 的模型请求发往远端
 * 127.0.0.1:15432，SSH RemoteForward 隧道回到本机的 llm-proxy（方案 C，
 * ~/.simple-code/llm-proxy.mjs），由它带真 key 转发给服务商。
 *
 * 配置由本机供给 + 远端本地并层（2026-09-26 拍板）：本机代理开只读端点
 * GET /simplecode/settings（本机 settings.json 的全量，providers 的
 * baseUrl 改指隧道口、apiKey 换假值），远端扩展拉下来**与远端自己的
 * ~/.simple-code/settings.json 深并（本地覆盖）**后写进远端的
 * ~/.simple-code/settings.remote.json——同名 provider 本地接管（走远端
 * 直连），mcp/bash 等段远端机器自己说了算。见
 * .simple-code/events/vscode-remote-ssh-arch.md。
 *
 * 本模块**不 import vscode**（panel.ts 只接线的纪律）：路径、fetch、home
 * 全部可注入，测试直接跑。
 */

/** 远端配置文件：远端 home 下的独立名字，扩展全权拥有 */
export const remoteSettingsPath = (home = homedir()): string =>
  join(home, '.simple-code', 'settings.remote.json')

/** 远端本地配置：标准全局配置位（与 CLI 同一份文件）。并进同步结果——
 * 同名 provider 本地接管（走远端直连），mcp/bash 等段远端机器自己说了算 */
export const localSettingsPath = (home = homedir()): string =>
  join(home, '.simple-code', 'settings.json')

/** 默认隧道口：与伴生扩展（companion）共用一个常量（core/remote.ts），测试也从这拿 */
export { PROXY_PORT }

export type RemoteSyncResult =
  | { ok: true; path: string; localError?: string }
  | { ok: false; reason: string; path: string }

/**
 * 从本机代理同步一次配置。**不抛**——失败是常态（隧道没配、本机没开），
 * 调用方决定要不要给用户看指引卡。
 */
export async function syncRemoteSettings(
  opts: { fetchImpl?: typeof fetch; home?: string; port?: number; timeoutMs?: number } = {},
): Promise<RemoteSyncResult> {
  const { fetchImpl = fetch, port = PROXY_PORT, timeoutMs = 2_000 } = opts
  const path = remoteSettingsPath(opts.home)
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/simplecode/settings`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, reason: `代理回了 ${res.status}`, path }
    const payload = (await res.json()) as Record<string, unknown>
    // 本地覆盖远端（2026-09-26 拍板）：远端自己的 settings.json（用户
    // home 下的文件，非仓库内容，不受工作区黑名单管辖）深并进 payload。
    // 缺失/空文件是正常情况（纯隧道用户），静默跳过；坏 JSON 不拦同步
    // ——payload 照写，错误挂 localError 上可见
    const home = opts.home ?? homedir()
    let merged: Record<string, unknown> = payload
    let localError: string | undefined
    try {
      const raw = await readFile(localSettingsPath(home), 'utf8')
      if (raw.trim() !== '') {
        merged = deepMerge(payload, JSON.parse(raw)) as Record<string, unknown>
      }
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ENOENT')
        localError = `远端本地 settings.json 没并进来：${e instanceof Error ? e.message : String(e)}`
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
    return { ok: true, path, ...(localError ? { localError } : {}) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), path }
  }
}
