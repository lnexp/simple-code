import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * 扩展产物的冒烟测试。**这里每一条都对应一种「配错了不报错，装进编辑器
 * 才白屏」的情况**——而那时报错信息指向 minify 后的行号，等于没有。
 *
 * 单测盖不到这些：它们跑在 vitest 里加载源码 `.ts`，而产物走的是另一条路
 * （扩展宿主 require CJS、浏览器加载 ESM）。
 */

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../..', import.meta.url))
const pkgDir = `${root}packages/vscode`
const dist = `${pkgDir}/dist`

/**
 * **从 package.json 的 `main` 读，不写死路径。** 写死的话改了 main 忘了改
 * 测试，测试会继续测那个已经没人加载的旧文件——绿着，但测的是死代码
 */
const mainPath = `${pkgDir}/${(JSON.parse(readFileSync(`${pkgDir}/package.json`, 'utf8')) as { main: string }).main.replace(/^\.\//, '')}`

let extension = ''
let webview = ''

describe('扩展构建产物', () => {
  beforeAll(async () => {
    // 先删。上一次的残留能让「这次构建其实失败了」照样绿
    await rm(dist, { recursive: true, force: true })
    await exec('node', ['scripts/build.mjs'], { cwd: root })
    extension = await readFile(mainPath, 'utf8')
    webview = await readFile(`${dist}/webview.js`, 'utf8')
  }, 90_000)

  describe('扩展宿主侧', () => {
    it('**Node 真的能 require 它**', () => {
      // 这条是踩过坑之后加的。原来只断言了「产物内容是 CJS」（下一条），
      // 而**真正决定加载方式的是扩展名 + package.json 的 type**：产物内容
      // 完全正确，但叫 extension.js + type:module，宿主按 ESM 加载，
      // 报「This file is being treated as an ES module」，激活直接失败。
      //
      // 界面上的表现只是面板一直转圈——没有任何报错弹窗，日志里才看得到。
      //
      // require 成功即证明整条加载路径通了。exports 里必须有 activate，
      // 否则 VS Code 拿不到入口（同样只表现为"没反应"）
      // `vscode` 是宿主注入的，测试进程里没有。**它解析失败恰好是好消息**：
      // 说明加载已经走过了 ESM/CJS 判定那一关（那发生在加载文件本身时，
      // 早于解析依赖），正卡在「找不到 vscode」——而那在真宿主里不会发生。
      //
      // 所以判据是「**没有**报 ES module 那个错」，而不是「加载成功」。
      // 直接断言成功的话要造一整套 vscode stub，那测的就是 stub 的完整度了
      const require = createRequire(import.meta.url)
      let message = ''
      try {
        const required = require(mainPath)
        // 真能加载（比如将来 external 变了）就顺带查一下入口
        expect(typeof required.activate).toBe('function')
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).not.toContain('ES module')
      expect(message).not.toContain('Cannot use import statement')
      // 前提断言：确实走到了解析 vscode 那一步，而不是在更早的地方就挂了
      if (message !== '') expect(message).toContain("Cannot find module 'vscode'")
    })

    it('产物内容是 CJS', () => {
      expect(extension).toContain('"use strict"')
      expect(extension).not.toMatch(/^\s*import\s/m)
    })

    it('**vscode 保持 external**', () => {
      // 不 external 会构建失败（磁盘上没这个包），所以这条主要防的是
      // 反向：有人为了"修构建"把它打进去
      expect(extension).toContain('require("vscode")')
    })

    it('core 打进去了，不是 external', () => {
      // 前提断言：确认下面几条测的是真的打进来的 core 代码
      expect(extension).toContain('DatabaseSync')
      expect(extension).not.toContain('require("@simple-code/core")')
    })
  })

  describe('webview 侧', () => {
    it('不含 process.env', () => {
      // webview 里没有 process，留下引用就是白屏。
      //
      // **这条现在是空转的**：变异检验显示去掉 build.mjs 里的 define 之后
      // 产物一模一样——platform: 'browser' 自带这个 define。留着是因为哪天
      // 有人把 platform 改了（或自己写了 process.xxx），它会红
      expect(webview).not.toContain('process.env')
    })

    it('不含 node 模块引用', () => {
      // tsconfig.webview.json 保留了 @types/node（因为 core 的类型定义要它），
      // 所以类型层面挡不住误用 node API——这条断言是那道防线。
      //
      // **同样是空转的**：我们的 webview 代码目前一个 node 模块都没引用，
      // 所以 platform 换成 node 它也照样绿。它防的是将来
      expect(webview).not.toMatch(/require\(["']node:/)
      expect(webview).not.toMatch(/from\s*["']node:/)
      expect(webview).not.toContain('require(')
    })

    it('**不含 eval / new Function**', () => {
      // CSP 里没开 unsafe-eval（html.ts）。产物里有 eval 就会被拦，
      // 表现是控制台一行 CSP 报错 + 白屏
      expect(webview).not.toMatch(/\beval\(/)
      expect(webview).not.toContain('new Function')
    })

    it('**不含 navigator 引用（远端 exthost 迁移守卫）**', () => {
      // zod 的 Cloudflare 探测（typeof navigator）在远端 vscode-server 的
      // exthost 里炸：那里 navigator 是 VS Code 的 PendingMigrationError
      // 迁移守卫（throwing getter），typeof 也触发 getter 直接抛错，模块
      // 加载即失败——本机 Electron exthost 的 navigator 是真全局，本机
      // 永远复现不了（2026-09-27 memeda 远端首装暴露）。build.mjs 用
      // define 把 navigator 钉成 undefined（探测分支被常量折叠整体消除），
      // 这两条断言锁住 define 不被弄丢。webview 是浏览器，navigator 是
      // 真的，不受此限
      expect(extension).not.toContain('typeof navigator')
      expect(extension).not.toMatch(/navigator\?\./)
      // companion 同款（UI kind 只跑本机，但同款代码同款风险）
      const companion = readFileSync(`${root}packages/companion/dist/extension.cjs`, 'utf8')
      expect(companion).not.toContain('typeof navigator')
      expect(companion).not.toMatch(/navigator\?\./)
    })

    it('**构建确定：模块路径标签一律根相对（absWorkingDir 钉死）**', () => {
      // esbuild 把模块路径打进 bundle（sourcemap 注释 + 模块名字符串），
      // 相对谁算默认取 process.cwd()——不钉 absWorkingDir 的话，仓库根
      // `node scripts/build.mjs` 与 packages/* 下 `pnpm run package` 产出
      // 同码不同 md5 的产物（2026-09-27 实案：374a/cb4d/7fe6 三版），
      // 「md5 一致 = 装机一致」的判据被 cwd 漂移污染。根相对（不带
      // ../ 前缀）是钉死后的唯一形态，出现 ../../ 前缀即 define 回归
      for (const f of ['packages/vscode/dist/extension.cjs', 'packages/companion/dist/extension.cjs']) {
        expect(readFileSync(`${root}${f}`, 'utf8')).not.toContain('"../../node_modules/')
      }
    })

    it('**没把 core 打进来**', () => {
      // webview 只 import type，运行时不该有 core 的一行代码。真打进来的话
      // 产物里会出现 SQLite、子进程 spawn 这些浏览器里根本不存在的东西
      for (const marker of ['DatabaseSync', 'getSession', 'acquireLock']) {
        expect(webview).not.toContain(marker)
      }
    })

    it('React 确实打进来了', () => {
      // 前提断言：上面那些 not.toContain 若因为产物是空文件而通过，
      // 整组测试就毫无意义
      expect(webview.length).toBeGreaterThan(100_000)
      expect(webview).toContain('react')
    })
  })

  /**
   * codicon 这条链上每一环断了都**不报错**，表现统一是「图标位置空着」，
   * 而空白方框很容易被当成设计如此。三环各钉一条。
   */
  describe('codicon 资源', () => {
    it('css 和字体都进了 dist', async () => {
      // esbuild 不管这两个文件，是 build.mjs 手动拷的——漏拷不影响构建成功
      await expect(readFile(`${dist}/codicon.css`, 'utf8')).resolves.toContain('codicon')
      const font = await readFile(`${dist}/codicon.ttf`)
      expect(font.length).toBeGreaterThan(10_000)
    })

    it('**字体和 css 同目录**', async () => {
      // codicon.css 里是 url("./codicon.ttf?<hash>") 的相对引用。把字体拷到
      // 别处（或忘了拷）时 css 照样加载成功，只有字体 404 —— 图标全空
      const css = await readFile(`${dist}/codicon.css`, 'utf8')
      expect(css).toMatch(/url\(["']?\.\/codicon\.ttf/)
    })

    it('**没被 .vscodeignore 挡在 vsix 外**', async () => {
      // .vscodeignore 排除了 **/*.ts 和 **/*.map。将来有人加一条更宽的规则
      // （比如 dist/** 再找回来）就可能顺手把这两个漏掉，而 vsce 不会提醒
      const ignore = await readFile(`${pkgDir}/.vscodeignore`, 'utf8')
      const patterns = ignore
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
      for (const pattern of patterns) {
        expect(pattern).not.toMatch(/^!?dist/)
        expect(pattern).not.toMatch(/css|ttf/)
      }
    })
  })
})
