import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Interface } from 'node:readline'
import { PassThrough, Writable } from 'node:stream'
import { openStore } from '@simple-code/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { Sink } from '../src/render.ts'
import { runInteractive } from '../src/run.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const KEY = 'sk-SENTINEL-repl'

/** 一句话就结束的一轮。text 变化好断言是第几轮 */
const saysSSE = (text: string) =>
  [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}`,
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n')

/** 每次调用回一轮，按顺序推进。记下每次请求的 messages 条数，用来验历史在长 */
function replayRounds(texts: string[]) {
  let calls = 0
  const inputSizes: number[] = []
  const models: (string | undefined)[] = []
  // 最后一条 user 消息的文本：粘贴用例要验「整段进了同一条消息」
  const users: string[] = []
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: { role: string; content?: unknown }[]
      model?: string
    }
    inputSizes.push(body.messages?.length ?? 0)
    models.push(body.model)
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
    users.push(JSON.stringify(lastUser?.content ?? null))
    const text = texts[calls] ?? texts[texts.length - 1] ?? '好'
    calls += 1
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(saysSSE(text)))
          c.close()
        },
      }),
      { status: 200 },
    )
  }) as unknown as typeof fetch
  return { impl, calls: () => calls, inputSizes, models: () => models, users: () => users }
}

function collector() {
  let out = ''
  let err = ''
  const sink: Sink = { out: (s) => (out += s), err: (s) => (err += s) }
  return { sink, stdout: () => out, stderr: () => err }
}

const CONFIG = {
  provider: 'p',
  model: 'm',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.invalid',
      apiKey: '${TEST_KEY}',
      models: {
        m: { contextWindow: 100_000 },
        v: { contextWindow: 200_000, capabilities: { images: true } },
      },
    },
  },
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'sc-repl-'))
  dirs.push(dir)
  const globalPath = join(dir, 'settings.json')
  await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
  return { dir, globalPath }
}

/**
 * 轮询等到条件成立再返回，替代「睡固定毫秒再断言」。
 *
 * 后者在全量跑时会挂：几十个测试文件并行、bash 那组真开子进程，CPU 被挤占时
 * 20/40ms 不够 REPL 起来或请求发出——断言跑在前提成立之前。真实发生过：
 * 「空闲时按一次不退出」单跑永远绿、全量约一半概率挂。轮询把「等多久」从
 * 猜一个固定值变成「等到条件真成立」，超时上限兜底（说明前提本身没成立，
 * 而不是机器慢）。
 */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时：条件在期限内未成立')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/**
 * 同一份配置，但退避延迟改成 1ms。默认 2000ms × 指数退避 × 5 次，
 * 测试要等半分钟
 */
async function withFastRetry(globalPath: string): Promise<string> {
  const fast = globalPath.replace('.json', '.fast.json')
  await writeFile(
    fast,
    JSON.stringify({
      ...CONFIG,
      loop: { retry: { maxAttempts: 5, initialDelayMs: 1, backoffFactor: 1, maxDelayMs: 2 } },
    }),
    'utf8',
  )
  return fast
}

/** 丢弃提示符。readline 要一个可写的 output，但断言看 sink */
const sink0 = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })

/**
 * 喂几行输入然后关掉 stdin（= Ctrl-D）。
 *
 * **必须真的 end()**：不关的话 `for await (const line of rl)` 永远等下一行，
 * 测试挂到超时。这也正是 EOF 要处理的那条路径
 */
function lines(...items: string[]): NodeJS.ReadableStream {
  const stream = new PassThrough()
  for (const item of items) stream.write(`${item}\n`)
  stream.end()
  return stream
}

const repl = async (input: NodeJS.ReadableStream, texts: string[] = ['回答']) => {
  const { dir, globalPath } = await workspace()
  const fetchStub = replayRounds(texts)
  const c = collector()
  const code = await runInteractive({
    cwd: dir,
    sink: c.sink,
    globalPath,
    env: { TEST_KEY: KEY },
    fetchImpl: fetchStub.impl,
    input,
    output: sink0(),
  })
  return { code, dir, ...c, ...fetchStub }
}

describe('交互式循环', () => {
  it('/context：读 regions.jsonl 尾行，报水位与冷温热分区', async () => {
    const { dir, globalPath } = await workspace()
    await mkdir(join(dir, '.simple-code/memory'), { recursive: true })
    await writeFile(
      join(dir, '.simple-code/memory/regions.jsonl'),
      [
        JSON.stringify({ at: '2026-09-14T00:00:00Z', cold: 100, warm: 200, hot: 300 }),
        JSON.stringify({
          at: '2026-09-14T01:00:00Z',
          budget: 99000,
          overhead: 2000,
          cold: 0,
          warm: 0,
          hot: 4321,
          stub: 0,
          floor: 500,
          live: 12000,
          maxTokens: 8000,
        }),
      ].join('\n') + '\n',
      'utf8',
    )
    const c = collector()
    const code = await runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: replayRounds(['回答']).impl,
      input: lines('/context', '/exit'),
      output: sink0(),
    })
    expect(code).toBe(0)
    const err = c.stderr()
    // 用尾行不用首行：26821 = 2000+4321+500+12000+8000（CONFIG 测试模型窗口 100000）
    expect(err).toContain('上下文 26821/100000（26.8%）· 记录于 2026-09-14T01:00:00Z')
    expect(err).toContain('热 4321')
    expect(err).not.toContain('范围') // 范围行 2026-09-30 删除
  })

  it('连续两轮，两轮都发了请求', async () => {
    const { code, stdout, calls } = await repl(lines('第一个问题', '第二个问题'), [
      '第一轮回答',
      '第二轮回答',
    ])

    expect(calls()).toBe(2)
    expect(stdout()).toContain('第一轮回答')
    expect(stdout()).toContain('第二轮回答')
    expect(code).toBe(0)
  })

  it('第二轮的请求带着第一轮的历史', async () => {
    // REPL 的全部意义所在。不带历史的话，连续问和分两次跑没区别——
    // 而这不会报错，只是模型答非所问
    const { inputSizes } = await repl(lines('一', '二'), ['答一', '答二'])

    expect(inputSizes).toHaveLength(2)
    expect(inputSizes[0]).toBe(1) // 第一轮只有用户那条
    expect(inputSizes[1]).toBe(3) // 第二轮：user + assistant + user
  })

  it('空行不发请求', async () => {
    // 发的话模型收到空 user 消息，多半反问「你想说什么」，白烧一轮
    const { calls } = await repl(lines('', '   ', '真的问题'))

    expect(calls()).toBe(1)
  })

  it('EOF（Ctrl-D）正常退出，退出码 0', async () => {
    // 不处理 EOF 的话进程挂住等下一行，管道输入结束时看起来像死机
    const { code } = await repl(lines('问一句'))

    expect(code).toBe(0)
  })

  it.each(['/exit', '/quit', 'exit', 'quit', ':q'])('%s 退出，且不当成问题发出去', async (word) => {
    const { code, calls } = await repl(lines(word))

    expect(calls()).toBe(0) // 前提：确实一个请求都没发
    expect(code).toBe(0)
  })

  it('退出词后面的输入不再执行', async () => {
    // 对照组：没有这条的话，「识别了退出词但没 break」也能让上面全绿
    const { calls } = await repl(lines('第一个问题', '/exit', '不该跑的问题'))

    expect(calls()).toBe(1)
  })

  it('一轮 400 之后还能接着聊', async () => {
    // 一次性执行崩了就崩了；REPL 崩了用户丢的是整段会话的上下文
    const { dir, globalPath } = await workspace()
    let calls = 0
    const flaky = (async () => {
      calls += 1
      if (calls === 1) return new Response('{"error":{"message":"boom"}}', { status: 400 })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(saysSSE('第二轮成功')))
            c.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const c = collector()
    const code = await runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: flaky,
      input: lines('会失败的', '会成功的'),
      output: sink0(),
    })

    expect(calls).toBe(2) // 第一轮失败后确实还发了第二轮
    expect(c.stdout()).toContain('第二轮成功')
    expect(code).toBe(1) // 有失败就是非 0，但循环没断
  })

  it('第一轮把重试烧光也不死，第二轮照样能聊', async () => {
    // 跟上一条走的是不同路径：400 是协议层分类成不可重试直接报错，
    // 这里是 fetch **持续**抛异常直到 maxAttempts 用尽。两条都得测。
    //
    // 顺带记一笔：写这两条时我在 runTurn 外面加了个 try/catch 防「REPL 整个
    // 死掉」，变异检验显示把它改成重新抛出后两条都绿——因为 run.ts:97 的顶层
    // 兜底已经把异常转成 error 事件了，根本传不上来。那个 catch 已删
    const { dir, globalPath } = await workspace()
    let calls = 0
    const explosive = (async () => {
      calls += 1
      if (calls <= 5) throw new Error('网络炸了') // maxAttempts 默认 5
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(saysSSE('第二轮成功')))
            c.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const c = collector()
    const code = await runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath: await withFastRetry(globalPath),
      env: { TEST_KEY: KEY },
      fetchImpl: explosive,
      input: lines('会炸的', '会成功的'),
      output: sink0(),
    })

    expect(calls).toBeGreaterThan(5) // 前提：第一轮确实把重试烧光了
    expect(c.stdout()).toContain('第二轮成功') // 循环活着
    expect(code).toBe(1) // 有失败就非 0，但没中断
    void dir
  })

  it('每一轮的用量独立计数，不跨轮累加', async () => {
    // 页脚（与插件底栏同款）每轮一行、行内只报本轮的量——跨轮累加的话
    // ↑ 的数字会一路涨下去，越看越不知道在说什么
    const { stderr } = await repl(lines('一', '二'), ['答一', '答二'])

    const feet = [...stderr().matchAll(/首字 [\d.]+m?s · 总 [\d.]+m?s · ↑(\d+) ↓(\d+)/g)]
    expect(feet).toHaveLength(2)
    // 两轮的回复一样长，↑↓ 也该一样——第二轮比第一轮大就是跨轮累加了
    expect(feet[0]?.[1]).toBe(feet[1]?.[1])
    expect(feet[0]?.[2]).toBe(feet[1]?.[2])
  })

  it('起不来的时候不进循环，报配置错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-repl-'))
    dirs.push(dir)
    const c = collector()

    const code = await runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath: join(dir, '不存在.json'),
      env: {},
      input: lines('问题'),
      output: sink0(),
    })

    expect(code).toBe(2)
    expect(c.stderr()).toContain('还没有配置文件')
  })

  it('API key 不出现在任何输出里', async () => {
    const { stdout, stderr } = await repl(lines('问一句'))

    expect(stdout()).not.toContain(KEY)
    expect(stderr()).not.toContain(KEY)
  })
})

/**
 * Ctrl-C 在 REPL 里必须分级：**跑的时候打断当前轮，空闲的时候才谈退出**。
 *
 * 不分级的话，用户想停一条跑飞的 bash，结果把整个 REPL 关了——而在 REPL 里
 * 那意味着丢掉整段会话的上下文。所以打断要分级：Esc 打断、Ctrl-C 退出。
 */
describe('Ctrl-C', () => {
  /** 一个不会自己结束的输入流，好让 REPL 停在「等下一行」的状态 */
  const openStream = () => new PassThrough()

  /**
   * 起一个 REPL，返回它的 stdin、readline 实例和还在跑的 promise。
   *
   * **必须拿到 readline**：SIGINT 监听挂在它身上，往 stdin 上 emit 的话
   * readline 根本收不到，于是「REPL 还活着」的断言永远成立。踩过：两条
   * 测试因此假绿
   */
  async function liveRepl(texts: string[] = ['回答'], now?: () => number) {
    const { dir, globalPath } = await workspace()
    const input = openStream()
    const fetchStub = replayRounds(texts)
    const c = collector()
    let rl: Interface | undefined
    const done = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: fetchStub.impl,
      input,
      output: sink0(),
      onReady: (instance) => {
        rl = instance
      },
      ...(now ? { now } : {}),
    })
    // onReady 回调了才算起完（原来睡 20ms 赌它够用，全量被挤占时不成立）
    await waitFor(() => rl !== undefined)
    const ctrlC = () => rl?.emit('SIGINT')
    return { input, ctrlC, done, ...c, ...fetchStub }
  }

  it('跑的时候按 Ctrl-C 是打断这一轮，不是退出 REPL', async () => {
    // **分级设计的全部意义。** 变异检验发现的盲区：把 isRunning 分支改成
    // 恒 false（跑的时候也走退出流程），19 条测试全绿——说明这条路径
    // 一条覆盖都没有。而它正是「用户想停一条跑飞的 bash，结果整个 REPL
    // 关了」要防的那件事
    const { dir, globalPath } = await workspace()
    const input = openStream()
    const c = collector()
    let rl: Interface | undefined

    // 一个吐了半截就停住的流，好让 REPL 卡在「正在跑」的状态
    let release: (() => void) | undefined
    const slow = (async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(saysSSE('慢慢答').slice(0, 200)))
            release = () => ctrl.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const done = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: slow,
      input,
      output: sink0(),
      onReady: (instance) => {
        rl = instance
      },
    })
    await new Promise((r) => setTimeout(r, 20))

    input.write('问一个慢的\n')
    await waitFor(() => release !== undefined) // 前提：请求确实发出去了、流确实还开着

    rl?.emit('SIGINT')
    await waitFor(() => c.stderr().includes('已打断'))

    expect(c.stderr()).toContain('已打断')
    expect(c.stderr()).not.toContain('再按一次') // 不该走退出流程
    // 不用 release()：中断已经把流关掉了（再 close 会抛 "Controller is
    // already closed"）——这本身就是中断生效的旁证

    // REPL 还活着：EOF 才让它退出
    input.end()
    await done
  })

  it('空闲时按一次不退出，只提示', async () => {
    // 按一次就退出的话，手滑一下整段会话就没了
    const clock = { t: 1000 }
    const r = await liveRepl(['回答'], () => clock.t)

    r.ctrlC()
    await waitFor(() => r.stderr().includes('再按一次'))

    // 前提：REPL 确实还活着——没有这个断言，「退出了但恰好也打印了提示」
    // 也能让上面那行通过
    r.input.write('还能问\n')
    await waitFor(() => r.calls() >= 1)
    expect(r.calls()).toBe(1)

    r.input.end()
    await r.done
  })

  it('空闲时 800ms 内按两次才退出', async () => {
    const clock = { t: 1000 }
    const r = await liveRepl(['回答'], () => clock.t)

    r.ctrlC()
    clock.t += 100 // 窗口内
    r.ctrlC()

    expect(await r.done).toBe(0)
  })

  it('对照组：超过 800ms 再按不算连按', async () => {
    // 没有这条的话，「记住按过就退出」这种没有时间窗的实现也能让上面全绿
    const clock = { t: 1000 }
    const r = await liveRepl(['回答'], () => clock.t)

    r.ctrlC()
    clock.t += 900 // 超窗
    r.ctrlC()
    // 第二次提示也出来了，说明这次没被当成连按（连按会直接退出、没有第二次提示）
    await waitFor(() => (r.stderr().match(/再按一次/g) ?? []).length === 2)

    // 还活着：能接着问
    r.input.write('还能问\n')
    await waitFor(() => r.calls() >= 1)
    expect(r.calls()).toBe(1)

    r.input.end()
    await r.done
  })

  it('敲过东西之后，之前那次 Ctrl-C 不再算连按的第一下', async () => {
    // 不清的话：按一次 Ctrl-C → 改主意问了个问题 → 十分钟后再按一次 Ctrl-C
    // 就直接退出了，用户完全不知道为什么
    const clock = { t: 1000 }
    const r = await liveRepl(['回答'], () => clock.t)

    r.ctrlC()
    r.input.write('一个问题\n')
    await waitFor(() => r.calls() >= 1)

    r.ctrlC() // 时钟没动，不清的话这次会被当成连按
    await waitFor(() => r.stderr().includes('再按一次'))

    r.input.write('还能问\n')
    await waitFor(() => r.calls() >= 2)
    expect(r.calls()).toBe(2) // 两个问题都发出去了

    r.input.end()
    await r.done
  })
})

/**
 * 手动时钟。空闲摘要不该靠真的 sleep 去测——默认 delay 是 3 秒，
 * 而且「等了 3 秒还没触发」和「触发了但慢」在真时钟下分不出来。
 */
function manualTimer() {
  const pending: { ms: number; fn: () => void }[] = []
  const setTimer = (ms: number, fn: () => void) => {
    const entry = { ms, fn }
    pending.push(entry)
    return () => {
      const at = pending.indexOf(entry)
      if (at >= 0) pending.splice(at, 1)
    }
  }
  return {
    setTimer,
    armed: () => pending.length,
    /**
     * 触发当前排着的那个（只有一个）。until 给了就等到它成立再返回——
     * fire 之后是一串异步（摘要请求、写库、重新 arm），睡固定毫秒赌不完
     */
    fire: async (until?: () => boolean) => {
      const entry = pending.shift()
      entry?.fn()
      if (until) await waitFor(until)
    },
  }
}

describe('空闲摘要驱动', () => {
  /** 起一个 REPL，输入流由测试控制，定时器也是 */
  async function idleRepl(over: { fetchImpl?: typeof fetch } = {}) {
    const { dir, globalPath } = await workspace()
    await writeFile(
      globalPath,
      JSON.stringify({ ...CONFIG, memory: { idleSummarizeDelayMs: 5_000 } }),
      'utf8',
    )
    const input = new PassThrough()
    const fetchStub = replayRounds(['回答一', '回答二', '回答三'])
    const c = collector()
    const timer = manualTimer()
    const done = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: over.fetchImpl ?? fetchStub.impl,
      input,
      output: sink0(),
      setTimer: timer.setTimer,
    })
    await waitFor(() => c.stderr() !== '') // banner 出来了才算起完
    return { dir, input, done, timer, ...c, ...fetchStub }
  }

  /** 库里的摘要行 */
  const summariesOf = (dir: string) => {
    const store = openStore(dir)
    const rows = store.summaries()
    store.close()
    return rows
  }

  /** 发一行输入，等到这一轮的请求确实发出去（calls 涨了）再返回 */
  const send = async (repl: { input: PassThrough; calls: () => number }, text: string) => {
    const before = repl.calls()
    repl.input.write(`${text}\n`)
    await waitFor(() => repl.calls() > before)
  }

  it('**每轮跑完就摘，不用等空闲到点**', async () => {
    // 这条原来是反的（「没到点一条都不生成」），理由是「每轮结束就摘一次」
    // 会跟主对话抢速率限额。§9.7 修正二推翻了它：空闲驱动追不上积压。
    // 现在它是正向用例——全程不 fire 定时器，摘要照样出来
    const r = await idleRepl()
    await send(r, '第一个问题')
    await send(r, '第二个问题')

    await waitFor(() => summariesOf(r.dir).length > 0)
    r.input.end()
    await r.done
    expect(summariesOf(r.dir).length).toBeGreaterThan(0)
  })

  it('**用户敲字期间撤掉空闲定时器**', async () => {
    // 用户按了回车、这一轮正在跑的时候，那个空闲定时器必须已经作废——
    // 「空闲」的定义就是「跑完了、用户还没发下一条」，跑着的时候不叫空闲。
    //
    // **只断言定时器，不断言摘要**：§9.7 修正二之后跑的期间照样会摘
    // （step 跑完就触发），原来那句 `expect(summariesOf(dir)).toEqual([])`
    // 断的正是被推翻的那条规则。
    //
    // **不能断言 armed() 的条数**：arm() 自己开头就有 cancel?.()，所以条数
    // 恒为 1，撤不撤销都一样（变异检验实测存活）。要断言的是「这一轮跑的
    // 时候那个 handle 已经不在队列里了」——用一轮跑到一半才 resolve 的
    // fetch 卡住，此刻去 fire 应该什么都触发不了
    let release: (() => void) | undefined
    const slow = (async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('慢问题')) await new Promise<void>((r) => (release = r))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(saysSSE('回答')))
            c.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const r = await idleRepl({ fetchImpl: slow })
    // 这一问 slow 不卡，跑完回到等输入、排上空闲定时器——那是这轮结束的信号。
    // **不能用 send()**：它等 calls 涨，而这个用例的 fetch 是 slow 桩，
    // replayRounds 的计数器压根没接上，等不到
    r.input.write('第一个问题\n')
    await waitFor(() => r.timer.armed() === 1)

    r.input.write('慢问题\n')
    await waitFor(() => release !== undefined) // 前提：这一轮确实卡住了
    expect(r.timer.armed()).toBe(0) // 敲字时撤掉了，跑的期间没有排队的定时器

    release?.()
    r.input.end()
    await r.done
  })

  it('空闲这条线还接着：到点调 summarizeIdle，回来自己重排', async () => {
    // 空闲驱动在 §9.7 修正二之后降成兜底——step 跑完就摘，常态下空闲期
    // 已经没有债可还了。所以这条**不断言「多出一条摘要」**（那取决于有没有
    // 积压，不稳定），只断言这条线没断：到点了会去调、调完自己重排。
    //
    // 值得单独守着，是因为断了不报错：idle.ts 记的那次事故就是 watchIdle
    // 只在 CLI 接了线，扩展上线后没人记得，摘要一次都没跑过。
    // 「摘的内容对不对」由 core 的用例负责，这里只管接线
    const r = await idleRepl()
    await send(r, '第一个问题')
    await send(r, '第二个问题')

    await waitFor(() => r.timer.armed() === 1) // 前提：等输入时确实排了定时器
    await r.timer.fire(() => r.timer.armed() === 1) // 跑完回来又排上了

    r.input.end()
    await r.done
  })

  it('退出时清掉定时器', async () => {
    // 不清的话进程挂在事件循环上，`/exit` 之后光标卡住几秒像死机
    const r = await idleRepl()
    await send(r, '第一个问题')

    r.input.end()
    await r.done
    expect(r.timer.armed()).toBe(0)
  })

  it('idleSummarizeDelayMs 配 0 就完全不排定时器', async () => {
    // schema 允许 0（nonnegative）。不挡的话会排一个 0ms 的定时器，
    // 退化成「每轮结束都摘一次」
    const { dir, globalPath } = await workspace()
    await writeFile(
      globalPath,
      JSON.stringify({ ...CONFIG, memory: { idleSummarizeDelayMs: 0 } }),
      'utf8',
    )
    const input = new PassThrough()
    const fetchStub = replayRounds(['回答'])
    const c = collector()
    const timer = manualTimer()
    const done = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: fetchStub.impl,
      input,
      output: sink0(),
      setTimer: timer.setTimer,
    })
    await waitFor(() => c.stderr() !== '') // banner 出来了才算起完
    await send({ input, calls: fetchStub.calls }, '一个问题')

    expect(timer.armed()).toBe(0)
    input.end()
    await done
  })
})

// ── 审批（approval.md §4.3）：问终端 + 答复行不泄漏进模型 ─────────

/** 一轮 tool_use(bash) + 一轮收尾文本。审批允许后 bash 真执行 */
const sseToolUseThenText = (): string[] => {
  const toolUse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"bash","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\": \\"echo sc-approval-marker > /tmp/sc-cli-approval.txt\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n')
  return [toolUse, saysSSE('审批链路走完')]
}

describe('审批答复解析（createApproval）', () => {
  it('`n 一句话` → { deny: 一句话 }；裸 n → deny；y/a 不吃后文', async () => {
    const { createApproval } = await import('../src/run.ts')
    const { EventEmitter } = await import('node:events')
    // 假 readline：once/off 挂上后由测试主动 emit('line') 驱动答复
    const makeRl = () => {
      const ee = new EventEmitter()
      return ee as unknown as import('node:readline').Interface
    }
    type AskQ = Parameters<ReturnType<typeof createApproval>['requestApproval']>[0]
    const ask = async (q: AskQ, line: string) => {
      const shared = createApproval({ err: () => {}, info: () => {} } as never)
      const rl = makeRl()
      shared.attach(rl)
      const p = shared.requestApproval(q)
      ;(rl as unknown as { emit: (e: string, v: string) => void }).emit('line', line)
      return p
    }
    const q = {
      command: 'curl https://x',
      toolCallId: 't1',
      category: 'network_cmd' as const,
      detail: 'curl',
      reason: '网络命令',
    }
    expect(await ask(q, 'n 别用 curl，用 webfetch')).toEqual({ deny: '别用 curl，用 webfetch' })
    expect(await ask(q, 'N')).toBe('deny')
    expect(await ask(q, 'n')).toBe('deny')
    expect(await ask(q, 'y 随便你打多少')).toBe('allow')
  })

  it('stolen 是计数器：一轮 N 次审批就丢 N 行（Documents 连锁案）', async () => {
    // 案发：一轮里连续两次审批都答 y，布尔 stolen 只盖最后一次，
    // 轮后主循环只丢一行——漏出的第二个 y 变成新 turn「继续干」，
    // 又触发审批……连锁成「一直在回答停不下来」
    const { createApproval } = await import('../src/run.ts')
    const { EventEmitter } = await import('node:events')
    const rl = new EventEmitter() as unknown as import('node:readline').Interface
    const shared = createApproval({ err: () => {}, info: () => {} } as never)
    shared.attach(rl)
    const q = {
      command: 'curl a', toolCallId: 't', category: 'network_cmd' as const,
      detail: 'curl', reason: '网络命令',
    }
    const p1 = shared.requestApproval(q)
    ;(rl as unknown as { emit: (e: string, v: string) => void }).emit('line', 'y')
    const p2 = shared.requestApproval(q)
    ;(rl as unknown as { emit: (e: string, v: string) => void }).emit('line', 'y')
    expect(await p1).toBe('allow')
    expect(await p2).toBe('allow')
    // 两行滞留，都得丢得掉；丢干净后返回 false
    expect(shared.consumeStolen()).toBe(true)
    expect(shared.consumeStolen()).toBe(true)
    expect(shared.consumeStolen()).toBe(false)
  })
})

describe('REPL 审批', () => {
  it('ask 级命令问终端，y 放行执行，且 y 不被当成下一条命令发出去', async () => {
    const { dir, globalPath } = await workspace()
    const rounds = sseToolUseThenText()
    let calls = 0
    const bodies: string[] = []
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls += 1
      if (init?.body) bodies.push(String(init.body))
      const text = rounds[Math.min(calls - 1, rounds.length - 1)]
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text))
            c.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const input = new PassThrough()
    const { sink, stderr } = collector()
    const code = runInteractive({
      cwd: dir,
      sink,
      globalPath,
      fetchImpl: impl,
      input,
      output: new PassThrough(),
      env: { TEST_KEY: KEY },
    })
    // REPL 等第一条用户输入才会发请求（模型回 tool_use 触发审批）
    input.write('帮我把标记写到临时文件\n')
    await waitFor(() => stderr().includes('[需要审批·'))
    expect(stderr()).toContain('项目外路径') // 类别标签 + 判定理由展示给用户
    input.write('y\n')
    await waitFor(() => calls >= 2)
    // y 放行后命令真执行了
    const { readFileSync } = await import('node:fs')
    waitFor(() => {
      try {
        return readFileSync('/tmp/sc-cli-approval.txt', 'utf8').includes('sc-approval-marker')
      } catch {
        return false
      }
    })
    // 收尾：退出 REPL（等第二轮文本到再退，避免打断审批后的执行）
    await waitFor(() => stderr().includes('审批链路走完') || bodies.length >= 2)
    input.write('/exit\n')
    expect(await code).toBe(0)
    // 关键断言：第二轮请求体里没有把 'y' 当 user 消息发出去
    const round2 = bodies[1] ?? ''
    expect(round2).not.toMatch(/"role":"user"[^}]*"y"/)
  })

  it('非交互（runOnce）：ask 级命令自动拒绝，不执行', async () => {
    const { dir, globalPath } = await workspace()
    const { readFile } = await import('node:fs/promises')
    const { runOnce } = await import('../src/run.ts')
    const rounds = sseToolUseThenText()
    let calls = 0
    const impl = (async () => {
      const text = rounds[Math.min(calls++, rounds.length - 1)]
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text))
            c.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const { sink, stderr } = collector()
    const code = await runOnce({
      cwd: dir,
      sink,
      globalPath,
      fetchImpl: impl,
      prompt: '跑一条要审批的命令',
      env: { TEST_KEY: KEY },
    })
    expect(code).toBe(0)
    expect(stderr()).toContain('[需要审批·非交互模式自动拒绝]')
    await expect(readFile('/tmp/sc-cli-approval-once.txt', 'utf8')).rejects.toThrow()
  })

  it('非交互 + approveAll（测评容器）：ask 级命令放行并真执行', async () => {
    const { dir, globalPath } = await workspace()
    const { mkdtemp, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { runOnce } = await import('../src/run.ts')
    // 项目外路径 → external_dir 卡；默认会被拒（上一条用例）
    const outside = await mkdtemp(join(tmpdir(), 'sc-approve-all-'))
    const marker = join(outside, 'marker.txt')
    const rounds = sseToolUseThenText().map((r) => r.replace('/tmp/sc-cli-approval.txt', marker))
    let calls = 0
    const impl = (async () => {
      const text = rounds[Math.min(calls++, rounds.length - 1)]
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text))
            c.close()
          },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch
    const { sink, stderr } = collector()
    try {
      const code = await runOnce({
        cwd: dir,
        sink,
        globalPath,
        fetchImpl: impl,
        prompt: '跑一条要审批的命令',
        env: { TEST_KEY: KEY },
        approveAll: true,
      })
      expect(code).toBe(0)
      expect(stderr()).not.toContain('自动拒绝')
      expect(await readFile(marker, 'utf8')).toContain('sc-approval-marker')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('斜杠命令 /model /effort', () => {
  it('/model 空参：清单进 stderr、标当前，不发请求', async () => {
    const { stderr, calls } = await repl(lines('/model'))
    expect(calls()).toBe(0)
    expect(stderr()).toContain('p/m ← 当前')
    expect(stderr()).toContain('p/v')
    expect(stderr()).toContain('视觉')
  })
  it('/model p/v 切换，下一轮请求真的发到新模型', async () => {
    const { stderr, calls, models } = await repl(lines('/model p/v', '问题'))
    expect(stderr()).toContain('已切换：p/v')
    expect(calls()).toBe(1)
    expect(models()[0]).toBe('v')
  })
  it('/model 名字写错：报错、会话照旧（下一轮还能发）', async () => {
    const { stderr, calls } = await repl(lines('/model p/nope', '继续问题'))
    expect(stderr()).toContain('切换失败')
    expect(calls()).toBe(1)
  })
  it('/model 写法不带斜杠：提示写法，不当普通消息发', async () => {
    const { stderr, calls } = await repl(lines('/model nope'))
    expect(stderr()).toContain('写法是 /model provider/model')
    expect(calls()).toBe(0)
  })
  it('/effort 看档位、设档位、拒绝非法值', async () => {
    const { stderr, calls } = await repl(lines('/effort', '/effort high', '/effort bogus'))
    expect(stderr()).toContain('推理深度：high（配置默认）') // request 默认 high（load.ts:281）
    expect(stderr()).toContain('已设为 high')
    expect(stderr()).toContain('档位可选')
    expect(calls()).toBe(0)
  })
  it('/mod 不是命令：当普通消息发给模型', async () => {
    const { calls } = await repl(lines('/mod p/v'))
    expect(calls()).toBe(1)
  })
  it('/reload：settings.json 改了模型，重载后下一轮发到新模型', async () => {
    const { dir, globalPath } = await workspace()
    const fetchStub = replayRounds(['第一轮', '第二轮'])
    const c = collector()
    // reload 会重启 REPL 循环（第二次 runRepl 复用同一 input 流）——
    // PassThrough 不能提前 end()（EOF 后第二次 readline 永远等不到行），
    // 也不能一次性写完（第一问跑完前 /reload 还没被读）。按阶段喂
    const cfgV = { ...CONFIG, model: 'v' }
    const stream = new PassThrough()
    stream.write('第一问\n')
    const driver = (async () => {
      await waitFor(() => fetchStub.calls() >= 1)
      await writeFile(globalPath, JSON.stringify(cfgV), 'utf8') // 第一轮已用旧配置（m）发出
      stream.write('/reload\n')
      await waitFor(() => c.stderr().includes('配置已重载'))
      stream.write('第二问\n')
      await waitFor(() => fetchStub.calls() >= 2)
      stream.write('/exit\n')
    })()
    const code = await runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: fetchStub.impl,
      input: stream,
      output: sink0(),
    })
    await driver
    expect(code).toBe(0)
    expect(c.stderr()).toContain('配置已重载，当前模型：p/v')
    // 第一轮旧配置（m），重载后第二轮发到 v
    expect(fetchStub.models()[0]).toBe('m')
    expect(fetchStub.models()[1]).toBe('v')
  })
})


const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
/** onReady 要等 session 建立 + readline 建好——一拍不够 */
const ticks = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await tick()
}

describe('括号粘贴（bracketed paste）', () => {
  const pasteInput = (): PassThrough & { pushRaw(s: string): void } => {
    const s = new PassThrough()
    return Object.assign(s, { pushRaw: (t: string) => s.write(t) })
  }

  it('整段粘贴 + 回车 → 一次请求、一条 user 消息（多行原文进上下文）', async () => {
    // 2026-09-22 Documents 实测的形态：崩溃报告 8 行粘进 REPL，逐行变 8 个 turn。
    // 修后：整段缓冲、回车发送——模型看到的是完整多行文本
    const input = pasteInput()
    const { impl, inputSizes, users } = replayRounds(['看到了'])
    const { dir, globalPath } = await workspace()
    const c = collector()
    // 不先 await：REPL 起来后在等输入，先拿 promise 再喂
    const code = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: impl,
      input,
      output: sink0(),
    })
    await ticks()
    input.pushRaw('\x1b[200~Command:  org.eclipse\nPath: /Users/x\nOS Version: macOS\x1b[201~')
    await tick()
    input.pushRaw('\n') // 粘贴后回车 = 发送
    input.end()
    const r = await code
    expect(r).toBe(0)
    expect(inputSizes).toHaveLength(1) // 只发了一次请求，不是三行三次
    expect(users()[0]).toContain('Command:  org.eclipse\\nPath: /Users/x')
  })

  it('粘贴 + 追加一行 → 合并成一条发送', async () => {
    const input = pasteInput()
    const { impl, inputSizes, users } = replayRounds(['好'])
    const { dir, globalPath } = await workspace()
    const c = collector()
    const code = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: impl,
      input,
      output: sink0(),
    })
    await ticks()
    input.pushRaw('\x1b[200~line1\nline2\x1b[201~')
    await tick()
    input.pushRaw('帮我看看这个\\n') // 非空行 = 追加
    input.end()
    const r = await code
    expect(r).toBe(0)
    expect(inputSizes).toHaveLength(1)
    expect(users()[0]).toContain('line1\\nline2\\n帮我看看这个')
  })

  it('粘贴后 Ctrl-C 丢弃 → 不发请求，后续提问正常', async () => {
    const input = pasteInput()
    let rl: Interface | null = null
    const { impl, inputSizes, users } = replayRounds(['答'])
    const { dir, globalPath } = await workspace()
    const c = collector()
    const code = runInteractive({
      cwd: dir,
      sink: c.sink,
      globalPath,
      env: { TEST_KEY: KEY },
      fetchImpl: impl,
      input,
      output: sink0(),
      onReady: (r) => {
        rl = r
      },
    })
    await waitFor(() => rl !== null)
    input.pushRaw('\x1b[200~要丢的内容\x1b[201~')
    await tick()
    ;(rl as unknown as Interface).emit('SIGINT') // 丢粘贴，不是退出
    await tick()
    input.pushRaw('正常提问\\n')
    input.end()
    const r = await code
    expect(r).toBe(0) // Ctrl-C 没把 REPL 弄退出
    expect(inputSizes).toHaveLength(1)
    expect(users()[0]).toContain('正常提问')
  })
})
