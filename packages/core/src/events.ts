import type { ErrorKind } from './llm/protocol.ts'
import type { Usage } from './llm/types.ts'

/**
 * core 对外的事件流——**「模型说了什么 + 我们做了什么」**。
 *
 * 与 LLMEvent（llm/events.ts）的区别：那个只覆盖 HTTP 流里有的东西，这个还
 * 包含工具执行的结果。变量命名用 agentEv 而不是 ev（CLAUDE.md §3.1）。
 *
 * **必须可序列化**（不含函数、不含 class 实例）。这是给未来拆常驻 server 留的
 * 唯一后门，成本为零——streaming 本来就得是事件流——但如果写成
 * `await run() → 返回最终结果`，将来拆 server 就是重写。
 */
export type AgentEvent =
  // 文本。Start/End 配对（而不只是 delta）让 UI 知道一个块开始/结束了，好做折叠
  | { type: 'text_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'text_end' }
  // 推理。encrypted 不外传——那是发回给模型的不透明串，对 UI 没有意义
  | { type: 'reasoning_start' }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning_end' }
  // 工具。input 是流式累积的，攒完整才有 tool_call
  | { type: 'tool_input_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partial: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      id: string
      output: string
      exitCode: number
      /** 缩略图 data URL（256px JPEG）。原图几 MB 塞事件流会撑爆 webview */
      images?: string[]
    }
  | { type: 'tool_error'; id: string; message: string }
  /**
   * 后台进程列表有变化（新登记了残留/有进程死了/用户 kill 了）。
   * 全量快照，不是增量——宿主整包替换列表，不用记状态
   */
  | { type: 'bg_processes'; items: import('./tools/bg.ts').BgProcessInfo[] }
  // 控制
  /**
   * 流被重发了，**本轮已经吐出去的内容作废**（loop/retry.ts）。
   *
   * 请求是整个重发的（续传在协议层就没有支持），第二次会把同样的文本再吐
   * 一遍。UI 收到这个就清空当前 assistant 气泡，否则两次的内容会拼在一起
   * ——不报错，只是内容错了。
   */
  | { type: 'restart' }
  /**
   * 输出被 max_tokens 砍断了，loop 正在让模型接着写（loop/run.ts）。
   *
   * 跟 `restart` 相反：**已经吐出去的内容仍然有效**，后面的是续上去的，
   * UI 不能清空气泡。两个事件搞混的话，要么内容重复要么内容丢失，都不报错。
   */
  | { type: 'truncated'; attempt: number; limit: number }
  /**
   * 上下文到阈值，最老的 `count` 条消息被换成了「前 X 字符 + 归档路径」
   * （loop/unload.ts，design.md §9.4）。
   *
   * **原文没丢**，在 SQLite 和 `turns/*.jsonl` 里，模型可以 `cat` 回来。
   * UI 拿它提示用户「早期对话已归档」——不提示的话，用户翻上去会看到
   * 自己的消息变成了半截，像是数据被弄坏了。
   */
  /**
   * sinceMs = 距上次响应的毫秒（null = 本进程还没响应过，只有 budget/force
   * 可能带 null——stale 的判断依据就是它，必非 null）。渲染层把它写进
   * stale 文案「距上次响应 X 分钟」，文案自己就能自证有没有到 TTL，
   * 不用翻 runlog（2026-09-20，起因是「感觉没到 5 分钟却触发了」查无数据）
   */
  | {
      type: 'unloaded'
      count: number
      estimated: number
      reason: 'budget' | 'stale' | 'force' | 'merge'
      sinceMs: number | null
    }
  /**
   * 一步结束。**这是「一步」不是「一轮」**——一轮里模型每被调用一次就有
   * 一个，调工具之后还会继续。
   *
   * 这里**故意没有 `finish`**。曾经有过：`{ type: 'finish'; reason }`，
   * 声明在这儿但 loop 一次都没 yield 过（能产出 finish 的三处全在
   * llm/protocols/，那是 LLMEvent，见 §3.1 的命名规矩）。两个消费端各自
   * 写了 `case 'finish'` 的死分支，各自编了理由；VS Code 的消息页脚一度
   * 接在上面，结果是页脚永远不出现，而 tsc / lint / 全部单测都是绿的。
   *
   * **要加回来的话，先让 loop 真的产出它**，别只加类型——类型里凭空多一个
   * 成员，下游写出的就是永不执行的分支。「一轮结束了」目前由调用方自己
   * 判断：CLI 看 send() 的迭代器结束，扩展看 bridge 的 finally。
   *
   * `contextTokens` 是**下一轮要发出去多少**，不是这一轮发了多少：和预算
   * 判断（loop 的 `currentUsage`）同一个口径——上一轮真实 usage 打底 + 那
   * 之后新增的估算，量的都是拼装后那份。UI 拿它显示「上下文用了多少」；
   * 显示 `usage` 里的数会**滞后一轮且不含新增**，用户看到 126k 的时候触发
   * 线那边可能早就超了，「明明还很远却在归档」就是这么来的。
   */
  | { type: 'step_finish'; usage: Usage; contextTokens: number }
  /** 上一次成功请求的时延观测：ttftMs 是首块（text/reasoning 不分）到达差，totalMs 是整流耗时。overflow 自救重发后只发成功那次 */
  | { type: 'request_timing'; ttftMs: number; totalMs: number }
  /** kind 只在错误源自协议层（LLMStreamError）时有——顶层 catch 透传
   * detail 用的，UI 拿它决定给不给重试按钮、怎么标色。非协议错误
   * （未分类异常、熔断提示）就是纯 message */
  | { type: 'error'; message: string; retryable: boolean; kind?: ErrorKind }
