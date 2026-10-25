import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { LLMStreamError } from './protocol.ts'

export const SDK_VERSION = '0.3.308'
export type SdkQuery = AsyncIterable<{ type: string }> & { close(): void }
export type SdkOptions = {
  env: Record<string, string>
  cwd: string
  model: string
  tools: never[]
  systemPrompt: string
  settingSources: never[]
  persistSession: false
  strictMcpConfig: true
  maxTurns: number
  abortController: AbortController
  canUseTool: () => Promise<{ behavior: 'deny'; message: string }>
  spawnClaudeCodeProcess: (options: {
    command: string
    args: string[]
    cwd: string
    env: NodeJS.ProcessEnv
    signal?: AbortSignal
  }) => ChildProcessWithoutNullStreams
}
export type SdkModule = { query(args: { prompt: string; options: SdkOptions }): SdkQuery }

export function sdkError(message: string): LLMStreamError {
  return new LLMStreamError({
    kind: 'invalid_request',
    message: `Claude Agent SDK：${message}`,
    retryable: false,
  })
}

export async function loadSdk(root: string): Promise<SdkModule> {
  if (!isAbsolute(root)) throw sdkError('claudeAgentSdkPath 必须是外置 npm 安装目录的绝对路径')
  try {
    // 固定安装根，不能沿父目录寻找另一个恰好存在的 SDK。
    const directory = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    const entry = join(directory, 'sdk.mjs')
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      version: string
    }
    if (pkg.version !== SDK_VERSION) throw sdkError(`要求版本 ${SDK_VERSION}，实际 ${pkg.version}`)
    // 变量 URL 保留为运行时 import，不能把 SDK/原生程序塞进 CLI ESM 或扩展 CJS。
    const url = pathToFileURL(entry).href
    return (await import(/* @vite-ignore */ url)) as SdkModule
  } catch (error) {
    if (error instanceof LLMStreamError) throw error
    throw sdkError(`无法从 ${root} 加载 ${SDK_VERSION}，请检查外置安装及其依赖`)
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // 取消/退出可能先于调用者开始等待，拒绝仍由原 promise 传播。
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(sdkError(label)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function sdkEnvironment(root: string, endpoint: string, token: string) {
  const home = join(root, 'home'),
    work = join(root, 'work')
  await mkdir(home, { recursive: true })
  await mkdir(work, { recursive: true })
  return {
    cwd: work,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: work,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_API_KEY: token,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'simple-code/1.0',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  }
}

export function sdkProcess(options: Parameters<SdkOptions['spawnClaudeCodeProcess']>[0]) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    ...(options.signal ? { signal: options.signal } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // stderr 只消费不落内容/凭证，异常由进程事件向调用者传播。
  child.stderr.resume()
  return child
}

export function sdkUpstream(req: IncomingMessage, target: string, ownHeaders: RequestInit['headers']) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  for (const key of ['host', 'content-length', 'authorization', 'x-api-key', 'connection'])
    headers.delete(key)
  new Headers(ownHeaders).forEach((value, key) => headers.set(key, value))
  headers.set('connection', 'close')
  const url = new URL(target)
  new URL(req.url!, 'http://localhost').searchParams.forEach((v, k) => {
    if (!url.searchParams.has(k)) url.searchParams.set(k, v)
  })
  return { url, headers }
}
