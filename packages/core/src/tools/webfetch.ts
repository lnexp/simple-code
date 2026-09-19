import domino from 'domino'
import TurndownService from 'turndown'
import type { ToolDefinition } from '../llm/types.ts'
import { describeError } from './describe.ts'
import { truncateOutput } from './truncate.ts'
import type { ImageInput, Tool, ToolContext, ToolOutput } from './types.ts'

/**
 * webfetch（web-tools §3）：抓 URL → HTML 转 markdown → 截断 → 落盘原始响应。
 *
 * 图片 URL 直接 base64 进 images（D4 拍板）——**工具不自己压**，发送侧
 * resizer 统一处理，与用户贴图同一条路。
 *
 * 错误纪律对齐 Tool 接口（types.ts「永不抛异常」）：DNS、超时、4xx/5xx、
 * 二进制，全部 isError 正常返回。**不重试**——webfetch 是模型自己发起的，
 * 它看到错误会自己决定怎么办（bash 同款语义）；cause 链拼法用 describeError。
 */

export type WebfetchConfig = {
  /** 请求超时（ms），参数里可覆盖到 maxTimeoutMs */
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxOutputChars: number
}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
/** 响应体上限 */
const MAX_BYTES = 5 * 1024 * 1024

/** 描述按配置生成——超时数字必须与实际行为一致（同 bash.ts 的 definitionOf） */
const definitionOf = (config: WebfetchConfig): ToolDefinition => ({
  name: 'webfetch',
  description:
    '抓取一个 http/https URL 并把 HTML 转成 markdown 返回。用它读文档页、' +
    'CHANGELOG、GitHub 页面、API 响应。想要原始 HTML 或下载文件用 bash curl。' +
    '图片 URL 会直接把图返回给模型看。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整的 http/https URL' },
      timeout: {
        type: 'number',
        description: `超时秒数，默认 ${Math.round(config.defaultTimeoutMs / 1000)}，最大 ${Math.round(config.maxTimeoutMs / 1000)}`,
      },
    },
    required: ['url'],
  },
})

type Args = { url: string; timeoutMs: number }

/** turndown 惰性建——大多数请求不带 HTML，别为它付启动成本 */
let converter: TurndownService | undefined

/** 这三类对「可见内容」零贡献（浏览器也不渲染），不删会整段进正文 */
const INVISIBLE_TAGS = ['style', 'script', 'noscript'] as const

function toMarkdown(html: string): string {
  converter ??= new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    // domino 解析出的是纯 DOM，没有浏览器专有 API 可退，转不过的标签留原文
  })
  // as any：domino 的类型声明只有三行（lib/index.d.ts），而 core 刻意不开
  // DOM lib（tsconfig $comment）——DOM API 运行时都在，类型世界不存在，
  // any 是这里最诚实的选择。live collection 先展开再删，边遍历边删会跳元素
  const doc = domino.createDocument(html) as any
  for (const tag of INVISIBLE_TAGS) {
    // Array.from 而不是 spread：domino 的 HTMLCollection 没有 Symbol.iterator
    const els: unknown[] = Array.from(doc.getElementsByTagName(tag))
    for (const el of els)
      (el as { parentNode: { removeChild(c: unknown): unknown } | null }).parentNode?.removeChild(
        el,
      )
  }
  return converter.turndown(doc)
}

function parseArgs(input: unknown, config: WebfetchConfig): Args | string {
  if (typeof input !== 'object' || input === null) return '参数必须是对象：{ url: string }'
  const { url, timeout } = input as Record<string, unknown>
  if (typeof url !== 'string' || url === '') return 'url 必填（string）'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `url 解析失败：${url}`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return `协议只支持 http/https：${parsed.protocol}`
  // 带 username/password 的 URL 直接拒绝——
  // http://key@host 把凭据塞进 URL，它注定会进日志和原始落盘
  if (parsed.username !== '' || parsed.password !== '')
    return 'URL 里不能带 username/password——凭据会随 URL 进日志，去掉再用'
  let timeoutMs = config.defaultTimeoutMs
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
      return 'timeout 是正数（秒）'
    timeoutMs = Math.min(timeout * 1000, config.maxTimeoutMs)
  }
  return { url: parsed.toString(), timeoutMs }
}

/** 抓一次。UA 可换（Cloudflare 403 + cf-mitigated: challenge 时换诚实 UA 重试） */
async function fetchOnce(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ status: number; contentType: string; cfMitigated: string | null; bytes: Uint8Array }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    headers: {
      'user-agent': userAgent,
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  })
  const cfMitigated = response.headers.get('cf-mitigated')
  // 先收全 body 再判断大小——5MB 上限自己卡，content-length 不可信（chunked）
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    cfMitigated,
    bytes,
  }
}

export function createWebfetchTool(config: WebfetchConfig): Tool {
  return {
    name: 'webfetch',
    definition: definitionOf(config),
    async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
      const args = parseArgs(input, config)
      if (typeof args === 'string') return { output: args, exitCode: -1, isError: true }

      let response: Awaited<ReturnType<typeof fetchOnce>>
      try {
        response = await fetchOnce(args.url, args.timeoutMs, CHROME_UA)
        // Cloudflare bot 检测（TLS 指纹与 UA 不匹配）→ 换诚实 UA 重试一次
        if (response.status === 403 && response.cfMitigated === 'challenge') {
          response = await fetchOnce(args.url, args.timeoutMs, 'simple-code')
        }
      } catch (error) {
        return {
          output: `请求失败 ${args.url}：${describeError(error)}`,
          exitCode: -1,
          isError: true,
        }
      }

      if (response.status >= 400) {
        return {
          output: `HTTP ${response.status} ${args.url}（${response.contentType || '未知类型'}）`,
          exitCode: response.status,
          isError: true,
        }
      }
      if (response.bytes.byteLength > MAX_BYTES) {
        return {
          output: `响应 ${(response.bytes.byteLength / 1024 / 1024).toFixed(1)}MB，超过 5MB 上限。要完整内容用 bash curl -o 下载`,
          exitCode: -1,
          isError: true,
        }
      }

      const mime = response.contentType.split(';')[0]?.trim().toLowerCase() ?? ''

      // 图片：base64 直接进 images（D4）。原图不压——发送侧 resizer 统一处理
      if (mime.startsWith('image/')) {
        return {
          output: `图片 ${mime}，${response.bytes.byteLength} 字节`,
          exitCode: 0,
          isError: false,
          images: [{ data: Buffer.from(response.bytes).toString('base64'), mimeType: mime }],
        }
      }

      const body = new TextDecoder().decode(response.bytes)
      // 原始响应落盘（§3.2 第 6 步）——转换前的字节，模型想看未截断原文有路可走
      ctx.onRawOutput?.(body)

      if (mime.includes('text/html') || mime.includes('application/xhtml+xml')) {
        const markdown = toMarkdown(body)
        return {
          output: truncateOutput(markdown, config.maxOutputChars, ctx.rawPath),
          exitCode: 0,
          isError: false,
        }
      }
      // 文本类按原文，其余二进制降级（§3.4）
      if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
        return {
          output: truncateOutput(body, config.maxOutputChars, ctx.rawPath),
          exitCode: 0,
          isError: false,
        }
      }
      return {
        output: `不支持的内容类型 ${mime || '（未知）'}，${response.bytes.byteLength} 字节。要下载用 bash curl -o`,
        exitCode: 0,
        isError: false,
      }
    },
  }
}
