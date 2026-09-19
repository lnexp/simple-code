/**
 * LSP 桥：activate 时在 127.0.0.1 起一个 mini http server，bin（dist/lsp.js）
 * 把「命令+位置」POST 过来，这里调宿主现成的 execute*Provider，返回
 * 格式化文本。语言服务永远只有宿主这一份，bin 是薄壳。
 *
 * 端口 bind(0) 系统随机分，写进 process.env.SIMPLE_CODE_LSP_PORT——
 * env 沿进程树传播（SIMPLE_CODE_ROOTS 同链路），我 spawn 的 sc 子 agent
 * 的 bash 里 "$SIMPLE_CODE_LSP" 同样可达，且回的就是我这个窗口的宿主
 * （多窗口各起各的桥、各写各的 env，天然不串）。
 *
 * 窗口关闭/扩展停用 → server 死 → bin 收连接拒绝 → 明确报「桥不可用」，
 * 模型回落 grep——有能力就用、没有就降级，不硬崩。
 */
import { createServer, type Server } from 'node:http'
import * as vscode from 'vscode'
import { handleQuery, type LspRequest } from './lsp-query.ts'

export function startLspBridge(): Server {
  // executeCommand 返回 Thenable，桥内部统一 Promise（catch 兜底在 handler 的 try 里）。
  // 参数真对象化：query 层（可测）传 plain object，宿主要 vscode.Uri/Position
  // 实例——shape 判断而不是 instanceof（query 层构造的就这两种形状）
  const materialize = (arg: unknown): unknown => {
    if (arg && typeof arg === 'object' && 'scheme' in (arg as object) && 'path' in (arg as object)) {
      return vscode.Uri.file((arg as { path: string }).path)
    }
    if (arg && typeof arg === 'object' && 'line' in (arg as object) && 'character' in (arg as object)) {
      const p = arg as { line: number; character: number }
      return new vscode.Position(p.line, p.character)
    }
    return arg
  }
  const exec: Parameters<typeof handleQuery>[0] = (command, ...args) =>
    Promise.resolve(vscode.commands.executeCommand(command, ...args.map(materialize)))
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json')
      try {
        const { cmd, file, line, col } = JSON.parse(Buffer.concat(chunks).toString()) as LspRequest
        const uri = vscode.Uri.file(file)
        // 相对路径兜底：bin 侧已 resolve，这里只防手滑传了相对路径
        const abs = uri.scheme === 'file' && file.startsWith('/') ? file : vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? uri, file).fsPath
        // 语言服务只对「宿主感知过的文档」响应——没打开过的文件 TS server
        // 懒启动、execute*Provider 返回空（实测首跑 symbols 全空）。先
        // openTextDocument 轻量加载（不弹窗口），缓存过的文档零开销
        await Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(abs))).catch(() => undefined)
        // 冷启动：openTextDocument 只让 server「开始」加载项目，tsconfig/
        // 依赖解析要时间——就绪前的查询合法地返回空。对「无结果」退避
        // 重试两档（实测大项目 tsserver 初始化 1-3s），就绪后零重试开销
        const query = { cmd, file: abs, line, col } satisfies LspRequest
        let text = await handleQuery(exec, query)
        for (const delay of [400, 1200]) {
          if (!text.includes('无结果')) break
          await new Promise((r) => setTimeout(r, delay))
          text = await handleQuery(exec, query)
        }
        res.end(JSON.stringify({ ok: true, text }))
      } catch (error) {
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      process.env.SIMPLE_CODE_LSP_PORT = String(addr.port)
      // eslint-disable-next-line no-console -- 扩展日志里留一行，排查「桥为什么没起来」用
      console.log(`[simple-code] lsp bridge on 127.0.0.1:${addr.port}`)
    }
  })
  return server
}
