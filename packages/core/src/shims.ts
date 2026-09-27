import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 工具脚本的 Node 解析（2026-09-19 拍板：消灭 node 依赖）。
 *
 * 全部 bin（apply-patch/webfetch/memory/…）是 `#!/usr/bin/env node` 的
 * ESM 脚本，agent 在 bash 里 `"$SIMPLE_CODE_APPLY_PATCH"` 这样调——
 * shebang 从 PATH 找 node，只装了 VS Code/Cursor、没装 node 的机器上
 * 这些全挂（面板能聊、工具全残）。
 *
 * 方案：宿主激活时往 `~/.simple-code/bin/` 写 shim——一个小 shell 脚本，
 * 写死「node 可执行文件 + bin 绝对路径」，`SIMPLE_CODE_*` 改指 shim。
 * node 的优先级：**当前宿主的内置 Node**（扩展宿主里 `process.execPath`
 * 是 Electron helper，加 `ELECTRON_RUN_AS_NODE=1` 即纯 node——在 VS Code
 * 里就是 VS Code 的，在 Cursor 里就是 Cursor 的，不需要跨宿主找别家的：
 * 路径随版本变，脆且无收益）→ **系统 node 兜底**。
 *
 * 为什么探测而不是直接信 execPath：老宿主的 Electron 可能是 Node <22.5
 * （没有 node:sqlite），写死一个跑不起来的不如回落。探测内容就是 bins
 * 的硬门槛 `import('node:sqlite')`。
 */

export interface ShimEntry {
  /** 环境变量后缀（WEBFETCH → SIMPLE_CODE_WEBFETCH） */
  name: string
  /** shim 文件名（sc-webfetch；终端入口特例叫 sc） */
  bin: string
  /** 被包的脚本绝对路径 */
  script: string
}

export interface EnsureShimsOptions {
  binDir?: string
  /** 跳过探测直接指定。sc CLI 用 process.execPath——能跑 sc 的 node
   * 就能跑兄弟 bin，探测是白付的 */
  nodeBin?: string
}

/** 双引号转义。node 路径带空格（…/Code Helper (Plugin)）是常态 */
const sh = (value: string): string => `"${value.replaceAll('"', '\\"')}"`

function renderShim(nodeBin: string, script: string): string {
  return [
    '#!/bin/sh',
    '# SimpleCode 自动生成（激活时重写），勿手改：宿主内置 Node 优先，系统 node 兜底',
    `exec env ELECTRON_RUN_AS_NODE=1 ${sh(nodeBin)} --disable-warning=ExperimentalWarning ${sh(script)} "$@"`,
    '',
  ].join('\n')
}

/** 探测一个 node 可执行文件能不能跑我们的 bins。超时 2s——探测挂死
 * 不该拖住激活。stdio ignore：只看退出码，不看输出 */
export function probeNode(nodeBin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, ['--input-type=module', '-e', "await import('node:sqlite')"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      child.kill()
      resolve(false)
    }, 2000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** node 优先级：当前进程的（扩展宿主 = 宿主内置）→ 系统 node */
export async function resolveNodeBin(candidate = process.execPath): Promise<string> {
  return (await probeNode(candidate)) ? candidate : 'node'
}

/**
 * 写齐一组 shim，返回 name → shim 路径（调用方据此设 SIMPLE_CODE_*）。
 *
 * 内容没变不重写（mtime 稳定）；变了先删再写——路径上可能是 deploy.mjs
 * 留下的软链，直接写会写穿到链接目标，把 dist 里的真文件覆盖掉。
 */
export async function ensureShims(
  entries: ShimEntry[],
  options: EnsureShimsOptions = {},
): Promise<Record<string, string>> {
  const binDir = options.binDir ?? join(homedir(), '.simple-code', 'bin')
  const nodeBin = options.nodeBin ?? (await resolveNodeBin())
  mkdirSync(binDir, { recursive: true })
  const paths: Record<string, string> = {}
  for (const { name, bin, script } of entries) {
    const path = join(binDir, bin)
    const content = renderShim(nodeBin, script)
    let existing: string | undefined
    try {
      existing = readFileSync(path, 'utf8')
    } catch {
      // 不存在——首写
    }
    if (existing !== content) {
      rmSync(path, { force: true })
      writeFileSync(path, content)
    }
    chmodSync(path, 0o755)
    paths[name] = path
  }
  return paths
}
