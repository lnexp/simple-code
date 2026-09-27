/**
 * 伴生扩展（UI kind，跑在用户本机的扩展宿主里）。**只做接线**——逻辑在
 * proxy.ts / ssh-config.ts（不 import vscode，测试直接跑），本文件每多一个
 * if 都该问能不能挪过去。
 *
 * 两个职责：
 * ① 本机代理（proxy.ts）：Remote-SSH 时远端的模型请求经隧道回到这里转发。
 *    端口被占（老用户的 launchd 版代理、或另一个窗口的伴生实例）就静默让位
 * ② ssh config 自动配置（ssh-config.ts）：连接 SSH 远端时检测缺
 *    RemoteForward → 弹确认框 → 自动追加。替代手动粘贴
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { LLM_PROXY_PORT } from '@simple-code/core'
import { SETTINGS_PATH, createProxyServer } from './proxy.ts'
import { appendForwardBlock, forwardLine, hasForwardForHost, sshConfigPath } from './ssh-config.ts'

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SimpleCode Companion')
  // 请求日志沿用 ~/.simple-code/logs/llm-proxy.jsonl——launchd 版留下的排障
  // 入口（tail 这个文件验证隧道）不变；OutputChannel 是给人看的副本
  const log = (obj: Record<string, unknown>): void => {
    output.appendLine(JSON.stringify(obj))
    try {
      const dir = join(homedir(), '.simple-code', 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'llm-proxy.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n')
    } catch {
      /* 日志失败不拦请求 */
    }
  }
  const server = createProxyServer({
    readSettings: () =>
      JSON.parse(readFileSync(join(homedir(), '.simple-code', 'settings.json'), 'utf8')),
    log,
  })
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE')
      output.appendLine(
        `端口 ${LLM_PROXY_PORT} 已被占用（本机已有代理在跑——launchd 版或另一个窗口的伴生实例），伴生代理让位。`,
      )
    else output.appendLine(`代理出错: ${e.message}`)
  })
  server.listen(LLM_PROXY_PORT, '127.0.0.1', () => {
    output.appendLine(`伴生代理 listening 127.0.0.1:${LLM_PROXY_PORT}（${SETTINGS_PATH} + /sc-p/<provider>/… 转发）`)
  })
  context.subscriptions.push(
    { dispose: () => server.close() },
    output,
  )
  void offerForward(context, output)
}

/**
 * 连接 SSH 远端时（本窗口是远端窗口 + 本机 ssh config 缺该主机的转发 +
 * 用户没说过不再提示）弹一次确认框。
 *
 * 每条提前退出都写 OutputChannel——弹窗没出时从这里定位是哪条（2026-09-25
 * 实测：用户装完远端 VSIX 后弹窗没出，三个候选原因全在黑盒里）。
 *
 * 不查「远端装了主扩展」：2026-09-26 实测坐实 getExtension 跨扩展宿主
 * 不可见——伴生（本机宿主）永远看不到远端宿主里的主扩展，onDidChange
 * 也不为远端注册触发，那道闸对远程用户等于永久静默（弹窗全死）。撤闸
 * 的代价：没装 SC 的远端也会弹一次——每台主机一次、可「不再提示这台」
 * 关掉，装伴生的本就是 SC 用户，可接受（方案 A，2026-09-26 拍板）。
 */
async function offerForward(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (vscode.env.remoteName !== 'ssh-remote') {
    output.appendLine(`[ssh] 非远端窗口（remoteName=${vscode.env.remoteName ?? '本机'}），不弹`)
    return
  }
  const authority = vscode.workspace.workspaceFolders?.[0]?.uri.authority ?? ''
  if (!authority.startsWith('ssh-remote+')) {
    output.appendLine(`[ssh] workspace authority 不是 ssh-remote（${authority || '空'}），不弹`)
    return
  }
  const host = authority.slice('ssh-remote+'.length)
  if (!host) {
    output.appendLine('[ssh] authority 里没解析出主机名，不弹')
    return
  }
  void offer(context, output, host)
}

/** 条件齐了，查 ssh config 决定弹不弹 */
async function offer(context: vscode.ExtensionContext, output: vscode.OutputChannel, host: string): Promise<void> {
  let text = ''
  try {
    text = readFileSync(sshConfigPath(), 'utf8')
  } catch {
    /* 没有 config 文件——当作无转发，追加时创建 */
  }
  if (hasForwardForHost(text, host)) {
    output.appendLine(`[ssh] ${host}：ssh config 已有该主机的 RemoteForward，不弹`)
    return
  }
  const declined = context.globalState.get<string[]>('sshPromptDeclined') ?? []
  if (declined.includes(host)) {
    output.appendLine(`[ssh] ${host}：你点过「不再提示这台」，不弹`)
    return
  }
  const add = '自动添加'
  const never = '不再提示这台'
  const choice = await vscode.window.showInformationMessage(
    `SimpleCode：SSH 远端「${host}」的模型请求要走本机网络（key 不出本机），需要反向隧道。` +
      `自动在 ~/.ssh/config 加 ${forwardLine()} 吗？（加完后断开重连一次生效）`,
    add,
    never,
  )
  output.appendLine(`[ssh] ${host}：弹窗已出，选择=${choice ?? '没点（关掉）'}`)
  if (choice === add) {
    try {
      const path = appendForwardBlock(host)
      void vscode.window.showInformationMessage(
        `已写入 ${path}。请断开远端连接再重连一次（Remote-SSH 菜单），隧道即生效。`,
      )
    } catch (e) {
      void vscode.window.showWarningMessage(
        `写入 ssh config 失败: ${e instanceof Error ? e.message : String(e)}（可手动加 ${forwardLine()}）`,
      )
    }
  } else if (choice === never) {
    void context.globalState.update('sshPromptDeclined', [...declined, host])
  }
}
