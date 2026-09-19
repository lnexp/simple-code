#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * websearch 的 CLI 形态（web-tools §10）。与 webfetch-bin 同款理由：
 * 工具版撤掉，模型经 bash 调用，结果可直接接管道（grep 站点、wc 计数）。
 *
 * exaApiKey 从全局 settings.json 读——工具版走 session config 是历史；
 * bin 是独立进程，全局配置是它唯一的常识来源。只读 websearch 段，不整份
 * loadConfig（那要求完整 model/provider，会挡住没配置过的环境）。
 */
import { readFile } from 'node:fs/promises'
import { GLOBAL_CONFIG_PATH } from '@simple-code/core/src/config/load.ts'
import { createWebsearchTool, type WebsearchConfig } from '@simple-code/core/src/tools/websearch.ts'

/**
 * 只取全局 settings 的 websearch 段，不走 loadConfig——那要求完整的
 * model/provider（§1.2 没有默认模型），会把没有配置过的环境整个挡住。
 * websearch 的唯一配置项是 optional 的 key：文件缺失/字段缺失都等于
 * 「匿名层」，静默（AGENTS.md「可选文件缺失是正常情况」）
 */
async function websearchConfig(): Promise<WebsearchConfig> {
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_CONFIG_PATH, 'utf8')) as {
      websearch?: WebsearchConfig
    }
    return parsed.websearch ?? {}
  } catch {
    return {} // 读不到 = 匿名层，正常情况
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
