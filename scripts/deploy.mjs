// 一键装机：build → vsce → 解压 → rsync → md5 核对 → 提示 reload。
//
// 为什么需要它：装机链路踩过四条教训（教训库可查）——
//   vsce-without-build-stale-vsix   裸 vsce 不构建，装的是旧 bundle
//   vsix-manual-unzip-wrong-layer   手动解压多套 extension/ 层，reload 跑旧码
//   verify-install-via-jsonl-not-self-read  装机验证不能自读，要核对产物
//   webview-asset-cache             webview 外链缓存（已用内容 hash 文件名解决）
// 每步都对人——五步少一步就「装机成功但行为没变」。固化成一条命令。
//
// 用法：packages/vscode 下 `pnpm run deploy`。
// 装机目标默认 ~/.vscode/extensions（用户拍板：以后主力环境是 VS Code，
// Cursor 不再装），可用 SIMPLE_CODE_EXTENSIONS_DIR 覆盖。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = fileURLToPath(new URL('../packages/vscode', import.meta.url))
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
// 扩展目录名规则：publisher.name-version（name 转小写）
const extDirName = `${manifest.publisher}.${manifest.name.toLowerCase()}-${manifest.version}`
const extRoot = join(process.env.SIMPLE_CODE_EXTENSIONS_DIR ?? join(homedir(), '.vscode/extensions'), extDirName)

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: pkgDir, stdio: 'inherit', ...opts })
const fsStatMtime = (p) => statSync(p).mtimeMs

// 1. 构建 + 打包（package script 已含 build.mjs——教训 vsce-without-build-stale-vsix）
console.log(`[deploy] package (build + vsce) …`)
run('pnpm', ['run', 'package'])

// 2. 找 vsix（目录里可能有历史版本，取 mtime 最新的）
const vsix = readdirSync(pkgDir)
  .filter((f) => f.endsWith('.vsix'))
  .map((f) => ({ f, m: fsStatMtime(join(pkgDir, f)) }))
  .sort((a, b) => b.m - a.m)[0]?.f
if (!vsix) throw new Error('vsix 不存在——package 失败了？')
console.log(`[deploy] vsix: ${vsix}`)

// 3. 解压到临时目录，摊平 extension/ 层（教训 vsix-manual-unzip-wrong-layer）
const stage = mkdtempSync(join(tmpdir(), 'sc-deploy-'))
run('unzip', ['-q', vsix, '-d', stage])
const layer = join(stage, 'extension')
if (!existsSync(layer)) throw new Error(`vsix 里没有 extension/ 层：${stage}`)

// 4. rsync 到位（--delete 清掉旧文件，防旧 webview.<hash>.js 堆积）
console.log(`[deploy] rsync → ${extRoot}`)
run('rsync', ['-a', '--delete', `${layer}/`, `${extRoot}/`])

// 5. md5 核对关键产物——装机验证以产物为准（教训 verify-install-via-jsonl-not-self-read）
const md5 = (p) => createHash('md5').update(readFileSync(p)).digest('hex')
const checks = ['dist/extension.cjs', 'dist/webview.current']
let ok = true
for (const rel of checks) {
  const local = join(pkgDir, rel)
  const remote = join(extRoot, rel)
  if (!existsSync(remote)) { console.error(`[deploy] ✗ 装机缺文件 ${rel}`); ok = false; continue }
  // webview.current 是指针文件（内容是 webview.<hash>.js 文件名），核对它指向的文件本体
  if (rel.endsWith('webview.current')) {
    const web = readFileSync(remote, 'utf8').trim()
    for (const side of [join(pkgDir, 'dist', web), join(extRoot, 'dist', web)]) {
      if (!existsSync(side)) { console.error(`[deploy] ✗ webview 指针指向不存在的 ${web}（${side}）`); ok = false }
    }
    if (!ok) break
    if (md5(join(pkgDir, 'dist', web)) !== md5(join(extRoot, 'dist', web))) {
      console.error(`[deploy] ✗ ${web} 两边不一致`); ok = false
    } else {
      console.log(`[deploy] ✓ ${web} md5 一致`)
    }
    continue
  }
  const same = md5(local) === md5(remote)
  console.log(`[deploy] ${same ? '✓' : '✗'} ${rel} md5 ${same ? '一致' : '不一致！'}`)
  if (!same) ok = false
}

rmSync(stage, { recursive: true, force: true })

// 稳定 symlink：~/.simple-code/bin/sc → 扩展目录 dist 下的
// 对应 bin。扩展目录名带版本号，人的 PATH 不该跟着版本改——deploy 每次
// 重指。终端裸用还需 export SIMPLE_CODE_API_KEY（key 是 ${ENV} 引用）
{
  const binDir = join(homedir(), '.simple-code/bin')
  for (const [name, file] of [['sc', 'sc.js']]) {
    const target = join(extRoot, `dist/${file}`)
    const link = join(binDir, name)
    if (!existsSync(target)) {
      console.error(`[deploy] ✗ ${target} 不存在——查 build.mjs 的 bin 清单`)
      ok = false
      continue
    }
    mkdirSync(binDir, { recursive: true })
    try { unlinkSync(link) } catch { /* 不存在最好 */ }
    symlinkSync(target, link)
    console.log(`[deploy] ✓ ${link} → ${target}`)
  }
  console.log(`[deploy] PATH 加 ${join(homedir(), '.simple-code/bin')} 即可裸用`)
}
if (!ok) { console.error('[deploy] 核对失败——上面的差异要处理，别 reload'); process.exit(1) }
console.log(`[deploy] 完成。Cmd+Shift+P → Reload Window 生效`)
console.log(`[deploy] 注：reload 后行为仍没变，先跑 verify-install 教训那套（jsonl 仲裁），再怀疑缓存`)
