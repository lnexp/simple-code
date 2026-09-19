#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * MCP 的 CLI 形态（MCP over bash）。产品不把 MCP 工具动态挂进 agent
 * 工具表——降维成一条命令，走 bash 通道：
 *
 *   "$SIMPLE_CODE_MCP" list                     已配置的 servers
 *   "$SIMPLE_CODE_MCP" tools <server>           工具清单（名字/描述/schema）
 *   "$SIMPLE_CODE_MCP" <server> <tool> '<json>' 调用，结果写 stdout
 *
 * server 配置在 ~/.simple-code/settings.json 的 mcp.servers；凭证在
 * server 子进程的 env 里，不进模型上下文。审批按 bash 命令前缀，
 * `mcp <server> [tool]` 可逐级放行。
 *
 * unix 语义同 webfetch-bin：正文 stdout、错误 stderr、isError → 非零 exit。
 */
import { readFile } from 'node:fs/promises'
import {
  listMcpTools,
  callMcpTool,
  type McpServers,
} from '@simple-code/core/src/tools/mcp.ts'
import { GLOBAL_CONFIG_PATH } from '@simple-code/core/src/config/load.ts'
import { describeError } from '@simple-code/core/src/tools/describe.ts'

/** 只取 settings 的 mcp 段，读不到 = 没配置，正常情况（同 websearch-bin） */
async function mcpServers(): Promise<McpServers> {
  try {
    const parsed = JSON.parse(await readFile(GLOBAL_CONFIG_PATH, 'utf8')) as {
      mcp?: { servers?: McpServers }
    }
    return parsed.mcp?.servers ?? {}
  } catch {
    return {}
  }
}

const USAGE = `用法：mcp list | mcp tools <server> | mcp <server> <tool> [json参数]
list   列 settings.json 里配置的 MCP servers
tools  列某 server 的工具（名字、描述、参数 schema）
调用   mcp <server> <tool> '{"key":"value"}'，结果文本写 stdout`

const argv = process.argv.slice(2)
const fail = (msg: string, code = 1): void => {
  process.stderr.write(`${msg}\n`)
  process.exitCode = code
}

if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
  process.stdout.write(`${USAGE}\n`)
} else if (argv[0] === 'list') {
  const servers = await mcpServers()
  const names = Object.keys(servers)
  if (names.length === 0) {
    process.stdout.write(
      'settings.json 还没配 mcp.servers。示例：\n' +
        '"mcp": { "servers": { "github": { "command": "npx", ' +
        '"args": ["-y", "@modelcontextprotocol/server-github"] } } }\n',
    )
  } else {
    for (const n of names) {
      const s = servers[n]
      if (!s) continue
      process.stdout.write(`${n}   ${s.command} ${(s.args ?? []).join(' ')}\n`)
    }
  }
} else if (argv[0] === 'tools') {
  const name = argv[1]
  if (name === undefined) fail('mcp tools 需要 server 名', 2)
  else {
    const servers = await mcpServers()
    const cfg = servers[name]
    if (cfg === undefined)
      fail(`未配置的 server：${name}。已配置：${Object.keys(servers).join(', ') || '（无）'}`, 2)
    else {
      try {
        const tools = await listMcpTools(cfg)
        for (const t of tools) {
          process.stdout.write(`${t.name} — ${t.description}\n`)
          process.stdout.write(`  参数: ${JSON.stringify(t.inputSchema)}\n`)
        }
      } catch (e) {
        fail(`连不上 ${name}：${describeError(e)}`)
      }
    }
  }
} else if (argv.length === 2 || argv.length === 3) {
  const [name, tool, json] = [argv[0], argv[1], argv[2]] as const
  if (name === undefined || tool === undefined) fail(USAGE, 2)
  else {
    const servers = await mcpServers()
    const cfg = servers[name]
    if (cfg === undefined)
      fail(`未配置的 server：${name}。已配置：${Object.keys(servers).join(', ') || '（无）'}`, 2)
    else {
      try {
        const r = await callMcpTool(cfg, tool, json ?? '')
        if (r.isError) fail(r.text === '' ? `工具 ${tool} 报错（无文本输出）` : r.text)
        else process.stdout.write(`${r.text}\n`)
      } catch (e) {
        fail(describeError(e))
      }
    }
  }
} else {
  fail(USAGE, 2)
}
