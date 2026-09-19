import { describe, expect, it } from 'vitest'
import type { ProviderContext } from '../src/llm/protocol.ts'
import { PROTOCOL_NAMES, resolveProtocol } from '../src/llm/registry.ts'
import type { Request } from '../src/llm/types.ts'

const request: Request = {
  model: 'm',
  maxTokens: 100,
  thinking: 'adaptive',
  effort: 'high',
  reasoningDisplay: 'summarized',
  system: 'S',
  tools: [{ name: 'bash', description: 'd', parameters: { type: 'object' } }],
  messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
}

describe('protocol registry', () => {
  it('三个协议都在表里', () => {
    expect(PROTOCOL_NAMES).toEqual(['anthropic-messages', 'openai-chat', 'openai-responses'])
  })

  it('未知协议报错并列出可选值——不猜、不回落默认值', () => {
    expect(() => resolveProtocol('anthropic')).toThrow(/未知的 protocol "anthropic"/)
    expect(() => resolveProtocol('')).toThrow(/anthropic-messages/)
  })

  it('每个协议都能对同一个 Request 生成请求，调用方不需要知道是谁', () => {
    // key 要选一个不会在 JSON 里凑巧出现的串：单字母的 'k' 在 "max_tokens"
    // 里就有，那样的断言必然失败，且失败原因和被测行为无关
    const apiKey = 'sk-SENTINEL-9f3a'

    for (const name of PROTOCOL_NAMES) {
      const protocol = resolveProtocol(name)
      const built = protocol.buildRequest(request, { baseUrl: 'https://x.test', apiKey })

      expect(protocol.name).toBe(name)
      expect(built.url).toMatch(/^https:\/\/x\.test\//)
      expect(JSON.stringify(built.body)).toContain('bash')

      // API key 只能出现在 header 里，绝不进 body
      expect(JSON.stringify(built.headers)).toContain(apiKey)
      expect(JSON.stringify(built.body)).not.toContain(apiKey)
    }
  })

  it('每个协议的 parseError 对 429 都判为可重试', () => {
    for (const name of PROTOCOL_NAMES) {
      const err = resolveProtocol(name).parseError(429, { error: { message: 'slow down' } })
      expect(err).toMatchObject({ kind: 'rate_limit', retryable: true })
    }
  })
})

/**
 * 透传要在**三个协议上行为一致**，所以测在这里而不是各自的测试文件里。
 * 单独测一个的话，另外两个漏接了也照样全绿。
 */
describe('protocol registry / 模型级 headers 与 extraBody 透传', () => {
  const build = (ctx: Partial<ProviderContext>) =>
    PROTOCOL_NAMES.map((name) =>
      resolveProtocol(name).buildRequest(request, {
        baseUrl: 'https://x.test',
        apiKey: 'k',
        ...ctx,
      }),
    )

  it('三个协议都把 headers / extraBody 原样发出去', () => {
    // 对照组：不配的时候这两个字段一个都不该出现，否则下面的断言等于没测
    for (const built of build({})) {
      expect(built.headers['x-route']).toBeUndefined()
      expect(built.body).not.toHaveProperty('providerId')
    }

    for (const built of build({
      headers: { 'X-Route': 'gw-a' },
      extraBody: { providerId: 51 },
    })) {
      // 键名转小写：用户写 X-Route、协议写小写，不归一化会两条一起发
      expect(built.headers['x-route']).toBe('gw-a')
      expect(built.body).toMatchObject({ providerId: 51 })
    }
  })

  it('headers 能覆盖协议自己的头——换认证方式时只能这么配', () => {
    for (const built of build({ headers: { 'content-type': 'application/json; charset=utf-8' } })) {
      expect(built.headers['content-type']).toBe('application/json; charset=utf-8')
    }
  })

  it('extraBody 覆盖不了协议自己的字段', () => {
    // stream: false 塞进来的话，流式读取会一直等到空闲超时才报错，
    // 现象像网络问题，极难排查——所以这条必须挡住
    for (const built of build({ extraBody: { model: 'hijacked', stream: false } })) {
      expect(built.body).toMatchObject({ model: 'm' })
      expect((built.body as { stream: unknown }).stream).toBe(true)
    }
  })

  it('非字符串的 header 值转成字符串——fetch 不接受数字', () => {
    for (const built of build({ headers: { 'x-provider-id': 51 } })) {
      expect(built.headers['x-provider-id']).toBe('51')
    }
  })
})
