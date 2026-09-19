import type { Message, Part } from '../llm/types.ts'

/** 裁剪的三个旋钮。两个 number 挨着放太容易传反，收成对象 */
export type ClipOptions = {
  /** 超过这么多字符才动手。低于它原样保留，**一个通知都不加** */
  threshold: number
  /** 动手之后留多少头部 */
  keepHeadChars: number
  /** 归档路径，写进通知里 */
  archive: string
}

/**
 * 卸载：把**超过阈值**的工具输入输出换成「头部 + 归档路径」。
 *
 * **只裁工具的 input 和 output，别的一个字不动**——提案 §0 / §4.2 的原话，
 * §11.4 把它落地。这个函数一度还做两件多余的事，都撤了：
 *
 * - **对话文本不再裁。** 原来裁，理由是「文本不裁 → `pickOldest` 算出
 *   `saved <= 0` → 这条永远选不中 → 它所在的 step 永远不标 unloaded →
 *   摘要永远不生效」。§11.5 把出局判据从「省不省得到」换成「在不在保底区外」
 *   之后，那条因果链断了：短消息裁不动照样出局。
 * - **reasoning 不再整块删。** design.md §9.9「历史轮次的推理对当前决策没有
 *   价值」仍然成立，但处理方式换了——老 step 整条被摘要顶替，reasoning 跟着
 *   整条一起不发，不需要单独删。留着它还有一个好处：段还没被摘要盖住时，
 *   推理块和它后面的 tool_call 仍然配对完整。
 *
 * 阈值默认 1000 字符，依据是提案 §8.2 的实测：命中 474/8038 段（5.9%）、
 * 全语料省 18%。500 能到 22% 但命中段数翻倍——1000 字符约 12 行输出，
 * 低于这个量扫一眼就读完了，裁掉省不下多少却丢掉上下文。
 *
 * **只截断字符串字段的值，绝不改对象结构。** 这是整个卸载能成立的前提：
 * 把 `tool_call.input` 整个换成一个摘要字符串的话，类型从 object 变 string，
 * 破坏工具 schema——模型下一轮就看不懂那条历史了。
 *
 * 归档路径指向 `turns/<桶>/turn-NNNNNN.jsonl`：**原文在这之前就已经写进去了**
 * （`store.save` 对每条没写过的消息都追加，与卸载无关），所以裁掉不丢内容
 * ——模型照着路径 cat 得回来。
 *
 * 纯函数，不碰数据库、不碰文件。调用方负责先把原文标记落库。
 */
export function unloadMessage(msg: Message, opts: ClipOptions): Message {
  return { ...msg, parts: msg.parts.map((part) => unloadPart(part, opts)) }
}

function unloadPart(part: Part, opts: ClipOptions): Part {
  if (part.type === 'tool_result') return { ...part, output: clipShell(part.output, opts) }
  if (part.type === 'tool_call') return { ...part, input: clipCommand(part.input, opts) }
  // text / reasoning / image 一律原样穿过，见上面的注释
  return part
}

/**
 * `cat > src/auth.ts <<EOF ... 500行 ... EOF` 这种命令能有几万字符，比大多数
 * tool_result 都大（§9.4），所以 command 也要裁。
 *
 * 但**只动 command 这一个字段的值**：`cwd`/`timeout` 是几十字节，不值得动；
 * `id`/`name` 在 part 上不在 input 里，配对和分发要用，更不能动。
 */
function clipCommand(input: unknown, opts: ClipOptions): unknown {
  if (typeof input !== 'object' || input === null) return input
  const command = (input as { command?: unknown }).command
  if (typeof command !== 'string') return input
  return { ...input, command: clipShell(command, opts) }
}

/**
 * 裁 shell 文本（command / 输出）。**这是现在唯一的截断函数**——原来还有个
 * 裁对话文本的 `clip`（notice 不带 `#`），随 §11.4「卸载只裁工具 I/O」一起
 * 删了。`isStubbed` 仍然认无 `#` 的旧形态，因为库里存着大量那种老存根。
 *
 * 两处设计来自 2026-08-27 的真实事故（`stub-leak.test.ts` 有完整记录）：
 * 管线本身不篡改
 * 工具输入，但历史里的存根是「开头 `<<'EOF'` 还在、收尾终止符被截走、
 * notice 顶在断口」的**没写完的 heredoc**——模型照着自己上一条命令的这种
 * 形状续写，把 notice 当成命令内容带出来，bash 拿它当命令执行。所以：
 *
 * **① notice 带 `#` 前缀。** 模仿挡不住（那就是模型的天性），但被抄走的
 * notice 变成注释：抄进命令是 no-op，不再 `command not found`，更不会
 * 落进 heredoc 正文里炸语法。
 *
 * **② 断口对齐行边界。** 半截命令行比整行难读也更诱导续写，截到 keep 内
 * 最后一个换行为止（没有换行就硬切——多行总比空强）。
 */
function clipShell(text: string, opts: ClipOptions): string {
  if (text.length <= opts.threshold) return text
  if (isStubbed(text)) return text
  const head = text.slice(0, opts.keepHeadChars)
  const lastLine = head.lastIndexOf('\n')
  const clipped = `${lastLine > 0 ? head.slice(0, lastLine) : head}\n# [已卸载，完整内容见 ${opts.archive}]`
  return clipped.length < text.length ? clipped : text
}

/**
 * 尾部是不是已经挂着卸载提示。**裁剪必须幂等**：存根作为 live 消息留在
 * context 里（下次 save 重插），下一轮预算又超时 pickOldest 会再次挑中它
 * ——不判这一下的话 notice 逐轮叠加（`\n[已卸载A]\n[已卸载A]…`），头部
 * 提取按「\n[已卸载」切、webview 的存根判定按行尾锚定，都只认一段。
 *
 * 真实库里叠到过 10 层，33,937 行受害，`cleanup.ts` 是去收拾那批的。
 *
 * 两种形态都认：现在只有 shell 版（带 `#`）会新产生，但库里存着大量文本版
 * （无 `#`）的老存根，判错就会被重新裁一遍、再叠一个通知上去。
 *
 * 边界（接受的误伤）：正文**恰好以**这个模式结尾的正常消息会被当成存根
 * 跳过截断——后果是保守的（少裁一条，预算估算如实反映），且这个模式在
 * headOfStep 和 webview 那头同样只能按文本判，没有更准的信号可统一
 */
export const isStubbed = (text: string): boolean =>
  /\n#? ?\[已卸载，完整内容见 [^\]]*\]$/.test(text)
