import { describe, expect, it, vi } from 'vitest'
import type { LLMEvent } from '../src/llm/events.ts'
import { LLMStreamError, type ProtocolError } from '../src/llm/protocol.ts'
import { type RetryConfig, requestWithRetry, type StreamEvent } from '../src/loop/retry.ts'

const FAST: RetryConfig = {
  maxAttempts: 5,
  initialDelayMs: 1,
  backoffFactor: 2,
  maxDelayMs: 10,
}

const rateLimited = (extra?: Partial<ProtocolError>) =>
  new LLMStreamError({ kind: 'rate_limit', message: '429', retryable: true, ...extra })

const fatal = new LLMStreamError({
  kind: 'invalid_request',
  message: 'bad request',
  retryable: false,
})

const text = (t: string): LLMEvent => ({ type: 'text_delta', text: t })

/**
 * 前 `failures` 次尝试抛 `error`，之后成功。`emitBefore` 控制抛之前先吐几个事件——
 * 「已经吐过东西再重试」和「一上来就失败」是完全不同的两条路径
 */
function flaky(options: { failures: number; error: unknown; emitBefore?: LLMEvent[] }): {
  attempt: (signal: AbortSignal) => AsyncIterable<LLMEvent>
  calls: () => number
} {
  let calls = 0
  async function* attempt(): AsyncIterable<LLMEvent> {
    const attemptIndex = calls++
    if (attemptIndex < options.failures) {
      for (const llmEv of options.emitBefore ?? []) yield llmEv
      throw options.error
    }
    yield text('ok')
  }
  return { attempt, calls: () => calls }
}

const collect = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

describe('分类', () => {
  it('成功一次就不再试', async () => {
    const { attempt, calls } = flaky({ failures: 0, error: fatal })

    const out = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(calls()).toBe(1)
    expect(out).toEqual([text('ok')])
  })

  it('429 重试后成功', async () => {
    const { attempt, calls } = flaky({ failures: 2, error: rateLimited() })

    const out = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(calls()).toBe(3)
    expect(out).toEqual([text('ok')])
  })

  it('retryable: false 直接抛，一次都不重试', async () => {
    const { attempt, calls } = flaky({ failures: 1, error: fatal })

    await expect(
      collect(requestWithRetry(attempt, FAST, new AbortController().signal)),
    ).rejects.toThrow('bad request')
    expect(calls()).toBe(1)
  })

  it('context_overflow 不重试 —— 那要靠压缩', async () => {
    const overflow = new LLMStreamError({
      kind: 'context_overflow',
      message: 'too long',
      retryable: false,
    })
    const { attempt, calls } = flaky({ failures: 1, error: overflow })

    await expect(
      collect(requestWithRetry(attempt, FAST, new AbortController().signal)),
    ).rejects.toThrow('too long')
    expect(calls()).toBe(1)
  })

  it('非 LLMStreamError 当成可重试 —— fetch 的网络错误就是个裸 TypeError', async () => {
    const { attempt, calls } = flaky({ failures: 1, error: new TypeError('fetch failed') })

    const out = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(calls()).toBe(2)
    expect(out).toEqual([text('ok')])
  })

  it('**cause 链要跟着抛出来**——`fetch failed` 五个字本身不含任何信息', async () => {
    // undici 把真实原因塞在 cause 里，DNS 挂了和连接被重置抛出来长得一模一样。
    // 2026-09-03 排查一次稳定复现的 fetch failed，排掉网络和体积之后仍然只有
    // 这五个字，等于没线索
    const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
    const { attempt } = flaky({
      failures: 99,
      error: new TypeError('fetch failed', { cause: socket }),
    })

    await expect(
      collect(requestWithRetry(attempt, { ...FAST, maxAttempts: 2 }, new AbortController().signal)),
    ).rejects.toThrow('fetch failed（原因：other side closed [UND_ERR_SOCKET]）')
  })

  it('**对照：没有 cause 就一个字不加**，别给干净的错误加个空括号', async () => {
    const { attempt } = flaky({ failures: 99, error: new TypeError('fetch failed') })

    await expect(
      collect(requestWithRetry(attempt, { ...FAST, maxAttempts: 2 }, new AbortController().signal)),
    ).rejects.toThrow(/^fetch failed$/)
  })

  it('自引用的 cause 链不能把分类转死', async () => {
    // 防御，正常的 Error 不会这样。转死的话现象是「发完请求整个 loop 不动了」，
    // 不抛异常也没有输出——CLAUDE.md §6.4 那一类
    const loop = new Error('a')
    loop.cause = loop
    const { attempt } = flaky({
      failures: 99,
      error: new TypeError('fetch failed', { cause: loop }),
    })

    await expect(
      collect(requestWithRetry(attempt, { ...FAST, maxAttempts: 2 }, new AbortController().signal)),
    ).rejects.toThrow('fetch failed（原因：a ← a ← a ← a）')
  })

  it('用尽 maxAttempts 后抛出去', async () => {
    const { attempt, calls } = flaky({ failures: 99, error: rateLimited() })

    await expect(
      collect(requestWithRetry(attempt, { ...FAST, maxAttempts: 3 }, new AbortController().signal)),
    ).rejects.toThrow('429')
    expect(calls()).toBe(3)
  })
})

describe('restart', () => {
  it('已经吐过事件再重试时必须发 restart', async () => {
    // 不发的话：消费方把两次的 text_delta 拼在一起，历史里存下一条内容翻倍的
    // assistant 消息。不报错，只是内容错了
    const { attempt } = flaky({
      failures: 1,
      error: rateLimited(),
      emitBefore: [text('半截')],
    })

    const out = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(out).toEqual([text('半截'), { type: 'restart' }, text('ok')])
  })

  it('一个事件都没吐过就失败时不发 restart —— 没有半截可丢', async () => {
    const { attempt } = flaky({ failures: 1, error: rateLimited() })

    const out = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(out.some((ev) => ev.type === 'restart')).toBe(false)
  })

  it('每次重试各发一个 restart', async () => {
    const { attempt } = flaky({
      failures: 2,
      error: rateLimited(),
      emitBefore: [text('半截')],
    })

    const out = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(out.filter((ev) => ev.type === 'restart')).toHaveLength(2)
  })
})

describe('空响应', () => {
  const zeroUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningTokens: 0,
  }

  /** 只有元信息的「正常」流：message_start + finish，零内容——2026-10-09
   * 某项目实案（claude-opus 走 31.6s 返回零内容带终止标记）的形状 */
  const emptyAttempt = (): LLMEvent[] => [
    { type: 'message_start', usage: zeroUsage },
    { type: 'finish', reason: 'stop', usage: zeroUsage },
  ]

  it('零内容的正常收尾按可重试错误处理——先空一次再正常返回，应该重试成功', async () => {
    let calls = 0
    const attempt = async function* (): AsyncIterable<LLMEvent> {
      const i = calls++
      if (i === 0) {
        yield* emptyAttempt()
        return
      }
      yield text('ok')
    }
    const events = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))
    expect(calls).toBe(2)
    expect(events.some((ev) => ev.type === 'text_delta')).toBe(true)
  })

  it('始终零内容：用尽 maxAttempts 后抛出去（放弃后顶层 catch 变成 error 事件）', async () => {
    let calls = 0
    const attempt = async function* (): AsyncIterable<LLMEvent> {
      calls++
      yield* emptyAttempt()
    }
    await expect(
      collect(requestWithRetry(attempt, FAST, new AbortController().signal)),
    ).rejects.toThrow('没有返回任何内容')
    expect(calls).toBe(FAST.maxAttempts)
  })

  it('finish 带 refusal 不算空——拒答是内容，不能被重试', async () => {
    let calls = 0
    const attempt = async function* (): AsyncIterable<LLMEvent> {
      calls++
      yield { type: 'finish', reason: 'content-filter', usage: zeroUsage, refusal: { category: 'reasoning_extraction' } }
    }
    const events = await collect(requestWithRetry(attempt, FAST, new AbortController().signal))
    expect(calls).toBe(1)
    expect(events).toHaveLength(1)
  })
})

describe('退避', () => {
  it('Retry-After 优先于退避', async () => {
    const slow: RetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 400,
      backoffFactor: 2,
      maxDelayMs: 5_000,
    }

    // 对照组：不带 retryAfterMs 时确实会等满退避，证明这个配置真的会拖时间
    const control = flaky({ failures: 1, error: rateLimited() })
    const startControl = performance.now()
    await collect(requestWithRetry(control.attempt, slow, new AbortController().signal))
    expect(performance.now() - startControl).toBeGreaterThan(300)

    const hinted = flaky({ failures: 1, error: rateLimited({ retryAfterMs: 0 }) })
    const start = performance.now()
    await collect(requestWithRetry(hinted.attempt, slow, new AbortController().signal))
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('Retry-After 也受 maxDelayMs 限制 —— 服务端说等一小时不能真等', async () => {
    const { attempt } = flaky({
      failures: 1,
      error: rateLimited({ retryAfterMs: 3_600_000 }),
    })

    const start = performance.now()
    await collect(requestWithRetry(attempt, FAST, new AbortController().signal))

    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('中断', () => {
  it('中断落在退避等待里时立刻醒来，不等满', async () => {
    const controller = new AbortController()
    const { attempt, calls } = flaky({ failures: 99, error: rateLimited() })
    const slow: RetryConfig = {
      maxAttempts: 5,
      initialDelayMs: 30_000,
      backoffFactor: 2,
      maxDelayMs: 30_000,
    }

    const start = performance.now()
    const running = collect(requestWithRetry(attempt, slow, controller.signal))
    setTimeout(() => controller.abort(), 10)

    await expect(running).rejects.toThrow()
    expect(performance.now() - start).toBeLessThan(1_000)
    expect(calls()).toBe(1) // 醒来后不再发第二次请求
  })

  it('中断时抛的是中断本身，不被改写成可重试错误', async () => {
    // 错误消息故意不带 abort 字样。带了的话「抛中断」和「抛被改写的可重试错误」
    // 在断言上分不开——这个测试就会绿得毫无意义（变异检验抓到过一次）
    const controller = new AbortController()
    let calls = 0
    async function* attempt(): AsyncIterable<LLMEvent> {
      calls++
      controller.abort()
      throw new TypeError('fetch failed')
      // biome-ignore lint/correctness/noUnreachable: 让 TS 认出这是 AsyncGenerator
      yield text('never')
    }

    await expect(collect(requestWithRetry(attempt, FAST, controller.signal))).rejects.toBe(
      controller.signal.reason,
    )
    expect(calls).toBe(1) // 裸 TypeError 本来是可重试的，中断必须先于分类
  })
})

describe('重试要写运行日志（runlog 接线）', () => {
  it('每次重试和最终放弃各一行，成功不打扰', async () => {
    // 真写盘会碰 ~/.simple-code——spy 掉，只验证「调没调、带了什么」。
    // 落盘契约在 runlog.test.ts。
    const calls: Array<Record<string, unknown>> = []
    const mod = await import('../src/runlog.ts')
    const spy = vi.spyOn(mod, 'logRun').mockImplementation((ev) => calls.push(ev))
    try {
      // 两次 429 后成功 → 两次重试决策各一行（attempt 1、2）
      const a = flaky({ failures: 2, error: rateLimited() })
      await collect(
        requestWithRetry(a.attempt, FAST, new AbortController().signal, {
          model: 'm9',
          folder: '/tmp/目录A',
        }),
      )
      const retries = calls.filter((c) => c.ev === 'llm_retry')
      expect(retries.map((c) => c.attempt)).toEqual([1, 2])
      for (const r of retries) {
        expect(r).toMatchObject({
          model: 'm9',
          folder: '/tmp/目录A',
          waitMs: expect.any(Number),
          error: { kind: 'rate_limit', message: '429' },
        })
      }

      // 永远 429 到放弃 → giveup 一行，带最后一次 attempt 数
      calls.length = 0
      const b = flaky({ failures: 99, error: rateLimited() })
      await expect(
        collect(requestWithRetry(b.attempt, FAST, new AbortController().signal, { model: 'm9' })),
      ).rejects.toBeInstanceOf(LLMStreamError)
      expect(calls.filter((c) => c.ev === 'llm_retry_giveup')).toEqual([
        { ev: 'llm_retry_giveup', model: 'm9', attempt: FAST.maxAttempts, error: { kind: 'rate_limit', message: '429' } },
      ])

      // 一把过 → 重试相关零行
      calls.length = 0
      const c = flaky({ failures: 0, error: fatal })
      await collect(requestWithRetry(c.attempt, FAST, new AbortController().signal))
      expect(calls).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
