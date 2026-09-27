import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LLM_PROXY_PORT } from '@simple-code/core'

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const pkg = JSON.parse(read('../package.json'))

describe('伴生扩展接线（manifest 级）', () => {
  it('UI kind + 启动激活 + main 指向 dist——装在本机侧、远端窗口也在本机跑', () => {
    expect(pkg.extensionKind).toEqual(['ui'])
    expect(pkg.activationEvents).toContain('onStartupFinished')
    expect(pkg.main).toBe('./dist/extension.cjs')
  })

  it('id 命名稳定 + 主扩展不得声明 extensionDependencies（跨宿主激活死循环）', () => {
    const main = JSON.parse(read('../../vscode/package.json'))
    const id = `${main.publisher}.${String(pkg.name).toLowerCase()}`
    // id 是 guidance 卡/文档引用的名字，钉住防改名
    expect(id).toBe('lnexp.simplecode-companion')
    // 2026-09-25 实测：主扩展（远端宿主）声明依赖伴生（UI kind，只在本机
    // 宿主）→ 远端永远解析不到 → 主扩展激活失败 + reload 循环。依赖只能
    // 靠文档/指引卡引导安装，不能硬声明
    expect(main.extensionDependencies).toBeUndefined()
  })

  it('代理监听口与主扩展/ssh 转发行共用 core 常量（错一处整条链路断）', async () => {
    expect(LLM_PROXY_PORT).toBe(15432)
    const ext = read('../src/extension.ts')
    expect(ext).toContain(`server.listen(LLM_PROXY_PORT, '127.0.0.1'`)
    const ssh = read('../src/ssh-config.ts')
    // 转发行文本已搬进 core/remote.ts（主扩展指引卡同一份）——断言两处：
    // core 里是模板串（常量引用而非字面量），companion 用的是 forwardBlock
    const core = read('../../core/src/remote.ts')
    expect(core).toContain('RemoteForward ${LLM_PROXY_PORT} 127.0.0.1:${LLM_PROXY_PORT}')
    expect(ssh).toContain('forwardBlock(host)')
    const remote = read('../../vscode/src/remote.ts')
    expect(remote).toContain('LLM_PROXY_PORT as PROXY_PORT')
  })

  it('弹窗前置：只有 ssh-remote 窗口、没说过不再提示才弹；不查远端主扩展', () => {
    const ext = read('../src/extension.ts')
    expect(ext).toContain("remoteName !== 'ssh-remote'")
    expect(ext).toContain('sshPromptDeclined')
    // 2026-09-26 实测：getExtension 跨扩展宿主不可见——远端宿主里的主扩展
    // 本机宿主永远看不到，那道闸让弹窗对所有远程用户永久静默（方案 A 撤闸）
    expect(ext).not.toContain('MAIN_EXT_ID')
    expect(ext).not.toContain('vscode.extensions.getExtension')
  })
})
