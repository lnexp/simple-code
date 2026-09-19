import { describe, expect, test } from 'vitest'
import { callMcpTool, listMcpTools, type McpServerConfig } from '../src/tools/mcp.ts'

/** 夹具配置：node 跑本目录下的 fake-mcp-server.mjs（SDK 真 server） */
const cfg: McpServerConfig = {
  command: process.execPath,
  args: [new URL('./fixtures/fake-mcp-server.mjs', import.meta.url).pathname],
}

describe('mcp：listMcpTools', () => {
  test('列出工具名与 schema', async () => {
    const tools = await listMcpTools(cfg)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['add', 'echo'])
    const echo = tools.find((t) => t.name === 'echo')
    expect(echo?.description).toBe('回显文本')
    expect((echo?.inputSchema as { required?: string[] }).required).toEqual(['text'])
  })
})

describe('mcp：callMcpTool', () => {
  test('add(2,40) → 42', async () => {
    const r = await callMcpTool(cfg, 'add', '{"a":2,"b":40}')
    expect(r).toEqual({ isError: false, text: '42' })
  })
  test('echo 回显', async () => {
    const r = await callMcpTool(cfg, 'echo', '{"text":"你好"}')
    expect(r.text).toBe('echo: 你好')
  })
  test('空参数体 = 空对象', async () => {
    // 无参工具的常见形态：mcp <server> <tool> 不带第三参
    const r = await callMcpTool(cfg, 'echo', '')
    expect(r.text).toBe('echo: undefined')
  })
  test('未知工具 → isError 透传', async () => {
    const r = await callMcpTool(cfg, 'nope', '{}')
    expect(r.isError).toBe(true)
    expect(r.text).toContain('unknown tool nope')
  })
  test('非法 JSON → 本地报错，不连 server', async () => {
    await expect(callMcpTool(cfg, 'echo', '{oops}')).rejects.toThrow('参数不是合法 JSON')
  })
  test('起不来的 command → 连接报错', async () => {
    await expect(
      listMcpTools({ command: '/nonexistent-bin-xyz', args: [] }),
    ).rejects.toThrow()
  })
})
