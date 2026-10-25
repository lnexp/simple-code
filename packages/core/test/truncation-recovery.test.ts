import { describe, expect, it, vi } from 'vitest'
import type { Message, Request } from '../src/llm/types.ts'
import { createPrefixGuard, fingerprint, PrefixBrokenError, type PrefixFingerprint } from '../src/loop/prefix-guard.ts'
import { replaceLegacyResumePrompts, RESUME_STARVED_PROMPT } from '../src/loop/truncation-recovery.ts'
import { run, type LoopContext } from '../src/loop/run.ts'

const legacy = '输出被长度上限截断了，正文一个字都没写出来——整个预算都花在了推理上。你被截断前的推理已保存在 /project/.simple-code/tmp/truncated-reasoning-123.md，可读取它看看自己思考到了哪一步；但不要照原样继续长推理。不要试图一次想清整个任务：先只推进一步，能查证的就直接调工具、用结果代替长推理，得到结果后再想下一步。避免再次被截断。'
const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })
const request = (messages: Message[]): Request => ({
  model: 'm', maxTokens: 100, thinking: 'disabled', effort: 'high', reasoningDisplay: 'omitted', system: 'S', tools: [], messages,
})

describe('旧截断提示的发送副本恢复', () => {
  it('loop发送中性提示，checkpoint与内存保留原文，未重跑已有工具', async () => {
    const original: Message[] = [
      user('任务'),
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'a', name: 'bash', input: {} }] },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'a', output: '执行成功', isError: false }] },
      user(legacy),
    ]
    const execute = vi.fn(async () => ({ output: '不该重跑', exitCode: 0, isError: false }))
    let baseline: PrefixFingerprint | null = fingerprint(request(original))
    let prev = request(original)
    const prefixGuard = createPrefixGuard({
      baseline: { read: () => baseline, write: (fp) => { baseline = fp } },
      prev: { read: () => prev, write: (r) => { prev = r } }, dump: () => null,
    })
    const sent: Request[] = []
    const checkpoints: Message[][] = []
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 }
    const ctx: LoopContext = {
      messages: original.slice(), tasks: [], signal: new AbortController().signal,
      deps: {
        root: '.', caps: { images: true }, request: request([]), prefixGuard,
        tools: new Map([['bash', { name: 'bash', definition: { name: 'bash', description: '', parameters: {} }, execute }]]),
        maxIterations: 3, now: () => 0,
        checkpoint: (messages) => { checkpoints.push(messages.slice()) },
        stream: async function* (r) {
          sent.push(r)
          yield { type: 'text_start' }
          yield { type: 'text_delta', text: '继续任务' }
          yield { type: 'text_end' }
          yield { type: 'finish', reason: 'stop', usage }
        },
      },
    }
    const events = []
    for await (const event of run(ctx)) events.push(event)
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.messages).toEqual([...original.slice(0, 3), user(RESUME_STARVED_PROMPT)])
    expect(checkpoints[0]).toEqual(original)
    expect(ctx.messages.slice(0, original.length)).toEqual(original)
    expect(execute).not.toHaveBeenCalled()
  })

  it('替换中段所有完整旧提示，原记录不变，重复转换幂等', () => {
    const source = [user('任务'), user(legacy), user('继续'), user(legacy)]
    const next = replaceLegacyResumePrompts(source)
    expect(next).toEqual([user('任务'), user(RESUME_STARVED_PROMPT), user('继续'), user(RESUME_STARVED_PROMPT)])
    expect(source[1]).toEqual(user(legacy))
    expect(replaceLegacyResumePrompts(next)).toEqual(next)
    expect(next[0]).toBe(source[0])
  })

  it('不动tool结果、assistant、引用、片段、多part和新版提示', () => {
    const messages: Message[] = [
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'a', output: legacy, isError: false }] },
      { role: 'assistant', parts: [{ type: 'text', text: legacy }] },
      user(`代码中有：${legacy}`), user(legacy.slice(0, -1)),
      { role: 'user', parts: [...user(legacy).parts, { type: 'text', text: '讨论这句话' }] },
      user(RESUME_STARVED_PROMPT),
    ]
    expect(replaceLegacyResumePrompts(messages)).toEqual(messages)
  })

  it('持久化旧基线重建后只允许确定的替换，其余改写仍拦截', () => {
    const prev = request([user('任务'), user(legacy), user('后续')])
    let saved: PrefixFingerprint | null = fingerprint(prev, 'config')
    let savedRequest = prev
    const guard = () => createPrefixGuard({
      baseline: { read: () => saved, write: (fp) => { saved = fp } },
      prev: { read: () => savedRequest, write: (r) => { savedRequest = r } },
      dump: () => null,
    })
    const next = request([...replaceLegacyResumePrompts(prev.messages), user('继续')])
    expect(() => guard().check({ ...next, system: '偷改system' }, 'config')).toThrow(PrefixBrokenError)
    saved = fingerprint(prev, 'config'); savedRequest = prev
    expect(() => guard().check(request([...replaceLegacyResumePrompts(prev.messages).slice(0, 2), user('偷改后续')]), 'config')).toThrow(PrefixBrokenError)
    saved = fingerprint(prev, 'config'); savedRequest = prev
    expect(() => guard().check(next, 'config')).not.toThrow()
    expect(() => guard().check({ ...next, messages: [user('偷改任务'), ...next.messages.slice(1)] }, 'config')).toThrow(PrefixBrokenError)
  })

  it('旧请求原文缺失或与基线不符，不能用迁移绕过守卫', () => {
    const prev = request([user('任务'), user(legacy)])
    const next = request(replaceLegacyResumePrompts(prev.messages))
    for (const stored of [null, request([user('偷改任务'), user(legacy)])]) {
      const guard = createPrefixGuard({
        baseline: { read: () => fingerprint(prev), write: () => {} },
        prev: { read: () => stored, write: () => {} }, dump: () => null,
      })
      expect(() => guard.check(next)).toThrow(PrefixBrokenError)
    }
  })
})
