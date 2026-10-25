import { z } from 'zod'
import { PROTOCOL_NAMES } from '../llm/registry.ts'

/**
 * 所有对象都 .strict()：未知字段直接报错，不忽略。
 *
 * 理由是配置项拼错（maxToken vs maxTokens）时，忽略等于静默用默认值——用户
 * 以为配了其实没配，而且没有任何迹象。
 * 我们至少要有「未知字段报错」。
 */
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape)

/**
 * 模型能力。默认 false 是保守选择，理由见 design.md §8。
 *
 * **只有 images**，判据见 llm/types.ts 的 Capabilities 注释：本地能力校验
 * 只留给「配错了会污染历史」的那一类，其余交给 API 说话（design.md §724）
 */
const capabilities = strictObject({
  images: z.boolean().default(false),
})

/**
 * 请求偏好。每一项都 optional——模型级要能只覆盖其中一项，
 * 写成有默认值的话就分不清「用户没配」和「用户配成了默认值」
 */
const requestPreferences = strictObject({
  maxTokens: z.number().int().positive().optional(),
  thinking: z.enum(['adaptive', 'disabled']).optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  reasoningDisplay: z.enum(['omitted', 'summarized']).optional(),
  /**
   * Anthropic prompt cache 的 TTL 档位（cache_control.ttl）。不配 = 不带 ttl，
   * 走上游默认 5m。最终为 '1h' 时 cacheTtlMs 自动取至少 3600000（load.ts，
   * 否则 5 分钟后照样判过期去压缩，1h 白买）。其他协议忽略此项。
   * 2026-10-12 探针：providerId 140 认 1h（7 分钟后仍命中）；已有 5m 条目的
   * 会话切过去是否会多次 miss，探针受网关路由噪声干扰没定论——切换时看
   * llm_usage，详见 note anthropic-1h-cache-ttl-probe
   */
  cacheTtl: z.enum(['5m', '1h']).optional(),
})

/**
 * 网关要求的额外请求头 / 请求体字段，**按模型配**。
 *
 * 真实需求：有些网关按模型分流，不同模型要带不同的路由参数，
 * `providerId` 是一例。这类字段是网关私有的，没有通用性，
 * 协议层不该认识它，所以做成透传而不是给 `Request` 加字段。
 *
 * 放在模型级不放 provider 级：网关的路由参数天然是按模型分的，配在 provider
 * 上的话同一个 provider 下每个模型都得复制一份，改一个漏一个。
 *
 * 值只允许 string / number / boolean：嵌套对象会让「协议自己的字段 vs 用户
 * 塞的字段」谁覆盖谁变得没法解释，而目前没有需要嵌套的真实场景。
 */
const passthrough = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

/**
 * 同一个模型的可切换参数预设（t885）。典型用途：网关的同一模型挂多条线路，
 * 某条慢了或不通就在界面上换一条——**换的是线路不是模型**，所以切预设
 * 不清 effort、不剥 reasoning 签名（两者都是 setModel 的行为，见 session.ts）。
 *
 * **只允许覆盖请求参数、头、body 和可选 SDK 调用方式**，`contextWindow` 和 `capabilities` 不在内：窗口
 * 一变，预算与压缩水位全要重算，那是模型的物理属性不是线路属性；能力（是否
 * 支持图片）同理，预设切换不该让历史里的图突然非法。
 *
 * 覆盖是**深合并**：预设只写要改的字段，其余承袭模型本体（`长输出` 只写
 * maxTokens，temperature 之类仍用模型的）。与配置加载「全局→工作区深合并」
 * 同一个精神。
 *
 * 不做全局模板复用（t885 拍板先手写）：等真写烦了再加，那层加上去不破坏
 * 已有配置。
 */
const modelPreset = strictObject({
  claudeAgentSdk: z.boolean().optional(),
  request: requestPreferences.prefault({}),
  headers: passthrough.prefault({}),
  extraBody: passthrough.prefault({}),
})

const modelSpec = strictObject({
  /** 可选外置调用适配，仅主对话；不改变 anthropic-messages 协议。 */
  claudeAgentSdk: z.boolean().optional(),
  // 必填、不猜。没有默认模型就没有默认窗口；填错的后果是某轮突然 400
  contextWindow: z.number().int().positive(),
  capabilities: capabilities.prefault({}),
  request: requestPreferences.prefault({}),
  /** 额外请求头。键名大小写不敏感，同名会覆盖协议自己的头 */
  headers: passthrough.prefault({}),
  /** 额外请求体字段。**覆盖不了协议自己的字段**，见 protocol.ts 的 mergeBody */
  extraBody: passthrough.prefault({}),
  /**
   * 可切换的参数预设，键名即界面上显示的名字。空 = 这个模型没有预设，
   * UI 不显示预设下拉（没有的东西不占地方，同 modelRules 的条件拼）。
   * 未选预设时用的是模型本体的参数，界面上叫「默认」——这个词是产品给的，
   * 不占用户的键名（用户仍可自己定义一个叫「默认」的预设，只是没意义）
   */
  presets: z.record(z.string(), modelPreset).prefault({}),
  /**
   * 距上次模型响应超过这个毫秒数，下一次发请求前先把上下文压到 target——
   * 不是因为超预算，是因为 prompt cache 过期了（提案 §12）。
   *
   * **缺省 3 小时，是刻意往大了给的。** 误判两个方向的代价不对称：
   * - 缓存还热却压了：白破一个热缓存 + 全价重付小基数，比不动差 4 倍
   * - 缓存死了没压：全价重付大基数，比不动省得少但方向不错
   * 已知最长的真实 TTL 档位是 Anthropic 的 1h（本项目不用，§12），3h 是它的
   * 3 倍，误判率趋近零；同时仍覆盖 one session 的主要闲置模式——隔夜回来。
   * 想激进一点（比如午休回来也压）就显式配小。
   *
   * per-model 而不是全局：TTL 是厂商/模型属性（Anthropic 默认 5m、OpenAI
   * 自动缓存驱逐时间不定、网关任意），且误配的代价直接是钱
   */
  cacheTtlMs: z.number().int().positive().default(10_800_000),
})

const providerSpec = strictObject({
  protocol: z.enum(PROTOCOL_NAMES as [string, ...string[]]),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  models: z.record(z.string(), modelSpec),
})

export const bashConfig = strictObject({
  defaultTimeoutMs: z.number().int().positive().default(120_000),
  /** 上限 300s：超过 5 分钟的任务本来就该转后台跑（超时自动转、输出不丢），
   * 前台干等到 10 分钟只是白占一轮工具调用 */
  maxTimeoutMs: z.number().int().positive().default(300_000),
  maxOutputChars: z.number().int().positive().default(16_000),
  killGraceMs: z.number().int().nonnegative().default(3_000),
  // 第一版只实现 none，但枚举现在就留——加沙箱时改的是实现不是配置形状
  sandbox: z.enum(['none']).default('none'),
  envPassthrough: z
    .array(z.string())
    // SIMPLE_CODE_WEBFETCH/SEARCH/APPLY_PATCH/MEMORY 是宿主注入的 bin 路径（web-tools
    // §10）——路径不敏感，模型靠它在 bash 里调网络工具
    .default([
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TERM',
      'TMPDIR',
      'SHELL',
      'USER',
      'SIMPLE_CODE_WEBFETCH',
      'SIMPLE_CODE_WEBSEARCH',
      'SIMPLE_CODE_MCP',
      'SIMPLE_CODE_APPLY_PATCH',
      'SIMPLE_CODE_MEMORY',
      'SIMPLE_CODE_LESSON',
      'SIMPLE_CODE_NOTE',
      'SIMPLE_CODE_EVENT',
      'SIMPLE_CODE_SKILL',
      // LSP 桥（lsp-bridge.ts）：bin 路径 + 桥端口，缺端口则 bin 报
      // 「无 LSP 桥」回落 grep——两个必须成对，只传路径不传端口是半残
      'SIMPLE_CODE_LSP',
      'SIMPLE_CODE_LSP_PORT',
      // 凭据代理（proxy/credential-proxy.ts）：url 型 MCP server 经它访问，
      // 缺这两个 bin 报「无代理」。token 模型可见无妨——挡的是本机其他进程
      'SIMPLE_CODE_PROXY_PORT',
      'SIMPLE_CODE_PROXY_TOKEN',
      // 生图 bin（经上面的凭据代理；VS Code 与终端 sc 都会起代理并注入）
      'SIMPLE_CODE_IMAGEGEN',
      'SIMPLE_CODE_DOC',
    ]),
})

const webfetchConfig = strictObject({
  defaultTimeoutMs: z.number().int().positive().default(30_000),
  maxTimeoutMs: z.number().int().positive().default(120_000),
  maxOutputChars: z.number().int().positive().default(100_000),
})


/**
 * 视觉转述副模型（vision relay）。主模型无视觉（capabilities.images
 * = false）时，view_image 把图发给它换一段文字描述——主模型不切换、
 * 上下文里只有文字。null = 不转述，view_image 维持占位文本现状。
 * 形态与 memory.summaryModel 相同：string = 当前 provider 下的模型名，
 * { provider, model } = 跨 provider
 *
 * 两处共用这一个形态。对象形态可带 effort 覆盖副模型的推理档位，比主模型
 * 多一档 'none'：openai-chat 不认 thinking，关推理只能发 reasoning_effort
 * =none，而它只对部分端点安全（2026-09-30 实测某端点会 400、另一端点
 * 推理漏进正文），所以不做成默认映射，由用户按端点显式配
 */
const sideModelRef = z.union([
  z.string(),
  strictObject({
    provider: z.string(),
    model: z.string(),
    effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
])

const retryConfig = strictObject({
  maxAttempts: z.number().int().positive().default(5),
  initialDelayMs: z.number().int().positive().default(2_000),
  backoffFactor: z.number().positive().default(2),
  maxDelayMs: z.number().int().positive().default(60_000),
})

const loopConfig = strictObject({
  // 纯粹防失控的最终保险丝。主会话不设上限，靠上下文窗口和用户打断兜底。
  // 我们保留一个大值：doomLoopGuard 拦精确循环、上下文预算拦膨胀，这里只兜
  // 「渐变式磨洋工」的挂机场景。500 ≈ 实测最长 marathon turn（~100 轮，
  // turn-74/171）的 5 倍，对正常任务不构成约束。
  maxIterations: z.number().int().positive().default(500),
  retry: retryConfig.prefault({}),
  /**
   * 流式响应两个数据块之间的最大间隔。超过就中止本次尝试，交给 retry 重发。
   *
   * **口径是「空闲间隔」不是「请求总时长」**。总时长上限
   * 会误杀慢慢吐十分钟的长回答，而空闲超时只在真的不动了的时候触发。
   *
   * 数值取 120 秒，偏小，因为我们**已经真的
   * 挂过一次**（bash 跑完后请求再没回来，进程要手动 kill）。
   *
   * 没有遥测，挂了就是用户干等，所以默认开。
   */
  streamIdleTimeoutMs: z.number().int().positive().default(120_000),
})

const memoryConfig = strictObject({
  // 没有 unloadThresholdRatio：触发不再是比例，而是
  // `contextWindow - maxTokens - 安全余量`（run.ts 的 inputBudget）。
  // 比例形式的问题是它把「给输出留多少」藏在一个数字里——0.7 碰巧盖住了
  // 默认 maxTokens，配成 0.95 就直接撞窗口，而那时配置看起来完全合理
  /**
   * 保底区的**比例上限**：保底区 = min(`floorTokens`, 预算 × 这个比例)
   * （2026-09-28 用户拍板由 max 改 min，推翻 compaction-v2 §0.2）。预算
   * 290,000 时 min(16k, 29k) = 16k；小窗口按比例缩（预算 39k → 3.9k）。
   * max 时预算越大保底越大，压缩谷底跟着抬（opus 300k 窗口实测保底 29k）。
   *
   * **键名沿用、语义换了**：原来（proposal §8.3）是「卸载目标压回预算的
   * 这个比例」，默认 0.35——v2 推翻：四趟车（stale/预算/force/任务关闭）
   * 触发即「保底区外全卸」，没有「压回某个比例」的目标，比例改作保底区
   * 的上限，默认 0.10。
   *
   * 基数是预算（`contextWindow - maxTokens - reservedTokens`）不是窗口，
   * 见提案 §10.5。
   */
  unloadTargetRatio: z.number().gt(0).lte(1).default(0.10),
  /**
   * 保底区：最近这么多 token 的原文一个字不动（提案 §11.5 的 ⑤ 区）。
   *
   * **按 token，不按 turn。** 原来是「整个当前 turn」，那不是上限——turn
   * 多大它多大，实测最大的 turn 有 152,125 token（§8.1）。后果是「一个 turn
   * 有 100 个 step 就一条都卸不掉」：`pickOldest` 第一组就撞上保底区直接
   * break。理由和上面拒绝「保 N 个 turn」完全一样，只是当时没推到保底区。
   *
   * 默认 16,000 有依据但**不是实测**：§8.1 的 turn 中位数是 4,563，16,000
   * 装得下 3.5 个中位 turn；按每 step 1,300–3,700 token 算是 4–12 个 step，
   * 够模型知道「我在干什么、刚才那条命令返回了什么」。
   *
   * 按 token 保最近一段的整段原文——按条数收同样是数一个
   * 尺寸不稳定的单位。
   *
   * 调小 = 更省窗口但模型更容易忘记本轮上下文；调大 = 反之。配成比预算还大
   * 就退回改动前的行为（一条都卸不动）。
   */
  floorTokens: z.number().int().positive().default(16_000),
  /**
   * 存根区的 token 上界（compaction-v2 §0.4）。存根区 = 保底区上方
   * 「已卸成存根、摘要还没进场」的缓冲带，两个上界（这条 + `stubSteps`）
   * **先到先停**。实测（2026-09-28，方案 C 裁剪后）一个 step ≈ 280 token，
   * 30 step ≈ 8.4k——常态是 step 界先到，这条只兜「单步特别大」的情况。
   *
   * 语义变更（v2）：原来（2026-09-12 水位闸）是「存根段超过这条线才让
   * 摘要进场」，v2 改成位置制（存根区从保底往上数），这条只剩「缓冲带
   * 最多多大」一个意思。默认与 `floorTokens` 同量级。
   */
  stubTokens: z.number().int().positive().default(16_000),
  /**
   * 存根区的 **step** 数上界（compaction-v2 §0.4）。与 `stubTokens` 先到先停。
   *
   * **是 step 不是 turn**（2026-09-28 纠偏，原名 stubTurns）：9-24 用户定的
   * 是「保底区往上再数 30 个组 tool call」，并明确否决 turn 粒度——一个 turn
   * 常有 20~50 次工具调用。定稿文档误写成「30 轮」、实现照着数了 turnId，
   * 30 turn 在重会话里永远到不了，存根区一直由 16k 界撑满（实测 8 轮 17.9k）。
   *
   * **位置制，不是年龄制**：从保底往上数实际存在的 step——fork 的预留
   * 号段缝（跳号空洞）数不进去，这正是弃年龄改位置的原因。
   */
  stubSteps: z.number().int().positive().default(30),
  /**
   * 预算之外再留的 token 数：`预算 = contextWindow - maxTokens - 这个值`。
   *
   * 主要给 **system prompt 和工具定义**留——它们每轮都发，但不在 messages 里，
   * §9.4.1 的用量口径数不到它们。剩下的是估算误差的缓冲。
   *
   * 按「默认值有依据、但允许覆盖」处理。
   *
   * 默认 2000 是自行推断，**没有实测依据**（按 1M 窗口配 13k
   * 的常见比例缩到 128k 窗口取整）。真跑下来发现频繁早卸或仍然撞窗口，调这个值。
   */
  reservedTokens: z.number().int().nonnegative().default(2_000),
  /** 本地 L0 摘要的描述截断长度（session.ts headOf）。卸载的裁剪长度见下面 clip* 三键 */
  keepHeadChars: z.number().int().positive().default(300),
  /**
   * 卸载时命令（tool_call.command）留多少开头 / 输出留多少头和尾
   * （2026-09-28 用户拍板方案 C）。实测存根区 8 轮 59 条 bash：命令中位数
   * 318 字、输出 316 字，单条不长、胜在数量（合计 ≈18k token）。
   *
   * - 命令 200：39/59 条以 `cd <项目根> && ` 开头（36 字），100 只剩 ~64 字
   *   有用；desc 说了「干什么」，命令里的「哪个文件哪几行」是回头定位的依据
   * - 输出头 100 + 尾 100：测试/构建/git 的结论在尾部（`1 failed | 424
   *   passed`），只留头会裁掉它
   *
   * 读回很少：9-21 起 7596 次调用里点名读旧轮次文件的 43 次（0.6%），抽样
   * 几乎都是排查/修库，不是找回被裁内容——结论已写进不裁的回答正文。
   * 三档实测省：300/300 ≈6k、200/200 ≈8k、本方案 ≈8k 但保住尾部结论
   */
  clipCommandChars: z.number().int().positive().default(200),
  clipOutputHeadChars: z.number().int().positive().default(100),
  clipOutputTailChars: z.number().int().positive().default(100),
  /**
   * 工具输入/输出超过这么多字符才裁，**低于就原样留着、一个通知都不加**
   * （提案 §4.2）。默认 0（2026-09-28 方案 C 由 1000 改）：只要裁完比原文短
   * 就裁——存根区的量在几百字的短 I/O 上（见 clip* 三键的实测），1000 的
   * 门槛让它们一条都不裁。
   *
   * 原默认 1000 的依据（提案 §8.2）：阈值 1000 命中 474/8038 段（5.9%）、
   * 全语料省 18%。那时存根区不常驻（摘要靠水位闸早进场），短 I/O 留着代价
   * 小；位置制下存根区常驻十几轮，账变了。
   *
   * **和 clip* 三键是两件事**：这个决定「什么时候动手」，那几个决定
   * 「动手后留多少」。两个都得配，因为「多长算长」和「留多少够索引」没有
   * 必然关系。
   */
  clipThresholdChars: z.number().int().nonnegative().default(0),
  /**
   * 索引区（②，全部生效中的摘要）最多占预算的多少。超了才合并。
   *
   * **这是合并的唯一触发条件。** 原来是「攒够 mergeFactor 条连续同层摘要就
   * 合」，跟索引区占了多少无关——真库里索引区只用了配额的 2.7%（319/12,000）
   * 时，25 条写得好好的 L0 叶子已经被折成了一行关键词。折叠是有损的（叶子的
   * `description` 从 context 里消失，只能照路径去 cat），在还装得下的时候折
   * 纯亏。
   *
   * 5% 的来历是提案 §3.8 实测：1000 turn 规模下树 + 冷热折叠约占预算 4%，
   * 给 25% 余量。按实测单价（温 73 token/条、热 194）折算约 11,900 token
   * ≈ 8 条热正文 + 120 条温键 ≈ 87 个 turn 才第一次需要折叠。
   *
   * **写成比例不是绝对值**，是 `floorTokens` 那次的教训（§11.6）：绝对值在
   * 小窗口模型上会静默吞掉整个 context（现在靠保底区与比例取小来防）。
   */
  indexRatio: z.number().positive().max(1).default(0.05),
  /**
   * 一次合并吃几条。**是扇出，不是触发条件**——什么时候合由 `indexRatio` 决定。
   */
  mergeFactor: z.number().int().min(2).default(10),
  summaryModel: sideModelRef.nullable().default(null),
  idleSummarizeDelayMs: z.number().int().nonnegative().default(3_000),
  /**
   * 估算低于这个 token 数的 step 不做 L0 摘要，直接留截断存根。
   *
   * 账是这样的：存根 ≈ keepHeadChars 或原文（取小者）+ 归档提示，一两句话的
   * 摘要 ≈ 50-80 token——太短的 step 压缩比接近 1:1，白花一次摘要模型的
   * 调用。0 = 关掉这个过滤，什么 step 都摘。
   */
  summaryMinTokens: z.number().int().nonnegative().default(100),
  /**
   * 单个摘要单位的 token 上限。一个 turn 超过这个量就切成几段
   * （提案 §4.3），每段一次摘要调用。
   *
   * 16,000 的来历是 §1.1 那次**真实**摘要调用：15,031 prompt token 出来的
   * 摘要是好的。24k 超出这个已验证点 60%，摘要质量还成不成立没有实测依据，
   * 不外推。依据的分布是 §8.1：turn 大小 p50=4,563 / p90=51,527 token，
   * **p90 是 p50 的 11 倍**——不切的话大 turn 会整个喂进去，出来就是 §1.3
   * 那种「无内容可提炼」。
   */
  segmentTokens: z.number().int().positive().default(16_000),
  /**
   * 热区留几条摘要展开叶子正文，其余只给键（提案 §4.4 的分辨率梯度）。
   *
   * **从 2 抬到 8。** 原来的 2 依据是 §4.5 的估算「正文约 160 token、键约
   * 38」——差 4 倍，热区看着很贵。真库量下来（26 条 L0，按 renderSummary
   * 实际渲染的样子算）是**温 105 / 热 191**，只差 1.8 倍：
   *
   * ```
   * 索引区 11,900（= 预算 × indexRatio）
   *   热  2 条 + 温 109 条 = 111 段 ≈ 71 个 turn 后才第一次折叠
   *   热  8 条 + 温  98 条 = 106 段 ≈ 68 个 turn
   *   热 12 条 + 温  91 条 = 103 段 ≈ 66 个 turn
   * ```
   *
   * 热区从 2 加到 12 只少覆盖 5 个 turn——这个取舍比原来估的平得多，2 条
   * 属于白省。
   *
   * 差在哪：§4.5 那个估算漏了 `开头：`（原话锚点）和标签开销，两样温热都要
   * 付，摊薄了正文那 121 token 的占比。顺带记一条**不成立的担心**：一度以为
   * `开头` 会吃掉 200 token（`COMPACT_HEAD_CHARS` 是 300 字符），实测中位
   * 24 字符、26 条里只有 1 条被截到上限——真实提问就是二三十个字。
   *
   * 实际条数在 `hotLeaves` 和 `hotLeaves + demoteBatch - 1` 之间摆动，
   * 见 `hotSummaryIds`。
   */
  hotLeaves: z.number().int().nonnegative().default(8),
  /**
   * 热区降级一次降几条。
   *
   * **必须成批，不能每轮降一个**（§4.7 硬约束一）：③ 按时间排序，降级动的是
   * 最前面那几条，它后面的 KV 缓存全部失效。每轮降一个 → ③ 每轮都变 → 缓存
   * 永远只命中到 ②；攒满一批降 → 这一批的轮次里只有一轮付重读。
   *
   * 跟 mergeFactor 同为 10（扇出），但**是两个独立的旋钮**：一个管「热区什么
   * 时候降成键」，一个管「多少个键收成一行内部节点」。同值是巧合不是约束。
   */
  demoteBatch: z.number().int().positive().default(10),
})

const recallConfig = strictObject({
  /**
   * off：不算（零开销）。shadow：选择器不发请求、不注入——本产品默认值。
   * on：选择器（selector.ts）+ 关键词撞摘要（cue.ts）跑满
   */
  mode: z.enum(['off', 'shadow', 'on']).default('shadow'),
  /** 以下三键 2026-10-14 起**已废弃**（n-gram 引擎退役，cue.ts 换芯为
   *  关键词匹配）：接受不再使用——删掉会让存量配置 strict 校验失败 */
  halfLife: z.number().positive().default(10),
  window: z.number().int().positive().default(30),
  /** 每轮摘要线索行上限（噪声预算）——唯一还在用的 */
  topK: z.number().int().positive().default(2),
  dedupTurns: z.number().int().positive().default(5),
})

export const configSchema = strictObject({
  // JSON 没有注释语法，但配置文件本来就该能写说明。放行这两个约定键——
  // 它们不削弱拼错检测：写错的字段名不会正好是 $comment
  $schema: z.string().optional(),
  $comment: z.union([z.string(), z.array(z.string())]).optional(),

  // 五项必填的前两项。没有默认 provider、没有默认 model（CLAUDE.md §1.2）
  provider: z.string().min(1),
  model: z.string().min(1),
  providers: z.record(z.string(), providerSpec),
  /** 外置 npm 安装根目录，仅用户级可信配置；未启用模型时不加载。 */
  claudeAgentSdkPath: z.string().min(1).optional(),
  request: requestPreferences.prefault({}),
  bash: bashConfig.prefault({}),
  webfetch: webfetchConfig.prefault({}),
  visionModel: sideModelRef.nullable().default(null),
  // 生图（$SIMPLE_CODE_IMAGEGEN，docs/proposals/imagegen.md）：写法同 visionModel
  // 的对象形式，但 model 不必登记在 provider.models 里——它不是对话模型，没有
  // 上下文窗口可填；provider 只借 baseUrl/apiKey。只由宿主凭据代理读（全局级）
  imageModel: strictObject({ provider: z.string(), model: z.string() }).nullable().default(null),
  loop: loopConfig.prefault({}),
  memory: memoryConfig.prefault({}),
  // recall 线索层（docs/proposals/recall.md）：send 入口算一次 TF-IDF×
  // 半衰期命中，落 cues 表冻结。mode 三档——off 不算；shadow 算+落库但不
  // 渲染（上线前的观察日志，直接查 cues 表）；on 落库+装配渲染
  recall: recallConfig.prefault({}),
})

export type Config = z.infer<typeof configSchema>
export type ProviderSpec = z.infer<typeof providerSpec>
export type ModelSpec = z.infer<typeof modelSpec>
export type ModelPreset = z.infer<typeof modelPreset>
export type RequestPreferences = z.infer<typeof requestPreferences>
export type BashConfigShape = z.infer<typeof bashConfig>
