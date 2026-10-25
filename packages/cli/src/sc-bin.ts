#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// sc —— 唯一入口（simple-code 这个名字已退役）：
//   无参数 + stdin 是终端 → 人用的 REPL（反复对话，审批到终端问答）
//   其余（带参数 / stdin 是管道）→ 一次性，审批恒拒绝（无人放卡），
//     参数面向调用方（父 agent / 脚本 / 管道），退出码语义化，
//     -q 时 stdout 只有最终文本。形态与权限定案见
//     .simple-code/notes/sc-a-form-and-subagent-dissolved.md
// 判定依据是 stdin 形态而不是「谁在调」：管道那头没有问答的能力，
// 恒拒绝是唯一安全默认；人在终端不带参数，自然进对话
import { isAbsolute, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { type Effort, type ModelRef, loadConfig } from '@simple-code/core'
import { runInteractive } from './run.ts'
import { runOnce } from './run.ts'

export const SC_USAGE = `用法：sc            交互式对话（连续多轮，/exit 退出，审批到终端问答）
      sc [选项] [任务文本]   跑一轮就退出——审批恒拒绝（无人放卡），适合脚本/管道

  -m provider/model      选模型（--models 看清单；provider 名不含 /，从第一个 / 断开）
  -e low|medium|high|xhigh|max   推理深度
  -q                     安静：stdout 只输出最终回复，过程信息走 stderr
  -t 秒                  超时，到点收尾退出（码 1）
  --root DIR             工作根 = 审批边界 + 记忆库（默认当前目录；
                         目录被占会报错——那是另一个会话在用）
                         被 agent 调起（SIMPLE_CODE_ROOTS 存在）时须
                         落在父审批范围内，越界拒绝启动（退出 2）
  --models               列可用模型（TSV：provider/model<TAB>窗口<TAB>视觉），退出
  -h, --help             这段话

配置读 ~/.simple-code/settings.json，字段缺失直接报错——不猜默认模型。
环境变量 SIMPLE_CODE_APPROVE_ALL=1：一次性模式审批一律放行（只在隔离的
测评容器里用；被 agent 调起时拒绝启动，退出 2）。
stdin 不是终端时读入全部内容：给了任务文本 → 作为附加上下文前置；
没给 → stdin 整体就是任务（heredoc 任务书）。

退出码：0 成功 / 1 失败或超时 / 2 用法或配置错误 / 130 Ctrl-C`

export type ScParsed = {
  prompt?: string | undefined
  model?: ModelRef
  effort?: Effort
  quiet: boolean
  timeoutSec?: number
  root?: string
  listModelsFlag: boolean
  help: boolean
}

/** 纯解析，不碰 IO。export 给测试 */
export function parseScArgs(argv: string[]): { ok: true; value: ScParsed } | { ok: false; message: string } {
  const p: ScParsed = { quiet: false, listModelsFlag: false, help: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '-m':
      case '--model': {
        const v = argv[++i]
        if (!v) return { ok: false, message: '-m 需要值：provider/model（--models 看清单）' }
        const slash = v.indexOf('/')
        // provider 名不含 /（load.ts ModelRef 注释），模型名可以含——所以
        // 只从第一个 / 断，右边整段都是模型名
        if (slash <= 0 || slash === v.length - 1)
          return { ok: false, message: `模型写法是 provider/model，收到：${v}` }
        p.model = { provider: v.slice(0, slash), model: v.slice(slash + 1) }
        break
      }
      case '-e':
      case '--effort': {
        const v = argv[++i]
        const efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
        if (v === undefined || !efforts.includes(v as Effort))
          return { ok: false, message: `-e 可选 low|medium|high|xhigh|max，收到：${v ?? '(空)'}` }
        p.effort = v as Effort
        break
      }
      case '-q':
      case '--quiet':
        p.quiet = true
        break
      case '-t':
      case '--timeout': {
        const v = argv[++i]
        if (!/^\d+$/.test(v ?? '') || Number(v) <= 0)
          return { ok: false, message: `-t 需要正整数秒，收到：${v ?? '(空)'}` }
        p.timeoutSec = Number(v)
        break
      }
      case '--root': {
        const v = argv[++i]
        if (!v) return { ok: false, message: '--root 需要目录路径' }
        p.root = v
        break
      }
      case '--models':
        p.listModelsFlag = true
        break
      case '-h':
      case '--help':
        p.help = true
        break
      default:
        if (a.startsWith('-') && a !== '-')
          return { ok: false, message: `不认识的参数：${a}（-h 看用法）` }
        positional.push(a)
    }
  }
  p.prompt = positional.length ? positional.join(' ') : undefined
  return { ok: true, value: p }
}

export type ScIo = {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: (s: string) => void
  stderr: (s: string) => void
  cwd: string
  /** 覆盖全局配置路径（loadConfig），测试用 */
  globalPath?: string
  /** 展开 settings 里 ${ENV} 引用用的环境，默认 process.env */
  env?: NodeJS.ProcessEnv
  /** 换掉 fetch，测试回放 SSE 用（与 run.test.ts 同通道） */
  fetchImpl?: typeof fetch
  signal: AbortSignal
  /** 中断来源标记由调用方维护（SIGINT→130 / 超时→1），这里只透传 signal */
}

/** stdin 读到 EOF。sc 的约定：非 tty 才读 */
function readAll(stdin: ScIo['stdin']): Promise<string> {
  return new Promise((res) => {
    let buf = ''
    stdin.setEncoding('utf8')
    stdin.on('data', (c: string) => { buf += c })
    stdin.on('end', () => res(buf))
    stdin.on('error', () => res(buf))
  })
}

/** 可测入口：返回退出码，不 process.exit */
/** 子 agent 权限上限（t6100「逐级只减不增」）。父层（扩展或另一个 sc）
 * 起子进程时把自己的审批范围写进 SIMPLE_CODE_ROOTS（JSON 路径数组，
 * bash.ts spawn 处注入），子 sc 启动时校验 --root 必须落在其中某条
 * 前缀之下。返回 null = 放行（含「无变量=人直接用」）；string = 拒绝
 * 原因（exit 2 用）。环境父进程可改——威胁模型是误操作可见化（放行
 * 命令=放行进程树的拍板），不是恶意对抗 */
export function assertRootAllowed(root: string, envRoots: string | undefined): string | null {
  if (!envRoots) return null
  let roots: unknown
  try {
    roots = JSON.parse(envRoots)
  } catch {
    return `SIMPLE_CODE_ROOTS 不是合法 JSON（应为路径数组），拒绝启动：${envRoots.slice(0, 200)}`
  }
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string')) {
    return `SIMPLE_CODE_ROOTS 应为字符串数组，拒绝启动：${envRoots.slice(0, 200)}`
  }
  const list = roots as string[]
  const hit = list.some((r) => {
    const base = r.endsWith('/') ? r.slice(0, -1) : r
    return root === base || root.startsWith(`${base}/`)
  })
  if (hit) return null
  return `--root ${root} 超出父 agent 审批范围（${list.join('、')}），拒绝启动——子 agent 权限逐级只减不增`
}

export async function scMain(argv: string[], io: ScIo): Promise<number> {
  const parsed = parseScArgs(argv)
  if (!parsed.ok) {
    io.stderr(`${parsed.message}\n${SC_USAGE}\n`)
    return 2
  }
  const p = parsed.value
  if (p.help) {
    io.stdout(`${SC_USAGE}\n`)
    return 0
  }
  if (p.listModelsFlag) {
    // 只读配置列清单，不建 session 不拿锁。loadConfig 报错（无配置/
    // 配置坏）走 runOnce 同一套 explain 太绕，这里直接给一行人话
    try {
      const loaded = await loadConfig(io.cwd, {
        ...(io.globalPath ? { globalPath: io.globalPath } : {}),
        ...(io.env ? { env: io.env } : {}),
      })
      const rows: string[] = []
      for (const provider of Object.keys(loaded.config.providers)) {
        const spec = loaded.config.providers[provider]!
        for (const [model, m] of Object.entries(spec.models)) {
          rows.push(
            `${provider}/${model}\t${m.contextWindow}\t${m.capabilities?.images ? 'yes' : 'no'}`,
          )
        }
      }
      io.stdout(`${rows.join('\n')}\n`)
      return 0
    } catch (err) {
      io.stderr(
        `--models 读配置失败：${err instanceof Error ? err.message : String(err)}\n` +
          `（列清单也要能展开配置里的 \${ENV} 引用——终端裸用时先 export 对应变量）\n`,
      )
      return 2
    }
  }

  // 权限上限校验（在 help/models 之后：那两个不干活，不用拦）。两处
  // 分支共用的 root 在这里一次算清
  const rootAbs = p.root ? (isAbsolute(p.root) ? p.root : resolve(io.cwd, p.root)) : io.cwd
  const denied = assertRootAllowed(rootAbs, io.env?.SIMPLE_CODE_ROOTS ?? process.env.SIMPLE_CODE_ROOTS)
  if (denied) {
    io.stderr(`${denied}\n`)
    return 2
  }
  // 审批全放行（测评容器，2026-10-24 用户批准）。父 agent 调起时（ROOTS
  // 在）拒绝：否则 agent 一条 `SIMPLE_CODE_APPROVE_ALL=1 sc "..."` 就绕过
  // 自己的审批，违背「逐级只减不增」
  const approveAll = (io.env?.SIMPLE_CODE_APPROVE_ALL ?? process.env.SIMPLE_CODE_APPROVE_ALL) === '1'
  if (approveAll && (io.env?.SIMPLE_CODE_ROOTS ?? process.env.SIMPLE_CODE_ROOTS)) {
    io.stderr('SIMPLE_CODE_APPROVE_ALL 不能在 agent 调起的 sc 里用（子 agent 权限只减不增），拒绝启动\n')
    return 2
  }

  // 无参数 + 真终端 → REPL（人）。放在 stdin 读取之前：REPL 要自己接管
  // stdin（readline），先读掉就没了
  if (!p.prompt && io.stdin.isTTY) {
    return runInteractive({
      cwd: rootAbs,
      sink: { out: io.stdout, err: io.stderr },
      input: io.stdin,
      // readline 要 Writable；ScIo 的 stdout 是函数（进程版包了 process.stdout.write）
      output: new Writable({ write(ch, _enc, cb) { io.stdout(String(ch)); cb() } }),
      ...(io.globalPath ? { globalPath: io.globalPath } : {}),
      ...(io.env ? { env: io.env } : {}),
      ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    })
  }

  // stdin 附加/任务书
  let prompt = p.prompt
  if (!io.stdin.isTTY) {
    const text = await readAll(io.stdin)
    if (text) prompt = prompt ? `附加上下文：\n${text}\n\n任务：${prompt}` : text
  }
  if (!prompt?.trim()) {
    io.stderr(`没给任务：位置参数或 stdin（非 tty 时）至少一个。\n${SC_USAGE}\n`)
    return 2
  }

  // -q：out 全缓冲，跑完一次性给——管道那头拿到的是纯最终文本
  let buf = ''
  const out = p.quiet ? (s: string) => { buf += s } : io.stdout
  const sink = { out, err: io.stderr }

  const code = await runOnce({
    prompt,
    cwd: rootAbs,
    sink,
    signal: io.signal,
    ...(io.globalPath ? { globalPath: io.globalPath } : {}),
    ...(io.env ? { env: io.env } : {}),
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.effort ? { effort: p.effort } : {}),
    ...(approveAll ? { approveAll } : {}),
  })
  if (p.quiet && buf) io.stdout(buf)
  return code
}

// ── 真入口 ───────────────────────────────────────────────
// basename 匹配而不是 endsWith('.js')：经 ~/.simple-code/bin/sc 这类
// symlink 执行时 argv[1] 是链接路径，不带扩展名——endsWith('sc.js')
// 会漏判，整个文件静默空跑（真发生过，见 build.test.ts 的真机对照）
const argv1base = process.argv[1]?.split('/').pop()
if (argv1base === 'sc' || argv1base === 'sc.js' || argv1base === 'sc-bin.ts') {
  // sc 的子进程同样承诺这批工具（run.ts injectLocalTools）
  const { ensureCredentialProxy, injectLocalTools } = await import('./run.ts')
  await injectLocalTools()
  await ensureCredentialProxy()
  const controller = new AbortController()
  let interrupted = false
  let timedOut = false
  process.on('SIGINT', () => {
    interrupted = true
    controller.abort()
  })
  const args = process.argv.slice(2)
  const t = parseScArgs(args)
  const timer =
    t.ok && t.value.timeoutSec
      ? setTimeout(() => {
          timedOut = true
          process.stderr.write(`\n（${t.value.timeoutSec}s 超时，正在收尾）\n`)
          controller.abort()
        }, t.value.timeoutSec * 1000)
      : undefined
  // 配置层（provider 不存在、模型缺字段等）抛的是普通 Error，冒泡到顶层
  // 会被 node 打成一坨堆栈——对着终端的人只需要那句话。退出码沿用 2：
  // 与 --models 读配置失败、参数错误同类
  let code: number
  try {
    code = await scMain(args, {
      stdin: process.stdin,
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
      cwd: process.cwd(),
      signal: controller.signal,
    })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    code = 2
  }
  clearTimeout(timer)
  // 130 = 用户中断；超时归 1（失败类）。runOnce 对中断可能返回 0（正常
  // 收尾），这里用标志改写
  process.exitCode = interrupted ? 130 : timedOut ? 1 : code
}
