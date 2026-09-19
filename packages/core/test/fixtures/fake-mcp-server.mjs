// 测试夹具：真的 MCP server（SDK Server 实现），协议行为是真的。
// 工具：echo(text) 回显；add(a,b) 求和；未知工具 → isError
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const s = new Server({ name: 'fake', version: '0.0.0' }, { capabilities: { tools: {} } })
s.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: '回显文本',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: '两数相加',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  ],
}))
s.setRequestHandler(CallToolRequestSchema, (req) => {
  const a = req.params.arguments ?? {}
  if (req.params.name === 'echo')
    return { content: [{ type: 'text', text: `echo: ${a.text}` }] }
  if (req.params.name === 'add')
    return { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] }
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] }
})
await s.connect(new StdioServerTransport())
