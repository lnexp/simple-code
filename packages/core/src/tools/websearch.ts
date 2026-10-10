import type { ToolDefinition } from '../llm/types.ts'
import { describeError } from './describe.ts'
import type { Tool, ToolContext, ToolOutput } from './types.ts'

/**
 * websearch（web-tools §4，D2 拍板 Exa）：jsonrpc tools/call 打 Exa 的
 * MCP 端点，匿名层缺省可用，key/url 可选（~/.simple-code/websearch.json，
 * 缺该文件 = 匿名层——见 websearch-bin）。
 * websearch.url 可选：指向同形状的代理端点（如 LLM Center 网关的
 * dashboard.exa.ai——2026-10-08 实测工具名/参数/响应格式与官方一致），
 * 此时 exaApiKey 改走 Authorization: Bearer 头。
 *
 * 匿名层挂了的用户体验是「websearch 报错、webfetch 仍可用」——模型看到
 * 错误会自己改用 fetch，可恢复，所以不做 fallback provider。
 */

export type WebsearchConfig = {
  /** 可选。缺省走匿名层 */
  exaApiKey?: string | undefined
  /** 可选。自定义 MCP 端点，须与 mcp.exa.ai 同形状（web_search_exa） */
  url?: string | undefined
}

/** 超时 25 秒 */
const TIMEOUT_MS = 25_000
const DEFAULT_RESULTS = 5
const MAX_RESULTS = 10

const definition: ToolDefinition = {
  name: 'websearch',
  description:
    '搜索网页。返回带摘要的结果列表（markdown）。查最新版本号、文档入口、' +
    '报错信息时先用它，再用 webfetch 打开具体页面。需要精确站点内容时' +
    'site: 前缀可用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词' },
      numResults: {
        type: 'number',
        description: `结果数，默认 ${DEFAULT_RESULTS}，上限 ${MAX_RESULTS}`,
      },
    },
    required: ['query'],
  },
}

/**
 * 解析 Exa MCP 的响应体：可能是整体 JSON，也可能是 SSE（逐行 data:）。
 * 返回第一个带 text 的 content；解析不出返回 undefined——调用方转成
 * 「响应格式异常」的 isError。纯函数，不碰网络。
 */
export function parseSseData(body: string): string | undefined {
  const payload = (raw: string): string | undefined => {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('{')) return undefined
    try {
      const data = JSON.parse(trimmed) as {
        result?: { content?: Array<{ type?: string; text?: string }> }
      }
      return data.result?.content?.find((item) => item.text)?.text
    } catch {
      return undefined
    }
  }
  const direct = body.trim() ? payload(body) : undefined
  if (direct) return direct
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = payload(line.slice(6))
    if (data) return data
  }
  return undefined
}

function parseArgs(input: unknown): { query: string; numResults: number } | string {
  if (typeof input !== 'object' || input === null) return '参数必须是对象：{ query: string }'
  const { query, numResults } = input as Record<string, unknown>
  if (typeof query !== 'string' || query.trim() === '') return 'query 必填（非空 string）'
  const n =
    typeof numResults === 'number' && Number.isFinite(numResults) && numResults > 0
      ? Math.min(Math.floor(numResults), MAX_RESULTS)
      : DEFAULT_RESULTS
  return { query: query.trim(), numResults: n }
}

export function createWebsearchTool(config: WebsearchConfig): Tool {
  return {
    name: 'websearch',
    definition,
    async execute(input: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      const args = parseArgs(input)
      if (typeof args === 'string') return { output: args, exitCode: -1, isError: true }

      const url =
        config.url ??
        (config.exaApiKey
          ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(config.exaApiKey)}`
          : 'https://mcp.exa.ai/mcp')

      let body: string
      let status: number
      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            // 自定义端点（url）时 key 走 Bearer 头；官方端点 key 在 URL 上
            ...(config.url && config.exaApiKey
              ? { authorization: `Bearer ${config.exaApiKey}` }
              : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'web_search_exa', arguments: args },
          }),
        })
        status = response.status
        body = await response.text()
      } catch (error) {
        return {
          output: `搜索失败：${describeError(error)}。可改用 webfetch 直接抓已知站点`,
          exitCode: -1,
          isError: true,
        }
      }
      if (status !== 200) {
        return {
          output: `Exa 返回 HTTP ${status}。可改用 webfetch 直接抓已知站点`,
          exitCode: status,
          isError: true,
        }
      }
      const text = parseSseData(body)
      if (text === undefined) {
        return {
          output: `响应格式异常（前 200 字符：${body.slice(0, 200)}）。可改用 webfetch`,
          exitCode: -1,
          isError: true,
        }
      }
      return { output: text, exitCode: 0, isError: false }
    },
  }
}
