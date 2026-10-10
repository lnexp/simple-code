import { createInterface, type Interface } from 'node:readline'
import {
  type Effort,
  lastRegionLine,
  listModels,
  type Session,
  type SetTimer,
  watchIdle,
} from '@simple-code/core'
import type { ApprovalShared } from './run.ts'
import { bracketPaste, type PasteBox } from './paste.ts'
import { createRenderer, type Sink } from './render.ts'

export type ReplOptions = {
  session: Session
  sink: Sink
  input: NodeJS.ReadableStream
  /** 提示符写这里。跟 sink.err 分开：测试要能只看提示符 */
  output: NodeJS.WritableStream
  /** 换掉时钟，测试用——双击窗口不该靠 sleep 去测 */
  now?: () => number
  /**
   * 拿到 readline 实例，测试用。
   *
   * Ctrl-C 的监听挂在 readline 上而不是 stdin 上，测试没法靠往 stdin 里
   * emit('SIGINT') 触发它——那样发的是 PassThrough 的事件，readline 收不到，
   * 于是断言「REPL 还活着」永远成立，测了个寂寞
   */
  onReady?: (rl: Interface) => void
  /** 换掉定时器，测试用——空闲摘要不该靠真的等几秒去测 */
  setTimer?: SetTimer
  /** 审批协调（run.ts createApproval 的产物）。主 readline 建好后
   * attach 上去——审批问询复用它（once('line')），答复那行会在 iterator
   * 缓冲里滞留一份，取行前先 consumeStolen() 丢掉 */
  approvalShared?: ApprovalShared
}

/**
 * 空闲时连按两次 Ctrl-C 才退出，窗口 800ms。
 *
 * 为什么不做成「Ctrl-C 只打断、退出用 /exit」：**空闲时按 Ctrl-C 会毫无反应**，
 * 而那是终端里最反直觉的状态——用户会以为程序卡了，然后接着按第三下第四下。
 */
const DOUBLE_PRESS_MS = 800

const PROMPT = '> '

/** 裸文本也当退出命令（连 :wq 都收） */
const EXIT_WORDS = new Set(['/exit', '/quit', 'exit', 'quit', ':q'])

const EFFORTS = new Set<Effort>(['low', 'medium', 'high', 'xhigh', 'max'])

/** REPL 斜杠命令：/model（看/切模型）、/effort（看/切推理深度）、/reload
 * （重读 settings.json——loadConfig 只在建 session 时读一次）。返回
 * true = 已处理，主循环别把这条发给模型；'reload' = 要重启循环。
 * 元信息一律走 err 通道（render.ts
 * 的分工：stdout 是模型的话，stderr 是状态）。解析规则与 sc -m 一致：
 * provider/model 从第一个 / 断——模型名自己可含 /，provider 不会 */
async function handleSlash(session: Session, sink: Sink, text: string): Promise<boolean | 'reload'> {
  const [word, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')
  if (word === '/reload') {
    // 不在这里重建：interrupts/idle 的闭包都捕获着旧 session，重启整个
    // 循环（runInteractive 收到 'reload' 后 close+重建再进一次 runRepl）
    return 'reload'
  }
  if (word === '/context') {
    // 与 VS Code 上下文面板（get_regions → ctx-panel.tsx）同一数据源、同一
    // 口径：regions.jsonl 尾行是「实际发出去的那份」的分区实测
    const tail = lastRegionLine(session.root)
    if (!tail) {
      sink.err('还没有分区记录——跑完一轮对话才有（每轮请求落一行 regions.jsonl）\n')
      return true
    }
    const num = (k: string) => Number(tail[k] ?? 0) // 老行缺字段当 0
    const window_ = session.config.model.contextWindow
    const used =
      num('overhead') + num('cold') + num('warm') + num('hot') + num('stub') + num('floor') +
      num('live') + num('maxTokens')
    const pct = ((used / window_) * 100).toFixed(1)
    sink.err(
      `上下文 ${Math.round(used)}/${window_}（${pct}%）· 记录于 ${String(tail.at ?? '?')}\n` +
        `冷 ${num('cold')} · 温 ${num('warm')} · 热 ${num('hot')} · 已卸载 ${num('stub')} · 未卸载 ${num('live')} · 保底 ${num('floor')}（token）\n`,
    )
    return true
  }
  if (word === '/model') {
    if (arg === '') {
      const cfg = session.config
      const current = `${cfg.config.provider}/${cfg.config.model}`
      const lines = listModels(cfg.config).map((ref) => {
        const spec = cfg.config.providers[ref.provider]?.models[ref.model]
        const images = spec?.capabilities?.images ? ' 视觉' : ''
        const mark = `${ref.provider}/${ref.model}` === current ? ' ← 当前' : ''
        return `  ${ref.provider}/${ref.model}${images ? '  (' + images + ')' : ''}${mark}`
      })
      sink.err(`模型：/model provider/model\n${lines.join('\n')}\n`)
      return true
    }
    const slash = arg.indexOf('/')
    if (slash <= 0 || slash === arg.length - 1) {
      sink.err(`写法是 /model provider/model，收到：${arg}\n`)
      return true
    }
    try {
      session.setModel({ provider: arg.slice(0, slash), model: arg.slice(slash + 1) })
    } catch (err) {
      // setModel 自己保证：解析失败时状态没动，会话照旧可用
      sink.err(`切换失败：${err instanceof Error ? err.message : String(err)}\n`)
      return true
    }
    const cfg = session.config
    sink.err(`（模型已切换：${cfg.config.provider}/${cfg.config.model}，下一轮生效）\n`)
    return true
  }
  if (word === '/effort') {
    if (arg === '') {
      const { effort, overridden } = session.effortState()
      sink.err(`推理深度：${effort}${overridden ? '（本轮会话手动设的）' : '（配置默认）'}。/effort ${[...EFFORTS].join('|')}\n`)
      return true
    }
    if (!EFFORTS.has(arg as Effort)) {
      sink.err(`档位可选 ${[...EFFORTS].join('|')}，收到：${arg}\n`)
      return true
    }
    session.setEffort(arg as Effort)
    sink.err(`（推理深度已设为 ${arg}，下一轮生效）\n`)
    return true
  }
  return false
}

/**
 * 交互式循环。**读一条、跑一条、再读**，进程不退出。
 *
 * 跟一次性执行（runOnce）的区别不只是「多跑几轮」——session 的内存状态在这里
 * 连续演进，卸载、缓存命中、任务队列都只有在这条路径上才真正起作用。
 * §9.7 的空闲摘要由 core 的 watchIdle 驱动（session/idle.ts）：这里在提示符
 * 出来时 arm，VS Code 面板在一轮跑完时 arm，同一条线。
 *
 * 返回进程退出码。
 */
export async function runRepl(options: ReplOptions): Promise<number | 'reload'> {
  const { session, sink } = options
  // 括号粘贴：整段缓冲等回车（paste.ts 开头注释写了为什么必须拦在这层）。
  // 提示打在整段到达时——不回显全文，多行回显会把提示符搅乱，用户自己
  // 刚粘的内容心里有数
  const paste: PasteBox = {
    pending: null,
    onArrive: (_text, lines) => {
      sink.err(`（已收到 ${lines} 行粘贴，回车发送 / 输入文字追加发送 / Ctrl-C 丢弃）\n`)
    },
  }
  const source = bracketPaste(options.input, paste)
  // 只对真终端开 bracketed paste 模式（管道/测试不开，序列也写了没人发）。
  // 结束时关回去——不关的话终端留着这个模式，退出后粘贴行为变怪
  const tty = (options.input as { isTTY?: boolean }).isTTY === true
  if (tty) options.output.write('\x1b[?2004h')
  const rl = createInterface({
    input: source,
    output: options.output,
    prompt: PROMPT,
    // 历史上翻属于「全功能」那一档，但 readline 白送，不要白不要
    historySize: 100,
  })

  const interrupts = watchInterrupts(rl, session, sink, options.now ?? Date.now, paste)
  let failed = false
  /**
   * 读到 EOF 之后 readline 已经自己关了，再 prompt() 会抛 ERR_USE_AFTER_CLOSE。
   * **`for await` 的最后一次迭代和「流已结束」之间没有别的信号**——只能自己记
   */
  let closed = false
  let wantReload = false
  rl.once('close', () => {
    closed = true
  })

  const idle = watchIdle(session, options.setTimer)
  const prompt = () => {
    if (!closed) rl.prompt()
    idle.arm() // 提示符出来了、开始等输入，从这一刻算空闲
  }

  sink.err(banner(session.root))
  options.onReady?.(rl)
  options.approvalShared?.attach(rl)
  prompt()

  try {
    for await (const line of rl) {
      // 待发的粘贴优先：空回车=整段发送，非空=追加到粘贴段后面一起发
      // （「粘个日志再补一句"帮我看看"」是一个自然动作）。粘贴待发时
      // agent 不在跑，审批滞留行与它不共存，所以这条放在 consumeStolen 之前
      if (paste.pending !== null) {
        const text = line.trim() === '' ? paste.pending : `${paste.pending}\n${line.trim()}`
        paste.pending = null
        idle.disarm()
        interrupts.disarm()
        if (await runTurn(session, sink, text)) failed = true
        prompt()
        continue
      }
      // 审批吃剩的行（用户对 [y/n] 的答复）在这里被丢掉——见
      // ApprovalShared 的注释。空行检查之前
      if (options.approvalShared?.consumeStolen()) {
        prompt()
        continue
      }
      idle.disarm() // 敲了东西就不算空闲了
      const text = line.trim()
      // 空行不发请求。发的话模型收到一条空 user 消息，多半会反问「你想说什么」，
      // 白烧一轮
      if (text === '') {
        prompt()
        continue
      }
      if (EXIT_WORDS.has(text)) break
      const slash = await handleSlash(session, sink, text)
      if (slash === 'reload') {
        wantReload = true
        break
      }
      if (slash) {
        prompt()
        continue
      }

      interrupts.disarm() // 敲了东西，之前那次 Ctrl-C 不再算「连按」的第一下
      if (await runTurn(session, sink, text)) failed = true
      prompt()
    }
  } finally {
    // 定时器不清的话进程挂在事件循环上不退出——`/exit` 之后光标卡住几秒，
    // 看起来像死机（Node 的 timer 是 ref 的）
    idle.disarm()
    if (tty) options.output.write('\x1b[?2004l')
  }

  if (!closed) rl.close()
  if (wantReload) return 'reload'
  return failed ? 1 : 0
}

function watchInterrupts(
  rl: Interface,
  session: Session,
  sink: Sink,
  now: () => number,
  paste: PasteBox,
) {
  let armedAt = 0

  rl.on('SIGINT', () => {
    // 有待发粘贴时 Ctrl-C 只丢粘贴——连按退出那套语义会让「想丢粘贴」的
    // 用户意外退出整个 REPL
    if (paste.pending !== null) {
      paste.pending = null
      sink.err('（已丢弃粘贴）\n')
      rl.prompt()
      return
    }
    // 光标这时停在用户打了一半的输入后面，先换行，否则提示叠上去
    sink.err('\n')

    if (session.isRunning()) {
      session.interrupt('sigint')
      // 不重新 prompt：send 的循环还在跑，它结束后主循环自己会 prompt。
      // 这里再打一个的话，屏幕上会留下两个提示符
      sink.err('（已打断，正在收尾）\n')
      armedAt = 0
      return
    }

    if (now() - armedAt <= DOUBLE_PRESS_MS) {
      rl.close() // 结束 for await，主循环走正常退出路径
      return
    }
    armedAt = now()
    sink.err('（再按一次 Ctrl-C 退出，或用 /exit）\n')
    rl.prompt()
  })

  return {
    disarm: () => {
      armedAt = 0
    },
  }
}

async function runTurn(session: Session, sink: Sink, text: string): Promise<boolean> {
  const renderer = createRenderer(sink, {
    out: !!process.stdout.isTTY,
    err: !!process.stderr.isTTY,
  })
  let failed = false
  for await (const agentEv of session.send(text)) {
    if (agentEv.type === 'error') failed = true
    renderer.on(agentEv)
  }
  renderer.done()
  return failed
}

const banner = (root: string): string =>
  `sc · ${root}\n` +
    `直接输入开始对话。/exit 或 Ctrl-D 退出，Ctrl-C 打断当前这一轮。\n` +
    `/model 看清单换模型，/effort 换推理深度，/context 看上下文分区。\n\n`
