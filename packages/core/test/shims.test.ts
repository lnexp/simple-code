import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDocCopy, ensureShims, resolveNodeBin } from '../src/shims.ts'

const run = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs.length = 0
})

describe('shims（宿主内置 Node 优先、系统 node 兜底）', () => {
  it('清除退役 lesson 的自有 shim，保留用户同名脚本', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'sc-retired-'))
    dirs.push(binDir)
    const path = join(binDir, 'sc-lesson')
    await writeFile(path, '#!/bin/sh\n# SimpleCode 自动生成\nnode /old/lesson.js')
    await ensureShims([], { binDir, nodeBin: process.execPath })
    await expect(readFile(path)).rejects.toThrow()
    await writeFile(path, '#!/bin/sh\necho custom')
    await ensureShims([], { binDir, nodeBin: process.execPath })
    expect(await readFile(path, 'utf8')).toContain('custom')
  })
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

describe('ensureDocCopy（self.md 拷到 bin 目录，读它不弹隐藏路径卡）', () => {
  it('拷贝内容并返回拷贝路径；没变不重写，变了重写', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'sc-doc-'))
    const srcDir = await mkdtemp(join(tmpdir(), 'sc-doc-src-'))
    dirs.push(binDir, srcDir)
    const src = join(srcDir, 'self.md')
    await writeFile(src, '# 教程 v1\n')
    const path = ensureDocCopy(src, binDir)
    expect(path).toBe(join(binDir, 'self.md'))
    expect(await readFile(path, 'utf8')).toBe('# 教程 v1\n')
    const before = (await stat(path)).mtimeMs
    ensureDocCopy(src, binDir)
    expect((await stat(path)).mtimeMs).toBe(before)
    await writeFile(src, '# 教程 v2\n')
    ensureDocCopy(src, binDir)
    expect(await readFile(path, 'utf8')).toBe('# 教程 v2\n')
  })
})
