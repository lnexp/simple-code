#!/usr/bin/env node
/**
 * "$SIMPLE_CODE_LSP" <definition|refs|symbols|hover|calls-in|calls-out> <file>[:行[:列]]
 *
 * LSP 查询薄壳：把参数 POST 给 VS Code 宿主起的本机桥（lsp-bridge.ts），
 * 打印宿主格式化好的结果。真语言服务只在宿主里，这里零依赖。
 *
 * 退出码：0 查询完成（含「无结果」——那是有效答案）；2 无桥（非 VS Code
 * 宿主环境 / 宿主已关闭）——模型看到该回落 grep；3 参数错。
 */
import { resolve } from 'node:path'

export type ParsedArgs =
  | { ok: true; cmd: string; file: string; line: number; col: number; colGiven: boolean }
  | { ok: false; error: string }

export function parseLspArgs(argv: string[]): ParsedArgs {
  const [cmd, fileArg] = argv
  if (!cmd || !fileArg) {
    return { ok: false, error: '用法：<definition|refs|symbols|hover|calls-in|calls-out> <file>[:行[:列]]，如 refs src/run.ts:120:5' }
  }
  const parts = fileArg.split(':')
  // 上面判过 fileArg 非空，split 必有首段
  const file = resolve(parts[0] ?? fileArg)
  // symbols 只要文件；其余必须有行号（列缺省 1）
  const line = parts[1] ? Number(parts[1]) : cmd === 'symbols' ? 1 : NaN
  const col = parts[2] ? Number(parts[2]) : 1
  if (!Number.isFinite(line) || line < 1) {
    return { ok: false, error: cmd === 'symbols' ? `行号不合法：${String(parts[1] ?? '')}` : `${cmd} 需要位置：${fileArg}（file:行[:列]）` }
  }
  return { ok: true, cmd, file, line, col, colGiven: parts[2] !== undefined && parts[2] !== '' }
}

export async function lspMain(argv: string[]): Promise<number> {
  const parsed = parseLspArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`)
    return 3
  }
  const port = process.env.SIMPLE_CODE_LSP_PORT
  if (!port) {
    process.stderr.write('无 LSP 桥：不在 VS Code 宿主环境（或宿主已关闭）。回落 grep 吧。\n')
    return 2
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.ok ? { cmd: parsed.cmd, file: parsed.file, line: parsed.line, col: parsed.col } : {}),
      signal: AbortSignal.timeout(8000),
    })
    const body = (await res.json()) as { ok: boolean; text?: string; error?: string }
    if (!body.ok) {
      process.stderr.write(`桥报错：${body.error}\n`)
      return 1
    }
    // 缺列落在第 1 列（缩进/修饰符）→ 无结果，读起来像「真没引用」（历史实例：
    // refs store.ts:620 无结果、:620:11 命中）。只 bin 知道列是不是缺省的
    const colHint =
      parsed.cmd !== 'symbols' && !parsed.colGiven && body.text?.startsWith('无结果')
        ? '\n（未给列号，按第 1 列查的——列须落在符号名上，如 refs a.ts:620:11）'
        : ''
    process.stdout.write(`${body.text}${colHint}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`LSP 桥不可达：${error instanceof Error ? error.message : String(error)}（宿主关闭或端口失效）。回落 grep 吧。\n`)
    return 2
  }
}

// 直接执行时（bin 形态）跑 main；被 import（测试）时不跑
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  lspMain(process.argv.slice(2)).then((code) => process.exit(code))
}
