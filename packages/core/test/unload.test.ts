import { describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import { estimateMessageTokens } from '../src/loop/tokens.ts'
import { type ClipOptions, unloadMessage } from '../src/loop/unload.ts'

const ARCHIVE = '.simple-code/memory/turns/turn-000042.jsonl'
const long = (n: number) => 'x'.repeat(n)
const OPTS: ClipOptions = { threshold: 1000, keepHeadChars: 300, archive: ARCHIVE }

const toolResult = (output: string): Message => ({
  role: 'tool',
  parts: [{ type: 'tool_result', toolCallId: 't1', output, isError: false }],
})
const toolCall = (command: string): Message => ({
  role: 'assistant',
  parts: [
    { type: 'tool_call', id: 't1', name: 'bash', input: { command, cwd: '.', timeout: 120 } },
  ],
})
const text = (t: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text: t }] })

const outputOf = (m: Message) => (m.parts[0] as { output: string }).output
const commandOf = (m: Message) =>
  String((m.parts[0] as { input: { command: unknown } }).input.command)

describe('第 0 层裁剪：只裁工具输入输出', () => {
  it('tool_result 超过阈值才裁，保留头部 + 归档路径', () => {
    const out = unloadMessage(toolResult(`开头是关键\n${long(9000)}`), OPTS)

    const part = out.parts[0] as { output: string; toolCallId: string; isError: boolean }
    expect(part.output).toContain(ARCHIVE) // 模型靠它知道去哪 cat
    expect(part.output).toContain('开头是关键') // 保头不保尾：动词和目标在开头
    expect(part.output.length).toBeLessThan(400)
    // 配对和错误标记必须原样留着，否则 normalize 会当成孤儿处理
    expect(part.toolCallId).toBe('t1')
    expect(part.isError).toBe(false)
  })

  it('tool_call 只裁 input.command 的值，对象结构不动', () => {
    // 把整个 input 换成字符串会让类型从 object 变 string，破坏工具 schema，
    // 模型下一轮就看不懂那条历史了。而 `cat > f <<EOF ...500行... EOF`
    // 这种命令能有几万字符，必须能裁
    const out = unloadMessage(toolCall(long(9000)), OPTS)

    const part = out.parts[0] as { id: string; name: string; input: Record<string, unknown> }
    expect(typeof part.input).toBe('object') // 前提：还是对象，不是字符串
    expect(part.input.cwd).toBe('.') // 几十字节的字段不动
    expect(part.input.timeout).toBe(120)
    expect(part.id).toBe('t1') // 配对要用
    expect(part.name).toBe('bash') // 分发要用
    expect(String(part.input.command)).toContain(ARCHIVE)
    expect(String(part.input.command).length).toBeLessThan(400)
  })

  it('**对话文本一个字不动**，多长都不动（§4.2 落地）', () => {
    // **这条是反转过来的。** 原来断言的是「文本照裁」，理由是：文本不裁 →
    // pickOldest 算出 saved<=0 → 这条永远选不中 → 它所在的 step 永远不会被
    // 标 unloaded → 那个 step 的摘要永远不会生效，纯问答的 turn 从此卡在
    // live 里出不去（merge-e2e 的「生效的 L0 ≥ 2」当年就是被这个洞照出来的）。
    //
    // §11.5 把出局判据从「省不省得到」换成「在不在保底区外」之后，那条因果链
    // 断了：短消息裁不动照样出局、照样标冷、摘要照样生效。所以 §4.2 的另一半
    // 现在能兑现了——**当年那条推迟不是错的，只是前提没到**。
    //
    // 5000 字远超任何阈值，仍然逐字不变：挡它的不是阈值，是「根本不看 text」
    const longText = text(long(5000))
    expect(unloadMessage(longText, OPTS)).toEqual(longText)
    const short = text('你来继续实现')
    expect(unloadMessage(short, OPTS)).toEqual(short)
  })

  // 这里原来还有两条文本侧的对照组：「低于阈值的中等长度文本不动」和
  // 「文本裁完也必须变短」。§11.4 之后 `clip` 整个函数没了（文本一个字不裁），
  // 前者变成永远绿的空转、后者的被测对象不存在了，所以删掉。
  //
  // **它们钉住的两条教训没丢，都在工具那侧还有一份**：阈值那条见下面
  // 「低于阈值的工具输出逐字不变」里的 800 字用例（`long(800)` 裁完会更短，
  // 所以只有阈值能挡它——第一版用 6 字短语，被 shrink 顺手挡住，变异检验
  // 删掉阈值判断仍然全绿才暴露）；shrink 那条见「裁完必须比原文短」。

  it('**对照：低于阈值的工具输出逐字不变，一个通知都不加**', () => {
    // 提案 §1.4：原来这里写的是 `if (text.length <= keep) return text + notice`
    // ——没超长也照样追加。实测 6 字的「你来继续实现」卸载后变成 63 字
    const short = toolResult('ok')
    expect(unloadMessage(short, OPTS)).toEqual(short)
    expect(unloadMessage(toolCall('ls'), OPTS)).toEqual(toolCall('ls'))

    // **上面两条不够。** 'ok' 裁完反而更长，是「必须变短」那条挡住的，
    // 不是阈值——把阈值判断整条删掉它们照样绿（变异检验实测）。
    // 再来一组 800 字的：低于阈值 1000，但裁成 300 字头部+通知会更短，
    // 所以只有阈值能挡它
    const medium = toolResult(long(800))
    expect(unloadMessage(medium, OPTS)).toEqual(medium)
    expect(unloadMessage(toolCall(long(800)), OPTS)).toEqual(toolCall(long(800)))
  })

  it('**对照：短消息裁完不会变大**——这是不报错只是行为不对的那类 bug', () => {
    // 旧实现下 `pickOldest` 挑中它 → saved 是负数 → estimated 不降 → 把整个
    // live 集合挑光 → replaceLive 每轮重写一遍。真实库 6 天 74 MB 的来源
    for (const msg of [toolResult('ok'), toolCall('ls'), text('你来继续实现')]) {
      const before = estimateMessageTokens(msg.parts)
      const after = estimateMessageTokens(unloadMessage(msg, OPTS).parts)
      expect(after).toBeLessThanOrEqual(before)
    }
  })

  it('**对照：裁完必须比原文短**——keepHeadChars 配得比阈值大时原样返回', () => {
    // 两个旋钮各管一件事（「什么时候动手」和「留多少」），没有约束保证前者
    // 更大。判一下比让用户自己去对两个数靠谱
    const msg = toolResult(long(1200))
    const silly: ClipOptions = { threshold: 1000, keepHeadChars: 5000, archive: ARCHIVE }
    expect(unloadMessage(msg, silly)).toEqual(msg)
    // 前提：同一条消息在正常配置下**是会被裁的**，否则上面测的是「压根没超阈值」
    expect(outputOf(unloadMessage(msg, OPTS))).toContain(ARCHIVE)
  })

  it('保留的是**头部**，不是尾部', () => {
    // 跟 bash 输出截断（tools/truncate.ts 保两端）相反，是有理由的：
    // 写文件、跑测试、git 操作的动词和目标都在开头
    const out = outputOf(unloadMessage(toolResult(`开头是关键\n${long(5000)}结尾不重要`), OPTS))
    expect(out).toContain('开头是关键')
    expect(out).not.toContain('结尾不重要')
  })

  it('**reasoning 原样保留**，连 signature 都不动', () => {
    // **这条也是反转过来的。** 原来断言「整块丢弃」，依据是 design.md §9.9
    // 「历史轮次的推理对当前决策没价值，结论已经在文本和工具调用里」。
    //
    // 那个论证仍然成立，但 §11.4 换了兑现它的方式：**老 step 整条被摘要顶替，
    // reasoning 跟着整条一起不发**，不需要卸载单独去删它。留着还有一个好处
    // ——段还没被摘要盖住的那段时间里，推理块和它后面的 tool_call 仍然配对
    // 完整。
    //
    // 「绝不截断 reasoning」那条约束没变，而且现在更强：连碰都不碰。截断会
    // 依赖 signature 校验宽松，附录 A 说明没法确证。
    const msg: Message = {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: long(9000), encrypted: 'sig-abc' },
        { type: 'text', text: '结论是这样' },
      ],
    }

    // 9000 字远超阈值，仍然逐字不变——挡它的不是阈值，是「根本不看 reasoning」
    expect(unloadMessage(msg, OPTS)).toEqual(msg)
    // signature 必须原样带回去，改写过的 thinking 块 API 可能不收
    expect(JSON.stringify(unloadMessage(msg, OPTS))).toContain('sig-abc')
  })

  it('role 不变', () => {
    // 改了 role 会破坏 user/assistant 交替，某些协议直接 400
    expect(unloadMessage(toolResult(long(5000)), OPTS).role).toBe('tool')
  })
})

// ------------------------------------------------------------ 幂等

describe('裁剪幂等', () => {
  it('**对已是存根的消息再裁一次，notice 不叠加**', () => {
    // 存根作为 live 消息留在 context 里，下一轮预算又超时会被 pickOldest
    // 再次挑中。不幂等的话 notice 逐轮叠加——真实库里叠到过 10 层、
    // 33,937 行受害，cleanup.ts 就是去收拾那批的
    const once = unloadMessage(toolResult(long(9000)), OPTS)
    expect(unloadMessage(once, OPTS)).toEqual(once)
    expect(outputOf(once).match(/已卸载/g)).toHaveLength(1)

    const cmdOnce = unloadMessage(toolCall(long(9000)), OPTS)
    expect(unloadMessage(cmdOnce, OPTS)).toEqual(cmdOnce)
    expect(commandOf(cmdOnce).match(/已卸载/g)).toHaveLength(1)
  })

  it('无 `#` 的老存根也要认，正文恰好这样结尾的也一并跳过（保守方向的误伤）', () => {
    // 两件事共用一个判据，所以合成一条测：
    // ① 现在只有 shell 版（带 `#`）会新产生，但 §4.2 之前文本也会被裁，
    //    那批无 `#` 的存根还在库里，会被读回来再走一遍裁剪
    // ② 正文恰好以这个模式结尾的正常消息（比如模型 cat 了一个归档）会被
    //    误判成存根跳过——后果保守（少裁一条，预算估算如实反映），且这个
    //    模式在 headOfStep 和 webview 那头同样只能按文本判，没有更准的信号
    const legacy = toolResult(`${long(1200)}\n[已卸载，完整内容见 ${ARCHIVE}]`)
    // 前提：它确实超了阈值——不然测的是「压根没进裁剪分支」
    expect(outputOf(legacy).length).toBeGreaterThan(OPTS.threshold)
    expect(unloadMessage(legacy, OPTS)).toEqual(legacy)
  })
})

describe('输出留头 + 留尾（2026-09-28 方案 C：命令 200 / 输出头 100 + 尾 100）', () => {
  const C: ClipOptions = { threshold: 0, keepHeadChars: 200, outputHeadChars: 100, outputTailChars: 100, archive: ARCHIVE }
  // 真实形状：开头是无关报错，结论在最后一行（本项目 t16495「类型检查与相关测试」）
  const testRun = [
    "error TS5058: The specified path does not exist: 'packages/vscode/webview/tsconfig.json'.",
    ...Array.from({ length: 30 }, (_, i) => `  ✓ case ${i} passed in 3ms`),
    ' Test Files  1 failed | 33 passed (34)',
    '      Tests  1 failed | 424 passed (425)',
    '',
  ].join('\n')

  it('尾部结论保住，头部开头保住，中间省略并注明字数', () => {
    const out = outputOf(unloadMessage(toolResult(testRun), C))
    expect(out).toContain('error TS5058') // 头
    expect(out).toContain('1 failed | 424 passed (425)') // 尾：只留头时会被裁掉的那句
    expect(out).not.toContain('case 10 passed') // 中间确实省了
    expect(out).toMatch(/# …（省略 \d+ 字符）…/)
    expect(out.length).toBeLessThan(testRun.length)
  })

  it('**通知仍在末尾**：isStubbed 认得出、再裁一遍原样返回（幂等）', () => {
    const once = unloadMessage(toolResult(testRun), C)
    expect(outputOf(once).endsWith(`# [已卸载，完整内容见 ${ARCHIVE}]`)).toBe(true)
    expect(unloadMessage(once, C)).toEqual(once)
  })

  it('两端对齐行边界：头不留半行、尾不以半行开头', () => {
    const out = outputOf(unloadMessage(toolResult(testRun), C))
    const [head, rest] = out.split(/\n# …（省略 \d+ 字符）…\n/)
    expect(testRun.split('\n')).toContain(head?.split('\n').at(-1))
    const tailFirstLine = rest?.split('\n')[0]
    expect(testRun.split('\n')).toContain(tailFirstLine)
  })

  it('阈值 0 也不做赔本买卖：裁完不比原文短就原样留着', () => {
    const short = 'x'.repeat(150)
    expect(outputOf(unloadMessage(toolResult(short), C))).toBe(short)
  })

  it('命令只留头 200，不留尾（heredoc 的尾巴是终止符，留了诱导续写）', () => {
    const cmd = `cd /repo && python3 - <<'EOF'\n${Array.from({ length: 40 }, (_, i) => `print(${i})`).join('\n')}\nEOF`
    const out = commandOf(unloadMessage(toolCall(cmd), C))
    expect(out.startsWith("cd /repo && python3 - <<'EOF'")).toBe(true)
    expect(out).not.toContain('print(39)')
    expect(out).not.toContain('省略')
    expect(out.length).toBeLessThan(260)
  })

  it('没配头尾时退回只留头（旧行为，测试夹具与旧配置不受影响）', () => {
    const out = outputOf(unloadMessage(toolResult(testRun), { threshold: 0, keepHeadChars: 100, archive: ARCHIVE }))
    expect(out).not.toContain('424 passed')
    expect(out).not.toContain('省略')
  })
})
