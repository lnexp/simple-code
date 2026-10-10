import type { Message } from '../llm/types.ts'
import type { Db } from './db.ts'

/**
 * 一次性清洗写放大留下的垃圾行。跑一次，`user_version` 置 4。
 *
 * ## 为什么需要它
 *
 * `a84633a` 之前 `pickOldest` 会把已经是存根的消息也算进 picked（`clip` 对存根
 * 是恒等的，省不到 token），于是 `estimated` 一点不降、循环把整个 live 集合挑
 * 光，每轮 `replaceLive` 把它们整体重写一遍。真实库里的后果：
 *
 * ```
 * 66,545 行 → 剥标记后去重只剩 8,986 行   86% 是垃圾
 * 64,133 行带卸载标记，标记文本占全表 30%
 * 33,937 行叠了不止一个标记，最多 10 个    ← 4cce410 幂等保护之前的
 * ```
 *
 * **这不只是占磁盘。** `historyPage`（`store.ts` 的分页）查的就是
 * `state = 'unloaded'`——面板往上拉看到的历史，现在 86% 是重复的。
 *
 * ## 两步，各自的边界不一样
 *
 * 1. **折叠末尾叠加的通知**：所有行，只留最后一个
 * 2. **去重**：**只在 `state = 'unloaded'` 里做，live 行一条都不删**
 *
 * 第 2 步为什么不碰 live：live 只有 986 行、0 MB，删了没收益；而两条内容
 * 完全相同的 live 消息**可能是真的**（用户连发两次「继续」），删掉就是真丢
 * 数据。收益为零的操作不值得承担这个风险。
 *
 * 同理，**不跨 turn 合并**：同一条内容出现在 12 个 turn 里是 turn 归属的
 * 下标漂移（提案 §1.5 补记），要在归属那边修。在这里按内容合并等于用清洗
 * 脚本掩盖一个逻辑 bug，而且合并之后就再也看不出归属错过。
 */
export function cleanupLegacyRows(db: Db): void {
  if (db.all(`SELECT 1 AS x FROM migrations WHERE name = ?`, MIGRATION).length > 0) return

  db.transaction(() => {
    collapseStackedMarkers(db)
    dedupeUnloaded(db)
    db.run(`INSERT INTO migrations(name, ran_at) VALUES(?, datetime('now'))`, MIGRATION)
  })
}

/**
 * 标记写在 `migrations` 表，**不用 `PRAGMA user_version`**。
 *
 * 第一版用 `user_version = 4`，在空的新库上就把 `compactLegacyBacklog` 的
 * `>= 3` 闸关死了——后者判断「没积压」时**故意不置版本号**，等这个库真攒出
 * 积压，它已经被我推高的数字挡在门外，且不报错。`store.ts` 里那句「不够长
 * 就直接走，别置版本号」警告的正是这个形状，我从另一头撞了进去，
 * `store.test.ts` 的四条压实测试当场红。见 `schema.sql.ts` 的 migrations 表。
 */
const MIGRATION = 'cleanup-write-amplification'

/**
 * 结尾处连续的一串卸载通知。两种写法都要匹配：`clip` 写 `\n[…]`，
 * `clipShell` 写 `\n# […]`（`unload.ts`）。
 *
 * ## 两条约束，都是在真库副本上炸出来的
 *
 * **一、只认结尾（`$`），不认正文中间的。** 真库里有这样一行——一次
 * `grep unload.ts` 的输出，正文里合法地引用了通知的源码文本：
 *
 * ```
 * 82:  const notice = `\n[已卸载，完整内容见 ${archive}]`
 * ```
 *
 * 无锚点的正则会把它当成通知删掉，而那是用户看到的真实工具输出。判据来自
 * `clip` 的行为——它**只追加在末尾**，所以只有结尾那一串才是通知。
 *
 * **二、在解码后的字符串上匹配，不在 `content_json` 原文上。** 上面那行在
 * JSON 里是 `\\n[已卸载…]`（字面反斜杠 + n），在原文上匹配 `\\n` 会吃掉后
 * 一个反斜杠、留下半个转义序列，整行 JSON 从此解析不了。第一版就是这么写
 * 的，在真库副本上开库当场 `Bad escaped character in JSON`——**副本先跑这
 * 一步不能省**，直接上真库就是 6 天的会话历史带着一行坏 JSON 再也开不起来。
 */
const TRAILING_NOTICES = /(?:\n(?:# )?\[已卸载，完整内容见 [^\]]*\])+$/

/** 结尾那串通知里只留最后一个——它指向最近一次卸载写的归档路径 */
function keepLastNotice(text: string): string {
  const run = TRAILING_NOTICES.exec(text)
  if (run === null) return text
  return text.slice(0, run.index) + run[0].slice(run[0].lastIndexOf('\n'))
}

/** 通知只可能挂在这两个字段的末尾：文本正文、工具输出 */
function mapTexts(message: Message, f: (text: string) => string): Message {
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === 'text') return { ...part, text: f(part.text) }
      if (part.type === 'tool_result') return { ...part, output: f(part.output) }
      return part
    }),
  }
}

const parse = (json: string): Message => JSON.parse(json) as Message

function collapseStackedMarkers(db: Db): void {
  const rows = db.all<{ id: number; content_json: string }>(`SELECT id, content_json FROM messages`)
  for (const row of rows) {
    const collapsed = JSON.stringify(mapTexts(parse(row.content_json), keepLastNotice))
    if (collapsed !== row.content_json) {
      db.run(`UPDATE messages SET content_json = ? WHERE id = ?`, collapsed, row.id)
    }
  }
}

/**
 * 同一个 turn 里内容相同（剥掉结尾通知后）的 unloaded 行只留最早那条。
 *
 * 留最早而不是最晚：`historyPage` 同 step 内按 id 排序当时间轴，留最早的那条，这段历史
 * 在面板里的位置才跟它真正发生的时刻对得上。
 */
function dedupeUnloaded(db: Db): void {
  const rows = db.all<{ id: number; turn_id: number; content_json: string }>(
    `SELECT id, turn_id, content_json FROM messages WHERE state = 'unloaded' ORDER BY id`,
  )
  const kept = new Set<string>()
  for (const row of rows) {
    const stripped = mapTexts(parse(row.content_json), (t) => t.replace(TRAILING_NOTICES, ''))
    const key = `${row.turn_id} ${JSON.stringify(stripped)}`
    if (kept.has(key)) db.run(`DELETE FROM messages WHERE id = ?`, row.id)
    else kept.add(key)
  }
}
