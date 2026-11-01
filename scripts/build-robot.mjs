// 桌面机器人插件构建（docs/proposals/desktop-robot.md §8），只能在 macOS 上跑。
//
//   node scripts/build-robot.mjs                 两个平台包都出
//   node scripts/build-robot.mjs darwin-arm64    只出一个
//
// 产物：packages/robot/simplecode-robot-<平台>-<版本>.vsix。每个平台包只带本架构
// 的 SimpleCodeRobot.app，不出通用包——Windows/Linux 装不上，不带用不了的东西。
//
// 编出来的二进制先过 XProtect 的 yara 规则再打包：Swift 符号撞上恶意软件特征时，
// 用户一启动就被系统移进废纸篓并弹恶意软件警告（教训
// macos-self-built-app-moved-to-trash，ADLOAD_I 规则撞了 `Delegate…shown` 属性名）。
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, 'packages/robot')
const XPROTECT = '/var/protected/xprotect/XProtect.bundle/Contents/Resources/XProtect.yara'
const ARCH = { 'darwin-arm64': 'arm64', 'darwin-x64': 'x86_64' }

if (process.platform !== 'darwin')
  throw new Error('机器人插件只能在 macOS 上构建（要 swiftc、codesign、iconutil）')
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(ARCH)
for (const t of targets)
  if (!(t in ARCH)) throw new Error(`未知平台 ${t}，可选：${Object.keys(ARCH).join(' ')}`)
if (!existsSync(XPROTECT)) throw new Error(`找不到 ${XPROTECT}，没法做 XProtect 自查`)
try {
  execFileSync('yara', ['--version'], { stdio: 'ignore' })
} catch {
  throw new Error('缺 yara（brew install yara）：打包前要用 XProtect 规则自查二进制')
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts })
const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
const work = mkdtempSync(join(tmpdir(), 'robot-build-'))

// 宿主侧 TS：拉起 .app、开关命令。cjs + external vscode，同 companion
await build({
  entryPoints: [join(dir, 'src/extension.ts')],
  outfile: join(dir, 'dist/extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  logLevel: 'warning',
  // 产物里的源码路径注释按它算：不固定的话，从仓库根和从 packages/robot 跑出的包不一样
  absWorkingDir: root,
})

// .app 图标：assets/icon.png（默认皮肤 idle，1024px）缩出 iconset
const iconset = join(work, 'AppIcon.iconset')
mkdirSync(iconset)
for (const s of [16, 32, 128, 256, 512]) {
  for (const [scale, suffix] of [
    [1, ''],
    [2, '@2x'],
  ]) {
    const px = String(s * scale)
    run('sips', [
      '-z',
      px,
      px,
      join(dir, 'assets/icon.png'),
      '--out',
      join(iconset, `icon_${s}x${s}${suffix}.png`),
    ])
  }
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(work, 'AppIcon.icns')])

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.simplecode.robot</string>
  <key>CFBundleName</key><string>SimpleCode Robot</string>
  <key>CFBundleExecutable</key><string>SimpleCodeRobot</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`

const sources = readdirSync(join(dir, 'app'))
  .filter((f) => f.endsWith('.swift'))
  .map((f) => join(dir, 'app', f))

for (const target of targets) {
  const app = join(dir, 'dist/SimpleCodeRobot.app')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
  const bin = join(app, 'Contents/MacOS/SimpleCodeRobot')
  run('swiftc', [
    '-O',
    '-target',
    `${ARCH[target]}-apple-macos13`,
    ...sources,
    '-framework',
    'Cocoa',
    '-o',
    bin,
  ])
  writeFileSync(join(app, 'Contents/Info.plist'), plist)
  cpSync(join(work, 'AppIcon.icns'), join(app, 'Contents/Resources/AppIcon.icns'))
  // 只内置 default 一套（用户定 2026-10-31），其余皮肤用户自己放 ~/.simple-code/robot/skins
  cpSync(join(dir, 'skins/default'), join(app, 'Contents/Resources/skins/default'), {
    recursive: true,
  })
  // ad-hoc 签名：arm64 不签不能跑；签整包让资源也进签名
  run('codesign', ['--force', '--sign', '-', app])
  // yara 有命中时打印「规则名 路径」，没命中无输出
  const hits = run('yara', ['-r', XPROTECT, app]).trim()
  if (hits !== '')
    throw new Error(
      `XProtect 规则命中，不能打包（会被系统当恶意软件删掉）：\n${hits}\n用 yara -s 看命中串，改掉对应的符号名`,
    )

  const out = join(dir, `simplecode-robot-${target}-${version}.vsix`)
  run(
    join(root, 'node_modules/.bin/vsce'),
    ['package', '--no-dependencies', '--target', target, '--out', out],
    {
      cwd: dir,
      stdio: 'inherit',
    },
  )
  console.log(`✓ ${target} → ${out}`)
}
rmSync(work, { recursive: true, force: true })
