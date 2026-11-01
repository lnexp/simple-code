#!/usr/bin/env node
/**
 * "$SIMPLE_CODE_TASK" "<任务书>"  或  "$SIMPLE_CODE_TASK" <<'MD' … MD（stdin）
 * "$SIMPLE_CODE_TASK" --model <名> <<'MD' … MD   指定模型（规则 14，只认 taskModels 里的）
 * "$SIMPLE_CODE_TASK" --models                    列出可选模型与用途
 *
 * 派一个并行任务（task-trunk 规则 11）：把任务书 POST 给 VS Code 宿主的本机桥
 * （vscode task-bridge.ts），由宿主的 tasks 中心建任务、进任务条、在宿主里跑
 * ——和用户点「+ 任务」是同一个函数。这里不建任务，立即返回任务名，不等跑完；
 * 派出那一轮结束时结果以〔任务结果〕消息回到派它的会话（规则 12）。
 *
 * 退出码：0 已派出；1 宿主拒绝（如该目录没有面板）；2 无桥（不在 VS Code
 * 宿主里 / 宿主已关闭）；3 参数错（任务书为空、--model 后没写名字）。
 */
import {
  TASK_PORT_ENV,
  TASK_TOKEN_ENV,
  TASK_TOKEN_HEADER,
  type TaskDispatchResponse,
  type TaskModelsResponse,
} from '@simple-code/core/src/session/task-endpoint.ts'

/** 派它的会话所在目录：bash 注入的 SIMPLE_CODE_ROOTS 首项（会话 root）；
 *  缺了退回 cwd（bash 的 cwd 固定是 root，除非命令里 cd 过） */
export function rootOf(env: NodeJS.ProcessEnv, cwd: string): string {
  try {
    const roots = JSON.parse(env.SIMPLE_CODE_ROOTS ?? '') as unknown
    if (Array.isArray(roots) && typeof roots[0] === 'string') return roots[0]
  } catch {
    // 缺或坏：退回 cwd
  }
  return cwd
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const USAGE =
  `用法："$SIMPLE_CODE_TASK" [--model <名>] "<任务书>"，或 "$SIMPLE_CODE_TASK" [--model <名>] <<'MD' … MD。` +
  `任务书首行当任务名；"$SIMPLE_CODE_TASK" --models 列出可选模型\n`

/** 拆出 --model <名> / --models，剩下的是任务书参数。null = --model 后没跟名字 */
export function parseArgs(argv: string[]): { model?: string; list: boolean; rest: string[] } | null {
  const rest: string[] = []
  let model: string | undefined
  let list = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '--models') list = true
    else if (a === '--model') {
      model = argv[++i]
      if (model === undefined || model === '') return null
    } else rest.push(a)
  }
  return { ...(model !== undefined ? { model } : {}), list, rest }
}

/** POST 给桥。失败（连不上/超时/坏 JSON）返回错误文案 */
async function call<T>(port: string, token: string, path: string, body: unknown): Promise<T | string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TASK_TOKEN_HEADER]: token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    return (await res.json()) as T
  } catch (error) {
    return `任务桥不可达：${error instanceof Error ? error.message : String(error)}（宿主关闭或端口失效）\n`
  }
}

/** --models 的输出：一行一个，名字照 --model 能认的写 */
function formatModels(r: Extract<TaskModelsResponse, { ok: true }>): string {
  const head = `不写 --model = 配置默认 ${r.defaultModel}。`
  if (r.models.length === 0) return `${head}没配 taskModels，派任务只能用默认。\n`
  const lines = r.models.map(
    (t) => `- ${t.provider}/${t.model}${t.effort ? `（effort ${t.effort}）` : ''}：${t.use}`,
  )
  return `${head}可选（--model 写 model 或 provider/model）：\n${lines.join('\n')}\n`
}

/** --models：问桥要 root 所在目录的 taskModels。退出码同派任务 */
async function listModels(port: string, token: string, root: string): Promise<number> {
  const r = await call<TaskModelsResponse>(port, token, '/models', { root })
  if (typeof r === 'string') {
    process.stderr.write(r)
    return 2
  }
  if (!r.ok) {
    process.stderr.write(`取模型列表失败：${r.error}\n`)
    return 1
  }
  process.stdout.write(formatModels(r))
  return 0
}

export async function taskMain(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdin: () => Promise<string> = readStdin,
): Promise<number> {
  const args = parseArgs(argv)
  if (args === null) {
    process.stderr.write(`--model 后要写模型名。${USAGE}`)
    return 3
  }
  const brief = args.list ? '' : (args.rest.length > 0 ? args.rest.join(' ') : await stdin()).trim()
  if (!args.list && brief === '') {
    process.stderr.write(USAGE)
    return 3
  }
  const port = env[TASK_PORT_ENV]
  const token = env[TASK_TOKEN_ENV]
  if (!port || !token) {
    process.stderr.write(
      '无任务桥：不在 VS Code 宿主里（终端 sc 没有任务条）。要并行就自己跑完，或用 "$SIMPLE_CODE_SC"。\n',
    )
    return 2
  }
  const root = rootOf(env, process.cwd())
  if (args.list) return listModels(port, token, root)
  const body = await call<TaskDispatchResponse>(port, token, '/dispatch', {
    brief,
    root,
    owner: env.SIMPLE_CODE_OWNER ?? '',
    ...(args.model !== undefined ? { model: args.model } : {}),
  })
  if (typeof body === 'string') {
    process.stderr.write(body)
    return 2
  }
  if (!body.ok) {
    process.stderr.write(`派任务失败：${body.error}\n`)
    return 1
  }
  process.stdout.write(
    `已派出任务「${body.name}」。它在任务条里独立跑，派出那一轮结束时结果以〔任务结果〕消息回到这里。\n`,
  )
  return 0
}

// 直接执行时（bin 形态）跑 main；被 import（测试）时不跑
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  taskMain(process.argv.slice(2)).then((code) => process.exit(code))
}
