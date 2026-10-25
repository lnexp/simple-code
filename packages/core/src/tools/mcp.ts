import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { PROXY_TOKEN_HEADER, type ProxyEndpoint } from '../proxy/endpoint.ts'
import { describeError } from './describe.ts'

/**
 * MCP 薄封装——「MCP over bash」方案（web-tools 之后的第二个 bash 化工具）。
 *
 * 产品**不**把 MCP 工具动态挂进 agent 工具表：那要动静态注册表、管长驻
 * 子进程、给审批加新类别。这里降维成 CLI：`"$SIMPLE_CODE_MCP" <server>
 * <tool> '<json>'`——走 bash 通道，审批按命令前缀（`mcp <server> [tool]`
 * 可逐级放行），一次性进程调完即退，凭证在 server 子进程的 env 里、
 * 不进模型上下文。
 *
 * SDK 兜协议细节（版本协商/capabilities/心跳），这里只暴露两个动作：
 * 列工具、调用，都包在一次连接的生命周期里。延迟代价（每次 spawn +
 * 握手 1~3s）对低频调用可接受——烦了再做 daemon，先不加机制。
 */

export type McpStdioConfig = {
  command: string
  args?: string[]
  /** server 进程的工作目录——依赖相对路径文件的 server 需要（同 Cursor 格式） */
  cwd?: string
  env?: Record<string, string>
}
/**
 * 远端 HTTP server。url/headers **只由宿主凭据代理读**（credential-proxy.ts，
 * headers 里的 ${VAR} 在宿主进程内展开）；bin 只按 server 名连本机代理，
 * 密钥不进 bash 环境、不进命令行参数（docs/proposals/credential-proxy.md）
 */
export type McpHttpConfig = { url: string; headers?: Record<string, string> }
export type McpServerConfig = McpStdioConfig | McpHttpConfig
export type McpServers = Record<string, McpServerConfig>

export const isHttpServer = (cfg: McpServerConfig): cfg is McpHttpConfig => 'url' in cfg

/** url 型 server 没有代理可走（不在 SC 里 / 宿主已关）。bin 映射成退出码 2 */
export class McpNoProxyError extends Error {
  constructor() {
    super('url 型 server 只能经 SC 宿主的凭据代理访问，当前环境没有代理（SIMPLE_CODE_PROXY_PORT 未设置）——请在 SC 里运行（VS Code 面板或终端 sc）')
  }
}

/** 30s：npx 型 HTTP 桥（mcp-remote）要 spawn + OAuth 发现 + 握手，
    慢的 server 实测 11s+（2026-10-08 网关 jina，10s 超时误判连不上） */
const CONNECT_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 60_000

function makeTransport(cfg: McpServerConfig, via?: ProxyEndpoint): Transport {
  if (isHttpServer(cfg)) {
    if (!via) throw new McpNoProxyError()
    const http = new StreamableHTTPClientTransport(new URL(via.url), {
      requestInit: { headers: { [PROXY_TOKEN_HEADER]: via.token } },
    })
    // SDK 自己的类与 Transport 接口在 exactOptionalPropertyTypes 下对不上
    // （sessionId?: string 未写 | undefined），运行时就是同一个接口
    return http as Transport
  }
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    // 不 merge 默认环境的话子进程只有类 sudo 的极简 env（SDK 行为），
    // `npx` 型 server 连 PATH/HOME 都没有，必挂。用户 env 后并，可覆盖
    env: { ...getDefaultEnvironment(), ...cfg.env },
  })
}

/** 连接（SDK 自动 initialize 握手）→ fn → close，fn 抛错也保证关 */
async function withMcpServer<T>(
  cfg: McpServerConfig,
  via: ProxyEndpoint | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = makeTransport(cfg, via)
  const client = new Client({ name: 'simple-code', version: '0.0.0' })
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
    return await fn(client)
  } finally {
    await client.close().catch(() => {
      /* 关不掉就算了，进程马上退出 */
    })
  }
}

export type McpToolInfo = {
  name: string
  description: string
  /** 工具的入参 JSON Schema，原样透传（模型照着填参数） */
  inputSchema: unknown
}

/** via：url 型 server 的本机代理端点（endpoint.ts mcpProxyEndpoint），stdio 型忽略 */
export async function listMcpTools(cfg: McpServerConfig, via?: ProxyEndpoint): Promise<McpToolInfo[]> {
  return withMcpServer(cfg, via, async (client) => {
    const res = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS })
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }))
  })
}

export type McpCallResult = { isError: boolean; text: string }

export async function callMcpTool(
  cfg: McpServerConfig,
  tool: string,
  argsJson: string,
  via?: ProxyEndpoint,
): Promise<McpCallResult> {
  let args: Record<string, unknown> = {}
  if (argsJson.trim() !== '') {
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>
    } catch (e) {
      throw new Error(`参数不是合法 JSON：${describeError(e)}`)
    }
  }
  return withMcpServer(cfg, via, async (client) => {
    const res = await client.callTool(
      { name: tool, arguments: args },
      CompatibilityCallToolResultSchema,
      { timeout: CALL_TIMEOUT_MS },
    )
    // SDK 按 schema 泛型推断 content，无 schema 时退化成 {}——收窄成
    // 联合块取 text 字段（图片等非文本块拼不进 stdout，丢弃）
    const blocks = (res.content ?? []) as Array<{ type: string; text?: string }>
    const text = blocks
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter((s) => s !== '')
      .join('\n')
    return { isError: res.isError === true, text }
  })
}
