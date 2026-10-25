import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { logRun } from '../runlog.ts'
import {
  bounded,
  deferred,
  loadSdk,
  sdkEnvironment,
  sdkError,
  sdkProcess,
  sdkUpstream,
  type SdkModule,
  type SdkQuery,
} from './claude-sdk-runtime.ts'

type WireBody = {
  model: string
  system: unknown[]
  messages: { role: string; content: { type: string; text?: string }[] }[]
}
type Options = { path: string; folder: string; fetchImpl?: typeof fetch }

/** 只替换发送；请求格式、错误分类、流解析和重试继续由 SC 原实现负责。 */
export function claudeSdkFetch(options: Options): typeof fetch {
  return async (url, init) => {
    const signal = init?.signal
    if (!signal) throw sdkError('调用必须提供取消信号')
    signal.throwIfAborted()
    const body = JSON.parse(String(init.body)) as WireBody
    const prompt = body.messages
      .find((m) => m.role === 'user')
      ?.content.find((b) => b.type === 'text')?.text
    if (!prompt?.trim())
      throw sdkError('首条用户消息必须包含文字，首版不支持纯图片首条消息，请补充文字')
    const sdk = await loadSdk(options.path)
    signal.throwIfAborted()
    const parent = join(options.folder, '.simple-code', 'tmp', 'claude-agent-sdk')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'request-'))
    return new SdkRequest({
      ...options,
      url: String(url),
      init,
      signal,
      body,
      prompt,
      sdk,
      root,
    }).start()
  }
}

type Context = Options & {
  url: string
  init: RequestInit
  signal: AbortSignal
  body: WireBody
  prompt: string
  sdk: SdkModule
  root: string
}

// 一次请求的资源归同一个对象，所有结束路径共享幂等 cleanup；不保存 SDK session。
class SdkRequest {
  private server = createServer()
  private network = new AbortController()
  private sdkAbort = new AbortController()
  private ready = deferred<Response>()
  private exited = deferred<void>()
  private token = randomUUID()
  private child: ChildProcessWithoutNullStreams | undefined
  private query: SdkQuery | undefined
  private drain: Promise<void> | undefined
  private cleaning: Promise<void> | undefined
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private output: ReadableStreamDefaultController<Uint8Array> | undefined
  private forwarded = false
  private startedAt = Date.now()

  private ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async start(): Promise<Response> {
    try {
      this.ctx.signal.throwIfAborted()
      this.server.on('request', (req, res) => {
        if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/messages') {
          res.writeHead(404).end()
          return
        }
        if (
          req.headers['x-api-key'] !== this.token &&
          req.headers.authorization !== `Bearer ${this.token}`
        ) {
          res.writeHead(401).end()
          return
        }
        if (this.forwarded) {
          res.writeHead(409).end()
          return
        }
        this.forwarded = true
        void this.forward(req).catch((error) => this.fail(error))
        // 不回复 SDK，避免它消费模型响应、执行工具或因 HTTP 错误重试。
      })
      await new Promise<void>((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1', resolve)
      })
      this.ctx.signal.throwIfAborted()
      const address = this.server.address()
      if (!address || typeof address === 'string') throw sdkError('本地监听失败')
      const runtime = await sdkEnvironment(
        this.ctx.root,
        `http://127.0.0.1:${address.port}`,
        this.token,
      )
      this.ctx.signal.addEventListener('abort', this.abort, { once: true })
      this.ctx.signal.throwIfAborted()
      this.launch(runtime)
      return await this.ready.promise
    } catch (error) {
      await this.cleanup()
      throw error
    }
  }

  private launch(runtime: Awaited<ReturnType<typeof sdkEnvironment>>): void {
    this.query = this.ctx.sdk.query({
      prompt: this.ctx.prompt,
      options: {
        ...runtime,
        model: this.ctx.body.model,
        tools: [],
        settingSources: [],
        persistSession: false,
        systemPrompt: 'You are SimpleCode using the official Claude Agent SDK.',
        strictMcpConfig: true,
        maxTurns: 1,
        abortController: this.sdkAbort,
        canUseTool: async () => ({ behavior: 'deny', message: 'SC owns tool execution.' }),
        spawnClaudeCodeProcess: (options) => {
          this.ctx.signal.throwIfAborted()
          this.child = sdkProcess(options)
          this.child.once('error', (error) => {
            if (!this.child?.pid) this.exited.resolve()
            this.fail(error)
          })
          this.child.once('exit', () => {
            this.exited.resolve()
            if (!this.cleaning) this.fail(sdkError('模型请求完成前 SDK 进程退出'))
          })
          return this.child
        },
      },
    })
    this.drain = this.consumeSdk(this.query)
  }

  private async consumeSdk(query: SdkQuery): Promise<void> {
    try {
      for await (const event of query) {
        if (!this.cleaning && (event.type === 'assistant' || event.type === 'result')) {
          this.fail(sdkError('SDK 意外产生模型响应，已停止本次调用'))
        }
      }
      if (!this.cleaning) this.fail(sdkError('SDK 在模型响应完成前结束'))
    } catch (error) {
      if (!this.cleaning) this.fail(error)
    }
  }

  private async forward(req: IncomingMessage): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const generated = JSON.parse(Buffer.concat(chunks).toString()) as {
      system?: { text?: string }[]
    }
    const marker = generated.system?.[0]
    if (!marker?.text?.startsWith('x-anthropic-billing-header:'))
      throw sdkError('固定版本的请求标记格式不符')
    this.ctx.signal.throwIfAborted()
    const { url, headers } = sdkUpstream(req, this.ctx.url, this.ctx.init.headers)
    const response = await (this.ctx.fetchImpl ?? fetch)(url, {
      ...this.ctx.init,
      headers,
      body: JSON.stringify({ ...this.ctx.body, system: [marker, ...this.ctx.body.system] }),
      signal: this.network.signal,
    })
    this.ctx.signal.throwIfAborted()
    if (!response.body) {
      await this.cleanup()
      this.ready.resolve(response)
      return
    }
    this.reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.output = controller
      },
      pull: async (controller) => {
        try {
          const { done, value } = await this.reader!.read()
          if (done) {
            await this.cleanup()
            controller.close()
          } else controller.enqueue(value)
        } catch (error) {
          this.fail(error)
        }
      },
      cancel: async () => {
        await this.cleanup()
      },
    })
    this.ready.resolve(
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }

  private abort = (): void => {
    this.fail(this.ctx.signal.reason)
  }

  private fail(error: unknown): void {
    this.ready.reject(error)
    try {
      this.output?.error(error)
    } catch {
      /* 已关闭的消费者不再接收事件。 */
    }
    void this.cleanup().catch(() => {})
  }

  private cleanup(): Promise<void> {
    this.cleaning ??= Promise.resolve().then(async () => {
      const cleanupAt = Date.now()
      this.ctx.signal.removeEventListener('abort', this.abort)
      this.network.abort()
      let failure: unknown
      try {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGTERM')
          try {
            await bounded(this.exited.promise, 3000, '进程退出超时')
          } catch (error) {
            this.child.kill('SIGKILL')
            await bounded(this.exited.promise, 3000, '强制退出超时')
            throw error
          }
        }
      } catch (error) {
        failure = error
      } finally {
        this.sdkAbort.abort()
        try {
          this.query?.close()
        } catch (error) {
          failure ??= error
        }
        try {
          if (this.drain) await bounded(this.drain, 3000, 'SDK 迭代退出超时')
        } catch (error) {
          failure ??= error
        }
        this.server.closeAllConnections()
        if (this.server.listening)
          await new Promise<void>((resolve) => this.server.close(() => resolve()))
        await rm(this.ctx.root, { recursive: true, force: true })
        logRun({
          ev: 'claude_sdk',
          folder: this.ctx.folder,
          ms: Date.now() - this.startedAt,
          cleanupMs: Date.now() - cleanupAt,
          childPid: this.child?.pid,
          forwarded: this.forwarded,
          cleanupFailed: !!failure,
        })
      }
      if (failure) throw failure
    })
    return this.cleaning
  }
}
