import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * package.json 的贡献点。**这些字段写错了 VS Code 不报错**，只是行为不对：
 * 面板出现在别处、或者干脆不出现。
 *
 * 加这个文件的直接原因是踩过一次同类的坑：`main` 指向 `.js` 而包是
 * `type: module`，产物内容完全正确，扩展却激活失败——测试全绿，装进去才发现。
 */

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  main: string
  activationEvents: string[]
  contributes: {
    viewsContainers: Record<string, { id: string; icon: string }[]>
    views: Record<string, { id: string; type?: string; when?: string }[]>
  }
}

describe('扩展清单', () => {
  it('**面板挂在右侧副侧边栏**', () => {
    // VS Code 主位置是副侧边栏；activitybar 那份是 Cursor 专用（Cursor 拒
    // 第三方副栏容器）。完整历史在 package.json 的 $comment
    expect(Object.keys(pkg.contributes.viewsContainers).sort())
      .toEqual(['activitybar', 'secondarySidebar'])
  })

  it('双注册互斥：两套 view 都带 when，且条件互补', () => {
    // Cursor 拒第三方副栏容器（见 package.json $comment），双注册是定案；
    // 漏了 when 会让同一时刻两个入口都活着——两个 webview 实例抢一个 provider
    const side = pkg.contributes.views['simple-code']?.[0]
    const act = pkg.contributes.views['simple-code-activity']?.[0]
    expect(side?.when).toBe('!simpleCode.noSecondarySidebar')
    expect(act?.when).toBe('simpleCode.noSecondarySidebar')
  })

  it('view 的 id 和 panel.ts 里的 viewType 一致', () => {
    // 对不上的话 registerWebviewViewProvider 注册的是另一个 id，
    // 面板永远空白——不报错
    const source = readFileSync(fileURLToPath(new URL('../src/panel.ts', import.meta.url)), 'utf8')
    const viewId = pkg.contributes.views['simple-code']?.[0]?.id
    expect(viewId).toBeDefined()
    expect(source).toContain(`'${viewId}'`)
    // Cursor 侧的 view id 也要在（对不上的话注册的是另一个 id，面板空白不报错）
    expect(source).toContain(`'${pkg.contributes.views['simple-code-activity']?.[0]?.id}'`)
  })

  it('view 类型是 webview', () => {
    // 漏了 type 的话 VS Code 当成 tree view，resolveWebviewView 永远不被调用
    expect(pkg.contributes.views['simple-code']?.[0]?.type).toBe('webview')
  })

  it('容器 id 和 views 的 key 对得上', () => {
    // 对不上时 view 会回落进 Explorer
    const sideId = pkg.contributes.viewsContainers.secondarySidebar?.[0]?.id
    const actId = pkg.contributes.viewsContainers.activitybar?.[0]?.id
    expect([sideId, actId]).toEqual(['simple-code', 'simple-code-activity'])
    expect(Object.keys(pkg.contributes.views).sort()).toEqual([actId, sideId].sort())
  })

  it('main 指向 .cjs', () => {
    // 踩过：叫 .js 的话宿主按 ESM 加载 CJS 产物，激活失败，
    // 界面上只表现为面板一直转圈（build.test.ts 有对应的加载测试）
    expect(pkg.main).toMatch(/\.cjs$/)
  })
})
