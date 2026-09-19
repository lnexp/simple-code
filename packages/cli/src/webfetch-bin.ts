#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * webfetch 的 CLI 形态（web-tools §10）。工具版从模型工具列表里撤了——
 * 抓取走 bash 管道：`"$SIMPLE_CODE_WEBFETCH" <url> | head -50`。
 * 「给模型更少的选择」：一个入口（bash），组合自由（grep/sed/wc/重定向），
 * 大页面不再整页进上下文。
 *
 * unix 语义映射：正文走 stdout；错误说明走 stderr；isError → 非零 exit。
 * 图片响应不进 stdout（二进制没法配管道）：--save-image <目录> 落盘，
 * 之后 view_image 看——网页图和本地图在这条路上汇合。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createWebfetchTool } from '@simple-code/core/src/tools/webfetch.ts'

const USAGE = `用法：webfetch <url> [--timeout 秒] [--save-image 目录]
抓 URL，HTML 转 markdown，正文写 stdout。适合接管道：head / grep / sed / 重定向。
图片响应默认丢弃，加 --save-image <目录> 落盘（image-1.png…），之后用 view_image 看。`

const argv = process.argv.slice(2)
let url = ''
let timeout: number | undefined
let saveImage: string | undefined
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === undefined) break // noUncheckedIndexedAccess 的收口
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`)
    process.exitCode = 0
  } else if (arg === '--timeout') timeout = Number(argv[++i])
  else if (arg === '--save-image') saveImage = argv[++i]
  else url = arg
}
if (process.exitCode === undefined && url === '') {
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 2
}

if (process.exitCode === undefined) {
  const tool = createWebfetchTool({
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
    maxOutputChars: 100_000,
  })
  // stdin 没有中断语义可接；超时上限之外再给 10s 余量兜底进程本身
  const ctx = { root: process.cwd(), signal: AbortSignal.timeout(130_000) }
  const out = await tool.execute({ url, ...(timeout ? { timeout } : {}) }, ctx)

  if (out.isError) {
    process.stderr.write(`${out.output}\n`)
    process.exitCode = out.exitCode !== 0 ? out.exitCode : 1
  } else {
    process.stdout.write(`${out.output}\n`)
    if (out.images !== undefined && out.images.length > 0) {
      if (saveImage !== undefined) {
        await mkdir(saveImage, { recursive: true })
        for (const [i, img] of out.images.entries()) {
          const ext = img.mimeType.split('/')[1] ?? 'png'
          const file = `${saveImage}/image-${i + 1}.${ext}`
          await writeFile(file, Buffer.from(img.data, 'base64'))
          // 路径走 stderr：stdout 是给管道的正文，别混进文件名
          process.stderr.write(`已保存 ${file}\n`)
        }
      } else {
        process.stderr.write(
          `响应含 ${out.images.length} 张图，未保存。--save-image <目录> 落盘后可用 view_image 看\n`,
        )
      }
    }
    process.exitCode = 0
  }
}
