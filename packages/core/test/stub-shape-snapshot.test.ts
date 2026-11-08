import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Message } from '../src/llm/types.ts'
import { isStubMessage } from '../src/loop/regions.ts'
import { unloadMessage } from '../src/loop/unload.ts'

/**
 * 存根形态快照（2026-11-03，unit-pass-not-verified 教训）：卸载产物对拍——
 * 用真 unloadMessage 对真实消息生成存根，断言 isStubMessage 全认出。
 * 生成方（unloadMessage）与判定方（isStubMessage）在同一测试里对拍，
 * 通知格式哪边漂移这条先红，不用等真机炸。
 *
 * 取样教训（前两版快照取错的）：按「内容含已卸载字样」从库里捞，在
 * 这个仓库里注定误伤——我们天天讨论/grep 这个机制本身。改为抽**普通
 * live 消息**喂给生成方，产物形态只由 unloadMessage 决定。
 * 库不存在（CI/新机器）回落到合成样本，不跳过——对拍本身是确定性的
 */
describe('存根形态快照（unloadMessage × isStubMessage 对拍）', () => {
  it('含 tool I/O 的消息：卸载产物被 isStubMessage 认出；纯对话原样穿过（设计）', () => {
    // unloadPart 只裁 tool_result.output / tool_call.command，text/reasoning
    // 一律原样穿过——「已卸载 step 的对话文字还在场」是设计，lean 滤它们
    // 靠 unloadedSteps 身份判据，不靠文本形态
    const samples = realSamples()
    expect(samples.length).toBeGreaterThanOrEqual(20)
    let withTool = 0
    for (const [label, m] of samples) {
      const stub = unloadMessage(m, {
        // 压到 1：clipShell/clipOutput 对「不超过头+尾预算」的短内容原样
        // 放行（短的不值得裁，设计）——想全裁就得让守卫放不进任何东西
        threshold: 1,
        keepHeadChars: 1,
        outputHeadChars: 1,
        outputTailChars: 1,
        // 短 archive：真 archive 路径 62 字符，裁剪产物会比 ~60 字符的
        // 原文还长（最后一道守卫原样放行）——真机短输出本就裁不动，
        // lean 由 stepId 身份判据兜底；这里用短的是让「值得裁」的都真裁
        archive: 'x.jsonl',
      })
      // 可裁的 tool I/O：tool_result，或 input.command 是 string 的 tool_call
      // （bash）。**无 command 字段的 tool_call**（apply-patch 的 patch、
      // imagegen 的 prompt）clipCommand 不裁——卸载机制的既有边界，非
      // lean 下也原样在场；lean 滤它们靠 unloadedSteps 身份判据
      // 不猜长度界线（裁剪守卫是「产物短于原文」——同一内容因 archive
      // 长度/省略行位数不同而不同）：按**行为本身**分组——unloadMessage
      // 动了它，就必须带标记（对拍本意）；没动，就必须原样
      const changed = JSON.stringify(stub) !== JSON.stringify(m)
      if (changed) {
        withTool++
        expect(isStubMessage(stub), `${label} 的存根没被认出`).toBe(true)
      } else expect(stub).toEqual(m)
    }
    expect(withTool).toBeGreaterThanOrEqual(5) // 样本里得真有 tool I/O
  })
})

function realSamples(): [string, Message][] {
  if (existsSync('.simple-code/memory/state.db')) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite')
    const conn = new DatabaseSync('.simple-code/memory/state.db', { readOnly: true })
    // 排除内容里带「已卸载」的（unloadMessage 幂等跳过它们，测不到裁剪）
    const rows = conn
      .prepare(
        `SELECT id, content_json FROM messages WHERE state='live' AND role IN ('tool','user','assistant') AND content_json NOT LIKE '%已卸载%' ORDER BY id DESC LIMIT 60`,
      )
      .all() as { id: number; content_json: string }[]
    conn.close?.()
    return rows.map((r) => [`db#${r.id}`, JSON.parse(r.content_json) as Message])
  }
  // 合成回落（CI）：覆盖三种 part 形态
  return [
    ['synth-text', { role: 'user', parts: [{ type: 'text', text: '一整段够长的正文内容……' }] }],
    [
      'synth-tool',
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', toolCallId: 'c1', output: '总用量 100\ndata……', isError: false },
        ],
      },
    ],
  ] as [string, Message][]
}
