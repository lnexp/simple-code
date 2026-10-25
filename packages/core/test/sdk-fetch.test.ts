import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claudeSdkFetch } from '../src/llm/claude-sdk-fetch.ts'
import { loadSdk } from '../src/llm/claude-sdk-runtime.ts'

let root: string
const servers: Server[] = []
beforeEach(async () => {
  await mkdir(resolve('.simple-code/tmp'), { recursive: true })
  root = await mkdtemp(resolve('.simple-code/tmp/sdk fetch-'))
  const directory = join(root, 'node_modules/@anthropic-ai/claude-agent-sdk')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ version: '0.3.308', type: 'module' }),
  )
  // A real child process exercises HTTP, authentication, exit and cancellation without SDK/network dependencies.
  await writeFile(
    join(directory, 'sdk.mjs'),
    `
    import { once } from 'node:events'
    import { writeFileSync } from 'node:fs'
    export function query({prompt,options:o}) {
      if(o.env.SECRET_TEST || o.env.ANTHROPIC_API_KEY === 'real-key') throw Error('Leaked environment')
      if(o.tools.length || o.settingSources.length || o.persistSession) throw Error('Unsafe SDK options')
      const script = ${JSON.stringify(`
        const http=require('node:http');
        const base=process.env.ANTHROPIC_BASE_URL;
        const body=JSON.stringify({system:[{type:'text',text:'x-anthropic-billing-header: test'}]});
        async function send(key) {
          return new Promise(resolve=>{const r=http.request(base+'/v1/messages?beta=true',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});r.on('error',()=>resolve(0));r.end(body)})
        }
        (async()=>{const denied=await send('wrong');if(denied!==401)process.exit(22);send(process.env.ANTHROPIC_API_KEY);setTimeout(()=>send(process.env.ANTHROPIC_API_KEY),30)})();
        setInterval(()=>{},1000);
      `)}
      if(prompt==='reject') throw Error('SDK initialization failed')
      const code=prompt==='exit'?'process.exit(12)':prompt==='bad-marker'?script.replace('x-anthropic-billing-header: test','wrong marker'):prompt==='wait'?'setInterval(()=>{},1000)':script
      const child=o.spawnClaudeCodeProcess({command:process.execPath,args:['-e',code],cwd:o.cwd,env:o.env})
      if(prompt==='wait') writeFileSync(o.env.HOME+'/spawned',String(child.pid))
      const done=once(child,'exit')
      return { close(){}, async *[Symbol.asyncIterator](){ await done } }
    }
  `,
  )
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
  await rm(root, { recursive: true, force: true })
  delete process.env.SECRET_TEST
})
const body = () => ({
  model: 'test',
  system: [{ type: 'text', text: 'SC owns system' }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  metadata: { user_id: 'test' },
})
const init = (signal = new AbortController().signal) => ({
  method: 'POST',
  headers: { 'x-api-key': 'real-key' },
  body: JSON.stringify(body()),
  signal,
})
async function upstream(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('listen')
  return `http://127.0.0.1:${address.port}/v1/messages`
}
const adapter = () => claudeSdkFetch({ path: root, folder: root })
async function cleaned() {
  const path = join(root, '.simple-code/tmp/claude-agent-sdk')
  // Cancellation can reject the reader before asynchronous process cleanup finishes.
  await expect.poll(async () => await readdir(path).catch(() => []), { timeout: 5000 }).toEqual([])
}
it('保留SC完整body与上游status/headers，只转发一次，真实进程清理', async () => {
  process.env.SECRET_TEST = 'do not inherit'
  let count = 0
  const url = await upstream(async (req, res) => {
    count++
    expect(req.headers['x-api-key']).toBe('real-key')
    expect(req.url).toBe('/v1/messages?beta=true')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const forwarded = JSON.parse(Buffer.concat(chunks).toString())
    expect(forwarded).toEqual({
      ...body(),
      system: [{ type: 'text', text: 'x-anthropic-billing-header: test' }, ...body().system],
    })
    res.writeHead(429, { 'retry-after': '2' })
    setTimeout(() => res.end('controlled error'), 80)
  })
  const response = await adapter()(url, init())
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('2')
  expect(await response.text()).toBe('controlled error')
  expect(count).toBe(1)
  await cleaned()
})
it('预取消不加载外置包、不创建目录、不调用上游', async () => {
  const signal = AbortSignal.abort(new Error('stopped'))
  await expect(
    claudeSdkFetch({ path: '/missing', folder: root })('http://invalid', init(signal)),
  ).rejects.toBe(signal.reason)
  expect(await readdir(root)).toEqual(['node_modules'])
})
it('纯图片首消息拒绝，不伪造文本', async () => {
  const input = init()
  const wire = body() as unknown as { messages: { content: unknown[] }[] }
  wire.messages[0]!.content = [{ type: 'image', source: { type: 'base64', data: 'unused' } }]
  input.body = JSON.stringify(wire)
  await expect(adapter()('http://invalid', input)).rejects.toThrow('纯图片')
})
it('外置版本和缺失目录明确报错，不沿父目录寻找其他SDK', async () => {
  await expect(loadSdk(join(root, 'missing'))).rejects.toThrow('无法从')
  await writeFile(
    join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
    '{"version":"other"}',
  )
  await expect(loadSdk(root)).rejects.toThrow('实际 other')
})
it('等待响应时取消中断上游并释放运行目录', async () => {
  const controller = new AbortController()
  const reason = new Error('user stopped')
  const url = await upstream(async (req) => {
    for await (const _ of req) {
      /* drain */
    }
    controller.abort(reason)
  })
  await expect(adapter()(url, init(controller.signal))).rejects.toBe(reason)
  await cleaned()
})
it('消费者提前取消Response流也结束SDK，不依赖下一次请求', async () => {
  const url = await upstream(async (req, res) => {
    for await (const _ of req) {
      /* drain */
    }
    res.writeHead(200)
    res.write('partial')
  })
  const response = await adapter()(url, init())
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('partial')
  await reader.cancel()
  await cleaned()
})

it.each(['exit', 'reject', 'bad-marker'])(
  'SDK启动失败或标记错误也清理资源（%s）',
  async (prompt) => {
    const input = init()
    const wire = body()
    wire.messages[0]!.content[0]!.text = prompt
    input.body = JSON.stringify(wire)
    await expect(adapter()('http://invalid', input)).rejects.toThrow()
    await cleaned()
  },
)

it('进程已启动但本地请求未发出时取消，零上游请求且进程退出', async () => {
  const controller = new AbortController()
  const input = init(controller.signal)
  const wire = body()
  wire.messages[0]!.content[0]!.text = 'wait'
  input.body = JSON.stringify(wire)
  const request = adapter()('http://invalid', input)
  const reason = new Error('cancel startup')
  const rejected = expect(request).rejects.toBe(reason)
  let pid = 0
  const parent = join(root, '.simple-code/tmp/claude-agent-sdk')
  await expect
    .poll(async () => {
      const entries = await readdir(parent).catch(() => [])
      const content = await readFile(
        join(parent, entries[0] ?? 'none', 'home/spawned'),
        'utf8',
      ).catch(() => '')
      pid = Number(content)
      return pid > 0
    })
    .toBe(true)
  controller.abort(reason)
  await rejected
  await cleaned()
  expect(() => process.kill(pid, 0)).toThrow()
})
