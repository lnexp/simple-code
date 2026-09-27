import { appendFileSync, createWriteStream, mkdirSync, readFileSync, type WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Message, Part } from '../llm/types.ts'
import type { LiveMessage, Summary, SummaryStatus, UnloadedRef } from '../loop/assemble.ts'
import type { RegionSizes } from '../loop/regions.ts'
import { estimateMessageTokens } from '../loop/tokens.ts'
import { takeSegment } from '../loop/turns.ts'
import { searchable } from '../tools/memory.ts'
import type { RawSink } from '../tools/types.ts'
import { bucketedRel, ensureBucketFile, migrateToBuckets } from './buckets.ts'
import { cleanupLegacyRows } from './cleanup.ts'
import { type Db, openDb, type SqlValue } from './db.ts'
import { ensureGitIgnored } from './gitignore.ts'
import { type Leaf, leafName, readLeavesByCovers, writeLeaf as writeLeafFile } from './leaf.ts'
import { MIGRATIONS, SCHEMA } from './schema.sql.ts'
import { syncSearchIndex } from './search-index.ts'

export const MEMORY_RELATIVE = join('.simple-code', 'memory')

/**
 * 「这行不是任务的复制行」（messages 表无别名时可用）。复制行 = fork 时从
 * 主任务上下文复制给任务的 live 行：行归任务、轮归主任务，两者 owner 不等。
 * 按 step 读原文的地方（摘要输入、head、检索索引）要排除它——同一段历史
 * 在库里有两份，不排除就读成双份
 */
export const NOT_COPY = `messages.owner IS (SELECT t.owner FROM turns t WHERE t.id = messages.turn_id)`

/**
 * 历史分页的一行。id 是 messages 表的主键——AUTOINCREMENT 只增不重用，
 * 天然稳定游标。parts 是 canonical 原文（未经卸载截断——截断只发生在
 * live 行上，unloaded 行存的是全量原文，这正是「往上拉能看到完整历史」
 * 的前提）
 */
export type HistoryRow = {
  id: number
  /** 行属于哪轮。同轮最后一条 assistant 挂该轮页脚（model/耗时） */
  turnId: number
  role: 'user' | 'assistant' | 'tool'
  parts: Part[]
  /** 这一轮当时的模型/档位快照。加列之前的老轮次是 null */
  meta: TurnMeta | null
  /** 轮耗时（ms）。轮没跑完或加列之前的老轮次是 null */
  elapsedMs: number | null
  /** 轮完成时刻（epoch ms）= started_at + elapsed_ms。没有 elapsed 时是 null。
   * 页脚渲染以 finishedAt 为开关（App.tsx），缺了它历史轮整个页脚不显示 */
  finishedAt: number | null
}

/** turn 创建时以 JSON 落进 turns.meta。model 用 `provider/name` 全身份——
 * 同名模型可以配在两个 provider 下（load.ts 的注释），只给名字就有歧义 */
export type TurnMeta = { model: string; effort: string | null }

/**
 * 一个摘要单位：闭区间的 step id。`summaries.covers_from/to` 就是这两个数，
 * 所以从「一个 step」换成「一个 turn 的一段」不动表结构——assemble、L1 合并、
 * flipSummary 看到的仍然是连续 step 区间。
 */
export type Segment = {
  from: number
  to: number
  /** 这一段属于哪个 turn——**一段不会跨 turn**（见 nextSegment）。叶子文件名要用 */
  turn: number
}

/**
 * 磁盘上的会话状态。
 *
 * 第 2 步做「一切都记下来，重启能恢复」，第 3a 步加了卸载（`unload`）。
 * **摘要和分层合并还没有**——它们要等交互式 CLI（§9.7 的空闲触发在一次性
 * 执行的 CLI 下永远等不到），所以 `summaries` 表建了但一行都不写。
 *
 * 分步的理由是文档原话：「持久化能独立验证而卸载不能——卸载的正确性依赖
 * 『原文确实在磁盘上』这个前提」。
 */
export type Store = {
  /** 工作区根。运行日志（runlog）在摘要等模块级函数里从这里取目录标识 */
  readonly root: string
  /** 重启后读回的 live 上下文。顺序即写入顺序 */
  load(): Message[]
  /**
   * 把当前历史落盘。**全量替换，不是追加**——理由见实现处的注释。
   *
   * 调用点是「消息定稿」的时刻（session.ts）。同步执行：这个函数返回时
   * 数据已经在 SQLite 里，`kill -9` 也丢不掉。
   */
  save(messages: Message[]): void
  /** 一个 user 消息 + 后续往返算一个 turn（design.md §9.5）。返回 turn id */
  beginTurn(meta: TurnMeta): number
  /** 轮定稿时写耗时。update 而非改 meta JSON：elapsed 是独立事实列 */
  finishTurn(id: number, elapsedMs: number): void
  /**
   * `normalizeHistory` 增删过消息之后，按它报告的来源下标重排归属数组。
   *
   * **不调这个的话不报错，只是某轮历史归错 turn**——`attributeTurns` 纯按
   * 下标对齐，一次中断补 tool_result，插入点之后的全部历史整体错一位，
   * 要到摘要按 turn 分组时才炸（提案 §1.5 补记）。`applyPendingMerges` 那条
   * 路径早就有「必须通知 store」的注释，但只堵了一条路。
   */
  remapMessages(origin: (number | null)[]): void
  /**
   * applyPendingMerges 从 ctx.messages 中段剪掉已收编的存根块后调用：
   * 归属数组必须同步缩掉同样的下标。**不缩的话下一次 save 按下标对齐会全体
   * 错位**——凭空造出没有消息的幽灵 step，covers 连续性从此断裂，
   * 上层 L1 永远接不上（step-summary-rework §4.4 的坑）
   */
  pruneMessages(indices: number[]): void
  /** run loop 每条 assistant 响应开新 step（step-summary-rework §4.2） */
  beginStep(): number
  /** 一段（闭区间 step id）的全部消息，按落库顺序 */
  segmentMessages(segment: Segment): Message[]
  /**
   * 下一个待摘的**段**：同一个 turn 内一段连续、无摘要覆盖的 step
   * （提案 §4.3）。候选不依赖 live 状态；太短的也在内——走模型还是落本地 L0
   * 由调用方按 summaryMinTokens 决定（见 session.summarizeOnce）。
   * 没有候选返回 null。
   *
   * 单位是 turn 而不是 step：一个 turn 里九次工具往返讲的是同一件事，
   * 按 step 摘等于把它摘九遍（§1.1）。`budgetTokens` 是单段上限，
   * 超了就切（§4.3）。
   *
   * `activeTurn` 是**正在跑的那个 turn**，整个排除；idle 时传 null，
   * 一个都不排除。为什么不能只排除最后一个 step，见 nextSegment 的注释。
   */
  nextSegmentToSummarize(budgetTokens: number, activeTurn: number | null): Segment | null
  /**
   * 删掉一行摘要。只用来收拾**没能生成完**的行（pending / generating）。
   *
   * 不删的话那一段 step 就永远补不上：`nextSegment` 算「已覆盖」时不看 status，
   * 一行卡住的 pending 会永久占着它盖的 step，谁也不会再去摘。而 covers 上的
   * 洞会让 `pickMergeGroup` 的连续性判断断掉——合并从此起不来。归档掉的那个
   * 真库里 213 条 pending 加上 L0 合并停滞，就是这么攒出来的。
   *
   * 带 `in_context = 0` 的守卫：生效中的行删掉会让那截历史凭空消失。正常流程
   * 到不了（`activateSummary` 只认 ready），这条是防御。
   */
  dropSummary(id: number): void
  /**
   * 段头那一步是否已卸载（「碰头即上岗」的判定，提案 §11.6 坑三的修法）。
   * 补摘直通生效和 run.ts 卸载路径共用这一条规则，两条路必须同源
   */
  segmentHeadUnloaded(segment: Segment): boolean
  /** 翻 in_context=1（L0 补摘直通生效用） */
  flipSummary(id: number): void
  /** 工具原始输出的落盘句柄（§9.3 的第 ① 层）。调用方负责 close */
  rawSink(toolCallId: string): RawSink
  /**
   * 把这些下标的 live 行标记为已卸载，返回各自的归档路径（工作区相对）和
   * turn 归属。下标对齐 `load()` 的顺序。
   *
   * **只改 state，不动 content_json**——原文就是靠这个留在库里的。调用方拿
   * 返回的路径去构造截断版消息，下一次 `save` 会把截断版作为新的 live 行插入。
   */
  unload(indices: number[]): UnloadedRef[]
  /**
   * 把这些 step 标为冷（原文已不在 context，摘要可以顶替）。
   *
   * **和 `unload` 分开**：卸载单位是 turn（§4.5 ④），但一个 turn 里裁剪后
   * 一个字不变的短消息不会进 `unload` 的 indices——给它们也存一份「原文」
   * 就是往库里写内容完全相同的两行。于是「这个 step 还有没有 live 行」
   * 不再等价于「它冷了没有」，判冷得由决定冷热的那一方直接说。
   */
  markCold(stepIds: number[]): void
  /**
   * 追加一行「这次请求四个区各占多少」到 `memory/regions.jsonl`。
   *
   * **不入库。** 它是给人事后调比例看的（提案 §13.4 那几组数就是这么来的，
   * 只不过当时是手工抓包反推），不参与任何运行时判断，也不需要被 `load()`
   * 读回来。放进 SQLite 就得管迁移、管 `DELETE` 的时机；删一个 jsonl 文件
   * 不影响会话的任何一点状态。
   *
   * 行里带本会话的 owner（主任务 null / 任务名）：主任务和任务共用同一个
   * memoryRoot，谁装配请求谁追加一行——没有归属标记的话面板读尾行就是
   * 「最后写入者赢」，任务视图看到主任务的数字（get_regions 的坑，2026-09-24
   * 任务实测：任务面板显示主任务的 137k live、主任务面板显示任务的几十 k）
   */
  recordRegions(sizes: RegionSizes, budget: number): void
  /**
   * 把一段的摘要落成叶子文件（`summaries/turn-000087-s000123.md`，提案 §4.3）。
   *
   * 正文只在文件里，不进 `summaries.text`——库里那一列存的是**描述**，
   * 也就是进 context 的那一行。这正是 §4.4 的分辨率梯度：正文（叶子文件）
   * → 键（name+描述）→ 内部节点一行，每一级都是换个已有的表示，没有二次生成。
   */
  writeLeaf(segment: Segment, leaf: Omit<Leaf, 'turn' | 'coversFrom' | 'coversTo'>): void
  /**
   * 这几条摘要的叶子正文，按 summary id。**只给热区那几条用**（§4.4）。
   *
   * 查不到就不在返回值里——摘要生成了但模型没按格式输出（C 步的降级路径）、
   * 或者文件被删了，都是这种。调用方按「没有正文」走温区渲染，不是报错
   */
  leafBodies(summaries: Summary[]): Map<number, string>
  /** live 消息连同它们的 turn 归属。拼装（`assembleContext`）要按 turn 对齐 */
  liveWithTurns(): LiveMessage[]
  /**
   * 历史分页（往上拉加载）：读 `unloaded` 原文行，按 id 从新到旧翻页，
   * 返回时翻回正序（老→新），供 UI 直接 prepend。
   *
   * - cursor=null：第一页，从最新的 unloaded 行起（即紧贴 live 区下方）
   * - 返回的 next：下一页的 cursor；null = 到底。**hasMore 的判定在
   *   SQL 里数一次**，不靠「返回条数 < limit」——那要假设没有并发写入，
   *   而后台摘要线程恰好会并发地翻行状态
   */
  historyPage(cursor: number | null, limit: number): { rows: HistoryRow[]; next: number | null }
  /**
   * 批查若干轮的 meta/耗时。给 webview 基线用：live 轮不走 historyPage
   * （那是 unloaded 翻页的查询），但页脚要的「当时模型·耗时」一样得从
   * turns 行读——重启后 lastFooter 这种内存态清零，只剩落盘值可用
   */
  turnsInfo(turnIds: readonly number[]): Map<
    number,
    { meta: TurnMeta | null; elapsedMs: number | null; finishedAt: number | null }
  >
  /**
   * 最后一轮的完成时刻（epoch ms，= turn 开始 + 耗时）。null = 库里还没有 turn。
   *
   * 只给缓存过期判断做**重启兜底**（提案 §12）：正常计时走 session 闭包里的
   * lastResponseAt（响应结束时刻），只有重启后那份丢了才来读这里。原来是
   * 最后一个 step 的**开始**时刻——TTL 是按模型配的（glm-5.3 是 5 分钟），
   * 一轮跑几分钟的话开始口径天然把间隔算小、倾向误判过期，2026-09-20 换成
   * 完成时刻。最后一轮被打断没落耗时（elapsed_ms null）时退回开始时刻——
   * 被打断的那轮缓存多半也凉了，方向上可接受
   */
  lastRespondedAt(): number | null
  /**
   * 每条 live 消息所在轮的产出模型（turns.meta.model，`provider/name`；
   * 老库无 meta 的轮为 null）。下标对齐 `load()`。给 send 判「历史里哪些
   * reasoning 签名不是当前模型签的」用（session.ts dropForeignSignatures）
   */
  liveTurnModels(): (string | null)[]
  /**
   * system prompt 四个磁盘源段的快照（agents 是 clamp 后的；null = 该段
   * 不进 prompt，与 readNotesIndex 等的 null 语义一致）。建会话时缓存还
   * 热就沿用，见 schema.sql.ts prompt_snapshot 的表注释
   */
  readPromptSnapshot(): { agents: string | null; notes: string | null; events: string | null; lessons: string | null } | null
  writePromptSnapshot(snap: {
    agents: string | null
    notes: string | null
    events: string | null
    lessons: string | null
  }): void
  /** 前缀不变式基线（prefix-guard.ts）：本会话域上一次请求的指纹 JSON */
  readPrefixBaseline(): string | null
  writePrefixBaseline(fingerprint: string): void
  /**
   * 取走「合并待压缩」标记（读并删，一次性）。finalizeTask（任务合并还俗）
   * 落的——合并改写了主任务的前缀（经历摘要进场），这个改写必须搭压缩的
   * 车才合法（前缀不变式），而合并那一刻会话多半不在手上，只能标记等
   * 下一次请求把它当压缩触发处理（run.ts unloadIfNeeded）
   */
  consumeMergePending(): boolean
  /**
   * 给**内存里的**历史配上 turn 归属，供发请求前拼装用。
   *
   * 跟 `liveWithTurns` 的区别是数据从哪来：那个读库，这个用调用方传进来的数组。
   * loop 每轮都在改内存历史（卸载就地改写、normalize 重建数组），改完还没
   * `save` 就要发请求，这时库里是上一轮的状态。
   *
   * 归属规则跟 `save` 共用一份（老消息保留原归属，新增的算当前 turn）——
   * 两处各写一遍的话，摘要会盖错 turn，现象是 context 里某轮凭空消失或重复。
   */
  withTurns(messages: Message[]): LiveMessage[]
  /** summaries 表全部行。调用方自己按 `inContext` 过滤 */
  summaries(): Summary[]
  /**
   * recall 线索层（cue.ts）：本 turn 的冻结快照落库。`ON CONFLICT DO
   * NOTHING`——cue 是一次性的（send 入口算一次），任何重写路径都是 bug
   */
  saveCue(turnId: number, lines: string[], names: string[]): void
  /** 全部 cue 行（turn → 成品行）。渲染是纯函数读，任务视角也读对话行——
   *  继承轮带着它的 cue 一起被继承，语义一致 */
  cues(): Map<number, string[]>
  /** 最近 N 个 turn 被撞过的候选名（短窗去重） */
  recentCuedNames(dedupTurns: number): Set<string>
  /** 最近 N 个可见 turn 的可检索文本（旧→新）。cue 的信号源，与 memory
   *  search 同源（searchable）——搜得到的词才谈得上撞得到 */
  cueTurnTexts(window: number): string[]
  /** 缝 (from, to) 开区间里有没有内容痕迹（可见消息/外主 steps）——跨缝合的第②③道保险 */
  gapHasContent(from: number, to: number): boolean
  /** 建一条摘要行，返回 id。text 先存占位，ready 时再换 */
  addSummary(row: Omit<Summary, 'id' | 'owner'>): number
  /**
   * 卸载这个 step 时启用它的 L0 摘要：翻 `in_context`，补上原话开头和归档路径。
   *
   * **head 和 archivePath 由这里自己从库里算**（`headOfStep`），不从调用方
   * 收。原来是 run.ts 从「刚被卸载的那几条」里取，但第 0 层改成只裁工具
   * I/O 之后（提案 §4.2），文本消息永远不进那个集合，头部就退化成
   * `(tool_call)` ——§1.2 那 15% 垃圾的来源之一。
   *
   * **返回是否真的启用了。** 只有 `status = 'ready'` 的行才启用——摘要还在
   * 生成（或压根没生成）时返回 false，调用方走 3a 的截断存根（§9.7 的降级路径）。
   * 判断放在 SQL 里而不是让调用方先查再改：查和改之间摘要可能刚好写完，
   * 两条路径都走一遍的话 context 里会既有摘要又有存根。
   */
  activateSummary(stepId: number): boolean
  /** 已卸载（推进线过）的 step id 集合。存根段水位的口径要用：已卸未
   * 顶替的内容——存根和裁不动的原文——都算「等摘要收的滞留」 */
  unloadedSteps(): Set<number>
  /** 摘要生成完了。**只动这两个字段**，别顺手改 in_context——生效是 3b-2 的事 */
  finishSummary(id: number, text: string, name: string): void
  /** 标记开始生成。分出来是为了让「同时只有一个在跑」这件事在库里也看得见 */
  startSummary(id: number): void
  /**
   * 合并落库（§9.1 的「合并」，**只写这里，context 不动**）：插入上层行，
   * 把成员的 `superseded_by` 指过去。一个事务——插了父行但成员没标的话，
   * 下次合并会把这些成员再吃一遍，一份历史进两个 L1
   */
  recordMerge(row: Omit<Summary, 'id' | 'owner'>, memberIds: number[]): number
  /** 四表 MAX(id)——任务跑超检查（task-v3 配额闸）的输入。任务会话里只数
   *  **本段内**的号：对话 fork 后跳到段上方接着写，全库 max 越过段界是
   *  常态，不是配额烧穿 */
  maxIds(): { turns: number; steps: number; messages: number; summaries: number }
  /**
   * 生效（§9.1 的「生效」）。把所有「待生效」的塌缩换进来：子孙 → 0，
   * 链根 → 1，**一个事务、一次调用全部应用**（不是逐个合并地应用）。
   *
   * 返回被换出 context 的 turn id 集合——调用方要拿它修剪内存里的截断存根，
   * 不修剪的话 token 估算看不见这次释放，卸载会多卸一批（「生效先于卸载」
   * 就白设计了）
   */
  applyMerges(): Set<number>
  /**
   * 内存里的截断存根删掉之后，turn 归属缓存跟着缩。跟 `unload` 缩 turnOf
   * 是同一个道理：`turnOf` 和内存 messages 按同一谓词（turn id 在集合里）
   * 各自过滤，两边条数才仍然对得上
   */
  close(): void
}

/**
 * 任务的会话域（task-v3）：同一个库里「我是谁、看得见哪些轮、新行分配在哪个
 * 号段」。主对话（无 scope）看得见 owner IS NULL 的一切；任务看得见继承上界
 * （forkTurn 含）以下的对话历史 + 自己 owner 的轮。关闭任务把 owner 还俗为
 * NULL，该段自动变成对话可见——可见性规则只此一条，没有第二种路径
 */
export type TaskScope = {
  owner: string
  /** 继承上界（含）：owner IS NULL 且 id ≤ 此值的轮对任务可见 */
  forkTurn: number
  /** 分配上界（不含）。turns 的上界正是 fork 时插的 reserved 行，占住 max */
  turnCeil: number
  /** 以下三轴分配域 (floor, ceil]：floor=fork 时主库该轴 max */
  stepFloor: number
  stepCeil: number
  msgFloor: number
  msgCeil: number
  sumFloor: number
  sumCeil: number
}

/** 任务段配额用尽。跑到 beginTurn/save/addSummary 才发现——上抛为轮错误，
 *  任务只能关闭（docs/proposals/task-v3.md 配额表） */
export class SegmentFullError extends Error {
  constructor(axis: string) {
    super(`任务段配额用尽（${axis}）——请关闭任务`)
  }
}

/** migrations 表里「这个任务的继承上下文已复制」的标记名 */
export const copyMarker = (owner: string): string => `task-context-copy:${owner}`

/**
 * 把主任务此刻的上下文**复制一份归任务所有**（2026-09-23 用户定死的隔离
 * 原则，note task-context-isolation）：任务和主任务只共享数据库与文件，
 * 上下文各管各的——主任务之后压缩（卸载原文、摘要进场、合并）只改它自己
 * 的行，任务那份一个字不变；反过来也一样。
 *
 * 为什么复制而不是给原行打标记：主任务每次存盘整份 DELETE+INSERT
 * （replaceLive），行号存一次换一次，标记指向的行下一次就不存在了。
 *
 * 复制什么：
 * - messages：主任务 live 行（轮 ≤ forkTurn）→ 同 turn_id/step_id、
 *   owner=任务、id 取任务消息段。已卸载的历史不复制（两边都不再发给模型）。
 * - summaries：主任务 ready 行（covers_to ≤ stepFloor）里对上下文有用的
 *   ——链根、在场的、在场者的祖先；已被父行完全收编且不在场的老 L0/L1 不
 *   复制（父行覆盖范围包含它们）。superseded_by 映射到副本 id。
 *
 * 幂等：migrations 表记标记，已复制过直接返回；复制与标记在一个事务里。
 * 调用时机：forkTask 跳段之后、manifest 落盘之前（对话此刻静止）；老任务
 * （隔离之前开的）在 openStore 时补一次
 */
export function ensureInheritedCopy(db: Db, scope: TaskScope): void {
  const marker = copyMarker(scope.owner)
  if (db.all(`SELECT 1 AS x FROM migrations WHERE name = ?`, marker).length > 0) return
  db.transaction(() => copyInherited(db, scope, marker))
}

function copyInherited(db: Db, scope: TaskScope, marker: string): void {
  const nextIn = (table: string, floor: number, ceil: number): (() => number) => {
    let n =
      db.all<{ n: number | null }>(`SELECT MAX(id) AS n FROM ${table} WHERE id > ? AND id <= ?`, floor, ceil)[0]
        ?.n ?? floor
    return () => {
      n += 1
      if (n > ceil) throw new SegmentFullError(table)
      return n
    }
  }

  const msgId = nextIn('messages', scope.msgFloor, scope.msgCeil)
  const rows = db.all<{ turn_id: number; role: string; content_json: string; step_id: number | null }>(
    `SELECT turn_id, role, content_json, step_id FROM messages
     WHERE state = 'live' AND owner IS NULL
       AND turn_id IN (SELECT id FROM turns WHERE owner IS NULL AND state != 'reserved' AND id <= ?)
     ORDER BY turn_id, id`,
    scope.forkTurn,
  )
  for (const r of rows) {
    db.run(
      `INSERT INTO messages(id, turn_id, role, content_json, step_id, owner) VALUES(?, ?, ?, ?, ?, ?)`,
      msgId(),
      r.turn_id,
      r.role,
      r.content_json,
      r.step_id,
      scope.owner,
    )
  }

  type Row = SummaryRow
  const all = db.all<Row>(
    `SELECT id, level, covers_from, covers_to, text, status, in_context, superseded_by,
            head, archive_path, name, owner
     FROM summaries WHERE owner IS NULL AND status = 'ready' AND covers_to <= ?
     ORDER BY id`,
    scope.stepFloor,
  )
  const byId = new Map(all.map((r) => [r.id, r]))
  const parentOf = (r: Row): Row | undefined =>
    r.superseded_by === null ? undefined : byId.get(r.superseded_by)
  const keep = new Set<number>()
  for (const r of all) {
    if (parentOf(r) === undefined) keep.add(r.id) // 链根（含父行未就绪的）
    if (r.in_context === 1) {
      // 在场的连同整条祖先链：父行「算好了等生效」时子孙还在场
      for (let x: Row | undefined = r; x !== undefined && !keep.has(x.id); x = parentOf(x)) keep.add(x.id)
      keep.add(r.id)
    }
  }
  const sumId = nextIn('summaries', scope.sumFloor, scope.sumCeil)
  const idMap = new Map<number, number>()
  for (const r of all) if (keep.has(r.id)) idMap.set(r.id, sumId())
  // 两遍：先插行、再连 superseded_by——外键开着，父行不一定先插
  for (const r of all) {
    const id = idMap.get(r.id)
    if (id === undefined) continue
    db.run(
      `INSERT INTO summaries(id, level, covers_from, covers_to, text, status, in_context,
                             superseded_by, head, archive_path, name, owner)
       VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      id,
      r.level,
      r.covers_from,
      r.covers_to,
      r.text,
      r.status,
      r.in_context,
      r.head,
      r.archive_path,
      r.name,
      scope.owner,
    )
  }
  for (const r of all) {
    const id = idMap.get(r.id)
    const parent = r.superseded_by === null ? undefined : idMap.get(r.superseded_by)
    if (id !== undefined && parent !== undefined) {
      db.run(`UPDATE summaries SET superseded_by = ? WHERE id = ?`, parent, id)
    }
  }
  db.run(`INSERT INTO migrations(name, ran_at) VALUES(?, datetime('now'))`, marker)
}

/** owner 是我们生成的 'task-<base36>'，进 SQL 片段前校验形状（防注入兜底） */
const safeOwner = (owner: string): string => {
  if (!/^task-[a-z0-9]+$/.test(owner)) throw new Error(`非法 owner: ${owner}`)
  return owner
}

export function openStore(folderPath: string, opts: { task?: TaskScope } = {}): Store {
  // 排除出 git 要赶在用户第一次 add 之前——openStore 是三端必经点
  ensureGitIgnored(folderPath)
  const dir = join(folderPath, MEMORY_RELATIVE)
  const rawDir = join(dir, 'raw')
  const turnsDir = join(dir, 'turns')
  mkdirSync(rawDir, { recursive: true })
  mkdirSync(turnsDir, { recursive: true })

  const db = openDb(join(dir, 'state.db'))
  db.exec(SCHEMA)
  migrate(db)
  // 平铺老归档挪进桶（幂等，见 buckets.ts）。挪了文件才要重写 db 里
  // summaries.archive_path 的老平铺指路牌——那是模型点名读的路径，
  // 留着死链等于迁移自己制造「No such file」
  if (migrateToBuckets(dir) > 0) rewriteLegacyArchivePaths(db)
  dropUnfinishedSummaries(db)
  repairAppliedChains(db)
  // 开库补一次 FTS 同步：老库首跑全量灌入（一次性），之后这里通常是
  // 空操作——增量真正的落点是 save 尾部
  syncSearchIndex(db)

  /**
   * **惰性创建**：open 的时候不建 turn，第一次 save 才建。
   *
   * 开 store 就无条件建一个的话，每次启动都在库里留一个没有任何消息的孤儿
   * turn——`SELECT * FROM turns` 看着像跑过一轮，其实是空的。第 3 步按 turn
   * 做合并边界（§9.5），空 turn 会让「10 个 turn 合并成 1 条」的计数虚高。
   * 实测踩到过：开一次 store 就多一行。
   */
  // 旧 turn 语义的 summaries 一次性清空：covers 引用 turn_id，与新的 step_id
  // 语义无法区分。用 PRAGMA user_version=2 标记「step 语义已就位」——老库
  // 首次升级时版本还是 0/1，清空后置 2；之后任何 reopen 都不再触发
  if ((db.all<{ user_version: number }>(`PRAGMA user_version`)[0]?.user_version ?? 0) < 2) {
    db.run(`DELETE FROM summaries`)
    db.exec(`PRAGMA user_version = 2`)
  }

  // turns.meta：每轮的模型/档位快照（页脚按轮显示用）。CREATE TABLE IF NOT
  // EXISTS 对已存在的表不加列，ALTER 又没有 IF NOT EXISTS——catch duplicate
  // column 保持幂等。**不动 user_version**：那是 compact 迁移的版本号槽
  // （`>=3` 判定），混用会让它被跳过
  try {
    db.exec(`ALTER TABLE turns ADD COLUMN meta TEXT`)
  } catch (error) {
    if (!String(error).includes('duplicate column')) throw error
  }

  backfillSteps(db)
  reconcileStepUnloaded(db)
  compactLegacyBacklog(db)
  // 必须在 compactLegacyBacklog 之后：后者按 step 取「最长那条消息」当锚点
  // （`headOfStep`），而清洗会折叠叠加的卸载标记、改变「最长」是哪条。
  // 反过来先清洗的话，压实迁移在老库上选出的锚点跟这次不一样——两个一次性
  // 迁移之间有顺序依赖，不写下来下次就会有人按字母序重排
  cleanupLegacyRows(db)

  // ── task-v3 会话域派生物 ──
  const scope = opts.task ?? null
  // 老任务（上下文隔离之前开的）补一次复制。新任务 fork 时已在同一事务里
  // 复制过（标记在），这里是空操作
  if (scope) ensureInheritedCopy(db, scope)
  // turns 表的可见条件（带别名 turns.，查询里 turns 无别名时替换掉前缀）
  // 对话侧要排除 reserved 锚（fork 占段头的行，owner=NULL 但没有内容）——
  // 不排的话 lastTurnId 会把它当「当前轮」
  const turnCond = scope
    ? `(turns.owner = '${safeOwner(scope.owner)}' OR (turns.owner IS NULL AND turns.id <= ${scope.forkTurn}))`
    : `(turns.owner IS NULL AND turns.state != 'reserved')`
  // steps 查询的可见过滤（按轮）
  const turnVis = `turn_id IN (SELECT id FROM turns WHERE ${turnCond})`
  // 消息行归属（messages.owner）。上下文隔离（note task-context-isolation）：
  // 任务不再读主任务的 live 行，fork 时主任务上下文里的行被**复制**一份归
  // 任务所有（copyInheritedContext），之后两边各压各的。所以消息可见性按
  // 行的 owner 判，不按轮判——复制行的 turn_id 仍是主任务的轮
  const ownerEq = scope ? `owner = '${safeOwner(scope.owner)}'` : 'owner IS NULL'
  const msgVis = scope ? ownerEq : `${ownerEq} AND ${turnVis}`
  // historyPage 的 JOIN 里 turns 别名是 t
  const turnCondT = scope
    ? `(t.owner = '${safeOwner(scope.owner)}' OR (t.owner IS NULL AND t.id <= ${scope.forkTurn}))`
    : `(t.owner IS NULL AND t.state != 'reserved')`
  // 摘要可见（task-v3 起按 owner 列判）：对话只看自己的（owner IS NULL）；
  // 任务看自己的私有 + 对话的（继承摘要）。老库的行 owner 全 NULL，语义
  // 不变。比 v3 初版「covers→step→turn→owner」的迂回判据直，且天然支持
  // 任务的私有继承段摘要（那种行 covers 的是对话 step，旧判据挡不住它
  // 漏进对话视角）
  //
  // 继承只到 fork 点：covers_to ≤ stepFloor（fork 时 steps 的 max）。fork
  // 后对话自己的摘要（covers 跳段后的 step）不是任务的历史——2026-09-23
  // 真机漏过：任务视角把对话 fork 后 60 轮的 L1 排在自己的轮后面发给模型，
  // 对话一进场任务前缀就变（前缀守卫抓到，messages 第 37 条起不同）
  //
  // 上下文隔离之后（fork 时主任务的摘要复制一份归任务），任务只看自己的行
  // ——主任务之后的进场/合并/生效只改它自己的行，任务那份纹丝不动
  const sumVis = ownerEq
  // steps 可见（steps 别名 s）。任务侧含继承段：继承的 step 由任务摘成
  // **私有摘要**（owner=me，对话不可见）——这是任务压缩继承段的正路；
  // 对话 fork 后新轮（owner NULL 且 > forkTurn）不含在内，那是对话的活
  // 历史。已被可见摘要覆盖的 step 由候选查询自己排除（对话已摘过的继承
  // 段不会重复摘）
  const stepVis = `s.turn_id IN (SELECT id FROM turns WHERE ${turnCond})`
  // 写域：live 行的删/卸/换只许碰自己的轮。读域（msgVis）带继承是 fork
  // 语义——任务窗口看得见 fork 前的对话 live；但 replaceLive 是全量
  // DELETE+INSERT，拿读域删会把对话的 live 行删掉、再以任务段的 id 重插
  // 一遍（对话丢 live、两边乱序）。对话侧写域=读域
  // 复制行（继承段）同样不在写域里：任务只删/重插自己轮的行，复制行作为
  // 「继承的」留在原地（replaceLive 按 forkTurn 跳过），由私有摘要顶替
  const ownVis = scope ? `${ownerEq} AND turn_id > ${scope.forkTurn}` : msgVis
  // 这行是不是自己的（任务模式）。自己的轮 ∈ (forkTurn, turnCeil)，
  // 继承的 ≤ forkTurn。对行和归属数组都适用
  const forkTurnOf = scope?.forkTurn ?? null
  const isOwnTurn = (turnId: number): boolean =>
    forkTurnOf === null ? true : turnId > forkTurnOf
  // 段内 id 分配器（只有任务会话用）。种子=段内现 max，会话内存量单调；
  // 重开重播——号在段内即可，不留连续性承诺
  const seed = (sql: string): number => db.all<{ n: number }>(sql)[0]?.n ?? 0
  const alloc =
    scope === null
      ? null
      : {
          turn: (() => {
            let n = seed(`SELECT COALESCE(MAX(id), ${scope.forkTurn}) AS n FROM turns
                          WHERE id > ${scope.forkTurn} AND id < ${scope.turnCeil}`)
            return () => {
              n += 1
              if (n >= scope.turnCeil) throw new SegmentFullError('turns')
              return n
            }
          })(),
          step: (() => {
            let n = seed(`SELECT COALESCE(MAX(id), ${scope.stepFloor}) AS n FROM steps
                          WHERE id > ${scope.stepFloor} AND id <= ${scope.stepCeil}`)
            return () => {
              n += 1
              if (n > scope.stepCeil) throw new SegmentFullError('steps')
              return n
            }
          })(),
          msg: (() => {
            let n = seed(`SELECT COALESCE(MAX(id), ${scope.msgFloor}) AS n FROM messages
                          WHERE id > ${scope.msgFloor} AND id <= ${scope.msgCeil}`)
            return () => {
              n += 1
              if (n > scope.msgCeil) throw new SegmentFullError('messages')
              return n
            }
          })(),
          sum: (() => {
            let n = seed(`SELECT COALESCE(MAX(id), ${scope.sumFloor}) AS n FROM summaries
                          WHERE id > ${scope.sumFloor} AND id <= ${scope.sumCeil}`)
            return () => {
              n += 1
              if (n > scope.sumCeil) throw new SegmentFullError('summaries')
              return n
            }
          })(),
        }

  let currentTurn: number | null = lastTurnId(db, turnCond)
  /** 当前 turn 的身份快照。beginTurn 写、save 的惰性建 turn 也读它 */
  let currentMeta: string | null = null
  /**
   * 每条 live 消息属于哪个 turn，下标对齐 `save` 收到的数组。
   *
   * **必须记着**：`replaceLive` 会 DELETE 再重插，重插时如果一律用当前
   * turn，上一轮的消息就被改嫁到新 turn 了。真实跑出来的 bug——归档文件
   * 是对的（append-only 写完不动），只有 SQLite 错，跑起来完全正常，
   * 要到第 3 步按 turn 合并（§9.5）才会炸。
   */
  let turnOf: number[] = loadTurnIds(db, msgVis)
  /** 每条 live 消息属于哪个 step。约束与 turnOf 相同（replaceLive 重插问题） */
  let stepOf: number[] = loadStepIds(db, msgVis)
  let currentStep: number | null = lastStepId(db, turnVis)
  /**
   * 已经写进 `turns/*.jsonl` 的消息指纹。
   *
   * **不能用「已写条数」这个下标游标**，虽然那样更省内存。卸载会让 live
   * 集合变短，下标随之整体平移，于是同一个游标一会儿指向 A 一会儿指向 B：
   *
   * - 游标偏大 → 新消息被当成"已归档"**静默跳过**，归档里缺一段
   * - 游标偏小 → 已写过的又追加一遍，归档里同一段对话出现两次
   *
   * 两种都真实发生过，而且**症状只在归档文件里**——SQLite 和 context 全都
   * 正常，只有 cat 归档的模型会看到错乱的历史。
   *
   * 用内容指纹就跟下标彻底脱钩了。代价是每条消息多存一个字符串，
   * 而 live 集合被窗口限着（几十到几百条），量级可以忽略。
   */
  const archived = new Set<string>(loadLive(db, msgVis).map(fingerprint))

  return {
    root: folderPath,
    /**
     * **只还 live 消息，不拼摘要。**
     *
     * 提案 §4.1 说要在这里拼，那是错的——错得很隐蔽，实测出来的：
     * session 拿 `load()` 的结果当内存历史，之后每轮 `save()` 原样写回库。
     * 在这里拼的话，摘要文本会作为一条**真的 live 消息**入库，下次 `load()`
     * 又给它拼一次——重启一次多一份，跑十次十份，全程不报错。
     *
     * 所以拼装只有一个点：`run.ts` 发请求前（`assembleForRequest`）。库和内存
     * 里存的始终是 live 原样，摘要只在「要发出去的那份」里出现，不回流。
     */
    load: () => loadLive(db, msgVis),

    save: (messages) => {
      if (alloc === null) currentTurn ??= createTurn(db, currentMeta)
      else currentTurn ??= createTaskTurn(db, currentMeta, alloc.turn(), scope!.owner)
      turnOf = attributeTurns(messages, turnOf, currentTurn)
      stepOf = attributeSteps(messages, turnOf, stepOf, currentStep ?? 0, () => {
        // currentStep 为 null 时 currentTurn 一定已就位（上面 ??= 保证）
        currentStep = alloc === null ? createStep(db, currentTurn ?? 0) : createTaskStep(db, currentTurn ?? 0, alloc.step())
        return currentStep
      })

      replaceLive(db, turnOf, messages, stepOf, ownVis, forkTurnOf, alloc === null ? null : alloc.msg, scope?.owner ?? null)
      // 归档只追加没写过的。它是给模型 cat 的诊断材料（§9.3 第 ② 层），
      // 不是恢复来源——恢复读的是 SQLite。少写比重写整个文件好：
      // append-only 的文件崩溃时不会写坏
      for (const [index, message] of messages.entries()) {
        const id = fingerprint(message)
        if (archived.has(id)) continue
        archived.add(id)
        appendToArchive(turnsDir, turnOf[index] ?? currentTurn, message)
      }
      // search 的 FTS 增量同步（search-index.ts）：新 step 聚合入倒排表。
      // 放 save 尾部——写路径只有宿主，CLI 查询只读，无并发写
      syncSearchIndex(db)
    },

    beginTurn: (meta) => {
      currentMeta = JSON.stringify(meta)
      currentTurn =
        alloc === null
          ? createTurn(db, currentMeta)
          : createTaskTurn(db, currentMeta, alloc.turn(), scope!.owner)
      return currentTurn
    },

    finishTurn: (id, elapsedMs) => {
      db.run(`UPDATE turns SET elapsed_ms = ? WHERE id = ?`, elapsedMs, id)
    },

    /** run loop 每收到一条 assistant 响应开新 step。与 beginTurn 并列 */
    remapMessages: (origin) => {
      // **null 继承前一条。** 补出来的 tool_result 天然属于它要回答的那个
      // tool_call 那一轮——用「当前 turn」的话，一次中断就能把上一轮的
      // 收尾算进新一轮，摘要按 turn 分组时那条 result 会跟错组。
      // 数组第一条就是 null（理论上不会：pass 1 只在某条 tool_call 之后插）
      // 时退回当前值。
      const pick = (prev: number[], fallback: number, at: number, out: number[]): number => {
        const from = origin[at]
        if (from !== null && from !== undefined) return prev[from] ?? fallback
        return out[at - 1] ?? fallback
      }
      const nextTurn: number[] = []
      const nextStep: number[] = []
      for (let i = 0; i < origin.length; i++) {
        nextTurn.push(pick(turnOf, currentTurn ?? 0, i, nextTurn))
        nextStep.push(pick(stepOf, currentStep ?? 0, i, nextStep))
      }
      turnOf = nextTurn
      stepOf = nextStep
    },

    pruneMessages: (indices) => {
      const removed = new Set(indices)
      turnOf = turnOf.filter((_, index) => !removed.has(index))
      stepOf = stepOf.filter((_, index) => !removed.has(index))
      // **库里的 live 行也要一起删。** 只缩归属数组的话，`ctx.messages` 短了
      // 而 DB 的 live 行还是老长度，紧接着在同一个 `unloadIfNeeded` 里执行的
      // `store.unload(indices)` 按下标去 `liveRowIds()` 定位就会**标错行**
      // ——`unload` 的契约写的是「下标对齐 `load()` 的顺序」，prune 之后
      // ctx.messages 就不等于 load() 了。
      //
      // 实测现场：pickOldest 在 4 条的数组上挑出 [0,1]，unload 拿去 7 行里
      // 定位，标中的是上两轮已经卸过的 step 1、2；真正该卸的 step 4、5 一次
      // 都没被碰到。现象是「卸载看起来在跑，但该卸的没卸」，且不报错。
      //
      // 删的是存根行：原文早已在 `unloaded` 行里（卸载时留下的），现在又被
      // 合并摘要顶替，留在 live 集合里没有任何意义。下一次 save 的
      // replaceLive 本来也会删掉它们，这里只是把对齐提前到 unload 之前。
      const rows = liveRowIds(db, msgVis)
      db.transaction(() => {
        for (const index of indices) {
          const row = rows[index]
          // 继承的行（任务模式）不删——那是对话的 live，删了对话就丢上下文
          if (row && isOwnTurn(row.turn_id)) db.run(`DELETE FROM messages WHERE id = ?`, row.id)
        }
      })
    },

    beginStep: () => {
      currentStep =
        alloc === null
          ? createStep(db, currentTurn ?? createTurn(db, currentMeta))
          : createTaskStep(db, currentTurn ?? createTaskTurn(db, currentMeta, alloc.turn(), scope!.owner), alloc.step())
      return currentStep
    },

    /** 段的消息集合（live 与 unloaded 都算），给摘要候选用 */
    segmentMessages: (segment) => segmentMessagesOf(db, segment),

    /** 无摘要覆盖的最老已完结 step（候选）。完了返回 null */
    // MIN 就是区间上的逻辑与：有一个 step 还没卸空，整段就不算卸空。
    // 段里没有 step 时 MIN 是 NULL，退回 false——「不存在」不该被当成「已卸空」
    // 而去翻 in_context
    // 判**段头那一条**（段的第一个 step），不判整段（MIN）也不判任一（MAX）。
    // 挑选严格从最老开始（§11.5），卸载集合是 step id 的前缀——段头卸了，
    // 推进线就确实到过这段，段内其余 step 被摘要整段顶替是设计内的（碰头
    // 即上岗：floor 管「裁多少」，段边界管「顶替多少」，两把尺子各自独立）。
    // 反过来段头没卸就说明推进线还没到，此时翻 in_context 会顶掉模型还
    // 看得见的原文。判头还有一层：真出了非前缀的挑选 bug（段尾卸了段头
    // 没卸），这里退回「不上岗、存根顶着」而不是吞史
    segmentHeadUnloaded: (segment) =>
      // 任务视角的继承段一律算「已离场」，与 unloadedSteps 同口径——那段的
      // steps.unloaded 是主任务的账，主任务卸没卸跟任务无关
      (scope !== null && segment.from <= scope.stepFloor) ||
      (db.all<{ u: number | null }>(`SELECT unloaded AS u FROM steps WHERE id = ?`, segment.from)[0]
        ?.u ?? 0) === 1,

    flipSummary: (id) => {
      // **翻开关的同时必须把 head / archive_path 补上。** 拼装出来的摘要行是
      // 「头部 + 摘要 + 路径」三样（assemble.ts:135），缺哪样都退化：没头部就
      // 只剩模型转述、措辞会漂；没路径就是「知道该展开却不知道去哪 cat」。
      //
      // 另一条生效路径 `activateSummary` 一直是三个字段一起写的，这里长期只
      // 翻开关——症状是 in_context 的摘要里 15% 同时缺 head 和 archivePath
      // （实测 301 条里 46 条，turn-summary.md §1.2）。
      //
      // 之前没暴露，是因为写放大 bug 会让已经是存根的消息每轮被重新卸载一遍，
      // 顺带反复调 activateSummary 把这两个字段填上了。修掉写放大
      // （run.ts 的 `saved <= 0` 跳过）之后这个洞才露出来。
      const row = db.all<{ covers_from: number }>(
        `SELECT covers_from FROM summaries WHERE id = ?`,
        id,
      )[0]
      const head = row ? headOfStep(db, row.covers_from) : null
      db.run(
        `UPDATE summaries SET in_context = 1, head = ?, archive_path = ? WHERE id = ?`,
        head?.text ?? null,
        head?.archivePath ?? null,
        id,
      )
    },

    nextSegmentToSummarize: (budgetTokens, activeTurn) =>
      nextSegment(db, budgetTokens, activeTurn, stepVis, sumVis, ownerEq),

    dropSummary: (id) => {
      db.run(`DELETE FROM summaries WHERE id = ? AND in_context = 0`, id)
    },

    rawSink: (toolCallId) => {
      const name = `${sanitize(toolCallId)}.log`
      // 相对路径给模型（bash 的 cwd 就是工作区根），绝对路径给 fs；
      // 两者都带桶（buckets.ts 是路径唯一权威）
      return createRawSink(
        ensureBucketFile(dir, 'raw', name),
        join(MEMORY_RELATIVE, bucketedRel('raw', name)),
      )
    },

    markCold: (stepIds) => {
      db.transaction(() => {
        // unloaded 是共享列（对话的账本）。任务只标自己段的 step——卸载
        // 循环按「最老优先」会挑中继承段，不挡的话任务把对话的 step 翻
        // unloaded，对话被强制压缩
        for (const id of stepIds) {
          if (forkTurnOf === null) {
            db.run(`UPDATE steps SET unloaded = 1 WHERE id = ?`, id)
            continue
          }
          db.run(`UPDATE steps SET unloaded = 1 WHERE id = ? AND turn_id > ?`, id, forkTurnOf)
        }
      })
    },

    recordRegions: (sizes, budget) => {
      // 时间戳是唯一能把它跟 turns/*.jsonl 对上的东西——这个文件里没有
      // turn/step 号（组装点拿不到，那是 store 侧的归属）
      const line = JSON.stringify({
        at: new Date().toISOString(),
        budget,
        owner: scope ? scope.owner : null,
        ...sizes,
      })
      appendFileSync(join(dir, 'regions.jsonl'), `${line}\n`, 'utf8')
    },

    leafBodies: (rows) => {
      const leaves = readLeavesByCovers(
        dir,
        rows.map((row) => row.coversFrom),
      )
      const out = new Map<number, string>()
      for (const row of rows) {
        const body = leaves.get(row.coversFrom)?.body
        if (body) out.set(row.id, body)
      }
      return out
    },

    writeLeaf: (segment, leaf) =>
      writeLeafFile(dir, {
        ...leaf,
        turn: segment.turn,
        coversFrom: segment.from,
        coversTo: segment.to,
      }),

    unload: (indices) => {
      const rows = liveRowIds(db, msgVis)
      const picked = indices.flatMap((index) => {
        const row = rows[index]
        // 下标越界跳过；继承的行也跳过——unload 是写操作（state 翻
        // unloaded），动了会把对话窗口里的同一行卸掉。任务模式继承尾
        // 常驻热区，代价有界（见 task-v3.md「关闭」节）
        return row && isOwnTurn(row.turn_id) ? [row] : []
      })

      // 一个事务：标一半就崩的话，剩下的原文行会被下一次 save 的 DELETE 清掉
      db.transaction(() => {
        for (const row of picked) {
          db.run(`UPDATE messages SET state = 'unloaded' WHERE id = ?`, row.id)
        }
        // 此刻该 step 若再无其他 live 行，它的原文就整体离开了 context。
        // **必须现在判定**：卸载后消息会以存根形态回到 live 集合（下一次
        // save 重插），那时再数 live 行就永远是「还在」——stepUnloaded 的
        // 旧实现正是这么失效的。
        //
        // 这一条不够用了（turn 里的短消息不进 indices，那个 step 永远留着
        // live 行），补一条显式的 `markCold`——两条是「或」的关系，谁先满足
        // 都算冷
        for (const sid of new Set(picked.map((r) => r.step_id).filter((v) => v !== null))) {
          const left =
            db.all<{ n: number }>(
              // 只数自己的行：任务的复制行也挂在这个 step 上，数进来的话
              // 主任务的 step 永远卸不空
              `SELECT COUNT(*) AS n FROM messages WHERE step_id = ? AND state = 'live' AND ${ownerEq}`,
              sid,
            )[0]?.n ?? 0
          if (left === 0) db.run(`UPDATE steps SET unloaded = 1 WHERE id = ?`, sid)
        }
      })

      // **归属数组不缩。** ctx.messages 的卸载是原地换成存根——位置一个没动
      // （run.ts 的 unloadMessage 只改内容），归属数组必须继续逐位对齐。
      // 缩了反而全体错位：这是 turn 时代遗留的错误「修正」，靠错得稳定
      // 侥幸活着；step 语义的 covers 连续性把它放大成了致命伤。
      // 真正从数组删元素的只有 apply 剪枝，那边走 pruneMessages

      // **archived 不用动。** 它记的是「哪些内容已经写进归档文件」，而归档
      // 是 append-only——卸载不会把已写的行从文件里删掉，那些指纹依然有效。
      //
      // 卸载后消息会以截断版的形态回到 live 集合，指纹跟着变（内容变了），
      // 于是截断版会作为新行追加进归档。这是对的：归档如实记录了
      // 「原文」和「后来它被截断成什么样」两个状态。

      return picked.map((row) => ({
        archivePath: archivePath(row.turn_id),
        turnId: row.turn_id,
        stepId: row.step_id ?? 0,
      }))
    },

    liveWithTurns: () => loadLiveWithTurns(db, msgVis),

    saveCue: (turnId, lines, names) => {
      db.run(
        `INSERT INTO cues(owner, turn_id, lines, names, created_at) VALUES('', ?, ?, ?, ?)
         ON CONFLICT(owner, turn_id) DO NOTHING`,
        turnId,
        JSON.stringify(lines),
        JSON.stringify(names),
        new Date().toISOString(),
      )
    },

    cues: () => {
      const out = new Map<number, string[]>()
      for (const r of db.all<{ turn_id: number; lines: string }>(
        `SELECT turn_id, lines FROM cues WHERE owner = ''`,
      ))
        out.set(r.turn_id, JSON.parse(r.lines) as string[])
      return out
    },

    recentCuedNames: (dedupTurns) => {
      const names = new Set<string>()
      const min = db.all<{ turn_id: number }>(
        `SELECT DISTINCT turn_id FROM messages WHERE state = 'live' AND ${msgVis}
         ORDER BY turn_id DESC LIMIT ?`,
        dedupTurns,
      ).at(-1)?.turn_id
      if (min === undefined) return names
      for (const r of db.all<{ names: string }>(`SELECT names FROM cues WHERE owner = '' AND turn_id >= ?`, min))
        for (const n of JSON.parse(r.names) as string[]) names.add(n)
      return names
    },

    cueTurnTexts: (window) => {
      // 轮龄按实际轮数（DISTINCT turn_id 的位置），不按 id 相减——fork
      // 跳号会把 5 轮虚报成 1 万轮（proposal §4 坑①）
      const ids = db
        .all<{ turn_id: number }>(
          `SELECT DISTINCT turn_id FROM messages WHERE state = 'live' AND ${msgVis}
           ORDER BY turn_id DESC LIMIT ?`,
          window,
        )
        .map((r) => r.turn_id)
        .reverse()
      if (ids.length === 0) return []
      const byTurn = new Map<number, string[]>(ids.map((id) => [id, []]))
      for (const r of db.all<{ turn_id: number; content_json: string }>(
        `SELECT turn_id, content_json FROM messages
          WHERE state = 'live' AND ${msgVis} AND turn_id IN (${ids.map(() => '?').join(',')})
          ORDER BY turn_id, id`,
        ...ids,
      )) {
        const line = JSON.parse(r.content_json) as { parts?: unknown[] }
        for (const seg of searchable(line as Parameters<typeof searchable>[0])) byTurn.get(r.turn_id)?.push(seg.text)
      }
      return ids.map((id) => (byTurn.get(id) ?? []).join('\n'))
    },

    lastRespondedAt: () => {
      const row = db.all<{ started_at: string; elapsed_ms: number | null }>(
        `SELECT started_at, elapsed_ms FROM turns WHERE ${turnCond} ORDER BY id DESC LIMIT 1`,
      )[0]
      return row ? Date.parse(row.started_at) + (row.elapsed_ms ?? 0) : null
    },

    liveTurnModels: () =>
      db
        .all<{ meta: string | null }>(
          `SELECT (SELECT meta FROM turns WHERE turns.id = messages.turn_id) AS meta
             FROM messages WHERE state = 'live' AND ${msgVis} ORDER BY turn_id, id`,
        )
        .map((r) => (r.meta === null ? null : ((JSON.parse(r.meta) as TurnMeta).model ?? null))),

    readPromptSnapshot: () => {
      const row = db.all<{
        agents: string | null
        notes: string | null
        events: string | null
        lessons: string | null
      }>(`SELECT agents, notes, events, lessons FROM prompt_snapshot WHERE owner = ?`, scope?.owner ?? '')[0]
      return row ?? null
    },

    writePromptSnapshot: (snap) => {
      db.run(
        `INSERT INTO prompt_snapshot (owner, agents, notes, events, lessons, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner) DO UPDATE SET
           agents = excluded.agents, notes = excluded.notes,
           events = excluded.events, lessons = excluded.lessons,
           updated_at = excluded.updated_at`,
        scope?.owner ?? '',
        snap.agents,
        snap.notes,
        snap.events,
        snap.lessons,
        new Date().toISOString(),
      )
    },

    readPrefixBaseline: () =>
      db.all<{ fingerprint: string }>(
        `SELECT fingerprint FROM prefix_baseline WHERE owner = ?`,
        scope?.owner ?? '',
      )[0]?.fingerprint ?? null,

    writePrefixBaseline: (fingerprint) => {
      db.run(
        `INSERT INTO prefix_baseline (owner, fingerprint, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(owner) DO UPDATE SET
           fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
        scope?.owner ?? '',
        fingerprint,
        new Date().toISOString(),
      )
    },

    consumeMergePending: () => {
      // 标记是主任务的：任务会话不吃它（吃了就把主任务的压缩车票撕了）
      if (scope) return false
      const hit =
        db.all(`SELECT 1 FROM migrations WHERE name = 'merge-rewrite-pending'`).length > 0
      if (hit) db.run(`DELETE FROM migrations WHERE name = 'merge-rewrite-pending'`)
      return hit
    },

    historyPage: (cursor, limit) => {
      const params: SqlValue[] = []
      // JOIN turns 带出每轮的 meta。state/id 两张表都有，条件必须加 m. 前缀
      const own = `m.${ownerEq}`
      const where =
        cursor === null ? `m.state = 'unloaded' AND ${own}` : `m.state = 'unloaded' AND ${own} AND m.id < ?`
      if (cursor !== null) params.push(cursor)
      const rows = db.all<{
        id: number
        turnId: number
        role: string
        content_json: string
        meta: string | null
        elapsed_ms: number | null
        started_at: string
      }>(
        `SELECT m.id, m.turn_id AS turnId, m.role, m.content_json, t.meta, t.elapsed_ms, t.started_at
         FROM messages m JOIN turns t ON t.id = m.turn_id
         WHERE ${where} AND ${turnCondT} ORDER BY m.id DESC LIMIT ?`,
        ...params,
        limit,
      )
      // 翻回正序（老→新），prepend 的语义
      rows.reverse()
      const next =
        rows.length > 0 && hasRowBelow(db, rows[0]?.id ?? 0, msgVis) ? (rows[0]?.id ?? null) : null
      return {
        rows: rows.map((r) => ({
          id: r.id,
          turnId: r.turnId,
          role: r.role as HistoryRow['role'],
          parts: JSON.parse(r.content_json).parts as Part[],
          meta: r.meta === null ? null : (JSON.parse(r.meta) as TurnMeta),
          elapsedMs: r.elapsed_ms,
          finishedAt:
            r.elapsed_ms === null ? null : Date.parse(r.started_at) + r.elapsed_ms,
        })),
        next,
      }
    },

    turnsInfo: (turnIds) => {
      if (turnIds.length === 0) return new Map()
      const ids = [...new Set(turnIds)]
      const rows = db.all<{
        id: number
        meta: string | null
        elapsed_ms: number | null
        started_at: string
      }>(
        `SELECT id, meta, elapsed_ms, started_at FROM turns WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
      return new Map(
        rows.map((r) => [
          r.id,
          {
            meta: r.meta === null ? null : (JSON.parse(r.meta) as TurnMeta),
            elapsedMs: r.elapsed_ms,
            finishedAt:
              r.elapsed_ms === null ? null : Date.parse(r.started_at) + r.elapsed_ms,
          },
        ]),
      )
    },

    withTurns: (messages) => {
      // **不建 turn，只读**。`save` 那边 `currentTurn ??= createTurn` 是因为它
      // 真要写行；拼装是只读路径，在这里建 turn 会凭空多出空 turn 行
      // （惰性创建那条注释里踩过的坑）
      const turnAttr = attributeTurns(messages, turnOf, currentTurn ?? 0)
      // 只读：不建 step 行。用 currentStep 占位（库为空时是 null → 0）
      const stepAttr = attributeSteps(
        messages,
        turnAttr,
        stepOf,
        currentStep ?? 0,
        () => currentStep ?? 0,
      )
      return messages.map((message, index) => ({
        message,
        turnId: turnAttr[index] ?? 0,
        stepId: stepAttr[index] ?? 0,
      }))
    },
    summaries: () => loadSummaries(db, sumVis),

    /** 缝 (from, to) 开区间里有没有内容痕迹：可见消息行，或外主（任务）的
     * steps。pickMergeGroup 跨缝前的第②③道保险（第①道它自己拿 summaries
     * 纯查）——任务活着时它的 step 落在对话看不见的预留段里，只有查
     * steps 才挡得住「跨过去等任务合并回来、经历被 coversActive 收掉」
     * 那条丢历史的路。任务关闭时 step 行被清（真库旧预留段实测 0 行），
     * 死尾巴对它返回 false。 */
    gapHasContent: (from: number, to: number) =>
      (
        db.all<{ hit: number }>(
          `SELECT (EXISTS(SELECT 1 FROM messages WHERE step_id > ? AND step_id < ? AND ${msgVis})
                OR EXISTS(SELECT 1 FROM steps s JOIN turns t ON s.turn_id = t.id
                           WHERE s.id > ? AND s.id < ? AND t.owner IS NOT NULL)) AS hit`,
          from,
          to,
          from,
          to,
        )[0]?.hit === 1
      ),

    addSummary: (row) => {
      // owner 由 store 按自己的会话域填，不收调用方的——任务摘要器不知道
      // （也不该知道）自己跑在哪个视角里
      if (alloc !== null) {
        db.run(
          `INSERT INTO summaries(id, level, covers_from, covers_to, text, status, in_context,
                                 superseded_by, head, archive_path, name, owner)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          alloc.sum(),
          row.level,
          row.coversFrom,
          row.coversTo,
          row.text,
          row.status,
          row.inContext ? 1 : 0,
          row.supersededBy,
          row.head,
          row.archivePath,
          row.name,
          scope!.owner,
        )
        return lastRowId(db)
      }
      db.run(
        `INSERT INTO summaries(level, covers_from, covers_to, text, status, in_context,
                               superseded_by, head, archive_path, name, owner)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        row.level,
        row.coversFrom,
        row.coversTo,
        row.text,
        row.status,
        row.inContext ? 1 : 0,
        row.supersededBy,
        row.head,
        row.archivePath,
        row.name,
      )
      return lastRowId(db)
    },

    unloadedSteps: () =>
      new Set(
        db
          .all<{ id: number }>(
            // 任务视角把**继承段的 step 也算滞留**：它们的原文在任务的装配里
            // 出现（未顶替时），正是任务要收编的对象——不计的话 water 永远
            // 不含继承段，私有 L0 生成好了也进不了场（进场闸是 water）。
            // 对话视角不受影响（继承段就是它自己的段，unloaded 按账本来）
            scope
              ? `SELECT id FROM steps WHERE unloaded = 1 OR turn_id IN
                   (SELECT id FROM turns WHERE owner IS NULL AND id <= ${scope.forkTurn} AND state != 'reserved')`
              : `SELECT id FROM steps WHERE unloaded = 1`,
          )
          .map((r) => r.id),
      ),

    activateSummary: (stepId) => {
      // **head 和归档路径在这里算，不从调用方收。**
      //
      // 原来是 run.ts 的 collectHeads 从「被卸载的那几条」里取，但第 0 层
      // 改成只裁工具 I/O 之后，文本消息永远不进 indices，头部就再也取不到
      // 用户原话了。库这边能看到整个 step 的消息，是唯一取得准的地方——
      // flipSummary 早就是这么做的（a84633a），两条路径现在同源
      // **先定位段，再按段的第一个 step 取 head。**
      //
      // 原来直接 `headOfStep(db, stepId)`——用调用方传进来的那个 step。调用方
      // 是拿 cold 数组逐个调的，于是变成「最后一次调用赢」：段里第二个 step 的
      // assistant 回复会盖掉用户原话，context 里出现「开头：答一」而不是
      // 「开头：第一个问题」。`flipSummary` 一直是按 covers_from 取的
      // （a84633a），这里对齐——两条生效路径必须同源。
      //
      // 这个 bug 一直潜伏着：turn 粒度挑选时 cold 通常只有一个 step，
      // 「最后一次」恰好就是「第一个」。§11.5 改成 step 粒度后 cold 变长，
      // 它才现形（`summary-e2e` 当场红）。
      //
      // **段头被推进线碰过就生效**（子查询只查 covers_from 那一条，判定与
      // segmentHeadUnloaded 同源）。原来要求整段卸空（`NOT EXISTS unloaded=0`）：
      // 卸载按 token 刹车、段按卸载前的 16k 切，两把尺子不同，刹车点常常
      // 落在段中间——段头卸了、段尾还 live，`NOT EXISTS` 永远不满足，截断
      // 存根就永远顶班（真库 turn-28 就是这么滞留的）。现在拆成两层：
      // floorTokens 管「裁多少」（卸载后的 16k），段边界管「顶替多少」（整段
      // 换一行摘要）。段头卸了说明推进线到过这段，段尾的 live 原文跟着被
      // 顶掉是预期的——原文都在库里，路径就写在摘要行里
      //
      // task-v3 两条补充：① owner 限定——进场翻的是 `in_context`（共享
      // 列），翻别人视角的行会把对方的窗口也顶了。对话只翻自己的，任务只
      // 翻私有的。② 继承段豁免——私有摘要 covers 继承段时段头（对话的
      // step）在库里还是 live，那正是任务要顶替的东西，判据放宽为
      // 「段头已卸 OR 整段在继承界内」
      const row = db.all<{ id: number; covers_from: number }>(
        `SELECT id, covers_from FROM summaries
         WHERE covers_from <= ? AND covers_to >= ? AND status = 'ready'
           AND superseded_by IS NULL
           AND ${scope ? `owner = '${safeOwner(scope.owner)}'` : 'owner IS NULL'}
           AND ${
             scope
               ? `((SELECT st.unloaded FROM steps st WHERE st.id = covers_from) = 1
                  OR covers_to <= ${scope.stepFloor})`
               : `(SELECT st.unloaded FROM steps st WHERE st.id = covers_from) = 1`
           }`,
        stepId,
        stepId,
      )[0]
      if (row) {
        const { text: head, archivePath } = headOfStep(db, row.covers_from)
        // 三个字段一条 UPDATE 写完（SQLite 单语句本身就是原子的，不用额外包
        // 事务）。分两条写的话中间崩溃会留下「开关翻了但没有归档路径」的行
        // ——模型知道该展开却不知道去哪 cat，比不卸载还糟
        db.run(
          `UPDATE summaries SET in_context = 1, head = ?, archive_path = ? WHERE id = ?`,
          head,
          archivePath,
          row.id,
        )
      }
      // 回读而不是信 UPDATE 的影响行数：`status = 'ready'` 这个条件意味着
      // 「没匹配到」是正常情况（摘要还在生成），调用方要靠返回值决定走不走
      // 降级路径。返回值错了的现象是 context 里既有摘要又有截断存根，或者
      // 两者都没有——都不报错
      return activeSummaryCount(db, stepId, sumVis) > 0
    },

    startSummary: (id) => {
      db.run(`UPDATE summaries SET status = 'generating' WHERE id = ?`, id)
    },

    finishSummary: (id, text, name) => {
      // name 跟 text 一起写：两样是模型**一次**生成的，分两条 UPDATE 的话
      // 中间崩溃会留下「描述换成真的了、标题还是占位」的行
      db.run(
        `UPDATE summaries SET status = 'ready', text = ?, name = ? WHERE id = ?`,
        text,
        name,
        id,
      )
    },

    maxIds: () => {
      const max = (table: string, range: string): number =>
        db.all<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table} ${range}`)[0]?.m ?? 0
      if (scope === null)
        return {
          turns: max('turns', ''),
          steps: max('steps', ''),
          messages: max('messages', ''),
          summaries: max('summaries', ''),
        }
      // 段内口径（2026-09-23 真机：fork 后对话只要说一句就跳到 turnCeil+1，
      // 全库 max 口径让任务第一条消息就报「turns 段已满」）。空段回落到
      // floor：「还一个号都没用」
      return {
        turns: max('turns', `WHERE id > ${scope.forkTurn} AND id < ${scope.turnCeil}`) || scope.forkTurn,
        steps: max('steps', `WHERE id > ${scope.stepFloor} AND id <= ${scope.stepCeil}`) || scope.stepFloor,
        messages: max('messages', `WHERE id > ${scope.msgFloor} AND id <= ${scope.msgCeil}`) || scope.msgFloor,
        summaries: max('summaries', `WHERE id > ${scope.sumFloor} AND id <= ${scope.sumCeil}`) || scope.sumFloor,
      }
    },

    recordMerge: (row, memberIds) => {
      db.transaction(() => {
        // 新行归属 = **第一个成员的归属**（同组同 owner 由 pickMergeGroup
        // 保证）。注意不能填自己会话域的 owner：任务视角的可见集里也有
        // 对话的行，任务可能替对话合出一组（输入输出都在对话的域内，合
        // 并本身合法）——父行若被填成私有，对话成员就指向一个它看不见
        // 的父行（幽灵顶替，对话凭空丢摘要）
        const firstMemberOwner =
          memberIds.length > 0
            ? db.all<{ owner: string | null }>(`SELECT owner FROM summaries WHERE id = ?`, memberIds[0] ?? -1)[0]
                ?.owner ?? null
            : null
        db.run(
          `INSERT INTO summaries(level, covers_from, covers_to, text, status, in_context,
                                 superseded_by, head, archive_path, owner)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.level,
          row.coversFrom,
          row.coversTo,
          row.text,
          row.status,
          row.inContext ? 1 : 0,
          row.supersededBy,
          row.head,
          row.archivePath,
          firstMemberOwner,
        )
        const parentId = lastRowId(db)
        for (const id of memberIds) {
          db.run(`UPDATE summaries SET superseded_by = ? WHERE id = ?`, parentId, id)
        }
      })
      return lastRowId(db)
    },

    applyMerges: () => {
      const all = loadSummaries(db, sumVis)
      // 链根：自己没被谁合并（superseded_by NULL）、ready、下面还压着**别的**
      // 在场行。两种形态都收：还没生效的（!inContext，正常待生效），和已被
      // activateBacklog 先翻进场、成员还压着的（inContext）——压缩点上
      // activateBacklog 排在 applyPendingMerges 之前，activateSummary 又只翻
      // 自己，重叠态在这里诞生也必须在这里收掉；漏收的话它会留到下一次
      // openStore 被 repairAppliedChains 收——reload 在非压缩点改写前缀
      // （2026-09-24 两个目录 reload 后首请求双双 PrefixBrokenError）
      const candidates = all.filter(
        (s) => s.supersededBy === null && s.status === 'ready' && coversActive(all, s),
      )
      if (candidates.length === 0) return new Set<number>()

      // 极大根：候选里被**别的候选**罩住的出局。不滤的话等宽互罩会死锁——
      // 两条同范围 L1 互为 root，off 把双双翻 0、roots 循环又把双双翻回 1，
      // 谁也收不掉谁（2026-09-24 真机 66889/66891 同范围双 L1 在场就是这么
      // 僵住的）；嵌套链同理——L2 罩着 L1 时 L1 不该再当 root 把自己保回来。
      // 等宽时留 id 小的：胜负无关紧要，要的是确定性
      const roots = candidates.filter(
        (r) =>
          !candidates.some(
            (o) =>
              o.id !== r.id &&
              o.coversFrom <= r.coversFrom &&
              o.coversTo >= r.coversTo &&
              (o.coversFrom < r.coversFrom || o.coversTo > r.coversTo || o.id < r.id),
          ),
      )

      // 先在内存里算出最终状态再写库，事务里只留 UPDATE——边查边改的话
      // 前面翻掉的行会影响后面的判断，顺序耦合脆
      const off = new Set<number>()
      for (const root of roots) {
        for (const s of all) {
          if (
            s.id !== root.id &&
            s.inContext &&
            s.coversFrom >= root.coversFrom &&
            s.coversTo <= root.coversTo
          ) {
            off.add(s.id)
          }
        }
      }

      db.transaction(() => {
        for (const id of off) {
          db.run(`UPDATE summaries SET in_context = 0 WHERE id = ?`, id)
        }
        for (const root of roots) {
          db.run(`UPDATE summaries SET in_context = 1 WHERE id = ?`, root.id)
        }
      })

      // 被关掉的行覆盖的 step —— 调用方拿去修剪内存里的截断存根。covers 在
      // step 语义下是 step 区间（L0 单点、L1/L2 是收编后的宽区间），照区间
      // 展开即可。**不能按 turn 归并**：一个 turn 的消息分属多个 step，
      // 合并收编的单位是 step，按 turn 剪会把同 turn 里还在 context 的
      // step 连带剪掉（就是级联 e2e 抓出来的那个洞）
      const steps = new Set<number>()
      for (const s of all) {
        if (off.has(s.id)) {
          for (let t = s.coversFrom; t <= s.coversTo; t++) steps.add(t)
        }
      }
      return steps
    },

    close: () => db.close(),
  }
}

/**
 * 补上建库之后才加的列。已经有的列会抛「duplicate column name」，吞掉。
 *
 * **只吞这一种错**，不是 `catch {}` 了事：磁盘满、库损坏也会从这里抛出来，
 * 一并吞掉的话现象是「库悄悄缺列」，等到某次 SELECT 才炸，而那时早已看不出
 * 是开库时出的问题。
 */
function migrate(db: Db): void {
  for (const sql of MIGRATIONS) {
    try {
      db.run(sql)
    } catch (error) {
      if (!String(error).includes('duplicate column')) throw error
    }
  }
  // prompt_snapshot 单行表（id=1）→ 按 owner 分行（schema.sql.ts 的表注释
  // 写了翻车现场）。老表没有 owner 列且主键卡着 CHECK(id=1)，加列进不去，
  // 只能重建。PRAGMA 查形状做判据：每天开库都跑，新库/迁完的库一次
  // table_info 就跳过——不用 marker。旧行拷给主任务（owner=''），快照内容
  // 对上主任务的 prefix_baseline，跨升级的第一个请求不会白断一次
  const cols = db.all<{ name: string }>(`PRAGMA table_info(prompt_snapshot)`).map((r) => r.name)
  if (!cols.includes('owner')) {
    db.run(`CREATE TABLE prompt_snapshot_new (
      owner      TEXT PRIMARY KEY,
      agents     TEXT,
      notes      TEXT,
      events     TEXT,
      lessons    TEXT,
      updated_at TEXT NOT NULL
    )`)
    db.run(`INSERT INTO prompt_snapshot_new (owner, agents, notes, events, lessons, updated_at)
            SELECT '', agents, notes, events, lessons, updated_at FROM prompt_snapshot`)
    db.run(`DROP TABLE prompt_snapshot`)
    db.run(`ALTER TABLE prompt_snapshot_new RENAME TO prompt_snapshot`)
  }
}

/**
 * 启动时**删掉**没生成完的摘要行（`pending` / `generating`）。
 *
 * 摘要跑到一半进程没了（`/exit`、崩溃、`runOnce` 跑完就退）就会留下这种行。
 *
 * ## 原来是「退回 pending」，那是错的
 *
 * 旧注释说退回而不删，理由是「行里的占位文本正在 context 里用着，删了那段
 * 历史就凭空消失」。**这个前提不成立**：生效要么走 `activateSummary`（SQL 里
 * 写死 `status = 'ready'`），要么走 `flipSummary`（调用点在 `finishSummary`
 * 之后），没生成完的行**永远不可能 in_context=1**。
 *
 * 而退回 pending 之后没有任何代码会再挑到它：`nextSegment` 算「已覆盖」时
 * 不看 status，那一行会永久占着它盖的 step。真库里 213 条 pending 就是这么
 * 攒的，它们在 covers 上打的洞让 `pickMergeGroup` 的连续性判断一直断着，
 * L0 合并从此起不来（2026-09-03 真机验证确认）。
 *
 * 删掉之后那一段自然重新成为候选，下一次空闲补摘。摘要是纯派生数据。
 */
function dropUnfinishedSummaries(db: Db): void {
  db.run(`DELETE FROM summaries WHERE status IN ('pending', 'generating') AND in_context = 0`)
}

/** root 的覆盖范围内有没有**别的**还在 context 里的行——没有它就没什么可
 * 「生效」的。排除自身：不排的话每条在场行都是自己的 root，apply 永远非空 */
function coversActive(all: Summary[], root: Summary): boolean {
  return all.some(
    (s) => s.id !== root.id && s.inContext && s.coversFrom >= root.coversFrom && s.coversTo <= root.coversTo,
  )
}

/**
 * 启动一致性校验（提案 §5.3，纯防御）：apply 的事务理论上不可能留下中间态，
 * 但如果真的崩在了两条 UPDATE 之间（或库被外部动过），可能出现「父行已生效
 * 但子孙也还生效」——同一段历史在 context 里出现两次。
 *
 * 修复规则**以 superseded_by 链为准**（提案定案）：凡 superseded_by 指向某行
 * 且那行 in_context=1 的，自己强制压回 0。不做反向修复（父没生效就不动子孙）
 * ——那个状态是「待生效」的正常形态，不是损坏。
 */
function repairAppliedChains(db: Db): void {
  db.run(`
    UPDATE summaries SET in_context = 0
    WHERE in_context = 1
      AND superseded_by IS NOT NULL
      AND superseded_by IN (SELECT id FROM summaries WHERE in_context = 1)
  `)
}

type MessageRow = { content_json: string }

/**
 * 只读 `state = 'live'` 的行。第 3 步卸载会把行改成 'unloaded'，那些不进
 * context——但**行本身不删**，模型要能读回原文（§9.3）。
 */
function loadLive(db: Db, msgVis: string): Message[] {
  const rows = db.all<MessageRow>(
    `SELECT content_json FROM messages WHERE state = 'live' AND ${msgVis} ORDER BY turn_id, id`,
  )
  return rows.map((row) => JSON.parse(row.content_json) as Message)
}

/**
 * **全量替换 live 集合，一个事务。**
 *
 * 直觉上该做增量追加，但那是错的：`normalizeHistory` 每轮会重建整个数组
 * （补 interrupted 占位、删孤儿 tool_result、图片降级），消息**条数会变少**
 * 也会变多，条数游标必然错位——错位的现象是"某条消息永远没落盘"，不报错。
 *
 * 全量重写的代价可控：live 集合被上下文窗口限着（第 3 步的卸载会主动压它），
 * 量级是几十到几百条，一次事务微秒级。用正确性换掉一个不报错的错，值。
 *
 * 事务是必须的：中间崩溃会留下一个空的 messages 表，那比丢最后一条严重得多。
 */
function replaceLive(
  db: Db,
  turnOf: number[],
  messages: Message[],
  stepOf: number[],
  /** 删除过滤 = 写域（任务模式只删自己的行） */
  deleteVis: string,
  /** 任务模式的 fork 界：继承消息（turn ≤ forkTurn，即 fork 时复制来的
   * 行）不删不重插，原地保留。null = 对话模式 */
  forkTurn: number | null,
  nextMsgId: (() => number) | null,
  /** 新行的归属（messages.owner）。null = 主任务 */
  owner: string | null,
): void {
  db.transaction(() => {
    db.run(`DELETE FROM messages WHERE state = 'live' AND ${deleteVis}`)
    for (const [index, message] of messages.entries()) {
      if (forkTurn !== null && !((turnOf[index] ?? 0) > forkTurn)) continue // 继承的：留在原地
      if (nextMsgId !== null) {
        const id = nextMsgId()
        db.run(
          `INSERT INTO messages(id, turn_id, role, content_json, step_id, owner) VALUES(?, ?, ?, ?, ?, ?)`,
          id,
          turnOf[index] ?? 0,
          message.role,
          JSON.stringify(message),
          stepOf[index] ?? 0,
          owner,
        )
        continue
      }
      db.run(
        `INSERT INTO messages(turn_id, role, content_json, step_id) VALUES(?, ?, ?, ?)`,
        // 用这条消息**自己**的 turn，不是当前 turn——见 turnOf 的注释
        turnOf[index] ?? 0,
        message.role,
        // 存 canonical 格式，**不存 wire**（CLAUDE.md §3.2）。存 wire 的话
        // 换 provider 之后旧历史读不回来，而"能换 provider"正是这个项目的前提
        JSON.stringify(message),
        stepOf[index] ?? 0,
      )
    }
  })
}

function createTurn(db: Db, meta: string | null): number {
  db.run(`INSERT INTO turns(started_at, meta) VALUES(?,?)`, new Date().toISOString(), meta)
  return lastRowId(db)
}

/** 任务会话版：显式段内 id + owner。对话走上面的自然分配（max+1=fork 时
 *  reserved 行之上）。两版分开写而不是参数化——热路径少一次分支判断 */
function createTaskTurn(db: Db, meta: string | null, id: number, owner: string): number {
  db.run(
    `INSERT INTO turns(id, started_at, meta, owner) VALUES(?,?,?,?)`,
    id,
    new Date().toISOString(),
    meta,
    owner,
  )
  return id
}

/** 该 id 之下还有没有 unloaded 行。有 = 还有上一页（hasMore） */
function hasRowBelow(db: Db, id: number, msgVis: string): boolean {
  return (
    db.all(`SELECT 1 AS x FROM messages WHERE state = 'unloaded' AND id < ? AND ${msgVis} LIMIT 1`, id).length > 0
  )
}

function lastTurnId(db: Db, turnCond: string): number | null {
  return db.all<{ id: number }>(`SELECT id FROM turns WHERE ${turnCond} ORDER BY id DESC LIMIT 1`)[0]?.id ?? null
}

/**
 * 消息的身份。直接用序列化后的内容——canonical 格式里没有时间戳之类的
 * 易变字段，同样内容必然得到同样的串。
 *
 * 不做哈希：几百条消息的 Set 用完整串完全够，而哈希要处理碰撞
 */
const fingerprint = (message: Message): string => JSON.stringify(message)

/** 重启时把 turn 归属一起读回来，否则第一次 save 就会把老消息全改嫁到新 turn */
function lastStepId(db: Db, msgVis: string): number | null {
  return db.all<{ id: number }>(`SELECT id FROM steps WHERE ${msgVis} ORDER BY id DESC LIMIT 1`)[0]?.id ?? null
}

function createStep(db: Db, turnId: number): number {
  db.run(`INSERT INTO steps(turn_id, started_at) VALUES(?, ?)`, turnId, new Date().toISOString())
  return Number(db.all<{ id: number }>(`SELECT last_insert_rowid() AS id`)[0]?.id)
}

function createTaskStep(db: Db, turnId: number, id: number): number {
  db.run(`INSERT INTO steps(id, turn_id, started_at) VALUES(?,?,?)`, id, turnId, new Date().toISOString())
  return id
}

// 两个归属数组的下标必须对齐 `load()`，所以排序必须与 loadLive 同为
// (turn_id, id)。原来是 ORDER BY id：对话侧 id 与轮序同调，看不出差别；
// 任务侧不行——对话每次 save 重插自己的 live 行、fork 后新 id 落在任务段
// 之上，任务自己的行 id 反而更小，按 id 排就把自己的行排到继承行前面，
// 下标整体错位：存一次，继承行被当成自己的写进任务段、真消息被当继承跳过
// （2026-09-23 task-uo518x 真机：任务第一轮的三条被替换成 t273 的 MCP 消息）
function loadStepIds(db: Db, msgVis: string): number[] {
  return db
    .all<{ step_id: number }>(`SELECT step_id FROM messages WHERE state = 'live' AND ${msgVis} ORDER BY turn_id, id`)
    .map((row) => row.step_id)
}

function loadTurnIds(db: Db, msgVis: string): number[] {
  return db
    .all<{ turn_id: number }>(`SELECT turn_id FROM messages WHERE state = 'live' AND ${msgVis} ORDER BY turn_id, id`)
    .map((row) => row.turn_id)
}

const lastRowId = (db: Db): number =>
  db.all<{ id: number }>('SELECT last_insert_rowid() AS id')[0]?.id ?? 0

/**
 * `turns/000/turn-000042.jsonl`：消息归档（§9.3 的第 ② 层，桶规则见 buckets.ts）。
 *
 * 内容和 SQLite 重复，这是**故意的**。§9.8：「模型要用 `cat` 读它们——
 * 放进 SQLite 就 `cat` 不出来了」。第 3 步卸载后，原文靠模型自己 cat 读回。
 *
 * 用 appendFileSync 而不是流：频率是"每轮几条"，而流要管生命周期
 * （什么时候 close、崩溃时缓冲区里的会不会丢）。
 */
function appendToArchive(turnsDir: string, turnId: number, message: Message): void {
  // turnsDir 是 memory 根下的 turns/；桶目录由 ensureBucketFile 顺手建
  appendFileSync(
    ensureBucketFile(dirname(turnsDir), 'turns', archiveName(turnId)),
    `${JSON.stringify(message)}\n`,
    'utf8',
  )
}

const archiveName = (turnId: number): string => `turn-${String(turnId).padStart(6, '0')}.jsonl`

/**
 * 给模型看的归档路径。**必须和 appendToArchive 写的是同一个文件**——
 * 两处各拼各的话，卸载提示里的路径 `cat` 不出东西，而且不报错
 */
const archivePath = (turnId: number): string =>
  join(MEMORY_RELATIVE, bucketedRel('turns', archiveName(turnId)))

/**
 * 迁移收尾：把 `summaries.archive_path` 里的平铺老路径重写成带桶的新路径。
 * 只在 `migrateToBuckets` 真挪了文件时跑一次；turns 侧的指路牌在摘要行
 * 文本里（拼好存库的），历史行不动——读侧双探测兜底，新写的行天然带桶。
 */
function rewriteLegacyArchivePaths(db: Db): void {
  const rows = db.all<{ id: number; archive_path: string | null }>(
    `SELECT id, archive_path FROM summaries WHERE archive_path IS NOT NULL`,
  )
  for (const row of rows) {
    if (!row.archive_path) continue
    // 字段可能是**换行分隔的多路径**（L1 合并行把一串成员叶子 join('\n')，
    // 见 session.ts 组装 archivePath 的地方）——逐行重写再拼回去，
    // 认不出的行原样保留
    const next = row.archive_path
      .split('\n')
      .map((line) => {
        const m = /^\.simple-code\/memory\/(turns|summaries)\/([^/]+)$/.exec(line)
        return m?.[1] !== undefined && m[2] !== undefined
          ? join(MEMORY_RELATIVE, bucketedRel(m[1], m[2]))
          : line
      })
      .join('\n')
    if (next !== row.archive_path)
      db.run(`UPDATE summaries SET archive_path = ? WHERE id = ?`, next, row.id)
  }
}

type LiveRow = { content_json: string; turn_id: number; step_id: number | null }

/** live 消息 + turn/step 归属，顺序与 `load()` 一致 */
function loadLiveWithTurns(db: Db, msgVis: string): LiveMessage[] {
  const rows = db.all<LiveRow>(
    `SELECT content_json, turn_id, step_id FROM messages WHERE state = 'live' AND ${msgVis} ORDER BY turn_id, id`,
  )
  return rows.map((row) => ({
    message: JSON.parse(row.content_json) as Message,
    turnId: row.turn_id,
    stepId: row.step_id ?? 0,
  }))
}

type SummaryRow = {
  id: number
  level: number
  owner?: string | null
  covers_from: number
  covers_to: number
  text: string
  status: string
  in_context: number
  superseded_by: number | null
  head: string | null
  archive_path: string | null
  name: string | null
}

/**
 * 库里的 snake_case 在这里转成 canonical 的 camelCase。
 *
 * 不让 SQL 结果集的形状漏进上层——`assembleContext` 是纯函数，不该知道
 * 数据是从 SQLite 来的（CLAUDE.md §3.2 的同类理由）。
 */
function loadSummaries(db: Db, sumVis: string): Summary[] {
  return db
    .all<SummaryRow>(
      `SELECT id, level, covers_from, covers_to, text, status, in_context, superseded_by,
              head, archive_path, name, owner
       FROM summaries WHERE ${sumVis} ORDER BY covers_from, level`,
    )
    .map((row) => ({
      id: row.id,
      level: row.level,
      coversFrom: row.covers_from,
      coversTo: row.covers_to,
      // 老库迁移出来的行 name 是 NULL，空串是「没有标题」的正常态
      name: row.name ?? '',
      text: row.text,
      status: row.status as SummaryStatus,
      owner: row.owner ?? null,
      // SQLite 没有布尔类型，存的是 0/1
      inContext: row.in_context === 1,
      supersededBy: row.superseded_by,
      head: row.head,
      archivePath: row.archive_path,
    }))
}

/**
 * 每条消息属于哪个 turn：老消息保留原归属，新增的算在当前 turn 名下。
 *
 * `save` 和 `withTurns` 共用这一份。两处各写一遍的话，发请求时算出的归属和
 * 落盘时的不一样，摘要会盖错 turn——context 里某轮凭空消失或重复，不报错。
 *
 * normalize 删过消息时 `previous` 会比 `messages` 长，slice 掉多余的。
 */
const attributeTurns = (messages: Message[], previous: number[], current: number): number[] =>
  messages.map((_, index) => previous[index] ?? current).slice(0, messages.length)

/**
 * step 归属：与 turn 归属同一形状——老消息保留原 step id，新消息归 current。
 * 区别在于 step 会切：新段的第一条消息若是 assistant（stepBoundary），先造
 * step 行再归属。造行在归属函数里做（而不是只靠 run loop 的 beginStep）是
 * 因为 save 的调用点先于/晚于 beginStep 都要成立——归属不能依赖调用时序
 */
function attributeSteps(
  messages: Message[],
  turnAttr: number[],
  previous: number[],
  current: number | null,
  createOnBoundary: () => number,
): number[] {
  const out: number[] = []
  let step = current
  let stepTurn: number | null = null
  for (const [index, message] of messages.entries()) {
    // 与 backfillSteps 同一规则：assistant 开新段，换 turn 也开新段
    const boundary = stepBoundary(message.role, index) || stepTurn !== turnAttr[index]
    if (boundary && index >= previous.length) {
      // 新 step 的第一格：写路径（save）真建行；只读路径（withTurns）给
      // 占位——不改库，归属与稍后 save 的结果可能差一步，但拼装对 step_id
      // 的消费只按「同组消息同 id」分组，占位一致即可不漂移
      step = createOnBoundary()
      stepTurn = turnAttr[index] ?? 0
    } else if (index < previous.length) {
      step = previous[index] ?? step ?? 0
      stepTurn = turnAttr[index] ?? 0
    }
    out.push(step ?? 0)
  }
  return out
}

/** 一个 step 的全部消息，按落库顺序。save 和候选复核共用 */
function stepMessagesOf(db: Db, stepId: number): Message[] {
  const rows = db.all<{ content_json: string }>(
    `SELECT content_json FROM messages WHERE step_id = ? AND ${NOT_COPY} ORDER BY id`,
    stepId,
  )
  return rows.map((row) => JSON.parse(row.content_json) as Message)
}

/** 闭区间内所有 step 的消息，按落库顺序 */
function segmentMessagesOf(db: Db, segment: Segment): Message[] {
  const rows = db.all<{ content_json: string }>(
    `SELECT content_json FROM messages
     WHERE step_id BETWEEN ? AND ? AND ${NOT_COPY} ORDER BY id`,
    segment.from,
    segment.to,
  )
  return rows.map((row) => JSON.parse(row.content_json) as Message)
}

/**
 * 挑下一个待摘的段：先选 turn，再在 turn 内切。
 *
 * **占着 context 的 turn 排前面，然后才按 turn 序。** 光按 id 升序的话，摘要
 * 线程会从最老的 turn 开始排队，而那些 turn 的消息早被卸干净了——一条 live 行
 * 都不剩，摘出来顶不掉任何东西。真实库里排在队首的 6187 个 step 全是这种，
 * 按一次空闲一段算，要几千次 tick 才轮得到第一个真正占地方的。
 *
 * 仍然**不排除**它们（只是排后面）：排除会让 covers 出洞、L1 合并再也接不上
 * （§6.6 同一个坑）。
 */
function nextSegment(
  db: Db,
  budgetTokens: number,
  activeTurn: number | null,
  stepVis: string,
  sumVis: string,
  /** 「占着 context」只数自己的 live 行（messages.owner 判据，无别名） */
  ownerEq: string,
): Segment | null {
  const covered = new Set(
    db
      .all<{ covers_from: number; covers_to: number }>(
        `SELECT covers_from, covers_to FROM summaries WHERE ${sumVis}`,
      )
      .flatMap((r) => range(r.covers_from, r.covers_to)),
  )
  // **排除整个正在跑的 turn，不是只排除最后一个 step。**
  //
  // 原来是 `s.id < MAX(id)`。真机验证（2026-09-03）照出它的后果：摘要每个
  // step 跑完都被踢一脚，那时「除最后一个之外」的 step 只剩刚跑完的那一个,
  // 于是一个 turn 出了三条摘要（covers 1-1 / 2-2 / 3-3）——切段预算 16k
  // 一次都没机会起作用，退回了 §1.1 说的「一个 turn 摘九遍」。
  //
  // 排除整个 turn 之后，只有已经结束的 turn 才够格当候选，takeSegment 拿到的
  // 是完整的 turn，该切才切。**idle 时传 null**：那会儿最后一个 turn 也结束了，
  // 排除它等于让空闲摘要永远够不着最需要摘的那一轮
  const rows = db.all<{ id: number; turn_id: number; holds_context: number }>(
    `SELECT s.id, s.turn_id, EXISTS(
       SELECT 1 FROM messages m2 WHERE m2.step_id = s.id AND m2.state = 'live' AND m2.${ownerEq}
     ) AS holds_context
     FROM steps s
     JOIN messages m ON m.step_id = s.id -- 空消息的 step 不当候选
     -- 写成 "? IS NULL OR ..." 而不是 "turn_id IS NOT ?"：后者在 activeTurn
     -- 为 null 时的含义是「turn_id 不为 null」，靠「turn_id 从来不是 null」
     -- 才碰巧对，是偶然的正确
     WHERE ${stepVis} AND (? IS NULL OR s.turn_id <> ?)
     GROUP BY s.id ORDER BY s.id`,
    activeTurn,
    activeTurn,
  )

  const turns = new Map<number, { id: number; holds: boolean }[]>()
  for (const row of rows) {
    const steps = turns.get(row.turn_id) ?? []
    steps.push({ id: row.id, holds: row.holds_context === 1 })
    turns.set(row.turn_id, steps)
  }
  const ordered = [...turns.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      Number(right.some((s) => s.holds)) - Number(left.some((s) => s.holds)) || leftId - rightId,
  )

  for (const [turn, steps] of ordered) {
    // **取第一段连续未覆盖的 step，遇到已覆盖的就断。** 直接 filter 掉已覆盖的
    // 会把两侧接起来，covers 就跨过一个洞了——洞不报错，只是那截历史从此
    // 既不在 context 里也不在任何摘要里
    const start = steps.findIndex((s) => !covered.has(s.id))
    if (start === -1) continue
    const rest = steps.slice(start)
    const end = rest.findIndex((s) => covered.has(s.id))
    const run = end === -1 ? rest : rest.slice(0, end)

    const sized = run.map((s) => ({
      id: s.id,
      tokens: stepMessagesOf(db, s.id).reduce((sum, m) => sum + estimateMessageTokens(m.parts), 0),
    }))
    const segment = takeSegment(sized, budgetTokens)
    const first = segment[0]
    const last = segment[segment.length - 1]
    if (first && last) return { from: first.id, to: last.id, turn }
  }
  return null
}

/** 闭区间整数序列。给 covered 集合展开用 */
function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
}

/**
 * step = 一次模型调用往返（step-summary-rework.md §2）：一条 assistant 消息 +
 * 紧随其后到下一条 assistant 前的全部消息（tool_result 等）。turn 开头的
 * user 提问归入该 turn 的第一个 step。全覆盖、连续、无重叠。
 *
 * 切分只认 role，纯函数——重启、崩溃恢复后重跑同一规则，边界必然一致。
 */
const stepBoundary = (role: string, index: number): boolean => index === 0 || role === 'assistant'

/**
 * 老库回填：按 assistant 边界切分现存全部消息，建 steps 行、回写 step_id。
 *
 * 开库时跑一次。幂等：已有 step_id 的行不动（is null 过滤），重复执行只处理
 * 新增的消息。切分在 SQL 侧做不了（要按「相邻行的 role 变化」分组），拉到
 * 内存里算——万级行数，一次性成本可忽略。
 */
function backfillSteps(db: Db): void {
  const rows = db.all<{ id: number; turn_id: number; role: string }>(
    `SELECT id, turn_id, role FROM messages WHERE step_id IS NULL ORDER BY id`,
  )
  if (rows.length === 0) return
  let stepId: number | null = null
  let stepTurn: number | null = null
  db.transaction(() => {
    for (const [index, row] of rows.entries()) {
      if (stepBoundary(row.role, index) || stepTurn !== row.turn_id) {
        db.run(
          `INSERT INTO steps(turn_id, started_at) VALUES(?, ?)`,
          row.turn_id,
          new Date().toISOString(),
        )
        stepId = Number(db.all<{ id: number }>(`SELECT last_insert_rowid() AS id`)[0]?.id)
        stepTurn = row.turn_id
      }
      db.run(`UPDATE messages SET step_id = ? WHERE id = ?`, stepId, row.id)
    }
  })
}

/**
 * 一条 live 行都不剩的 step 补上 `unloaded = 1`。开库时跑，幂等。
 *
 * **回填出来的 step 从来没人给它翻这个标志。** 回填的原料多半是早就被卸载过
 * 的历史消息（`state='unloaded'`），而当年卸它们的时候 steps 表还不存在，
 * `unload()` 里那句 UPDATE 一次都没跑过——新建的行只拿到默认值 0，于是
 * 「原文早就没了」的 step 全都自称还在 context 里。
 *
 * 后果不报错，是两处一起静默失效：`stepUnloaded` 恒 false，补摘完永远不翻
 * `in_context`，摘要生成了也顶不掉存根；候选那边也因此挑不出该挑的。实测
 * 真实库里 6260 个 step 中招（占 92%），context 里滞留 1151 条存根 ≈ 250k token。
 *
 * **只补不撤**（`WHERE unloaded = 0`）：卸载后存根会以 live 身份回到集合里，
 * 反向清 0 的话刚卸干净的 step 又会被判成「还在 context」——那正是 `unload()`
 * 当初把判定放进事务里的原因。
 */
function reconcileStepUnloaded(db: Db): void {
  db.run(`
    UPDATE steps SET unloaded = 1
    WHERE unloaded = 0
      AND EXISTS (SELECT 1 FROM messages m WHERE m.step_id = steps.id)
      AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.step_id = steps.id AND m.state = 'live'
          -- 任务的复制行不算：它 live 着不代表主任务那份还在
          AND m.owner IS (SELECT t.owner FROM turns t WHERE t.id = m.turn_id)
      )`)
}

/**
 * 保留最后这么多个 step 的原文，更老的在压实迁移里一次性卸掉。
 *
 * 不做成配置项：这是**一次性修数据**的口径，不是常规行为。配置项会让人以为
 * 调它能改变日常卸载策略，而日常卸载看的是 token 预算（`inputBudget`），
 * 跟这个数字没有任何关系。
 */
const COMPACT_KEEP_STEPS = 100

/**
 * 一次性压实积压：老库里那些「原文早已离开 context、却没有任何摘要覆盖」的
 * step，直接卸原文 + 落一条本地 L0。跑一次，`user_version` 置 3。
 *
 * ## 为什么需要它
 *
 * 修完 `reconcileStepUnloaded` 和候选排序之后，摘要**能**正常工作了，但真实
 * 库里积压着 6524 个无摘要的 step。它们会正常进候选队列，于是重启后空闲摘要
 * 会连续调 6524 次模型（约 1160 万 input token、按 3s 间隔要跑几小时）——
 * 而这些 step 的原文早就不在 context 里，摘出来顶不掉任何东西，那笔钱纯属白花。
 *
 * ## 两步缺一不可
 *
 * 1. **卸原文**（`state='unloaded'`）：把滞留的截断存根清出 live 集合。
 *    单做这步不够——候选看的是「有没有摘要覆盖」，不是 live 状态，那 6524 个
 *    step 照样排在队里，照样烧那 6524 次调用
 * 2. **落本地 L0**：候选才会跳过它们。内容取原文头部（跟 `writeLocalL0` 同一
 *    口径），不调模型——原文已不在 context，摘要写得多好都影响不了模型，
 *    留个能判断「要不要 cat 归档」的锚点就够了
 *
 * 第 2 步还顺带保住了 covers 连续性：不落行的话这一整段全是洞，L1 合并要求
 * 成员严格连续，永远凑不齐（§6.6 那个坑的同一个形状）。
 *
 * **只处理 cutoff 之前的**：最后 `COMPACT_KEEP_STEPS` 个 step 原样留着，
 * 它们是近期上下文，该由正常的卸载/摘要流程处理。
 */
function compactLegacyBacklog(db: Db): void {
  if ((db.all<{ user_version: number }>(`PRAGMA user_version`)[0]?.user_version ?? 0) >= 3) return

  // cutoff 按**位置**算，不按 id 差：task-v3 的号段把 id 变稀了（fork 顶高
  // sqlite_sequence，对话后续 step 的 id 直接落在段尾之上），MAX(id)-100
  // 会把刚 fork 前后的真 step 当成远古积压压掉——实测就是这么炸的。位置制
  // （按 id 升序数到第 count-KEEP 个）在稠密老库上与 id 制完全等价，在带
  // 号段的库上自动跳过稀疏。只数**对话侧**的 step：任务段的摘要债归任务
  // 关闭流程（taskSummaryDebt），压实不许碰活着任务的 live 行
  const conv = `FROM steps s JOIN turns t ON t.id = s.turn_id WHERE t.owner IS NULL`
  const count = db.all<{ c: number }>(`SELECT COUNT(*) AS c ${conv}`)[0]?.c ?? 0
  // **不够长就直接走，别置版本号。** 新库开的时候一个 step 都没有，这时标
  // user_version=3 等于宣布「压实做过了」——等它真攒出积压时迁移已经被
  // 自己的版本号挡在门外，永远不会跑。空库上什么都不做本来就是幂等的
  if (count <= COMPACT_KEEP_STEPS) return
  const cutoffRow = db.all<{ id: number }>(
    `SELECT s.id ${conv} ORDER BY s.id LIMIT 1 OFFSET ?`,
    count - COMPACT_KEEP_STEPS - 1,
  )[0]
  if (cutoffRow === undefined) return
  const cutoff = cutoffRow.id

  // 无摘要覆盖的老 step。covers 是闭区间，用区间判断而不是等值——L1/L2 覆盖
  // 的是一段而不是一个点
  const stale = db
    .all<{ id: number }>(
      `SELECT s.id ${conv}
         AND s.id <= ?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.step_id = s.id)
         AND NOT EXISTS (
           SELECT 1 FROM summaries su
           WHERE su.covers_from <= s.id AND su.covers_to >= s.id
         )
       ORDER BY s.id`,
      cutoff,
    )
    .map((r) => r.id)

  db.transaction(() => {
    // **按 COMPACT_GROUP 分组写 L2，不是一个 step 一条 L0。**
    //
    // 一条 L0 只有几十 token，但 6524 条就是 50 万 token——比它要替换掉的
    // 1151 条存根还糟。实测确证：一 step 一条的版本把 context 推到 528k，
    // 分成 642 条 L1 仍有 120k。这批历史早就不在 context 里，模型需要的是
    // 「这段时间大致在干什么 + 去哪找原文」，不是逐 step 的流水账
    for (let i = 0; i < stale.length; i += COMPACT_GROUP) {
      const group = stale.slice(i, i + COMPACT_GROUP)
      const first = group[0] as number
      const last = group[group.length - 1] as number
      const head = headOfStep(db, first)
      for (const stepId of group) {
        db.run(
          // owner IS NULL：只卸主任务的行，任务的复制行是任务的上下文
          `UPDATE messages SET state = 'unloaded' WHERE step_id = ? AND state = 'live' AND owner IS NULL`,
          stepId,
        )
        db.run(`UPDATE steps SET unloaded = 1 WHERE id = ?`, stepId)
      }
      // level 2 对应 §9.6 的「L2 = 100 个 step」，跟 COMPACT_GROUP 一致。
      // 写成 L0 的话后续合并会把它当单点行去凑连续段，粒度就乱了。
      // in_context = 1 直接生效——原文已经不在 context 里，没有「等下次
      // 卸载再换」这一说，那批存根就是这一步刚清掉的
      db.run(
        `INSERT INTO summaries(level, covers_from, covers_to, text, status, in_context,
                               superseded_by, head, archive_path)
         VALUES(2, ?, ?, ?, 'ready', 1, NULL, NULL, ?)`,
        first,
        last,
        `step ${first}-${last}：早期历史，未摘要。原文见归档`,
        head.archivePath,
      )
    }
    db.exec(`PRAGMA user_version = 3`)
  })
}

/**
 * 压实时多少个 step 合成一条。
 *
 * 取 100 = §9.6 的「L2 = 100 个 step」。不取 mergeFactor 的 10：那会产出
 * 642 条 L1、实测 120k token，对一段早已离开 context 的历史来说太奢侈了
 */
const COMPACT_GROUP = 100

/** 压实用的锚点：取该 step 最长那条消息的头部，连同它的归档路径 */
function headOfStep(db: Db, stepId: number): { text: string; archivePath: string } {
  const rows = db.all<{ content_json: string; turn_id: number }>(
    `SELECT content_json, turn_id FROM messages WHERE step_id = ? AND ${NOT_COPY} ORDER BY id`,
    stepId,
  )
  // **先找第一条带文本的，找不到才退回最长那条。**
  //
  // 原来只有「取最长」。第 0 层改成只裁工具 I/O（提案 §4.2）之后，一个 step
  // 里最长的几乎必然是那条几万字符的 bash 命令或输出，而它没有 text part
  // ——头部于是全部退化成 `(tool_call)`，正是 §1.2 点名的那 15% 垃圾。
  // 用户那句话通常是 step 里最短的，按长度永远选不到它
  const parsed = rows.map((row) => ({ msg: JSON.parse(row.content_json) as Message, row }))
  const withText = parsed.find((x) => x.msg.parts.some((p) => p.type === 'text'))
  const longest = parsed.reduce<(typeof parsed)[number] | null>(
    (acc, x) => (acc === null || x.row.content_json.length > acc.row.content_json.length ? x : acc),
    null,
  )
  const picked = withText ?? longest
  const message = picked?.msg ?? null
  const turnId = picked?.row.turn_id ?? 0
  const part = message?.parts.find((p) => p.type === 'text')
  const raw = part?.type === 'text' ? part.text : `(${message?.parts[0]?.type ?? '空'})`
  // 存根里可能已经带着「[已卸载，完整内容见 …]」——那是上一次卸载写进正文的，
  // 当摘要正文会很难读。截在提示之前
  const clean = raw.split('\n[已卸载')[0] ?? raw
  const text = clean.length <= COMPACT_HEAD_CHARS ? clean : `${clean.slice(0, COMPACT_HEAD_CHARS)}…`
  // **给模型的是叶子，不是 raw 归档。**
  //
  // 原来给的是 `turns/turn-NNNNNN.jsonl`——真库里那是几百 KB 的逐字对话，
  // 模型顺着它 cat 等于把刚卸载掉的东西全读回来。叶子是同一段历史的结构化
  // 摘要（用户要求/实际完成/未完成失败/涉及文件），几 KB，正是下一档分辨率。
  //
  // raw 没丢：叶子的 frontmatter 里有 `turn:`，顺着它拼得出归档文件名。
  // 多一跳，换的是默认那一跳便宜 100 倍
  return {
    text,
    archivePath: join(MEMORY_RELATIVE, bucketedRel('summaries', leafName(turnId, stepId))),
  }
}

/** 压实摘要留多少字。跟 keepHeadChars 默认值一致，够判断「要不要 cat」了 */
const COMPACT_HEAD_CHARS = 300

/** 覆盖这个 turn 且已生效的摘要条数。正常只会是 0 或 1 */
function activeSummaryCount(db: Db, turnId: number, sumVis: string): number {
  return (
    db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM summaries
       WHERE covers_from <= ? AND covers_to >= ? AND in_context = 1 AND ${sumVis}`,
      turnId,
      turnId,
    )[0]?.n ?? 0
  )
}

/** live 行的 id 和 turn_id，顺序与 load() 一致 */
function liveRowIds(
  db: Db,
  msgVis: string,
): { id: number; turn_id: number; step_id: number | null }[] {
  return db.all<{ id: number; turn_id: number; step_id: number | null }>(
    `SELECT id, turn_id, step_id FROM messages WHERE state = 'live' AND ${msgVis} ORDER BY turn_id, id`,
  )
}

/**
 * 原始输出用流，跟消息归档相反——它是逐 chunk 来的（bash.ts:111 在
 * `stdout.on('data')` 里调），一次 npm install 有几千个 chunk。
 * 每个 chunk 一次 appendFileSync 就是几千次同步系统调用。
 */
function createRawSink(absolutePath: string, relativePath: string): RawSink {
  let stream: WriteStream | null = createWriteStream(absolutePath, { flags: 'a' })
  // 落盘失败不能让工具执行中断（CLAUDE.md §4.1）。原始输出是诊断用的附加品，
  // 丢了不影响对话——模型看到的是 tool_result，不是这个文件
  stream.on('error', () => {
    stream = null
  })
  return {
    path: relativePath,
    write: (chunk) => {
      stream?.write(chunk)
    },
    close: () => {
      stream?.end()
      stream = null
    },
  }
}

/** toolCallId 来自模型，直接当文件名有路径穿越风险 */
const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)

/**
 * regions.jsonl 里这个 owner 的最后一条（纯读展示，不走上面的 Store 接口——
 * 那是写侧的）。owner 匹配从尾往回找（主任务和任务交错写同一个文件），
 * 没有归属字段的老行按主任务算。
 * 坏行（手编/截断）跳过往前找，一条能解析的都没有（或文件不存在）返回 null。
 * VS Code 面板（get_regions）和 CLI 的 /context 共用——口径必须一处定义。
 */
export function lastRegionLine(root: string, owner: string | null = null): Record<
  string,
  unknown
> | null {
  let lines: string[]
  try {
    lines = readFileSync(join(root, '.simple-code', 'memory', 'regions.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i] as string) as Record<string, unknown>
      if ((parsed.owner ?? null) !== owner) continue
      return parsed
    } catch {
      continue
    }
  }
  return null
}
