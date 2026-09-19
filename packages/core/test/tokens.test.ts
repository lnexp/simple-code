import { describe, expect, it } from 'vitest'
import type { Part, Usage } from '../src/llm/types.ts'
import { estimateTokens, totalInputTokens, totalTokens } from '../src/loop/tokens.ts'

const usage = (u: Partial<Usage>): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
  ...u,
})

describe('totalInputTokens', () => {
  it('三者相加 —— 冷缓存那次 inputTokens 只有 29，其余全在 cache_creation 里', () => {
    // 数字来自实测（design.md 附录 A）。只读 inputTokens 会把 23k 读成 29
    const cold = usage({ inputTokens: 29, cacheCreationInputTokens: 23263 })
    expect(totalInputTokens(cold)).toBe(23292)

    const warm = usage({ inputTokens: 12, cacheReadInputTokens: 23263 })
    expect(totalInputTokens(warm)).toBe(23275)
  })

  it('命中与否，完整输入量不变（这是那条不变量）', () => {
    const cold = usage({ inputTokens: 29, cacheCreationInputTokens: 23263 })
    const warm = usage({ inputTokens: 29, cacheReadInputTokens: 23263 })
    expect(totalInputTokens(warm)).toBe(totalInputTokens(cold))
  })

  it('totalTokens 把输出也算上', () => {
    expect(totalTokens(usage({ inputTokens: 10, cacheReadInputTokens: 5, outputTokens: 7 }))).toBe(
      22,
    )
  })
})

describe('estimateTokens', () => {
  it('图片按固定值算，与 base64 长度无关', () => {
    const small: Part = { type: 'image', mimeType: 'image/png', data: 'AA==' }
    const large: Part = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200_000) }

    expect(estimateTokens(small)).toBe(estimateTokens(large))
    // 对照：按 base64 长度算会得到 5 万多，卸载策略会因此误判。
    // 3300 = 缩放进 2048 边后的最坏值（(2048×1536)/750 取整上界）
    expect(estimateTokens(large)).toBe(3300)
  })

  it('文本按字符数估，4 字符一个 token', () => {
    // 4 是通用取值（各家内建估算常量同值）
    const short = estimateTokens({ type: 'text', text: 'x'.repeat(40) })
    expect(short).toBeCloseTo(10, 5)
    expect(estimateTokens({ type: 'text', text: 'x'.repeat(80) })).toBeCloseTo(short * 2, 5)
  })

  it('中文按 ~1 token/字估，不再除以 4（实测落点 52k/真实 71k 的根因）', () => {
    // 400 个汉字：旧口径 400/4=100，真实约 400。新口径必须显著高于旧
    const cn = estimateTokens({ type: 'text', text: '汉'.repeat(400) })
    expect(cn).toBeCloseTo(400, 5)

    // 对照组：英文仍按 /4
    expect(estimateTokens({ type: 'text', text: 'x'.repeat(400) })).toBeCloseTo(100, 5)
  })

  it('中英混排各按各的口径', () => {
    // 100 汉字 + 400 英文字符 = 100 + 100
    const mixed = estimateTokens({ type: 'text', text: '汉'.repeat(100) + 'x'.repeat(400) })
    expect(mixed).toBeCloseTo(200, 5)
  })

  it('全角标点也是单 token 级（，。「」）', () => {
    expect(estimateTokens({ type: 'text', text: '，。「」'.repeat(10) })).toBeCloseTo(40, 5)
  })

  it('JSON 里的中文值：中文按 1/字，JSON 骨架按密集口径 /2', () => {
    const part = { type: 'tool_call', name: 'bash', input: { command: '汉'.repeat(100) } } as Part
    const est = estimateTokens(part)
    // name('bash'=4) + JSON 骨架（"command":"" 约 14 个 ASCII 字符）≈ 18/2=9，
    // 加 100 个汉字 ≈ 109。按旧口径全按 /2 只有 ~59——中文部分被砍半
    expect(est).toBeCloseTo(109, 0)
  })

  it('tool_result 的中文输出不再按 /4 低估', () => {
    const est = estimateTokens({
      type: 'tool_result',
      toolCallId: 't',
      isError: false,
      output: '错误：文件未找到'.repeat(50),
    } as Part)
    expect(est).toBeCloseTo(400, 5)
  })

  it('reasoning 有 encrypted 时按解码后的长度估，不按 base64 长度', () => {
    const encrypted = estimateTokens({
      type: 'reasoning',
      text: '',
      encrypted: 'A'.repeat(400),
    })
    const plain = estimateTokens({ type: 'reasoning', text: 'A'.repeat(400) })

    expect(encrypted).toBeLessThan(plain)
    expect(encrypted).toBeCloseTo((400 * 0.75) / 4, 5)
  })

  it('tool_call 算上名字和序列化后的参数', () => {
    const withArgs = estimateTokens({
      type: 'tool_call',
      id: 'a',
      name: 'bash',
      input: { command: 'ls -la' },
    })
    const bare = estimateTokens({ type: 'tool_call', id: 'a', name: 'bash', input: {} })

    expect(withArgs).toBeGreaterThan(bare)
    expect(bare).toBeGreaterThan(0) // 空参数也有 name 和 "{}"
  })

  it('tool_result 按输出长度算 —— bash 输出是最大的单项', () => {
    expect(
      estimateTokens({
        type: 'tool_result',
        toolCallId: 'a',
        output: 'x'.repeat(40_000),
        isError: false,
      }),
    ).toBeCloseTo(10_000, 5)
  })

  it('tool_result 的内容像 JSON 时按密集口径算', () => {
    // 理由：密集 JSON 里 `{`、`}`、`:`、`,`、
    // `"` 全是单字符 token，真实比值接近 2 而不是 4。按 4 估会系统性低估，
    // 而低估不报错——只是不触发卸载，然后请求撞窗口
    const json = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ f: `a${i}`, n: i })))
    const asJson = estimateTokens({
      type: 'tool_result',
      toolCallId: 'a',
      output: json,
      isError: false,
    })

    // 对照：同样长度的普通命令输出走 4 的口径，估出来是一半
    const plain = 'x'.repeat(json.length)
    const asPlain = estimateTokens({
      type: 'tool_result',
      toolCallId: 'a',
      output: plain,
      isError: false,
    })

    expect(asJson).toBeCloseTo(json.length / 2, 5)
    expect(asPlain).toBeCloseTo(json.length / 4, 5)
  })

  it('tool_call 的参数一律按 JSON 口径 —— 它序列化出来一定是 JSON', () => {
    const part: Part = { type: 'tool_call', id: 'a', name: 'bash', input: { command: 'ls -la' } }
    const serialized = 'bash'.length + JSON.stringify({ command: 'ls -la' }).length
    expect(estimateTokens(part)).toBeCloseTo(serialized / 2, 5)
  })
})

describe('tool_result 带图的计量（web-tools D4）', () => {
  it('每张图 3300，加在文本之上', () => {
    const text: Part = { type: 'tool_result', toolCallId: 'c', output: 'ok', isError: false }
    const withImg: Part = {
      type: 'tool_result',
      toolCallId: 'c',
      output: 'ok',
      isError: false,
      images: [
        { type: 'image', data: 'A', mimeType: 'image/png' },
        { type: 'image', data: 'B', mimeType: 'image/png' },
      ],
    }
    expect(estimateTokens(withImg) - estimateTokens(text)).toBe(6600)
  })
})
