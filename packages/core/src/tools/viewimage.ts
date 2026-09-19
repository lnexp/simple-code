/**
 * view_image（web-tools §1 D4 的「读本地图」落地）：模型主动看磁盘上的图。
 * 独立小工具，参数只有 path；detail 档位
 * （high/original）不做，我们统一 2048 一刀切（resizer 的 MAX_EDGE）。
 *
 * 工具不解码不缩放（解码和缩放归发送侧）——原图 base64 进 ToolOutput.images，
 * 发送侧 resizer 统一压。webfetch 抓图、用户贴图、本地图全走同一条出口。
 *
 * mime 靠文件头 magic bytes 而不是扩展名：Anthropic 的 image block
 * media_type 错了直接 4xx，而 `foo.png` 内容是 jpeg 的情况并不罕见。
 * 只有四种格式，手写 sniff 比上 file-type 库更短。
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { ToolDefinition } from '../llm/types.ts'
import type { ImageInput, Tool, ToolContext, ToolOutput } from './types.ts'

/**
 * 读入上限。发送侧 resizer 会把出场的图压进 5MB，这条只挡 OOM 级怪文件
 * （几十 MB 的截图该读就读，resizer 的活）。我们全程拖着 base64 字符串，
 * 得有一条硬线（字节流侧按 patches 限的做法不适用）
 */
const MAX_BYTES = 50 * 1024 * 1024

const definition: ToolDefinition = {
  name: 'view_image',
  description:
    '读一张本地图片给模型看（png/jpeg/gif/webp）。看截图、设计稿、图表用它；' +
    `想看图片的元信息（路径、大小、修改时间）用 bash ls/file。读入上限 ${MAX_BYTES / (1024 * 1024)}MB，` +
    '超限先用 bash 缩一份再读。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片路径；相对路径基于工作区根目录' },
      focus: {
        type: 'string',
        description:
          '想让转述重点看什么（如「右侧是否溢出」「报错文字」）。主模型自己能看图时忽略此参数',
      },
    },
    required: ['path'],
  },
}

/** 文件头识别。返回 mime 或 undefined（不认识）。四种 = Anthropic 支持的全集 */
function sniffMime(bytes: Uint8Array): string | undefined {
  const startsWith = (...prefix: number[]) => prefix.every((b, i) => bytes[i] === b)
  const startsWithAt = (offset: number, ...prefix: number[]) =>
    prefix.every((b, i) => bytes[offset + i] === b)
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif' // GIF8（7a/9a 都盖住）
  if (startsWith(0x52, 0x49, 0x46, 0x46) && startsWithAt(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp' // RIFF....WEBP——容器头在 0，格式名在偏移 8
  return undefined
}

const fail = (output: string): ToolOutput => ({ output, exitCode: -1, isError: true })

export function createViewImageTool(): Tool {
  return {
    name: 'view_image',
    definition,
    async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
      if (typeof input !== 'object' || input === null) return fail('参数必须是对象：{ path: string }')
      const { path, focus } = input as Record<string, unknown>
      if (typeof path !== 'string' || path === '') return fail('path 必填（string）')
      const focusText = typeof focus === 'string' ? focus.trim() : ''
      const absolute = isAbsolute(path) ? path : resolve(ctx.root, path)
      try {
        const info = await stat(absolute)
        if (info.isDirectory()) return fail(`\`${path}\` 是目录。要看目录里的图先 bash ls 再挑一张`)
        if (info.size > MAX_BYTES)
          return fail(
            `图片 ${info.size} 字节超过 ${MAX_BYTES} 上限。先用 bash 缩一份（sips/ImageMagick）再读`,
          )
        const bytes = new Uint8Array(await readFile(absolute))
        const mime = sniffMime(bytes)
        if (mime === undefined)
          return fail(
            `文件头不是 png/jpeg/gif/webp，读不了。\`${path}\` 若是别的格式，用 bash file 查实际类型`,
          )
        const image = { data: Buffer.from(bytes).toString('base64'), mimeType: mime }
        // 主模型无视觉时借转述副模型看图（有 relay 注入 = 配了 visionModel
        // 且主模型 caps.images=false）。图照样附上：库里的原图不丢，以后
        // 切到视觉模型还能直接看
        if (ctx.visionRelay) {
          try {
            const description = await ctx.visionRelay(image, focusText)
            return {
              output: `[视觉转述] ${description}`,
              exitCode: 0,
              isError: false,
              images: [image],
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            return {
              output:
                `图片 ${mime}，${bytes.byteLength} 字节（${path}）。视觉转述失败：${reason}——` +
                '图已保留，切到视觉模型可直看',
              exitCode: 0,
              isError: false,
              images: [image],
            }
          }
        }
        return {
          output: `图片 ${mime}，${bytes.byteLength} 字节（${path}）`,
          exitCode: 0,
          isError: false,
          images: [image],
        }
      } catch (error) {
        // stat/readFile 的 ENOENT/EACCES 都走这里，拼散文给模型
        const reason = error instanceof Error ? error.message : String(error)
        return fail(`读 \`${path}\` 失败：${reason}`)
      }
    },
  }
}
