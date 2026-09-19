import type { ToHost } from '../src/protocol.ts'

declare const acquireVsCodeApi: (() => { postMessage: (msg: unknown) => void }) | undefined

/**
 * 往扩展侧发消息。
 *
 * **`acquireVsCodeApi()` 可能返回 undefined**——已知三种情况，
 * 第一种是「**Cursor 扩展更新之后**」，而 Cursor 正是唯一的目标编辑器。不兜的话
 * `undefined.postMessage` 抛 TypeError，整个 webview 白屏——而真实原因
 * （宿主没给 API）在报错信息里一个字都看不到。
 *
 * 兜住之后表现是「点发送没反应」，至少界面还在，控制台里有一行说明。
 */
let api: { postMessage: (msg: unknown) => void } | null = null
let warned = false

export function post(msg: ToHost): void {
  api ??= (typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined) ?? null
  if (!api) {
    if (!warned) {
      warned = true
      console.warn('[simple-code] 拿不到 VS Code API，消息丢弃', msg)
    }
    return
  }
  api.postMessage(msg)
}
