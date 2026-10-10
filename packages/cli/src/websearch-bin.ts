#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * websearch 的 CLI 形态（web-tools §10）。与 webfetch-bin 同款理由：
 * 工具版撤掉，模型经 bash 调用，结果可直接接管道（grep 站点、wc 计数）。
 *
 * 配置从 ~/.simple-code/websearch.json 读（对齐 mcp.json：凭据类配置单独
 * 文件）。bin 经 bash 白名单 env 运行，宿主变量不在里面，key 只能落明文
 * 进文件。文件不存在 = 匿名层；不整份 loadConfig（那会挡住没配置过的环境）。
 */
import { readFile } from 'node:fs/promises'
import { WEBSEARCH_CONFIG_PATH } from '@simple-code/core/src/config/load.ts'
import { expandEnv } from '@simple-code/core/src/config/env.ts'
import { createWebsearchTool, type WebsearchConfig } from '@simple-code/core/src/tools/websearch.ts'

/**
 * websearch.json 缺失/字段缺失 = 匿名层，静默（AGENTS.md「可选文件缺失
 * 是正常情况」）。文件存在但 JSON 坏了要抛——静默等于悄悄把计费路径
 * 从网关切回免费层
 */
async function websearchConfig(): Promise<WebsearchConfig> {
  let ws: WebsearchConfig
  try {
    ws = JSON.parse(await readFile(WEBSEARCH_CONFIG_PATH, 'utf8')) as WebsearchConfig
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    return {} // 文件不存在 = 匿名层，正常情况
  }
  const cfg = ws
  // ${ENV} 引用照 env.ts 规则展开；白名单 env 里没有宿主变量，展开不了
  // 让它抛（配置错误必须响），吞掉会静默降级回匿名层
  if (cfg.exaApiKey !== undefined) cfg.exaApiKey = expandEnv(cfg.exaApiKey)
  return cfg
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

if (process.exitCode === undefined) {
  const dir = process.cwd()
  const tool = createWebsearchTool(await websearchConfig())
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
