import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureShims, resolveNodeBin } from '../src/shims.ts'

const run = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})

describe('shims（宿主内置 Node 优先、系统 node 兜底）', () => {
  it('写 shim 并真的能跑：参数透传、输出回收', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'sc-shim-'))
    const scriptDir = await mkdtemp(join(tmpdir(), 'sc-script-'))
    dirs.push(binDir, scriptDir)
    // 路径带空格是常态（…/Code Helper (Plugin)），一并验转义
    const script = join(scriptDir, 'space dir', 'echo-bin.js')
    await mkdir(join(scriptDir, 'space dir'))
    await writeFile(script, 'console.log("ok", process.argv.slice(2).join(" "))\n')
    const shims = await ensureShims(
      [{ name: 'TEST', bin: 'sc-test', script }],
      { binDir, nodeBin: process.execPath },
    )
    const { stdout } = await run(shims.TEST!, ['a', 'b c'])
    expect(stdout).toBe('ok a b c\n')
  })

  it('幂等：内容没变不重写（mtime 不变）；变了先删再写', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'sc-shim-'))
    dirs.push(binDir)
    const entries = [{ name: 'TEST', bin: 'sc-test', script: '/x/apply-patch.js' }]
    await ensureShims(entries, { binDir, nodeBin: process.execPath })
    const before = (await stat(join(binDir, 'sc-test'))).mtimeMs
    await ensureShims(entries, { binDir, nodeBin: process.execPath })
    expect((await stat(join(binDir, 'sc-test'))).mtimeMs).toBe(before)
    // node 换了 → 内容变 → 重写
    await ensureShims(entries, { binDir, nodeBin: '/other/node' })
    expect((await stat(join(binDir, 'sc-test'))).mtimeMs).toBeGreaterThanOrEqual(before)
    expect(await readFile(join(binDir, 'sc-test'), 'utf8')).toContain('/other/node')
  })

  it('路径上是软链时替换链接而不是写穿目标（deploy.mjs 的 sc 软链场景）', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'sc-shim-'))
    const targetDir = await mkdtemp(join(tmpdir(), 'sc-target-'))
    dirs.push(binDir, targetDir)
    const target = join(targetDir, 'real-sc.js')
    await writeFile(target, '真实脚本内容，被写穿就毁了\n')
    await symlink(target, join(binDir, 'sc'))
    await ensureShims([{ name: 'SC', bin: 'sc', script: '/x/sc.js' }], { binDir, nodeBin: process.execPath })
    // 链接被替换成普通文件，目标原封不动
    expect((await lstat(join(binDir, 'sc'))).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toContain('真实脚本内容')
  })

  it('权限兜底：即使内容没变也保证可执行位', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'sc-shim-'))
    dirs.push(binDir)
    const entries = [{ name: 'TEST', bin: 'sc-test', script: '/x/note.js' }]
    await ensureShims(entries, { binDir, nodeBin: process.execPath })
    await chmod(join(binDir, 'sc-test'), 0o644)
    await ensureShims(entries, { binDir, nodeBin: process.execPath })
    expect((await stat(join(binDir, 'sc-test'))).mode & 0o111).not.toBe(0)
  })

  it('探测失败回落系统 node 字面量', async () => {
    expect(await resolveNodeBin('/nonexistent/node')).toBe('node')
    // 本进程的 node 能跑 node:sqlite——正常路径命中 candidate
    expect(await resolveNodeBin(process.execPath)).toBe(process.execPath)
  })
})
