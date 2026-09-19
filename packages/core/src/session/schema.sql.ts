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
  meta        TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id      INTEGER NOT NULL REFERENCES turns(id),
  role         TEXT NOT NULL,
  content_json TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'live',
  step_id      INTEGER
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
  name          TEXT
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
  // 见 store.ts 的 clearLegacySummaries——一次性清空不能放这里（每次开库都跑）
  `CREATE INDEX IF NOT EXISTS messages_step ON messages(step_id)`,
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
]
