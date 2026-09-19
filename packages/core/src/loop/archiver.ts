/**
 * 事件归档 v3（可控式）：摘要落库后**单次** LLM 调用做归类判断，落盘
 * 全部由代码完成。演进史——
 *
 * v1（7cd6bf6）：agent mini loop（grep/read/write 三虚拟工具，自由重写）。
 * 一天实证三连翻车：连开碎片档案、把旧全文塞进 contents（双 references
 * 段）；且频率跟压缩走（2 小时 56 次调用 13 批）。
 * v2（203cd3c）：任务书写「整理式重写」标准 + 卡片嵌入 + runlog 观测。
 * 质量仍不可控——重写路径的存在本身就是风险（丢信息/塞旧文/格式漂移）。
 * v3（用户拍板）：去 agent 化。模型只产一个 JSON 判断（归到哪 / 一句话
 * 进展 / 可选新描述），写盘走 events.ts 三个原子原语——没有重写路径，
 * 就没有重写事故。正文大段不再维护：档案是活跃战役的状态板，过程细节
 * 在 turns/git。
 *
 * 输入只有摘要没有 turns 原文（提案 §2）：信息瓶颈是有意为之——档案是
 * 视图不是真相源。
 */
import type { LoadedConfig } from '../config/load.ts'
import { sendRequest } from '../llm/client.ts'
import { logRun } from '../runlog.ts'
import { emptyAccumulator, accumulate, finishAccumulator } from './accumulate.ts'
import { appendProgress, createEvent, listEvents, renameEvent, updateDescription } from '../tools/events.ts'

export type ArchiveSummary = {
  name: string
  description: string
  body: string
  coversFrom: number
  coversTo: number
}

/** 归类请求的 user 首行标记：summarize-idle 测试靠它分流归档请求（无
 *  tools 了，不能再按工具名认） */
export const EVENT_CLASSIFY_MARK = '[event-classify]'

const CLASSIFY_SYSTEM = `你把一份新窗口摘要归类进事件档案。只输出一个 JSON 对象，不要输出其他内容：

{"match": "<现有事件的 name；都不相关则为 null>",
 "progress": "<一句话进展，≤60 字，不带日期/step（代码会加）>",
 "name": "<match 为 null 且值得立新档时：kebab-case 含专有名词，如 lsp-bridge>",
 "description": "<一行描述；立新档必填；match 非空时仅当战役明显演进了才给>",
 "rename": "<可选：match 非空且其 name 已与战役实质矛盾时给新 name（如 classifier-keywords-lock 实为已删除）；仅在明显失真时用，不追风格>"}

规则：
- match 按内容实质判断（这批摘要推进了哪个战役），不按字面词；只能从清单里选
- 单次小修、纯验证、闲聊没有战役意义 → {"match": null, "progress": ""}（空进展=什么都不写）
- 新档只立给「战役的开端」：新机制立项、新 bug 现身、新方案争论——不是每段摘要都值得有档案`

export async function runEventArchive(opts: {
  root: string
  summary: ArchiveSummary
  config: LoadedConfig
  fetchImpl?: typeof fetch
}): Promise<{ action: string; match: string | null }> {
  const { root, summary, config, fetchImpl } = opts
  const roster = listEvents(root)

  const user =
    `${EVENT_CLASSIFY_MARK}\n` +
    `新窗口摘要（step ${summary.coversFrom}–${summary.coversTo}）：\n` +
    `### ${summary.name}\n${summary.description}\n\n${summary.body}\n\n` +
    `现有事件（match 只能从这些 name 里选）：\n${roster}`

  // 单次调用，无 tools——accumulate 只为把流拼成完整 text
  let acc = emptyAccumulator()
  const stream = sendRequest(
    { ...config.summary.request, model: config.summary.name, system: CLASSIFY_SYSTEM, tools: [], messages: [{ role: 'user', parts: [{ type: 'text', text: user }] }] },
    {
      protocol: config.summary.protocol,
      provider: {
        baseUrl: config.summary.baseUrl,
        apiKey: config.summary.apiKey,
        headers: config.summary.model.headers,
        extraBody: config.summary.model.extraBody,
      },
      signal: new AbortController().signal,
      idleTimeoutMs: config.config.loop.streamIdleTimeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
      tag: 'archiver',
    },
  )
  for await (const llmEv of stream) acc = accumulate(acc, llmEv)[0]
  const raw = finishAccumulator(acc)

  const text = raw.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim()

  const parsed = parseClassifyJson(text)
  const names = new Set(
    roster
      .split('\n')
      .map((l) => l.replace(/^[-·]\s*/, '').split(' — ')[0]?.trim())
      .filter((n): n is string => !!n && !n.startsWith('（')),
  )
  const stepRange = `${summary.coversFrom}–${summary.coversTo}`

  // match 必须在清单里——拼错名不当新建处理（防变相碎片化），本批跳过记日志
  if (parsed.match !== null && !names.has(parsed.match)) {
    logRun({ ev: 'archive', folder: root, action: 'skip-bad-match', match: parsed.match, steps: stepRange })
    return { action: 'skip-bad-match', match: parsed.match }
  }
  if (!parsed.progress.trim()) {
    logRun({ ev: 'archive', folder: root, action: 'empty', steps: stepRange })
    return { action: 'empty', match: null }
  }
  if (parsed.match === null) {
    if (!parsed.name || !parsed.description) {
      logRun({ ev: 'archive', folder: root, action: 'skip-incomplete', steps: stepRange })
      return { action: 'skip-incomplete', match: null }
    }
    // 已存在同名 → 并入（分类器重复立档的兜底）
    if (names.has(parsed.name)) {
      appendProgress(root, parsed.name, parsed.progress, stepRange)
      logRun({ ev: 'archive', folder: root, action: 'append-existing', match: parsed.name, steps: stepRange })
      return { action: 'append-existing', match: parsed.name }
    }
    createEvent(root, { name: parsed.name, description: parsed.description, firstProgress: parsed.progress, stepRange })
    logRun({ ev: 'archive', folder: root, action: 'create', match: parsed.name, steps: stepRange })
    return { action: 'create', match: parsed.name }
  }
  // 先改名再追加：本批进展落在改名后的档案上；rename 失败（重名/空名）只
  // 记日志不阻断——进展照常落在旧名档案，下一次归档还能再试改名
  let target = parsed.match
  if (parsed.rename) {
    const msg = renameEvent(root, parsed.match, parsed.rename)
    const ok = msg.startsWith('已改名')
    logRun({ ev: 'archive', folder: root, action: ok ? 'rename' : 'rename-failed', match: `${parsed.match} -> ${parsed.rename}` })
    if (ok) target = parsed.rename
  }
  appendProgress(root, target, parsed.progress, stepRange)
  if (parsed.description) updateDescription(root, parsed.match, parsed.description)
  logRun({ ev: 'archive', folder: root, action: 'append', match: parsed.match, steps: stepRange })
  return { action: 'append', match: parsed.match }
}

/** 容错解析：剥 ```json 围栏，取第一个 {...} 平衡块 */
type ClassifyOut = { match: string | null; progress: string; name?: string | undefined; description?: string | undefined; rename?: string | undefined }
function parseClassifyJson(text: string): ClassifyOut {
  const stripped = text.replace(/```(?:json)?/g, '').trim()
  const start = stripped.indexOf('{')
  if (start === -1) return { match: null, progress: '' }
  let depth = 0
  for (let i = start; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++
    else if (stripped[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          const o = JSON.parse(stripped.slice(start, i + 1)) as Record<string, unknown>
          return {
            match: typeof o.match === 'string' && o.match.trim() !== '' ? o.match.trim() : null,
            progress: typeof o.progress === 'string' ? o.progress : '',
            name: typeof o.name === 'string' ? o.name : undefined,
            description: typeof o.description === 'string' ? o.description : undefined,
            rename: typeof o.rename === 'string' && o.rename.trim() !== '' ? o.rename.trim() : undefined,
          }
        } catch {
          return { match: null, progress: '' }
        }
      }
    }
  }
  return { match: null, progress: '' }
}
