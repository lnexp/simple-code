import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * 构建产物的冒烟测试。
 *
 * **为什么其他 426 个测试盖不住这条路**：它们跑在 vitest 里，加载的是源码
 * `.ts`，而 vitest 有自己的解析器。产物走的是另一条路——Node 直接加载一个
 * 打包后的 `.js`。tsconfig.base.json 的注释里记着同类的坑：无扩展名 import
 * 在 vitest 下能过、`node sc-bin.ts` 起不来，测试全绿也照样暴露不出来。
 *
 * 这里只验「打得出来 + 起得来」，不验对话行为——那是 run.test.ts 的事，
 * 在这里重测一遍要真实 API key，没有对应的收益。
 */

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../..', import.meta.url))
const bundle = `${root}packages/cli/dist/sc.js`

describe('构建产物', () => {
  beforeAll(async () => {
    // 先删掉，否则上一次的残留能让「构建其实失败了」照样绿
    await rm(`${root}packages/cli/dist`, { recursive: true, force: true })
    await exec('node', ['scripts/build.mjs'], { cwd: root })
  }, 60_000)

  it('打出来的单文件能被 Node 直接执行', async () => {
    const { stdout } = await exec(bundle, ['--help'])
    expect(stdout).toContain('用法：sc')
  })

  it('**产物自带执行位**', async () => {
    // 执行位是 esbuild 看到 shebang 后自己加的，构建脚本里没有 chmod。
    // 断言的是这个行为别哪天变了：没有执行位时 `./main.js` 是
    // Permission denied，而 `node main.js` 照样能跑——只在分发时发作
    const mode = (await stat(bundle)).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('**shebang 压掉了 node:sqlite 的实验性警告**', async () => {
    // 走 shebang（execFile 直接执行文件，内核按 shebang 起进程）
    const viaShebang = await exec(bundle, ['--help'])
    expect(viaShebang.stderr).not.toContain('ExperimentalWarning')

    // 对照组：绕过 shebang 用 node 跑，警告必须出现。
    // 没有这一半的话，将来 node 不再警告了，上面那条会以「压制生效」的
    // 面目继续绿着——而那时 shebang 里的 flag 早已可以删掉却没人知道
    const viaNode = await exec('node', [bundle, '--help'])
    expect(viaNode.stderr).toContain('ExperimentalWarning')
  })
})

describe('真入口判定', () => {
  it('经改名路径执行也走真入口（symlink 场景）', async () => {
    // ~/.simple-code/bin/sc 部署时 argv[1] 不带 .js——曾因此静默空跑
    // 链接必须真叫 sc（basename 判定认的就是这个名字）
    const dir = await mkdtemp(join(tmpdir(), 'sc-link-'))
    const link = join(dir, 'sc')
    await exec('ln', ['-sf', bundle, link])
    try {
      const { stdout } = await exec(link, ['--help'])
      expect(stdout).toContain('用法：sc')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
