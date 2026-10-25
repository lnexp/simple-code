#!/usr/bin/env node
/**
 * "$SIMPLE_CODE_IMAGEGEN" "<指令>" <输出路径> [--size WxH] [--quality <档位>] [--n N]
 *
 * 生图薄壳（docs/proposals/imagegen.md）：POST 到宿主凭据代理的
 * /image/generations，代理按 settings.json 的 imageModel 钉模型、注入密钥、
 * 转发 /v1/images/generations。本 bin 不碰密钥，只解码 b64_json 落盘，
 * stdout 每张图一行——图片和 base64 都不进上下文，要看效果另调 view_image。
 *
 * 退出码：0 生成落盘；1 上游/代理报错、响应无图；2 无代理（同 LSP 无桥）；
 * 3 参数错（扩展名/路径/参数，不发请求、不计费）。
 */
import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PROXY_PORT_ENV, PROXY_TOKEN_ENV, PROXY_TOKEN_HEADER } from '@simple-code/core/src/proxy/endpoint.ts'

const USAGE = '用法：imagegen "<指令>" <输出路径(.png/.jpg/.jpeg/.webp)> [--size WxH] [--quality <档位>] [--n 张数，默认 1]'
/** 生成常需 30–120 秒，高档位更久 */
const TIMEOUT_MS = 300_000
const FORMATS: Record<string, string> = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' }

export type ImagegenArgs = { prompt: string; out: string; size?: string; quality?: string; n: number }

export function parseImagegenArgs(argv: string[]): { ok: true; args: ImagegenArgs } | { ok: false; error: string } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (!['--size', '--quality', '--n'].includes(a)) {
      positional.push(a)
      continue
    }
    const v = argv[++i]
    if (v === undefined) return { ok: false, error: `${a} 缺值。${USAGE}` }
    flags[a.slice(2)] = v
  }
  const [prompt, out] = positional
  if (!prompt || !out || positional.length > 2) return { ok: false, error: USAGE }
  const n = flags.n === undefined ? 1 : Number(flags.n)
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--n 须为正整数：${flags.n}` }
  return {
    ok: true,
    args: { prompt, out, n, ...(flags.size ? { size: flags.size } : {}), ...(flags.quality ? { quality: flags.quality } : {}) },
  }
}

/** 扩展名 → output_format；不支持返回 undefined */
export function outputFormat(path: string): string | undefined {
  return FORMATS[extname(path).toLowerCase()]
}

/** 按文件头认实际格式。网关实测不理 output_format（请求 jpeg 回 png），不能信扩展名 */
export function sniffFormat(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png'
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpeg'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return undefined
}

const EXT_OF: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp' }

/**
 * 输出路径只许落在项目目录（= bash 当前目录）内，不许进隐藏目录——
 * `.simple-code/tmp` 例外（用户定）。审批只看命令文本、认不出 bin 参数是
 * 写路径，所以 bin 自己守。返回绝对路径或错误
 */
export function checkOutPath(root: string, out: string): { ok: true; abs: string } | { ok: false; error: string } {
  const abs = resolve(root, out)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: `输出路径须在项目目录内：${out}` }
  const parts = rel.split(sep)
  const inScTmp = parts[0] === '.simple-code' && parts[1] === 'tmp'
  if (!inScTmp && parts.some((p) => p.startsWith('.'))) {
    return { ok: false, error: `输出路径不能在隐藏目录里（.simple-code/tmp 除外）：${out}` }
  }
  return { ok: true, abs }
}

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)

export type Placed = { path: string; taken: boolean; same: boolean }

/**
 * 落盘不覆盖（用户定）：目标已存在 → 同目录另存 `<名>-<新图 sha256 前 8 位><扩展名>`。
 * 带 hash 的名字也已存在 = 内容完全相同，不重写
 */
export async function placeImage(abs: string, bytes: Buffer): Promise<Placed> {
  await mkdir(dirname(abs), { recursive: true })
  if (!(await exists(abs))) {
    await writeFile(abs, bytes)
    return { path: abs, taken: false, same: false }
  }
  const ext = extname(abs)
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const alt = join(dirname(abs), `${basename(abs, ext)}-${hash}${ext}`)
  if (await exists(alt)) return { path: alt, taken: true, same: true }
  await writeFile(alt, bytes)
  return { path: alt, taken: true, same: false }
}

function humanSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/** 一张图一行。路径按相对当前目录显示 */
export function describePlaced(p: Placed, wanted: string, meta: string, root: string): string {
  const shown = relative(root, p.path)
  if (!p.taken) return `已生成 ${shown}（${meta}）`
  if (p.same) return `${wanted} 已存在，同内容的 ${shown} 也已存在，未重写（${meta}）`
  return `${wanted} 已存在，另存为 ${shown}（${meta}）`
}

type ImagesResponse = { data?: Array<{ b64_json?: string }>; size?: string; output_format?: string }

async function requestImages(args: ImagegenArgs, format: string, env: NodeJS.ProcessEnv): Promise<Response> {
  return fetch(`http://127.0.0.1:${env[PROXY_PORT_ENV]}/image/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PROXY_TOKEN_HEADER]: env[PROXY_TOKEN_ENV] ?? '' },
    body: JSON.stringify({
      prompt: args.prompt,
      n: args.n,
      output_format: format,
      ...(args.size ? { size: args.size } : {}),
      ...(args.quality ? { quality: args.quality } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
}

/** 失败时回给 agent 的响应摘要：去掉 base64，截断 */
function summarize(text: string): string {
  return text.replace(/"b64_json"\s*:\s*"[^"]*"/g, '"b64_json":"…"').slice(0, 800)
}

async function saveAll(body: ImagesResponse, args: ImagegenArgs, abs: string, ctx: { root: string; started: number }): Promise<string[]> {
  const images = (body.data ?? []).map((d) => d.b64_json).filter((b): b is string => typeof b === 'string' && b !== '')
  const lines: string[] = []
  for (const b64 of images) {
    const bytes = Buffer.from(b64, 'base64')
    // 实际格式与扩展名不符 → 换成实际格式的扩展名再存（用户定），行首写明；认不出照原路径
    const actual = sniffFormat(bytes)
    const wantedFormat = outputFormat(abs)
    const target = actual && actual !== wantedFormat ? abs.slice(0, -extname(abs).length) + EXT_OF[actual] : abs
    const note = target === abs ? '' : `请求 ${wantedFormat}，网关返回 ${actual}，改存 ${relative(ctx.root, target)}；`
    const placed = await placeImage(target, bytes)
    const meta = [body.size ?? args.size, body.output_format, humanSize(bytes.length), `用时 ${Math.round((Date.now() - ctx.started) / 1000)}s`]
      .filter(Boolean)
      .join('，')
    lines.push(note + describePlaced(placed, relative(ctx.root, target), meta, ctx.root))
  }
  return lines
}

export async function imagegenMain(argv: string[], env: NodeJS.ProcessEnv = process.env, root = process.cwd()): Promise<number> {
  const parsed = parseImagegenArgs(argv)
  if (!parsed.ok) return fail(parsed.error, 3)
  const { args } = parsed
  const format = outputFormat(args.out)
  if (!format) return fail(`不支持的扩展名：${args.out}（只认 .png/.jpg/.jpeg/.webp）`, 3)
  const target = checkOutPath(root, args.out)
  if (!target.ok) return fail(target.error, 3)
  if (!env[PROXY_PORT_ENV] || !env[PROXY_TOKEN_ENV]) {
    return fail('无凭据代理：生图须在 SC 里用（VS Code 面板或终端 sc；SIMPLE_CODE_PROXY_PORT 未设置）', 2)
  }
  const started = Date.now()
  let res: Response
  try {
    res = await requestImages(args, format, env)
  } catch (e) {
    // 超时是上游慢（生成中），不是代理不在——分开报，退出码也分开
    if (e instanceof Error && e.name === 'TimeoutError') return fail(`生图超时（${TIMEOUT_MS / 1000}s 未返回）`, 1)
    return fail(`凭据代理不可达：${e instanceof Error ? e.message : String(e)}（宿主关闭或端口失效）`, 2)
  }
  const text = await res.text()
  if (!res.ok) return fail(`生图失败（HTTP ${res.status}）：${summarize(text)}`, 1)
  let body: ImagesResponse
  try {
    body = JSON.parse(text) as ImagesResponse
  } catch {
    return fail(`响应不是 JSON：${summarize(text)}`, 1)
  }
  const lines = await saveAll(body, args, target.abs, { root, started })
  if (lines.length === 0) return fail(`响应里没有图片（data[].b64_json 为空）：${summarize(text)}`, 1)
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

function fail(message: string, code: number): number {
  process.stderr.write(`${message}\n`)
  return code
}

// 直接执行时（bin 形态）跑 main；被 import（测试）时不跑
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  imagegenMain(process.argv.slice(2)).then((code) => process.exit(code))
}
