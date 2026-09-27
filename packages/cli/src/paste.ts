import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'

/**
 * 括号粘贴（bracketed paste）拦截层。
 *
 * **为什么必须在这层做**：终端开启 bracketed paste 后，粘贴的整段文本会被
 * `ESC[200~ ... ESC[201~` 包着发过来，但 Node 的 readline 不认识这对序列——
 * 剥掉包裹后按 `\n` 切行，一段八行的粘贴变成八条 line 事件，REPL 逐行当
 * 独立问题发请求（2026-09-22 Documents 实测：一份崩溃报告粘进去，3 分钟
 * 连跑 8 个 turn，用户只能 kill 进程）。
 *
 * 做法：挂在 stdin 和 readline 之间——包裹内的文本**不流向 readline**，
 * 整段收进 `box.pending` 等用户回车确认（回车发送 / 输入文字追加 / Ctrl-C
 * 丢弃，见 repl.ts 的接线）。包裹外的数据原样透传，手敲行为一个字节都不变。
 *
 * 序列可能跨 chunk 分裂（`ESC[2` 和 `00~` 分两段到）：尾部像序列前缀的字节
 * hold 在缓冲里等下一个 chunk 拼齐再判。粘贴没等到闭合就 EOF 的，flush 时
 * 当作粘贴结束交付——宁可把半段交给用户确认，不吞用户的输入。
 */
const OPEN = '\x1b[200~'
const CLOSE = '\x1b[201~'
/** 序列长 6，真前缀最长 5——hold 不会超过这个数 */
const MAX_HOLD = 5

/** 待发粘贴的共享状态。repl 主循环和 SIGINT 处理都从这里读写 */
export type PasteBox = {
  /** 粘贴段原文（含内部换行，不含包裹序列）。null = 没有待发的粘贴 */
  pending: string | null
  /** 粘贴整段到达时回调（打提示用） */
  onArrive?: (text: string, lines: number) => void
}

/** 尾部有多少字节是 OPEN/CLOSE 的真前缀（可能是被 chunk 切断的序列头） */
function holdLen(buf: string): number {
  const max = Math.min(buf.length, MAX_HOLD)
  for (let n = max; n > 0; n--) {
    const tail = buf.slice(buf.length - n)
    if (OPEN.startsWith(tail) || CLOSE.startsWith(tail)) return n
  }
  return 0
}

/** 数行数。末尾换行不算一行（粘贴常带尾换行，多算会虚报） */
const lineCount = (text: string): number =>
  text.replace(/\n$/, '').split('\n').length

export function bracketPaste(input: NodeJS.ReadableStream, box: PasteBox): Transform {
  const decoder = new StringDecoder('utf8')
  let buf = ''
  let inPaste = false
  let acc = ''

  const deliver = (): void => {
    if (acc === '') return // 空粘贴（只包了一对序列）不当回事
    box.pending = acc
    box.onArrive?.(acc, lineCount(acc))
    acc = ''
  }

  const t = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (e: Error | null, s?: string) => void) {
      // StringDecoder：多字节字符跨 chunk 时不拆 UTF-8 序列
      buf += decoder.write(chunk)
      let out = ''
      for (;;) {
        if (inPaste) {
          const end = buf.indexOf(CLOSE)
          if (end === -1) {
            const hold = holdLen(buf)
            acc += buf.slice(0, buf.length - hold)
            buf = buf.slice(buf.length - hold)
            break
          }
          acc += buf.slice(0, end)
          buf = buf.slice(end + CLOSE.length)
          inPaste = false
          deliver()
        } else {
          const start = buf.indexOf(OPEN)
          if (start === -1) {
            const hold = holdLen(buf)
            out += buf.slice(0, buf.length - hold)
            buf = buf.slice(buf.length - hold)
            break
          }
          out += buf.slice(0, start)
          buf = buf.slice(start + OPEN.length)
          inPaste = true
          acc = ''
        }
      }
      cb(null, out)
    },
    flush(cb: (e: Error | null, s?: string) => void) {
      if (inPaste) {
        // 没等闭合就 EOF：当粘贴结束交付，剩余 buf 丢弃（都在包裹语义内）
        inPaste = false
        buf = ''
        deliver()
      } else if (buf !== '') {
        // 序列前缀 hold 着就到了 EOF：不是序列，放行
        this.push(buf)
        buf = ''
      }
      cb(null)
    },
  })
  input.pipe(t)
  return t
}
