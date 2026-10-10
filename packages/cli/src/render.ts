import { type AgentEvent } from '@simple-code/core'
import { makePaint, type Paint } from './colors.ts'
import { highlightAnsi } from './ansi-highlight.ts'
import { isTableRow, renderInline, renderTable } from './markdown.ts'

/**
 * 输出去处。分 out/err 不是为了美观：
 *
 * 模型的回答和工具输出走 **stdout**，元信息（token 用量、重连提示、错误）
 * 走 **stderr**。这样 `simple-code "..." > answer.txt` 拿到的是干净的回答，
 * 而不是混着一堆状态行。
 */
export type Sink = { out: (s: string) => void; err: (s: string) => void }

/** 工具输出显示多少行就够看了。bash 那边已经按 maxOutputChars 截过一次 */
const MAX_RESULT_LINES = 20

/** 毫秒 → 「X 分钟」/「X 秒」，unloaded 的 stale 文案自证用 */
const fmtInterval = (ms: number | null): string => {
  if (ms === null) return '?'
  const min = Math.round(ms / 60_000)
  return min >= 1 ? `${min} 分钟` : `${Math.round(ms / 1000)} 秒`
}

export type Renderer = {
  on: (agentEv: AgentEvent) => void
  /** 跑完之后调一次，打总计。只有一步时不打——那跟上一行一模一样 */
  done: () => void
}

export function createRenderer(
  sink: Sink,
  tty: { out: boolean; err: boolean } = { out: false, err: false },
): Renderer {
  /**
   * 每步的页脚在两个事件里各拿一半：request_timing 带首字/总耗时（runStep
   * 收尾时报），step_finish 带 token（外层 runLoop 报）——**顺序是 timing
   * 先到**，实测事件流 ...text_end, request_timing, step_finish。谁先到
   * 不该是渲染层的假设，各攒各的、五个字段齐了才打一行，格式与插件页脚
   * （App.tsx 底栏）一字不差
   */
  let foot: {
    ttftMs?: number
    totalMs?: number
    inputTokens?: number
    outputTokens?: number
    contextTokens?: number
  } = {}
  const maybeFoot = () => {
    if (foot.ttftMs === undefined || foot.inputTokens === undefined) return
    sink.err(
      errPaint.dim(
        `首字 ${fmtMs(foot.ttftMs!)} · 总 ${fmtMs(foot.totalMs ?? 0)} · ` +
          `↑${fmtTok(foot.inputTokens!)} ↓${fmtTok(foot.outputTokens ?? 0)} ｜ 上下文 ${fmtTok(foot.contextTokens ?? 0)}\n`,
      ),
    )
    foot = {}
  }
  // 两套色：stdout（模型正文/代码）和 stderr（元信息）各自跟流——
  // `sc -q > file` 时 stdout 无色、stderr 仍是终端有色
  const outPaint = makePaint(tty.out)
  const errPaint = makePaint(tty.err)

  // ——代码围栏缓冲（感知层：流式打字机里高亮完整代码块）——
  // 块外的行到齐就打（保流式感）；块内的行攒到围栏闭合，整块高亮重放。
  // 判不了围栏的极端流（``` 被劈在两个 delta 里）当作普通文本打出——
  // 内容永不丢，只是那块不高亮
  let inCode = false
  let codeLang = ''
  let codeLines: string[] = []
  // 表格攒行（与围栏同骨架：块内行攒到块尾整块重放，跨 text part
  // 持续——text_end 不清状态，流被劈在表格中间也不散架）
  let tableLines: string[] = []
  let partial = ''
  const isFence = (line: string) => /^\s*`{3,}/.test(line)

  const onText = (text: string) => {
    partial += text
    const lines = partial.split('\n')
    partial = lines.pop() ?? ''
    for (const line of lines) {
      const full = `${line}\n`
      if (!inCode && isFence(full)) {
        inCode = true
        codeLang = full.trim().replace(/^`+/, '').trim()
        codeLines = [full]
        continue
      }
      if (inCode) {
        if (isFence(full)) {
          codeLines.push(full)
          emitCodeBlock()
        } else codeLines.push(full)
        continue
      }
      // Markdown 渲染只挂 tty 的 stdout（colors.ts 同约定）：`sc > file`
      // 自动回退原样直出，零污染。攒中的表格优先——先冲表再处理当前行
      if (tty.out) {
        if (tableLines.length > 0) {
          if (isTableRow(full)) {
            tableLines.push(full)
            continue
          }
          sink.out(renderTable(tableLines, outPaint))
          tableLines = []
        }
        if (isTableRow(full)) {
          tableLines.push(full)
          continue
        }
        sink.out(renderInline(full, outPaint))
        continue
      }
      sink.out(full)
    }
  }

  const emitCodeBlock = () => {
    const [open = '', ...rest] = codeLines
    const close = rest.pop() ?? ''
    const body = rest.join('')
    const highlighted = highlightAnsi(body.replace(/\n$/, ''), codeLang, outPaint)
    sink.out(outPaint.dim(open))
    sink.out(highlighted === '' ? '' : `${highlighted}\n`)
    sink.out(outPaint.dim(close))
    inCode = false
    codeLines = []
  }

  const flushText = () => {
    // text_end：冲掉块外没等到换行的尾巴。**围栏状态跨 text part 持续**——
    // qwen 等模型的流是 reasoning/text 多段交替，代码块会被 text_end 劈成
    // 两半，中途清状态会把整块当「未闭合」原样放出（不高亮）。块只认
    // markdown 的 ```，不认事件层的 part 边界
    if (inCode) {
      if (partial !== '') {
        // qwen 的流：闭合围栏不带尾换行（delta "...\n}\n\`\`\`" 后直接
        // text_end）——尾巴恰是围栏就当块闭合，走高亮输出而不是拖到
        // done() 的原样兜底
        const full = `${partial}\n`
        partial = ''
        if (isFence(full)) {
          codeLines.push(full)
          emitCodeBlock()
          return
        }
        codeLines.push(full)
      }
      return
    }
    // 表格同围栏：partial 尾巴跟攒中的表一起等下个 part，text_end 的
    // 换行也不插进表中间
    if (tableLines.length > 0) return
    if (partial !== '') sink.out(partial)
    partial = ''
  }

  const on: Renderer['on'] = (agentEv) => {
    switch (agentEv.type) {
      case 'text_delta':
        return onText(agentEv.text)
      case 'text_end':
        flushText()
        // 块还开着时这个换行会插进代码块/表格中间——块闭合时自带，跳过
        if (inCode || tableLines.length > 0) return
        return sink.out('\n')

      case 'reasoning_start':
        return sink.err(`\n${errPaint.dim('[思考]')} `)
      case 'reasoning_delta':
        return sink.err(errPaint.dim(agentEv.text))
      case 'reasoning_end':
        return sink.err('\n')

      case 'tool_call':
        return sink.out(`\n${outPaint.cyan('$')} ${describe(agentEv.name, agentEv.input, outPaint)}\n`)
      case 'tool_result':
        return sink.out(outPaint.dim(resultText(agentEv.output, agentEv.exitCode)))
      case 'tool_error':
        return sink.err(`\n工具出错：${agentEv.message}\n`)

      case 'restart':
        return sink.err(`\n${errPaint.yellow('（连接断了，正在重发）')}\n`)
      case 'truncated':
        // 跟 restart 相反：上面已经打出去的内容是有效的，后面接着往下写。
        // 不提示的话用户看到的是一段莫名其妙断开又续上的文字
        return sink.err(`\n${errPaint.yellow(`（输出被长度上限截断，正在续写 ${agentEv.attempt}/${agentEv.limit}）`)}\n`)
      case 'unloaded': {
        // 必须告诉用户。不说的话他翻上去看到自己的消息变成了半截，
        // 像是数据被弄坏了——而实际上原文还在，只是不占上下文了。
        // 文案按触发原因分开（方案 A）：budget 才真的是「接近上限」；
        // stale 是缓存过期搭车压缩，预算没超也说「接近上限」是误导；
        // stale 文案带实际间隔（sinceMs）自证到没到 TTL（2026-09-20，
        // 起因「感觉没到 5 分钟却触发了」查无数据）
        // force 是超限自救、连保底区一起卸，严重度跟前两者完全不同
        const text =
          agentEv.reason === 'stale'
            ? `距上次响应 ${fmtInterval(agentEv.sinceMs)}，缓存已过期、横竖全价，顺手把最早的 ${agentEv.count} 条归档了，之后基数更小`
            : agentEv.reason === 'force'
              ? `超出模型上限，紧急归档 ${agentEv.count} 条（含最近上下文）`
              : `上下文接近上限，最早的 ${agentEv.count} 条已归档到磁盘，模型需要时会自己读回来`
        return sink.err(`\n${errPaint.dim(`（${text}）`)}\n`)
      }
      case 'step_finish':
        foot.inputTokens = agentEv.usage.inputTokens
        foot.outputTokens = agentEv.usage.outputTokens
        foot.contextTokens = agentEv.contextTokens
        return maybeFoot()
      case 'request_timing': {
        foot.ttftMs = agentEv.ttftMs
        foot.totalMs = agentEv.totalMs
        return maybeFoot()
      }
      case 'error':
        return sink.err(`\n错误：${agentEv.message}\n`)

      // 这几个在 CLI 里没有对应的显示：text_start 靠 delta 自然开头，
      // tool_input_* 是参数流式拼装的中间态（拼完了才是 tool_call）
      case 'text_start':
      case 'tool_input_start':
      case 'tool_input_delta':
      // 后台进程快照是 vscode UI 的东西，终端里没地方放（孤儿列表
      // session 内存里也有，真要时 ps 一下就行）
      case 'bg_processes':
        return
      default:
        return assertNever(agentEv)
    }
  }

  const done = () => {
    // 整轮结束围栏还开着（模型忘写闭合/输出被截断）才兜底原样放——
    // 一字不丢，只是这块不高亮
    if (inCode) {
      if (partial !== '') {
        codeLines.push(`${partial}\n`)
        partial = ''
      }
      sink.out(codeLines.join(''))
      inCode = false
      codeLines = []
    }
    // 表格没等到收尾的行（后面再来非表格行/本轮结束）：尝试渲染——
    // 行凑齐了（表头+分隔+数据）就是完整表格；不像表格（缺分隔行）
    // renderTable 自己原样返回，一字不丢
    if (tableLines.length > 0) {
      if (partial !== '') {
        tableLines.push(`${partial}\n`)
        partial = ''
      }
      sink.out(renderTable(tableLines, outPaint))
      tableLines = []
    }
    // 页脚在 request_timing 时逐行打过了，这里没有收尾要打的
  }

  return { on, done }
}

/**
 * bash 的入参是 `{ command }`，显示成 `$ ls` 比显示 JSON 可读得多。
 *
 * 这不是协议特化——工具定义是我们自己写的，不是某家模型的格式。
 */
function describe(name: string, input: unknown, paint: Paint): string {
  // description：glm 照官方 Bash 工具的参数名写，同 bash.ts hasDesc
  const { desc: d, description, command } = (input ?? {}) as Record<string, unknown>
  const desc = typeof d === 'string' && d !== '' ? d : description
  const label = typeof desc === 'string' && desc !== '' ? `${paint.cyan(desc)} ${paint.dim('·')} ` : ''
  return `${label}${typeof command === 'string' ? command : `${name} ${JSON.stringify(input)}`}`
}

function resultText(output: string, exitCode: number): string {
  const lines = output.split('\n')
  const rest = lines.length - MAX_RESULT_LINES
  const shown = lines.slice(0, MAX_RESULT_LINES).join('\n')
  const more = rest > 0 ? `\n… 还有 ${rest} 行` : ''
  // 非 0 退出码要显式标出来：模型看得到它，用户看不到的话会以为命令成功了
  const tag = exitCode === 0 ? '' : `（退出码 ${exitCode}）\n`
  return `${tag}${shown}${more}\n`
}

/** token/耗时 → 人话。与插件页脚（webview/events.ts fmtMs/fmtTok）同格式：
 * 850 / 1k / 45.2k；0ms / 1.2s */
const fmtMs = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${parseFloat((ms / 1000).toFixed(1))}s`)
const fmtTok = (n: number): string => (n < 1000 ? `${n}` : `${parseFloat((n / 1000).toFixed(1))}k`)

function assertNever(value: never): never {
  throw new Error(`未处理的事件类型：${JSON.stringify(value)}`)
}
