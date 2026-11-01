// 反思任务书的三条硬约束（docs/proposals/reflect-trigger.md §4）：
// 首行=任务名（同名闸的锚）、收尾事件前缀（面板「上次反思」的检索键）、
// 无 skill front matter（内置指令不是 skill 格式）
import { describe, expect, it } from 'vitest'
import { REFLECT_TASK_BOOK } from '../src/reflect'

describe('REFLECT_TASK_BOOK', () => {
  it('首行恒为「反思」——任务名与同名闸的锚，改它=破坏防重入', () => {
    expect(REFLECT_TASK_BOOK.split('\n')[0]).toBe('反思')
  })

  it('含收尾事件 memory-reflect- 前缀约定——面板按此找上次反思', () => {
    expect(REFLECT_TASK_BOOK).toContain('memory-reflect-')
  })

  it('非 skill 格式：无 front matter', () => {
    expect(REFLECT_TASK_BOOK.startsWith('---')).toBe(false)
  })

  // 只锁定任务书约定，执行质量需实跑验收。
  it('写入前核对记录与来源，写入后复读订正，报告未核实项', () => {
    const before = REFLECT_TASK_BOOK.indexOf('写入前由你自己对照本次工具调用与返回结果自查')
    const write = REFLECT_TASK_BOOK.indexOf('第一、二步攒下的全部写动作在这里统一执行')
    const after = REFLECT_TASK_BOOK.indexOf('## 第四步：自查与订正（必做）')
    const report = REFLECT_TASK_BOOK.indexOf('## 收尾（必做）')
    expect(before).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(write)
    expect(report).toBeGreaterThan(after)
    expect(REFLECT_TASK_BOOK).toContain('拿准备写入的结论逐项对照来源原文')
    expect(REFLECT_TASK_BOOK).toContain('重新读实际修改或')
    expect(REFLECT_TASK_BOOK).toContain('发现错误当场订正，再复读改动处')
    expect(REFLECT_TASK_BOOK).toContain('不另起核验任务')
    expect(REFLECT_TASK_BOOK).toContain('简述自查发现并订正了什么、还有什么未核实')
  })

  // 两次实跑（两个不同项目）都跳过主题 search 且写后
  // 自查没发现：阅读核对放在第二步末尾、进入写入之前；时间取 date 输出
  it('阅读核对是进入第三步的前提，收尾时间取 date 输出', () => {
    const gate = REFLECT_TASK_BOOK.indexOf('第二步收口（进入第三步前必做）')
    const write = REFLECT_TASK_BOOK.indexOf('## 第三步：写入')
    expect(gate).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(gate)
    expect(REFLECT_TASK_BOOK).toContain('list --all 只给索引行，不能代替主题 search --all')
    expect(REFLECT_TASK_BOOK).toContain("date '+%Y-%m-%d %H:%M:%S'")
  })

  // 重复错误指标（note self-diagnosis-repeat-error-metric，2026-10-25 拍板）：
  // 第四步之后、收尾之前；单独账本；首次 14 天基线；重复必附证据
  it('第五步自我诊断：位置、账本路径、首次基线、三类判定', () => {
    const check = REFLECT_TASK_BOOK.indexOf('## 第四步：自查与订正（必做）')
    const diag = REFLECT_TASK_BOOK.indexOf('## 第五步：自我诊断（必做）')
    const report = REFLECT_TASK_BOOK.indexOf('## 收尾（必做）')
    expect(diag).toBeGreaterThan(check)
    expect(report).toBeGreaterThan(diag)
    expect(REFLECT_TASK_BOOK).toContain('.simple-code/diagnosis/self-diagnosis.md')
    expect(REFLECT_TASK_BOOK).toContain('最近 14 天')
    expect(REFLECT_TASK_BOOK).toContain('重复·没想起来')
    expect(REFLECT_TASK_BOOK).toContain('重复·想起来没用上')
    expect(REFLECT_TASK_BOOK).toContain('证据不足记「未判定」')
    // 10-26 首跑：21 条「新错误」零检索、日期未核致误订正 t19412 → 每条附命令输出
    expect(REFLECT_TASK_BOOK).toContain('没跑检索的不能判「新错误」')
    expect(REFLECT_TASK_BOOK).toContain("grep -m1 '^created'")
  })
})
