#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * websearch 的 CLI 形态（web-tools §10）。与 webfetch-bin 同款理由：
 * 工具版撤掉，模型经 bash 调用，结果可直接接管道（grep 站点、wc 计数）。
 *
 * 配置在 ~/.simple-code/websearch.json（对齐 mcp.json：凭据类配置单独文件）。
 * 有宿主凭据代理（VS Code 里）→ 一律经代理 POST /websearch，代理在宿主进程
 * 读文件、展开 `${EXA_API_KEY}`、拼 key，bin 碰不到 key（2026-10-23 迁移）。
 * 没有代理（不在 SC 里，如用户在 shell 直接敲）→ 照旧自己读文件直连：`${VAR}`
 * 按当前环境展开，缺了报错（配置错必须响，不静默降级匿名层）。终端 sc 会自起
 * 代理（run.ts ensureCredentialProxy），走上一条。
 * 文件不存在 = 匿名层；不整份 loadConfig（那会挡住没配置过的环境）。
 */
import { WEBSEARCH_CONFIG_PATH } from '@simple-code/core/src/config/load.ts'
import { PROXY_PORT_ENV, PROXY_TOKEN_ENV, PROXY_TOKEN_HEADER } from '@simple-code/core/src/proxy/endpoint.ts'
import { WEBSEARCH_ROUTE } from '@simple-code/core/src/proxy/websearch-route.ts'
import { createWebsearchTool, readWebsearchConfig, type WebsearchConfig } from '@simple-code/core/src/tools/websearch.ts'

/** 配置错（坏 JSON、`${VAR}` 没设）返回一行文案而不是抛——顶层 await 抛出去
 * node 会打整段堆栈，用户在终端直接敲时看到的是源码行和 \u 转义 */
async function websearchConfig(): Promise<WebsearchConfig | string> {
  const port = process.env[PROXY_PORT_ENV]
  const token = process.env[PROXY_TOKEN_ENV]
  if (port && token) return { url: `http://127.0.0.1:${port}${WEBSEARCH_ROUTE}`, headers: { [PROXY_TOKEN_HEADER]: token } }
  try {
    return await readWebsearchConfig(WEBSEARCH_CONFIG_PATH)
  } catch (e) {
    return `websearch 配置错误（~/.simple-code/websearch.json）：${e instanceof Error ? e.message : String(e)}`
  }
}

const USAGE = `用法：websearch <query> [--num N]
搜索网页，带摘要的结果列表（markdown）写 stdout。--num 结果数，默认 5，上限 10。`

const argv = process.argv.slice(2)
let query = ''
let numResults: number | undefined
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === undefined) break // noUncheckedIndexedAccess 的收口
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`)
    process.exitCode = 0
  } else if (arg === '--num') numResults = Number(argv[++i])
  else query = arg
}
if (process.exitCode === undefined && query === '') {
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 2
}

const config = process.exitCode === undefined ? await websearchConfig() : undefined
if (typeof config === 'string') {
  process.stderr.write(`${config}\n`)
  process.exitCode = 2
} else if (config !== undefined) {
  const dir = process.cwd()
  const tool = createWebsearchTool(config)
  const out = await tool.execute(
    { query, ...(numResults ? { numResults } : {}) },
    { root: dir, signal: AbortSignal.timeout(30_000) },
  )
  if (out.isError) {
    process.stderr.write(`${out.output}\n`)
    process.exitCode = out.exitCode !== 0 ? out.exitCode : 1
  } else {
    process.stdout.write(`${out.output}\n`)
    process.exitCode = 0
  }
}
