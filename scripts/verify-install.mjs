#!/usr/bin/env node
/**
 * 装机后验证 reload 是否真的跑在新版本上（教训 verify-install-via-jsonl-not-self-read：
 * 自读不可信，要客观数据仲裁；extension-folder-exists-but-not-loaded：目录在≠会被加载）。
 *
 * 用法：Reload Window 之后跑 `node scripts/verify-install.mjs [--wait 60]`。
 * 判据：最新一条 ext_activate 事件的 version == 本仓库 package.json 的 version，
 * 激活时刻晚于装机目录里 dist/extension.cjs 的 mtime，且其 pid 存活（扩展宿主
 * 进程还在跑）。只比版本号不够：平时装机不升版本，没 reload 时最新一条激活
 * 也是同一个版本号（2026-10-29 实测：22:22 装机，脚本拿 18:52 的激活报了 ✓）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const logsDir = join(homedir(), '.simple-code', 'logs')
// 版本以扩展清单为准——仓库根 package.json 是 monorepo 自己的号，两者不同步
const manifestPath = fileURLToPath(new URL('../packages/vscode/package.json', import.meta.url))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const localVersion = manifest.version
// 装机目录同 deploy.mjs：publisher.name-version（name 转小写）
const extRoot = join(
  process.env.SIMPLE_CODE_EXTENSIONS_DIR ?? join(homedir(), '.vscode/extensions'),
  `${manifest.publisher}.${manifest.name.toLowerCase()}-${localVersion}`,
)
const installedAt = statSync(join(extRoot, 'dist', 'extension.cjs')).mtimeMs

const scanOnce = () => {
  // 扫最近 3 天的日志文件（UTC 切天：本地「今天」可能横跨两个文件）
  const files = readdirSync(logsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .slice(-3)
  const hits = []
  for (const f of files) {
    for (const line of readFileSync(join(logsDir, f), 'utf8').split('\n')) {
      if (!line.includes('"ext_activate"')) continue // 快速预筛，避免逐行 JSON.parse
      try { hits.push(JSON.parse(line)) } catch { /* 截断行：下一天文件里会有完整的 */ }
    }
  }
  return hits.at(-1)
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

const waitArg = process.argv.indexOf('--wait')
const waitSec = waitArg >= 0 ? Number(process.argv[waitArg + 1]) || 60 : 0
const deadline = Date.now() + waitSec * 1000

let last
for (;;) {
  last = scanOnce()
  const fresh = last?.version === localVersion && Date.parse(last.at) > installedAt
  if (fresh && pidAlive(last.pid)) break
  if (Date.now() >= deadline) break
  await new Promise((r) => setTimeout(r, 1000))
}

if (!last) {
  console.error('✗ 日志里没有 ext_activate 事件——装的还是旧版本（0.1.5 之前的构建没有这行），或 reload 未发生')
  process.exit(1)
}
const alive = pidAlive(last.pid)
const match = last.version === localVersion
console.log(`最新 ext_activate: version=${last.version} pid=${last.pid} at=${last.at}`)
if (!match) {
  console.error(`✗ 最新激活的是 ${last.version}，本地构建是 ${localVersion}——reload 未生效或装错了目录`)
  console.error('  下一步：exthost 日志时间戳核对（教训 reload-claims-verify-exthost-timestamps）')
  process.exit(1)
}
if (Date.parse(last.at) <= installedAt) {
  console.error(
    `✗ 最新激活早于装机（装机产物 ${new Date(installedAt).toISOString()}）——装完还没 Reload Window，跑的是旧构建`,
  )
  process.exit(1)
}
if (!alive) {
  console.error(`⚠ version 匹配（${localVersion}）但 pid ${last.pid} 已退出——可能又 reload 过一次；重跑本脚本看最新一条`)
  process.exit(1)
}
console.log(`✓ 扩展 ${localVersion} 正在运行（pid ${last.pid}）`)
