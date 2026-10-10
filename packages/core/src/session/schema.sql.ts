/**
 * 表结构见 design.md §9.8，**包括第 2 步用不到的 summaries**。
 *
 * 现在就按最终形态建，是因为加一张表比给已有库做迁移便宜——第 3 步再建的话
 * 得先写迁移代码，而那时库里已经有真实数据了。三张表加起来不到 20 行，
 * 提前建的成本约等于零。
 *
 * `state` 列同理：第 2 步只会写 'live'，'unloaded' 是第 3 步的。
 *
 * 「提前建就不用迁移」这个便宜只占到了第 3b 步：`head` / `archive_path` 两列
 * 是后加的，而那时已经有真实的 `.simple-code/memory/state.db` 在跑了。
 * 所以下面有个 MIGRATIONS——**`CREATE TABLE IF NOT EXISTS` 对已存在的表
 * 一个字段都不会加，而且不报错**，老库会一直缺列到某个 SELECT 炸掉为止。
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'live',
  meta        TEXT,
  -- task-v3（docs/proposals/task-v3.md）：NULL=对话的轮；'task-xxx'=任务
  -- 的轮。对话流/记忆分治的唯一开关——关闭任务=owner 还俗为 NULL，该段
  -- 从此就是对话的历史，零特殊路径
  owner       TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id      INTEGER NOT NULL REFERENCES turns(id),
  role         TEXT NOT NULL,
  content_json TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'live',
  step_id      INTEGER,
  -- 行归属：NULL=主任务；'task-xxx'=任务（自己的轮 + fork 时复制来的主任务
  -- 上下文）。见 MIGRATIONS 末尾与 store.ts ensureInheritedCopy
  owner        TEXT
);

CREATE INDEX IF NOT EXISTS messages_live ON messages(state, id);

CREATE TABLE IF NOT EXISTS steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id    INTEGER NOT NULL REFERENCES turns(id),
  started_at TEXT NOT NULL,
  -- 整个 step 的原文已离开 context（存根还在 live 集合里，但那不算——
  -- stepUnloaded 看这个 flag，不看 live 行数）
  unloaded   INTEGER NOT NULL DEFAULT 0
);

-- messages(step_id) 的索引不放在这里：老库的 messages 表没有这列，
-- exec(SCHEMA) 又先于 migrate 跑——这里建索引会在 ALTER 补列之前炸。
-- 放 MIGRATIONS 里（ALTER 之后），新库老库都走得通

CREATE TABLE IF NOT EXISTS summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  level         INTEGER NOT NULL,
  covers_from   INTEGER NOT NULL,
  covers_to     INTEGER NOT NULL,
  text          TEXT NOT NULL,
  status        TEXT NOT NULL,
  in_context    INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER REFERENCES summaries(id),
  -- 卸载时才填：原话开头、归档路径。跟 text 分列存是因为**两个写入方不同**
  -- ——text 归后台摘要写，这两列归卸载写。挤一列的话谁后写谁把对方覆盖掉，
  -- 而且不报错（提案 §4.1 评审修正二）
  head          TEXT,
  archive_path  TEXT,
  -- 短标题，温区那一行显示它。跟 text（描述）分列：两者是模型一次生成的
  -- 两样东西，挤一列的话温区想只显示标题就得再切一次字符串
  name          TEXT,
  -- task-v3：摘要归属。NULL=对话的（含任务关闭后还俗的）；'task-xxx'=任务
  -- 私有的。私有摘要只在 owner 自己的组装里可见/进场——in_context 和行
  -- 的 state 一样是「窗口账本」，账本记在归属上而不是行的比特上
  owner         TEXT
);

-- search 的 FTS5 倒排索引（search-index.ts）。虚表 + 游标表，均可随时
-- 删了重灌（从 steps/messages 可完全推导）——它是加速结构，不是本体
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text,
  turn_no  UNINDEXED,
  step_no  UNINDEXED
);

CREATE TABLE IF NOT EXISTS search_fts_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- system prompt 四个磁盘源段（agents/notes/events/lessons）的快照，**每个
-- 会话域一行**（主任务 owner=''，任务 owner=任务 id，与 prefix_baseline
-- 同款）。建会话时若 prompt cache 还热（距上次响应 < cacheTtlMs）就
-- 沿用快照、不重读磁盘：磁盘内容变了会让 system prompt 变一个字，而
-- system prompt 在请求最前，它一变后面全部历史错位——2026-09-21 实测
-- 27 字符的事件索引行废掉 77k token 的前缀缓存（note
-- system-prompt-refresh-paths）。缓存冷了照常重读并回写这里。
-- reloadSystem（卸载触发点）刷新时也回写。
--
-- **必须按 owner 分行**（2026-09-25 实测翻车）：原来是全文件夹单行
-- （id=1），任务会话的 reloadSystem 在它自己的压缩点写快照——对主任务
-- 不是压缩点。主任务会话实例重建（面板重开/settings 变更，合法）读到
-- 被任务换过的快照 → system 在非压缩点变了 → PrefixBrokenError
-- （现场 prefix-breaks/2026-09-25T12-33-30-179Z.json：task-ws12fr 的
-- stale 车 12:27:30 写快照，主任务 12:33:30 重建即炸）。前缀不变式按
-- 会话域算，快照也必须按会话域分
CREATE TABLE IF NOT EXISTS prompt_snapshot (
  owner      TEXT PRIMARY KEY,
  agents     TEXT,
  user_agents TEXT,
  notes      TEXT,
  events     TEXT,
  lessons    TEXT,
  updated_at TEXT NOT NULL
);

-- 前缀不变式的基线（loop/prefix-guard.ts）：上一次请求的指纹（各块哈希），
-- 每个会话域一行（对话 owner=''，任务 owner=任务 id）。落盘是为了跨
-- reload：缓存还热的话 reload 后第一次请求也必须接得上上一次的前缀
CREATE TABLE IF NOT EXISTS prefix_baseline (
  owner       TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- recall 线索层（docs/proposals/recall.md §5）：每个 turn 的 cue 冻结快照
-- ——send 入口算一次，之后**永不变**。lines 是渲染好的成品行（JSON 数组），
-- names 是被撞候选的名字（短窗去重用，同一记忆连轮重撞 = 狼来了放大器）。
-- 渲染是装配期纯函数（relay 同款）：库里的消息行一个字节不动，assemble
-- 把 lines 贴在该 turn 的用户消息后面。turn 卸载（被摘要顶替）后 live 块
-- 不再出现，cue 随之自然消失，不删行也不用清——行很小，留着当影子模式
-- 的观察日志（mode=shadow 时只写不渲染）
CREATE TABLE IF NOT EXISTS cues (
  owner      TEXT NOT NULL DEFAULT '',
  turn_id    INTEGER NOT NULL,
  lines      TEXT NOT NULL,
  names      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, turn_id)
);
`

/**
 * 给建库之后才加的列补上。
 *
 * 每条都要能**重复执行**——`SCHEMA` 每次开库都跑一遍，这些跟着跑。SQLite 没有
 * `ADD COLUMN IF NOT EXISTS`，所以调用方吞掉「duplicate column」那个错。
 * 只用来加可空列：加非空列要给默认值，改列类型要重建表，那种规模的迁移不该
 * 藏在开库路径里。
 */
export const MIGRATIONS = [
  `ALTER TABLE summaries ADD COLUMN head TEXT`,
  `ALTER TABLE summaries ADD COLUMN archive_path TEXT`,
  `ALTER TABLE summaries ADD COLUMN name TEXT`,
  // step 摘要重做（step-summary-rework.md §4.1）：steps 表 + messages.step_id。
  // covers 的引用单位从 turn_id 换成 step_id，两套数字无法区分，旧 summaries
  // 整表清掉重建——原料全在 messages 表里，后台空闲几分钟补齐
  `CREATE TABLE IF NOT EXISTS steps (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     turn_id    INTEGER NOT NULL REFERENCES turns(id),
     started_at TEXT NOT NULL,
     unloaded   INTEGER NOT NULL DEFAULT 0
   )`,
  `ALTER TABLE messages ADD COLUMN step_id INTEGER`,
  // task-v3：owner 列。老库（含 v2 时代合并进来的段）全 NULL=对话，语义不变
  `ALTER TABLE turns ADD COLUMN owner TEXT`,
  // task-v3：摘要归属列（见 schema 的列注释）
  `ALTER TABLE summaries ADD COLUMN owner TEXT`,
  `CREATE INDEX IF NOT EXISTS turns_owner ON turns(owner)`,
  // 见 store.ts 的 clearLegacySummaries——一次性清空不能放这里（每次开库都跑）
  `CREATE INDEX IF NOT EXISTS messages_step ON messages(step_id)`,
  // 用户级 ~/.simple-code/AGENTS.md（2026-09-29）。老快照这列是 NULL =
  // 「没有用户级段」——与升级前的 system 一致，reload 后缓存照样接得上，
  // 下一个压缩点 reloadSystem 才读进来
  `ALTER TABLE prompt_snapshot ADD COLUMN user_agents TEXT`,
  // 一次性迁移的「跑过了」标记，一个迁移一行。
  //
  // **为什么不继续用 PRAGMA user_version**：一个单调整数扛不住两个互相独立的
  // 一次性迁移。`compactLegacyBacklog` 的闸是 `>= 3`；清洗迁移最初写 4，于是
  // 在空的新库上——压实判断「没积压」直接走、按注释说的**不置版本号**，清洗
  // 却把数字推到了 4。等这个库真攒出积压，压实已经被别人的版本号挡在门外，
  // **而且不报错**。store.ts 那句「别置版本号」警告的就是这个，实测踩到才
  // 明白单个整数根本表达不了「哪几个跑过了」
  `CREATE TABLE IF NOT EXISTS migrations (
     name   TEXT PRIMARY KEY,
     ran_at TEXT NOT NULL
   )`,
  // 页脚耗时落盘（用户拍板：历史事实不可变——落盘的是当时的值，之后换
  // 模型不改写历史轮）。model/effort 本来就在 turns.meta，缺的只是耗时
  `ALTER TABLE turns ADD COLUMN elapsed_ms INTEGER`,
  // 上下文隔离（2026-09-23 用户定死：任务与主任务只共享数据，上下文隔离、
  // 压缩独立）：消息行的归属。NULL=主任务；'task-xxx'=任务——含任务自己
  // 的轮，以及 fork 时从主任务上下文复制来的行（turn_id 仍是主任务的轮，
  // 所以归属不能再靠 turn 推）。回填只动「轮归任务、行还没标」的老行，
  // 幂等，每次开库跑一遍无害
  `ALTER TABLE messages ADD COLUMN owner TEXT`,
  `CREATE INDEX IF NOT EXISTS messages_owner ON messages(owner)`,
  `UPDATE messages SET owner = (SELECT t.owner FROM turns t WHERE t.id = messages.turn_id)
   WHERE owner IS NULL AND turn_id IN (SELECT id FROM turns WHERE owner IS NOT NULL)`,
  // turn 续接（docs/proposals/turn-resume.md，2026-09-29 拍板）：轮怎么结束的
  // + 最后一次结束时刻。end_state：'done' | 'aborted' | 'error'，NULL = 老轮
  // 或进行中，按 done 对待（不续）。ended_at 单独一列而不是 started_at +
  // elapsed_ms：续接轮的 elapsed 是累加的干活时长，不含中间停顿，两者相加
  // 算不出结束时刻
  `ALTER TABLE turns ADD COLUMN end_state TEXT`,
  `ALTER TABLE turns ADD COLUMN ended_at TEXT`,
]
