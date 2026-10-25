import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendRequest } from '../src/llm/client.ts'
import type { LLMEvent, RefusalDetail } from '../src/llm/events.ts'
import type { Protocol } from '../src/llm/protocol.ts'
import type { Request } from '../src/llm/types.ts'
import * as runlog from '../src/runlog.ts'

const key = 'sk-refusal-sentinel-"quoted"\nline'
const headerSecret = 'header-secret-sentinel'
const refusal: RefusalDetail = {
  category: 'frontier_llm',
  explanation: 'This request was blocked as it may violate Terms of Service.',
}
const request: Request = {
  model: 'test-model', system: '完整 system', tools: [], maxTokens: 1024,
  thinking: 'disabled', effort: 'high', reasoningDisplay: 'omitted',
  messages: [{ role: 'user', parts: [{ type: 'text', text: '是否记录下来' }] }],
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function folder() {
  const parent = resolve('.simple-code/tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'refusal-test-'))
  roots.push(root)
  return root
}

async function send(options: { folder?: string; reason?: 'stop' | 'content-filter'; detail?: RefusalDetail } = {}) {
  const reason = options.reason ?? 'content-filter'
  const body = { model: request.model, system: request.system, messages: request.messages, providerId: 140 }
  const protocol: Protocol = {
    name: 'anthropic-messages',
    buildRequest: () => ({ url: 'https://example.invalid', headers: { 'x-api-key': key }, body }),
    parseError: () => ({ kind: 'unknown', message: 'unused', retryable: false }),
    async *parseStream() {
      if (reason === 'stop') yield { type: 'text_delta', text: '好的' }
      yield { type: 'finish', reason, ...(options.detail ? { refusal: options.detail } : {}),
        usage: { inputTokens: 1, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0 } }
    },
  }
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('unused'))
  const events: LLMEvent[] = []
  for await (const event of sendRequest(request, {
    protocol, provider: { baseUrl: 'https://example.invalid', apiKey: key, headers: { 'x-custom-auth': headerSecret } },
    signal: new AbortController().signal, fetchImpl,
    ...(options.folder ? { folder: options.folder } : {}), tag: 'summary',
  })) events.push(event)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  return { events, body }
}

describe('安全拒答现场保存', () => {
  it('保存对应请求正文与拒答详情，日志可定位；多次拒答不覆盖', async () => {
    const root = await folder()
    const logs: Record<string, unknown>[] = []
    vi.spyOn(runlog, 'logRun').mockImplementation((event) => void logs.push(event))
    const before = structuredClone(request)
    const { body, events } = await send({ folder: root, detail: refusal })
    const log = logs.find((event) => event.ev === 'llm')!
    expect(log).toMatchObject({ finish: 'content-filter', refusal, folder: root, tag: 'summary' })
    expect(typeof log.dumpPath).toBe('string')
    const path = log.dumpPath as string
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(saved).toMatchObject({ protocol: 'anthropic-messages', model: request.model,
      finish: 'content-filter', refusal, body, tag: 'summary', bodyStage: 'protocol.buildRequest' })
    expect(saved.requestedAt).toMatch(/Z$/)
    expect(saved.refusedAt).toMatch(/Z$/)
    expect(saved.headers).toBeUndefined()
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(events.at(-1)).toMatchObject({ type: 'finish', refusal })
    expect(request).toEqual(before)
    await send({ folder: root, detail: refusal })
    await send({ folder: root, reason: 'stop' })
    expect(await readdir(join(root, '.simple-code/memory/refusals'))).toHaveLength(2)
  })

  it('没有详情的 content-filter 也保存，不凭空编造类别', async () => {
    const root = await folder()
    const logs: Record<string, unknown>[] = []
    vi.spyOn(runlog, 'logRun').mockImplementation((event) => void logs.push(event))
    await send({ folder: root })
    const log = logs.find((event) => event.ev === 'llm')!
    const saved = JSON.parse(await readFile(log.dumpPath as string, 'utf8'))
    expect(saved.finish).toBe('content-filter')
    expect(saved.refusal).toBeUndefined()
  })

  it('成功请求不新增快照，也不把正文写入日志', async () => {
    const root = await folder()
    const logs: Record<string, unknown>[] = []
    vi.spyOn(runlog, 'logRun').mockImplementation((event) => void logs.push(event))
    await send({ folder: root, reason: 'stop' })
    await expect(stat(join(root, '.simple-code/memory/refusals'))).rejects.toThrow()
    expect(logs.find((event) => event.ev === 'llm')).not.toHaveProperty('dumpPath')
    expect(JSON.stringify(logs)).not.toContain('是否记录下来')
  })

  it('写盘失败只记录错误，拒答仍正常透传且不重试', async () => {
    const root = await folder()
    await writeFile(join(root, '.simple-code'), 'occupied')
    const logs: Record<string, unknown>[] = []
    vi.spyOn(runlog, 'logRun').mockImplementation((event) => void logs.push(event))
    const { events } = await send({ folder: root, detail: refusal })
    expect(events.at(-1)).toMatchObject({ type: 'finish', refusal })
    expect(logs.find((event) => event.ev === 'llm')).toMatchObject({ refusal, dumpError: expect.any(String) })
  })

  it('没有项目目录时只记拒答详情，不猜快照目录', async () => {
    const logs: Record<string, unknown>[] = []
    vi.spyOn(runlog, 'logRun').mockImplementation((event) => void logs.push(event))
    await send({ detail: refusal })
    expect(logs.find((event) => event.ev === 'llm')).toMatchObject({ refusal })
    expect(logs.find((event) => event.ev === 'llm')).not.toHaveProperty('dumpPath')
  })

  it('请求与拒答中出现配置凭据时脱敏，不持久化认证头', async () => {
    const root = await folder()
    const original = request.system
    request.system = `context ${key} ${headerSecret}`
    const logs: Record<string, unknown>[] = []
    vi.spyOn(runlog, 'logRun').mockImplementation((event) => void logs.push(event))
    try {
      await send({ folder: root, detail: { category: 'frontier_llm', explanation: `${key} ${headerSecret}` } })
      const log = logs.find((event) => event.ev === 'llm')!
      const text = await readFile(log.dumpPath as string, 'utf8')
      for (const secret of [key, headerSecret]) {
        expect(text).not.toContain(secret)
        expect(JSON.stringify(logs)).not.toContain(secret)
      }
      expect(text).toContain('[REDACTED]')
    } finally { request.system = original }
  })
})
