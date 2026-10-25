import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RefusalDetail } from './events.ts'
import type { ProtocolName, ProviderContext } from './protocol.ts'

type Snapshot = {
  folder?: string
  tag?: string
  model: string
  protocol: ProtocolName
  provider: ProviderContext
  body: string
  startedAt: number
  refusal?: RefusalDetail
}

/** 本项目自行推断：只在拒答时保留现场，不把完整对话塞进用户级runlog。 */
export async function saveRefusalSnapshot(snapshot: Snapshot): Promise<{
  refusal?: RefusalDetail; dumpPath?: string; dumpError?: string
}> {
  const redact = redactor(snapshot.provider)
  const refusal = snapshot.refusal
    ? JSON.parse(redact(JSON.stringify(snapshot.refusal))) as RefusalDetail
    : undefined
  const detail = refusal ? { refusal } : {}
  if (!snapshot.folder) return detail
  try {
    const refusedAt = new Date().toISOString()
    const dir = join(snapshot.folder, '.simple-code', 'memory', 'refusals')
    const dumpPath = join(dir, `${refusedAt.replace(/:/g, '-')}-${randomUUID()}.json`)
    await mkdir(dir, { recursive: true })
    await writeFile(dumpPath, redact(JSON.stringify({
      requestedAt: new Date(snapshot.startedAt).toISOString(), refusedAt,
      protocol: snapshot.protocol, model: snapshot.model, tag: snapshot.tag,
      finish: 'content-filter', ...detail,
      // SDK还会追加billing标记；这里明确只保证buildRequest生成的正文，不含认证头。
      bodyStage: 'protocol.buildRequest', body: JSON.parse(snapshot.body),
    }, null, 2)), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return { ...detail, dumpPath }
  } catch (error) {
    // 观测失败不能把正常的拒答变成网络错误，触发外层重试。
    return { ...detail, dumpError: redact(JSON.stringify(String(error))).slice(1, -1) }
  }
}

function redactor(provider: ProviderContext): (text: string) => string {
  const secrets = [provider.apiKey, ...Object.values(provider.headers ?? {})]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length)
  // 对JSON编码后的值替换，带引号/换行的凭据也不破坏文件格式。
  return (text) => secrets.reduce((out, secret) =>
    out.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]'), text)
}
