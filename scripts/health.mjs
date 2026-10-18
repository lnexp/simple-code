#!/usr/bin/env node
// 每日健康巡检：node scripts/health.mjs [YYYY-MM-DD]（默认今天）
// 读 ~/.simple-code/logs/<date>.jsonl，输出七段报告。这些检查此前是
// 每天人肉跑的 python（2026-10-08 起逐日重复），2026-10-16 固化。
// 只读，不写任何东西。

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const file = join(homedir(), '.simple-code', 'logs', `${date}.jsonl`)
if (!existsSync(file)) {
  console.error(`没有日志文件：${file}`)
  process.exit(1)
}

const short = (f) => f.replace(/^\/Users\/[^/]+/, '~').split('/').pop() || f
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]

const folder = {} // 项目活动
const anomalous = {} // 异常事件: [count, sample]
const retryErr = new Map()
const lags = []
const recall = {}
const approval = {} // [cat][decision] -> n
const approvals = new Map() // (folder|pid|id) -> approval[cat] 计数器
const cache = {} // model -> {req, rewrite, input, read, write, output}

for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line) continue
  let e
  try {
    e = JSON.parse(line)
  } catch {
    continue
  }
  const f = e.folder ? short(e.folder) : '(无)'
  folder[f] ??= { llm: 0, toolRun: 0, toolFail: 0 }
  switch (e.ev) {
    case 'llm':
      folder[f].llm++
      break
    case 'tool_run':
      folder[f].toolRun++
      break
    case 'tool_fail':
      folder[f].toolFail++
      break
    case 'llm_retry_giveup':
    case 'prefix_break':
    case 'merge_error':
    case 'llm_empty':
    case 'error':
    case 'interrupt':
    case 'task_close_error': {
      const sample = String(e.error ?? e.message ?? e.reason ?? JSON.stringify(e)).slice(0, 120)
      anomalous[e.ev] ??= [0, sample]
      anomalous[e.ev][0]++
      break
    }
    case 'llm_retry': {
      const msg = String(e.error?.message ?? e.error ?? '').slice(0, 80)
      retryErr.set(msg, (retryErr.get(msg) ?? 0) + 1)
      break
    }
    case 'loop_lag':
      lags.push(Number(e.ms) || 0)
      break
    case 'recall_select': {
      const r = (recall[f] ??= { select: 0, unparsed: 0, noKw: 0, ms: [], inject: 0 })
      r.select++
      if ('unparsed' in e || 'error' in e) r.unparsed++
      if (!('keywords' in e)) r.noKw++
      if (e.ms) r.ms.push(Number(e.ms))
      break
    }
    case 'recall_inject': {
      const r = (recall[f] ??= { select: 0, unparsed: 0, noKw: 0, ms: [], inject: 0 })
      r.inject++
      break
    }
    case 'approval_ask':
      approval[e.category ?? '?'] ??= { allow: 0, always: 0, deny: 0, noResult: 0 }
      approvals.set(`${f}|${e.pid}|${e.id}`, approval[e.category ?? '?'])
      break
    case 'approval_result': {
      const a = approvals.get(`${f}|${e.pid}|${e.id}`)
      if (a) a[e.decision ?? 'noResult']++
      break
    }
    case 'llm_usage': {
      const m = (cache[e.model ?? '?'] ??= { req: 0, rewrite: 0, input: 0, read: 0, write: 0, output: 0 })
      m.req++
      m.input += Number(e.input) || 0
      m.read += Number(e.cacheRead) || 0
      m.write += Number(e.cacheWrite) || 0
      m.output += Number(e.output) || 0
      // 整段重写不读：write>0 且 read==0（长间隔 TTL 过期或渠道漂移的信号）
      if (Number(e.cacheWrite) > 0 && !Number(e.cacheRead)) m.rewrite++
      break
    }
  }
}

console.log(`# 健康巡检 ${date}\n`)

console.log('## 项目活动')
for (const [f, s] of Object.entries(folder).sort((a, b) => b[1].llm - a[1].llm)) {
  console.log(`  ${f.padEnd(20)} llm ${String(s.llm).padStart(5)}  tool ${String(s.toolRun).padStart(4)}  fail ${s.toolFail}`)
}

console.log('\n## 异常事件')
const an = Object.entries(anomalous)
if (!an.length) console.log('  零异常')
for (const [ev, [n, sample]] of an) console.log(`  ${ev} ×${n}  ${sample}`)

console.log('\n## 重试')
if (!retryErr.size) console.log('  零重试')
for (const [msg, n] of [...retryErr.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
  console.log(`  ×${n}  ${msg}`)
}

console.log('\n## loop_lag')
if (!lags.length) console.log('  零记录')
else {
  const big = lags.filter((m) => m > 60_000)
  console.log(`  ${lags.length} 条，>60s ${big.length} 条，最大 ${Math.round(Math.max(...lags) / 1000)}s（大值多为 macOS 睡眠，见 note loop-lag-is-macos-sleep）`)
}

console.log('\n## recall')
for (const [f, r] of Object.entries(recall)) {
  const sorted = [...r.ms].sort((a, b) => a - b)
  const p = (q) => (sorted.length ? Math.round(pct(sorted, q)) : '-')
  console.log(
    `  ${f.padEnd(20)} select ${r.select}  inject ${r.inject}  unparsed ${r.unparsed}  空关键词 ${r.noKw}  p50 ${p(50)}ms  p95 ${p(95)}ms`,
  )
}
if (!Object.keys(recall).length) console.log('  零调用')

console.log('\n## 审批')
let askTot = 0
let okTot = 0
for (const [cat, d] of Object.entries(approval).sort()) {
  const tot = d.allow + d.always + d.deny + d.noResult
  askTot += tot
  okTot += d.allow + d.always
  console.log(`  ${cat.padEnd(14)} 弹 ${String(tot).padStart(3)}  放行 ${d.allow + d.always}  拒绝 ${d.deny}  无结果 ${d.noResult}`)
}
if (askTot) console.log(`  放行率 ${Math.round((okTot / askTot) * 100)}%（放行率高≠误弹：ask_rule 类是用户自设的确认流程）`)
else console.log('  零弹卡')

console.log('\n## 缓存健康（write>0 且 read=0 的请求数 = rewrite）')
for (const [m, s] of Object.entries(cache).sort((a, b) => b[1].req - a[1].req)) {
  console.log(
    `  ${m.padEnd(28)} req ${String(s.req).padStart(4)}  rewrite ${s.rewrite}  in ${(s.input / 1e3).toFixed(0)}k  rd ${(s.read / 1e3).toFixed(0)}k  wr ${(s.write / 1e3).toFixed(0)}k  out ${(s.output / 1e3).toFixed(0)}k`,
  )
}
