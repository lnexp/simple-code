import { access } from 'node:fs/promises'
import type { Interface } from 'node:readline'
import { constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Effort, ModelRef, SessionOptions } from '@simple-code/core'
import { GLOBAL_CONFIG_PATH, ensureShims, getSession, type ShimEntry } from '@simple-code/core'
import { createRenderer, type Sink } from './render.ts'
import { type ReplOptions, runRepl } from './repl.ts'

/**
 * CLI 宿主自注入工具路径。这批变量本来由 VS Code 扩展 activate() 注入
 * （extension.ts），终端裸跑 CLI 时没有宿主——不补的话 system prompt 里
 * 承诺的 `"$SIMPLE_CODE_WEBFETCH" <url>` 等工具全是空变量，模型一调
 * 就是空命令。bin 与本文件同目录（dist），存在才设、不覆盖已有注入。
 *
 * 指向 shim 而不是脚本本体（core shims.ts 头注释）：node 用跑着 sc 的
 * 这个（process.execPath——能跑 sc 就能跑兄弟 bin，不用探测），PATH 里
 * 没有 node 的机器上全部工具照用。binDir 参数只给测试换目录。
 */
export async function injectLocalTools(
  dir = dirname(fileURLToPath(import.meta.url)),
  binDir?: string,
): Promise<void> {
  const kebab = (name: string) => name.toLowerCase().replaceAll('_', '-')
  const entries: ShimEntry[] = []
  for (const name of ['WEBFETCH', 'WEBSEARCH', 'MCP', 'APPLY_PATCH', 'MEMORY', 'LESSON', 'NOTE', 'EVENT', 'SKILL', 'SC']) {
    const key = `SIMPLE_CODE_${name}`
    if (process.env[key]) continue
    const script = join(dir, `${name === 'SC' ? 'sc' : kebab(name)}.js`)
    try {
      await access(script, fsConstants.X_OK)
    } catch {
      // 该 bin 没构建（如裁剪版 dist）——跳过，prompt 层自会看到变量缺失
      continue
    }
    entries.push({ name, bin: name === 'SC' ? 'sc' : `sc-${kebab(name)}`, script })
  }
  if (entries.length > 0) {
    try {
      const shims = await ensureShims(entries, binDir === undefined ? { nodeBin: process.execPath } : { nodeBin: process.execPath, binDir })
      for (const { name } of entries) process.env[`SIMPLE_CODE_${name}`] = shims[name]
    } catch {
      // shim 写不进——回落直指脚本（shebang 找系统 node）
      for (const { name, script } of entries) process.env[`SIMPLE_CODE_${name}`] = script
    }
  }
  // 教程（self.md）：agent 在任何目录下查自己怎么运作。不是可执行
  // bin，不走上面的循环（那找 .js 查 X_OK）；拷贝由 build.mjs 同步
  const selfDoc = join(dir, 'self.md')
  await access(selfDoc, fsConstants.R_OK)
    .then(() => {
      process.env.SIMPLE_CODE_DOC = selfDoc
    })
    .catch(() => {})
}

/** 开一个 session 要的东西。两种运行方式共用，`start` 只认这些 */
export type StartOptions = {
  cwd: string
  sink: Sink
  /** 换掉全局配置路径，测试用 */
  globalPath?: string
  env?: NodeJS.ProcessEnv
  /** 换掉 fetch，测试用。协议层和重试仍然真跑 */
  fetchImpl?: typeof fetch
}

export type RunOptions = StartOptions & {
  prompt: string
  /** Ctrl-C。abort 之后 loop 收尾并退出，不是硬杀进程 */
  signal?: AbortSignal
  /** sc -m：start 成功后 setModel（下一次 send 生效，one-shot 正好赶上） */
  model?: ModelRef
  /** sc -e：同上 */
  effort?: Effort
}

// ── 审批问询（approval.md §4.3）────────────────────────────────

/**
 * REPL 与主 readline 抢 stdin 的协调状态。审批实例（临时的
 * createInterface）读走 y 的**同一瞬间**，主 readline 也收到同一行并
 * 滞留在它的 iterator 缓冲里——runTurn 结束后主循环会把这行 'y' 当
 * 用户命令发出去。解法是显式的：审批问完 stolen 计数 +1，主循环取行
 * 前先 consumeStolen() 消费计数丢行。不搞 pause/恢复那种隐式时序，
 * 这能被测试。
 *
 * **必须是计数器不是布尔**：一轮 agent 里连续多次审批（连发危险命令）
 * 时，N 次审批滞留 N 行——布尔只盖最后一次，轮后只丢一行，漏出的
 * 'y' 变成新 turn「继续干」→ 又触发审批 → 用户再批 → 再漏……连锁成
 * 「一直在回答停不下来」（Documents 实测，turn 7/8/9 全是漏出的 y）
 */
export type ApprovalShared = {
  requestApproval: NonNullable<SessionOptions['requestApproval']>
  /** REPL 主循环用：取到行之前先调，true = 这行是审批吃剩的，丢弃 */
  consumeStolen: () => boolean
  /** REPL 建好主 readline 后接上。审批问询复用它，不另开实例 */
  attach: (rl: Interface) => void
}

export const createApproval = (sink: Sink): ApprovalShared => {
  let stolen = 0
  let rl: Interface | null = null
  return {
    attach(r) {
      rl = r
    },
    requestApproval: (q) =>
      new Promise((resolve) => {
        if (!rl) return resolve('deny') // 没接上就拒绝：宁可拦住
        const alwaysHint = q.always
          ? q.always.kind === 'lead'
            ? `[a]始终允许（${q.always.lead} * 今后免审）`
            : q.always.kind === 'nonpath'
              ? `[a]始终允许（${q.always.lead} 的第 ${q.always.from} 位参数起不是路径，今后免审）`
              : q.always.kind === 'paths'
                ? `[a]始终允许（这 ${q.always.dirs.length} 个目录今后免审）`
                : `[a]始终允许（${q.always.dir}/ 今后免审）`
          : ''
        sink.err(
          `\n[需要审批·${APPROVAL_LABEL[q.category] ?? q.category}] ${q.reason}\n  ${q.command}\n` +
            `[y]允许 ${alwaysHint} / [n]拒绝（n 后可跟一句话带给 agent，如 n 用webfetch）：`,
        )
        const onLine = (line: string) => {
          cleanup()
          stolen += 1
          const c = line.trim().toLowerCase()
          if (c.startsWith('a') && q.always) return resolve('always')
          if (c.startsWith('y')) return resolve('allow')
          // `n 别用 curl`：拒绝并把后面的话带给 agent。首词判定后取
          // 原串余文，不是 toLowerCase 后的——反馈保留用户原文大小写
          const rest = line.trim().replace(/^[nN]\s*/, '')
          resolve(rest ? { deny: rest } : 'deny')
        }
        const onClose = () => {
          cleanup()
          resolve('deny')
        }
        const cleanup = () => {
          rl?.off('line', onLine)
          rl?.off('close', onClose)
        }
        rl.once('line', onLine)
        rl.once('close', onClose)
      }),
    consumeStolen: () => {
      if (stolen <= 0) return false
      stolen -= 1
      return true
    },
  }
}

/** 审批类别的中文标签。与 webview 的 APPROVAL_TAG 同源（approval.md §4.2） */
const APPROVAL_LABEL: Record<string, string> = {
  external_dir: '项目外路径',
  hidden_path: '隐藏路径',
  network_cmd: '网络命令',
  unparseable: '无法静态判定',
  multi: '多重触发',
}

/** one-shot（非交互）：stdin 已被管道占用，问了也读不到——EOF/无应答
 * 一律按拒绝。宁可拦住让用户换交互模式，不静默放行 */
const askNonInteractive =
  (sink: Sink): NonNullable<SessionOptions['requestApproval']> =>
  (q) => {
    sink.err(`\n[需要审批·非交互模式自动拒绝] ${q.reason}\n  ${q.command}\n`)
    return Promise.resolve('deny')
  }

/** 0 = 正常跑完，1 = loop 里出错，2 = 压根没起来（配置错、目录被占） */
export async function runOnce(options: RunOptions): Promise<number> {
  const session = await start(options, askNonInteractive(options.sink))
  if (typeof session === 'number') return session
  if (options.model) session.setModel(options.model)
  if (options.effort) session.setEffort(options.effort)

  options.signal?.addEventListener('abort', () => session.interrupt(), { once: true })

  // 一次性模式也着色：stdout 是管道时自动无色（makePaint 的约定），
  // stderr 若仍是终端则元信息有色
  const renderer = createRenderer(options.sink, {
    out: !!process.stdout.isTTY,
    err: !!process.stderr.isTTY,
  })
  let failed = false
  try {
    for await (const agentEv of session.send(options.prompt)) {
      if (agentEv.type === 'error') failed = true
      renderer.on(agentEv)
    }
  } finally {
    renderer.done()
    // 不放 finally 的话，中途抛异常就漏了文件锁，下次打开同一目录会说"被占用"
    await session.close()
  }
  return failed ? 1 : 0
}

export type InteractiveOptions = StartOptions & {
  /** 换掉 stdin/stdout，测试用。默认接进程自己的 */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  now?: () => number
  /** 拿到 readline 实例，测试用。理由见 repl.ts 的 ReplOptions */
  onReady?: ReplOptions['onReady']
  /** 换掉空闲定时器，测试用 */
  setTimer?: ReplOptions['setTimer']
}

/**
 * 交互式：一个 session 连续跑多轮，进程不退出。
 *
 * 跟 runOnce 共用 `start`（配置错误的解释一字不差），区别只在中间那段——
 * 一次性执行是 send 一次就 close，这里是循环。
 */
export async function runInteractive(options: InteractiveOptions): Promise<number> {
  const approval = createApproval(options.sink)
  let session = await start(options, approval.requestApproval)
  if (typeof session === 'number') return session

  try {
    for (;;) {
      const r = await runRepl({
      session,
      sink: options.sink,
      approvalShared: approval,
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
      ...(options.now ? { now: options.now } : {}),
      ...(options.onReady ? { onReady: options.onReady } : {}),
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      })
      if (r !== 'reload') return r
      // /reload：close 释放锁，重建重读 settings。循环内建的闭包
      // （interrupts/idle/readline）随 runRepl 重跑全部换新
      await session.close()
      const next = await start(options, approval.requestApproval)
      if (typeof next === 'number') return next // 配置被改坏：解释已打过，退出
      session = next
      options.sink.err(`（配置已重载，当前模型：${session.config.config.provider}/${session.config.config.model}）\n`)
    }
  } finally {
    // 跟 runOnce 一样收在 finally。REPL 崩了没释放锁的话，下次打开同一目录
    // 会说"被占用"，而用户完全不知道是上一次崩溃留下的
    await session.close()
  }
}

/** 起不来时把原因写清楚再返回退出码——这里的错几乎都是用户能自己修的 */
async function start(
  options: StartOptions,
  askApproval: NonNullable<SessionOptions['requestApproval']>,
) {
  try {
    const session = await getSession(options.cwd, {
      ...(options.globalPath ? { globalPath: options.globalPath } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      // CLI 的审批是问终端（approval.md §4.3）——v1 恒开。REPL 与
      // one-shot 两种问法都在外面建好传进来：REPL 版要跟主 readline
      // 抢 stdin（见 approvalState 的注释），不能在这里写死
      requestApproval: askApproval,
    })
    for (const warning of session.config.warnings) options.sink.err(`警告：${warning}\n`)
    return session
  } catch (error) {
    options.sink.err(await explain(error, options.globalPath ?? GLOBAL_CONFIG_PATH))
    return 2
  }
}

/**
 * 配置根本不存在，和配置写错了，是两种完全不同的处境。
 *
 * 不区分的话，第一次用的人看到的是一串「provider: expected string, received
 * undefined」——那说的是缺什么，没说文件该放哪、照着谁抄。
 */
async function explain(error: unknown, globalPath: string): Promise<string> {
  try {
    await access(globalPath)
  } catch {
    return (
      `还没有配置文件：${globalPath}\n` +
      `照着仓库里的 packages/cli/settings.example.json 建一份。\n` +
      `apiKey 写成 \${环境变量名} 的形式，别把 key 写进文件。\n`
    )
  }
  return `启动失败：${error instanceof Error ? error.message : String(error)}\n`
}
