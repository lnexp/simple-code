/**
 * 派任务桥（task-trunk 规则 11）：activate 时在 127.0.0.1 起一个 mini http
 * server，bin（dist/task.js）把任务书 POST 过来，这里交给对应目录 bridge 的
 * tasks 中心建任务——和用户点「+ 任务」同一个函数，建完任务条就有了。
 *
 * 形态同 lsp-bridge.ts（端口 bind(0) 写进 env、沿进程树传给 bash），多一个
 * token：派任务会让 agent 干活，网页对 127.0.0.1 的跨站 POST 不能叫动它
 * （同凭据代理，core proxy/endpoint.ts）。
 *
 * 窗口关闭/扩展停用 → server 死 → bin 收连接拒绝 → 报「任务桥不可达」。
 *
 * 两条路由：POST /dispatch 派任务（可带 model，规则 14）；POST /models 列出
 * root 所在目录配置里的 taskModels（bin --models）。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  logRun,
  TASK_PORT_ENV,
  TASK_TOKEN_ENV,
  TASK_TOKEN_HEADER,
  type TaskDispatchRequest,
  type TaskDispatchResponse,
  type TaskModelEntry,
  type TaskModelsRequest,
  type TaskModelsResponse,
} from '@simple-code/core'

/** 任务书上限：够写一份详尽的任务书；挡住误把整个文件灌进来 */
const MAX_BRIEF_BYTES = 256 * 1024

export type TaskDispatcher = (req: TaskDispatchRequest) => Promise<TaskDispatchResponse>
export type TaskModelLister = (req: TaskModelsRequest) => Promise<TaskModelsResponse>
export type TaskBridgeHandlers = { dispatch: TaskDispatcher; models: TaskModelLister }

/** --model 的原文 → taskModels 里的一项（规则 14）：认 model 或 provider/model。
 *  不在列表里 / 光写 model 撞了两个 provider → 字符串（给 agent 看的拒绝原因） */
export function pickTaskModel(list: TaskModelEntry[], name: string): TaskModelEntry | string {
  const hits = list.filter((t) => t.model === name || `${t.provider}/${t.model}` === name)
  if (hits.length === 1 && hits[0] !== undefined) return hits[0]
  if (hits.length > 1) return `模型「${name}」在 taskModels 里有 ${hits.length} 个 provider，写成 provider/model`
  const known = list.map((t) => `${t.provider}/${t.model}`).join('、')
  return list.length === 0
    ? `没配 taskModels，派任务只能用配置默认模型（不写 --model）`
    : `模型「${name}」不在 taskModels 里。可选：${known}（"$SIMPLE_CODE_TASK" --models 看用途）`
}

const tokenOk = (got: string | string[] | undefined, want: string): boolean =>
  typeof got === 'string' &&
  got.length === want.length &&
  timingSafeEqual(Buffer.from(got), Buffer.from(want))

/** owner 只认主任务 '' 与 task-xxx（store safeOwner 同款）——它会进库当信箱键 */
const validOwner = (owner: unknown): owner is string =>
  owner === '' || (typeof owner === 'string' && /^task-[a-z0-9]+$/.test(owner))

/** 读 JSON 请求体（超限只计数不收）。null = 超限；undefined = 不是 JSON */
function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_BRIEF_BYTES) chunks.push(c)
    })
    req.on('end', () => {
      if (size > MAX_BRIEF_BYTES) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve(undefined)
      }
    })
  })
}

export function createTaskBridge(opts: { token: string } & TaskBridgeHandlers): Server {
  return createServer((req, res) => {
    let root: string | undefined
    const reply = (status: number, body: TaskDispatchResponse | TaskModelsResponse): void => {
      // 被拒的派任务在 agent 那边只是 bin 的一行报错，宿主这边也留一行
      if (!body.ok)
        logRun({ ev: 'task_bridge_reject', folder: root ?? null, status, error: body.error })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    // handler 抛错 = 宿主内部错：500，bin 照样拿到一行原因
    const answer = async (fn: () => Promise<TaskDispatchResponse | TaskModelsResponse>): Promise<void> => {
      try {
        reply(200, await fn())
      } catch (error) {
        reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (req.method !== 'POST' || (req.url !== '/dispatch' && req.url !== '/models'))
      return reply(404, { ok: false, error: '没有这条路由' })
    if (!tokenOk(req.headers[TASK_TOKEN_HEADER], opts.token))
      return reply(401, { ok: false, error: 'token 缺失或不对' })
    void readJson(req).then(async (parsed) => {
      if (parsed === null) return reply(413, { ok: false, error: `任务书超过 ${MAX_BRIEF_BYTES / 1024}KB` })
      if (parsed === undefined) return reply(400, { ok: false, error: '请求体不是 JSON' })
      const { brief, owner, model } = parsed
      const dir = typeof parsed.root === 'string' ? parsed.root : ''
      if (dir === '') return reply(400, { ok: false, error: '缺 root' })
      root = dir
      if (req.url === '/models') return answer(() => opts.models({ root: dir }))
      if (typeof brief !== 'string' || brief.trim() === '')
        return reply(400, { ok: false, error: '任务书为空' })
      if (!validOwner(owner))
        return reply(400, { ok: false, error: `非法 owner：${String(owner)}` })
      if (model !== undefined && (typeof model !== 'string' || model === ''))
        return reply(400, { ok: false, error: '--model 后要写模型名' })
      const req2: TaskDispatchRequest = { brief, root: dir, owner, ...(model !== undefined ? { model } : {}) }
      return answer(() => opts.dispatch(req2))
    })
  })
}

/** 宿主启动入口：随机端口 + 随机 token，写进 process.env 供 bash 透传 */
export function startTaskBridge(handlers: TaskBridgeHandlers): Server {
  const token = randomBytes(24).toString('hex')
  const server = createTaskBridge({ token, ...handlers })
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      process.env[TASK_PORT_ENV] = String(addr.port)
      process.env[TASK_TOKEN_ENV] = token
    }
  })
  return server
}
