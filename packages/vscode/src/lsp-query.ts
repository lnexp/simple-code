/**
 * LSP 查询的纯逻辑层：给定「命令+位置」，调宿主的 execute*Provider，
 * 把结果格式化成模型好读的文本。不 import vscode（执行器注入）——
 * 这样它可以直接进 vitest；lsp-bridge.ts 只做 http + vscode 胶水。
 *
 * 位置一律 1-based（`file.ts:120:5`，模型友好，与主流 LSP 工具同口径）。
 * 空结果不是错误：返回一句「无结果」让模型知道该换路（grep 回落），
 * 而不是对着 exit code 猜。
 */

/** executeCommand 的注入形态。真实实现是 vscode.commands.executeCommand */
export type Exec = (command: string, ...args: unknown[]) => Promise<any>

export type LspRequest = { cmd: string; file: string; line: number; col: number }

const COMMANDS: Record<string, string> = {
  definition: 'vscode.executeDefinitionProvider',
  refs: 'vscode.executeReferenceProvider',
  symbols: 'vscode.executeDocumentSymbolProvider',
  hover: 'vscode.executeHoverProvider',
}

export const LSP_COMMANDS = [...Object.keys(COMMANDS), 'calls-in', 'calls-out'] as const

const loc = (l: any): string => {
  // definition 返回 LocationLink[]（targetUri/targetSelectionRange），
  // refs 返回 Location[]（uri/range）——两种都接。实测首版只认后者，
  // definition 全被过滤成空（教训：provider 返回形态不统一）
  const uri = l?.uri ?? l?.targetUri
  const line = (l?.range?.start?.line ?? l?.targetSelectionRange?.start?.line ?? 0) + 1
  return uri?.fsPath ? `${uri.fsPath}:${line}` : '?'
}

const formatSymbols = (syms: any[], depth = 0): string[] =>
  syms.flatMap((s) => {
    // DocumentSymbol（层级形态）与 SymbolInformation（平铺形态）都接——
    // 不同语言的 provider 返回哪种不一定
    const line = `${'  '.repeat(depth)}${(s.range?.start?.line ?? s.location?.range?.start?.line ?? 0) + 1}  ${s.name}`
    return [line, ...(s.children ? formatSymbols(s.children, depth + 1) : [])]
  })

export async function handleQuery(exec: Exec, req: LspRequest): Promise<string> {
  const { cmd, file, line, col } = req
  const fsPath = file
  const providerCmd = COMMANDS[cmd]
  if (providerCmd !== undefined) {
    const res = await exec(providerCmd, { scheme: 'file', path: fsPath } as any, { line: line - 1, character: col - 1 } as any)
    if (cmd === 'symbols') {
      const lines = formatSymbols(res ?? [])
      return lines.length > 0 ? lines.join('\n') : '无结果：该文件没有语言服务，或文件为空'
    }
    if (cmd === 'hover') {
      const texts = (res ?? []).map((h: any) => {
        const c = Array.isArray(h.contents) ? h.contents : [h.contents]
        return c.map((x: any) => (typeof x === 'string' ? x : x?.value ?? '')).join('\n')
      }).filter(Boolean)
      return texts.length > 0 ? texts.join('\n---\n') : '无结果：该位置没有 hover 信息'
    }
    const locs = (res ?? []).map(loc).filter((s: string) => !s.startsWith('?'))
    return locs.length > 0 ? locs.join('\n') : '无结果：没找到定义/引用（或该文件类型没有语言服务）'
  }
  if (cmd === 'calls-in' || cmd === 'calls-out') {
    // VS Code 只公开了 prepare（executeCallHierarchyProvider）；incoming/
    // outgoing 没有内置 execute 命令（实测 not found）。prepare 能拿 item
    // 但展开不了方向——等上游补命令再上真调用层级；眼下用 refs 近似：
    // 定义处全部引用 = 调用方的超集（含类型引用），标注清楚不冒充精确
    const viaRefs = await exec('vscode.executeReferenceProvider', { scheme: 'file', path: fsPath } as any, { line: line - 1, character: col - 1 } as any)
    const locs = (viaRefs ?? []).map(loc).filter((s: string) => !s.startsWith('?'))
    return locs.length > 0
      ? `（近似——宿主未公开调用层级展开命令，以下是全部引用，含类型引用）\n${locs.join('\n')}`
      : '无结果：该位置没有符号（或没有引用）'
  }
  return `未知命令 ${cmd}。可用：${LSP_COMMANDS.join(' | ')}`
}
