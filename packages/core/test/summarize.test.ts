import { describe, expect, it } from 'vitest'
import type { Message, Request } from '../src/llm/types.ts'
import type { LiveMessage } from '../src/loop/assemble.ts'
import {
  buildSummaryRequest,
  cleanSummaryText,
  parseSummaryOutput,
  pickTurnToSummarize,
  renderTurn,
} from '../src/loop/summarize.ts'

const at = (turnId: number, message: Message): LiveMessage => ({ turnId, stepId: turnId, message })
const says = (role: Message['role'], text: string): Message => ({
  role,
  parts: [{ type: 'text', text }],
})
const calls = (id: string, command: string): Message => ({
  role: 'assistant',
  parts: [{ type: 'tool_call', id, name: 'bash', input: { command } }],
})
const returns = (id: string, output: string): Message => ({
  role: 'tool',
  parts: [{ type: 'tool_result', toolCallId: id, output, isError: false }],
})

describe('挑哪个 turn 摘要', () => {
  it('挑最老的', async () => {
    // 卸载也从最老开始（§9.4）。摘要要赶在卸载前面才有意义——挑最新的话，
    // 等轮到那个 turn 被卸载时摘要早过期了
    const live = [at(3, says('user', '三')), at(1, says('user', '一')), at(2, says('user', '二'))]

    expect(pickTurnToSummarize(live, new Set())?.turnId).toBe(1)
  })

  it('跳过已经有摘要行的', () => {
    const live = [at(1, says('user', '一')), at(2, says('user', '二')), at(3, says('user', '三'))]

    expect(pickTurnToSummarize(live, new Set([1]))?.turnId).toBe(2)
  })

  it('**不挑当前 turn**', () => {
    // 当前 turn 还在进行中，工具可能没跑完。这时候摘要等于对着半截对话总结，
    // 而且下一轮消息进来后这条摘要就错了
    const live = [at(1, says('user', '一')), at(2, says('user', '进行中'))]

    expect(pickTurnToSummarize(live, new Set([1]))).toBeNull()
  })

  it('只有一个 turn 时不挑（它就是当前 turn）', () => {
    expect(pickTurnToSummarize([at(1, says('user', '唯一'))], new Set())).toBeNull()
  })

  it('全都有摘要了就返回 null', () => {
    const live = [at(1, says('user', '一')), at(2, says('user', '二'))]

    expect(pickTurnToSummarize(live, new Set([1, 2]))).toBeNull()
  })

  it('挑中的 turn 带着它全部的消息', () => {
    const live = [
      at(1, says('user', '问')),
      at(1, calls('t1', 'ls')),
      at(1, returns('t1', 'a.txt')),
      at(2, says('user', '当前')),
    ]

    expect(pickTurnToSummarize(live, new Set())?.messages).toHaveLength(3)
  })
})

describe('渲染成摘要模型的输入', () => {
  it('**命令和它的输出成对出现**', () => {
    // §9.6 的核心。单看 output 不知道在干嘛，单看 command 不知道成没成——
    // 一个空输出可能是「写文件成功」也可能是「grep 没找到」
    const text = renderTurn([calls('t1', 'wc -l src/*.ts'), returns('t1', '  1234 total')])

    expect(text).toContain('wc -l')
    expect(text).toContain('1234 total')
    // 配对信息不能只是"两者都在文本里"，得挨着——中间隔着别的内容的话，
    // 模型要自己去猜哪个输出对应哪个命令
    const commandAt = text.indexOf('wc -l')
    const outputAt = text.indexOf('1234 total')
    expect(outputAt - commandAt).toBeLessThan(80)
  })

  it('空输出要说明是空的，不是漏了', () => {
    // 「写入 500 行，exit 0，无输出」和「这条命令的结果没记下来」是两回事
    const text = renderTurn([calls('t1', 'cat > a.ts <<EOF'), returns('t1', '')])

    expect(text).toContain('(空输出)')
  })

  it('有调用没结果时标出来，不假装有', () => {
    // 中断留下的孤儿。渲染成"返回：(空)"会让模型以为命令成功了
    const text = renderTurn([calls('t1', 'sleep 100')])

    expect(text).toContain('(无输出记录)')
  })

  it('多个工具调用各自配对，不串台', () => {
    const text = renderTurn([
      calls('t1', 'ls'),
      calls('t2', 'pwd'),
      returns('t2', '/tmp'),
      returns('t1', 'a.txt'),
    ])

    // ls 配 a.txt、pwd 配 /tmp，尽管 t2 的结果在数组里排得更前。
    // 按行验配对关系，不靠字符窗口——窗口大小是拍脑袋定的，跨进下一条命令
    // 就会误报（第一版这么写，红了才发现测的是窗口不是配对）
    const lines = text.split('\n')
    const pairAfter = (command: string) => {
      const at = lines.findIndex((line) => line.includes(`"${command}"`))
      return lines[at + 1] ?? ''
    }
    expect(pairAfter('ls')).toContain('a.txt')
    expect(pairAfter('pwd')).toContain('/tmp')
  })

  it('推理块不进摘要', () => {
    // 它是模型的草稿，不是发生过的事实（§9.9 同理）
    const withReasoning: Message = {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: '我先想想应该怎么做…' },
        { type: 'text', text: '好的' },
      ],
    }

    const text = renderTurn([withReasoning])
    expect(text).not.toContain('我先想想')
    expect(text).toContain('好的')
  })

  it('tool_result 不重复出现', () => {
    // 它已经贴在对应的 tool_call 后面了。再列一遍的话摘要模型会看到两份，
    // 长输出时白烧一倍 token
    const text = renderTurn([calls('t1', 'ls'), returns('t1', '独一无二的输出')])

    expect(text.match(/独一无二的输出/g)).toHaveLength(1)
  })
})

const BASE: Omit<Request, 'messages' | 'system' | 'tools'> = {
  model: 'test-model',
  maxTokens: 1024,
  thinking: 'adaptive',
  effort: 'high',
  reasoningDisplay: 'omitted',
}

describe('组装摘要请求', () => {
  it('**不带工具**', () => {
    // 给了工具模型可能去跑命令「确认一下」——既慢又危险，而且摘要不进
    // agent loop，跑出来的工具调用没人执行
    expect(buildSummaryRequest('内容', BASE).tools).toEqual([])
  })

  it('关掉 thinking', () => {
    // 一两句话的索引不需要推理，开着纯粹是延迟和 token
    expect(buildSummaryRequest('内容', BASE).thinking).toBe('disabled')
  })

  it('turn 文本作为唯一的 user 消息', () => {
    const request = buildSummaryRequest('调用 bash：ls\n返回：a.txt', BASE)

    expect(request.messages).toHaveLength(1)
    expect(JSON.stringify(request.messages)).toContain('a.txt')
  })

  it('system 里要求具体，且明确要求写出失败', () => {
    // §9.6 的正反例：「修改了 auth.ts 的 verify 函数，测试 3 条全过」
    // vs「进行了代码修改并验证」
    const { system } = buildSummaryRequest('内容', BASE)

    expect(system).toContain('文件名')
    expect(system).toContain('失败')
    expect(system).toContain('已于本段重新展开过') // 归档重复读取的防护标注（§9.10）
  })

  it('model 等基础字段来自调用方', () => {
    expect(buildSummaryRequest('内容', { ...BASE, model: '便宜模型' }).model).toBe('便宜模型')
  })
})

describe('清洗模型返回的文本', () => {
  it.each([
    ['  前后有空白  ', '前后有空白'],
    ['摘要：写入了 a.ts', '写入了 a.ts'],
    ['总结: 跑了测试', '跑了测试'],
    ['"带引号的"', '带引号的'],
    ['「中文引号」', '中文引号'],
  ])('%s → %s', (raw, want) => {
    expect(cleanSummaryText(raw)).toBe(want)
  })

  it('正常文本不动', () => {
    // 对照组：没有这条的话，「无论如何都砍掉首尾字符」也能让上面全绿
    const clean = '修改了 auth.ts 的 verify 函数，测试 3 条全过'
    expect(cleanSummaryText(clean)).toBe(clean)
  })

  it('句子里的引号不受影响', () => {
    expect(cleanSummaryText('执行 grep "TODO" 找到 3 处')).toBe('执行 grep "TODO" 找到 3 处')
  })
})

describe('解析 L0 的结构化输出', () => {
  const structured = [
    '名称: 历史懒加载方案对齐',
    '描述: 定了按 turn id 分页的方案，未写代码',
    '',
    '## 用户要求',
    '翻历史',
    '## 实际完成',
    '定方案',
  ].join('\n')

  it('名称 / 描述 / 正文各归各位', () => {
    expect(parseSummaryOutput(structured)).toEqual({
      name: '历史懒加载方案对齐',
      description: '定了按 turn id 分页的方案，未写代码',
      body: '## 用户要求\n翻历史\n## 实际完成\n定方案',
    })
  })

  it('**头部没有描述时，正文里的「描述:」不能顶上**', () => {
    // 模型在「## 涉及文件」底下再写一行「描述: xxx」不是稀奇事。往下扫着找
    // 字段的实现会把正文那行当成描述——**不报错**，只是 context 里那一行
    // 变成了正文的片段，读起来像从半路开始的。
    //
    // **头部必须没有描述**才测得到这个差异：头部有的话，往下扫也是先命中它，
    // 两种实现结果一样（第一版就这么写的，变异检验当场存活）
    const out = parseSummaryOutput('名称: 只有标题\n\n## 涉及文件\n描述: store.ts 里的那段')

    expect(out.name).toBe('只有标题')
    expect(out.description).not.toBe('store.ts 里的那段')
    // 退化路径：剩下的整段都当描述
    expect(out.description).toContain('## 涉及文件')
  })

  it('正文里的「描述:」也不影响正常解析', () => {
    const out = parseSummaryOutput(`${structured}\n## 涉及文件\n描述: store.ts 里的那段`)
    expect(out.description).toBe('定了按 turn id 分页的方案，未写代码')
    expect(out.body).toContain('描述: store.ts 里的那段') // 前提：正文里确实有
  })

  it('**没按格式输出时退化成「整段都是描述」**，不是丢掉整条摘要', () => {
    // 摘要是锦上添花的功能（§9.7）。为了模型没写「名称:」就把整条丢掉，
    // 等于拿一个可选功能的瑕疵换掉它的全部价值
    expect(parseSummaryOutput('读了 config.ts，发现三个配置项')).toEqual({
      name: '',
      description: '读了 config.ts，发现三个配置项',
      body: '',
    })
  })

  it('**只有名称没有描述时，描述里不能带「名称:」那几个字**', () => {
    // 退化路径把整段当描述，但已经认出来的那行要跳过——不跳的话「名称:」
    // 四个字会跟着进 context，每一轮都在那儿杵着
    const out = parseSummaryOutput('名称: 只写了标题\n后面是正文一样的东西')
    expect(out.name).toBe('只写了标题')
    expect(out.description).toBe('后面是正文一样的东西')
    expect(out.description).not.toContain('名称')
  })

  it('对照：全角冒号也认', () => {
    const out = parseSummaryOutput('名称：短标题\n描述：一句话\n\n## 用户要求')
    expect(out.name).toBe('短标题')
    expect(out.description).toBe('一句话')
  })

  /**
   * 2026-09-03 从真库回查抓到的：34 条叶子里 18 条没有 md 文件，其中 8 条是
   * 解析失败——`description` 以「名称/描述/#」开头，那正是 fallback 把整段
   * 吞进去的形状。
   *
   * 根因是键认死行号 0 和 1。模型空一行、或者写成 `**描述**:`，第 1 行就对
   * 不上，于是整条退化成「整段当描述、正文为空」；而**正文为空就不写叶子
   * 文件**（session.ts:517 的降级路径），热区那一条从此没有正文可展——
   * 症状不是报错，是热区静默退化成温区。
   */
  it('**名称和描述之间空一行也要认出来**', () => {
    const out = parseSummaryOutput('名称: 短标题\n\n描述: 做了什么\n\n## 用户要求\n要求')
    expect(out.name).toBe('短标题')
    expect(out.description).toBe('做了什么')
    // 正文非空才写得出叶子文件，热区才有东西可展
    expect(out.body).toContain('## 用户要求')
  })

  it('**`**描述**:` 这种加粗也要认出来**', () => {
    const out = parseSummaryOutput('**名称**: 短标题\n**描述**: 做了什么\n\n## 用户要求\n要求')
    expect(out.name).toBe('短标题')
    expect(out.description).toBe('做了什么')
    expect(out.body).toContain('## 用户要求')
  })

  it('**对照：搜索仍然只在第一个标题之前**——正文里的「描述:」不能顶上', () => {
    // 这条是上面两条的代价上限。放开成全文搜索的话，模型在「## 涉及文件」
    // 下面写「描述: store.ts 那段」会被当成字段——那比认死行号还糟，
    // context 里会出现一句跟这轮无关的话
    const out = parseSummaryOutput('名称: 短标题\n\n## 涉及文件\n描述: 这行不能被当字段')
    expect(out.description).not.toBe('这行不能被当字段')
    expect(out.description).toContain('涉及文件') // 走的是 fallback，整段当描述
  })

  /**
   * 2026-09-03 真机验证抓到的：跑 4 轮真实对话，8 条摘要、**0 个叶子文件**。
   *
   * 用的 flash 档小模型把整个格式压成了一行——内容全对，四个字段
   * 一个不少，就是没有换行符。后果是一条四环全都不报错的链：
   *
   *   name 吃掉整行 → description 为空 → session.ts 的 `if (out.description)`
   *   为 false → finishSummary 从不被调用 → 摘要行永久卡在 pending →
   *   pending 在 covers 上打洞 → pickMergeGroup 要求连续 → 合并永远起不来
   *
   * 旧库里 213 条 pending、L0 合并停滞，根因就是这个。
   */
  describe('模型把格式压成一行（真机夹具）', () => {
    const oneLine =
      '名称: 系统信息与磁盘容量盘点描述: 执行 df -h 与 uname -a，确认是 macOS ' +
      'Sequoia 15.6，460Gi 盘已用 251Gi。未完成/失败: 无涉及文件: 无'

    it('**一行也要拆得出名称和描述**', () => {
      const out = parseSummaryOutput(oneLine)

      expect(oneLine).not.toContain('\n') // 前提：夹具确实只有一行
      expect(out.name).toBe('系统信息与磁盘容量盘点')
      expect(out.description).toContain('执行 df -h 与 uname -a')
      // name 不能把描述也吞进去——它是「十来个字的短标题」
      expect(out.name).not.toContain('df -h')
    })

    it('**原文非空时 description 绝不为空**——这条不变量比拆得准更重要', () => {
      // 空 description 的代价不是「摘要难看」，是整条流水线卡死（见上面那条链）。
      // 所以格式再怎么跑偏，也必须还回点东西
      for (const raw of [
        oneLine,
        '名称: 只有名称没有别的',
        '名称: 标题描述: ',
        '完全不按格式的一句话',
        '名称:',
      ]) {
        expect(parseSummaryOutput(raw).description, `raw = ${raw}`).not.toBe('')
      }
    })

    it('对照：多行输入的行为一个字没变', () => {
      // 拆行只在「整段就一行」时做。多行也拆的话，正文里的「描述:」会被
      // 当成字段——上面那两条测试盯的就是这个
      expect(parseSummaryOutput(structured)).toEqual({
        name: '历史懒加载方案对齐',
        description: '定了按 turn id 分页的方案，未写代码',
        body: '## 用户要求\n翻历史\n## 实际完成\n定方案',
      })
    })
  })
})

describe('tool_result 带图的渲染（web-tools D4）', () => {
  it('附图张数进 L0 材料，跟在 output 后面', () => {
    const rendered = renderTurn([
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c1', name: 'webfetch', input: { url: 'https://x' } }],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            output: '# 标题',
            isError: false,
            images: [
              { type: 'image', data: 'A', mimeType: 'image/png' },
              { type: 'image', data: 'B', mimeType: 'image/png' },
            ],
          },
        ],
      },
    ])
    expect(rendered).toContain('返回：# 标题（附图 2 张）')
  })
})
