#!/usr/bin/env node
/**
 * "$SIMPLE_CODE_TASK_SEND"                    列任务（名字、状态、最近一句）
 * "$SIMPLE_CODE_TASK_SEND" <任务名> <文本>    给任务发消息
 *
 * 任务互发（docs/loop-interrupt.md §4，实现项 2）：按名寻址、单向、非实时——
 * 对方跑着 = 插话（排队进上下文），停着 = 唤醒（点火新 turn）。不检查父子
 * 关系，任意两任务可互发；不带参数 = 列任务（agent 的任务视野：拿不准先列
 * 再发）。与用户在任务条输入是同一个函数，审批类别天然 allow。
 *
 * 退出码：0 成功；1 宿主拒绝（任务不存在 / 该宿主不支持）；2 无桥（不在
 * VS Code 宿主里 / 宿主已关闭）；3 参数错（没写文本）。
 */
import {
  TASK_PORT_ENV,
  TASK_TOKEN_ENV,
  TASK_TOKEN_HEADER,
  type TaskSendListResponse,
  type TaskSendResponse,
} from '@simple-code/core/src/session/task-endpoint.ts'

const USAGE =
  `用法："$SIMPLE_CODE_TASK_SEND" 列出任务；"$SIMPLE_CODE_TASK_SEND" <任务名> <文本> 发消息。\n` +
  `消息身份是〔task-send〕（非人类输入）。跑着=插话，停着=唤醒\n`

async function call<T>(path: string, body: unknown): Promise<T | string> {
  const port = process.env[TASK_PORT_ENV]
  const token = process.env[TASK_TOKEN_ENV]
  if (port === undefined || token === undefined)
    return `无任务桥：不在 VS Code 宿主里（或宿主已关闭）\n`
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

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  let roots: unknown = []
  try {
    roots = JSON.parse(process.env.SIMPLE_CODE_ROOTS ?? '[]')
  } catch {
    // 缺或坏：用 cwd（bash 的 cwd 固定是 root）
  }
  const root = Array.isArray(roots) && typeof roots[0] === 'string' ? roots[0] : process.cwd()
  if (args.length === 0) {
    const res = await call<TaskSendListResponse>('/send-list', { root })
    if (typeof res === 'string') {
      process.stdout.write(res)
      return 2
    }
    if (!res.ok) {
      process.stdout.write(`${res.error}\n`)
      return 1
    }
    if (res.tasks.length === 0) process.stdout.write('当前没有任务\n')
    for (const t of res.tasks) {
      const line = t.lastLine === '' ? '' : `｜${t.lastLine}`
      process.stdout.write(`${t.status.padEnd(9)} ${t.name}${line}\n`)
    }
    return 0
  }
  const task = args[0] ?? ''
  const text = args.slice(1).join(' ')
  if (text.trim() === '') {
    process.stdout.write(USAGE)
    return 3
  }
  const res = await call<TaskSendResponse>('/send', { root, task, text: `〔task-send〕${text}` })
  if (typeof res === 'string') {
    process.stdout.write(res)
    return 2
  }
  if (!res.ok) {
    process.stdout.write(`${res.error}\n`)
    return 1
  }
  process.stdout.write(`已发给「${task}」（跑着=插话排队，停着=唤醒开新轮）\n`)
  return 0
}

process.exit(await main())
