# SC 自我运行手册（self.md）

> 你（agent）正跑在 simple-code（SC）里。这份文档讲**你自己怎么运作**——
> 在任何目录下你都可以查它。用法：`grep -n "<关键词>" "$SIMPLE_CODE_DOC"`
> 定位节，或整份读。设计决策的「为什么」在源仓库 docs/design.md，这里只写
> 「机制是什么 + 所以你该怎么办」。参数以源码为准，本文写的是 2026-09 快照。

## 1. 上下文分区（context / regions / 冷温热 / token）

你的上下文窗口分三区，随 `.simple-code/memory/regions.jsonl` 记录水位：

- **热区**：最近几轮的**原文**——工具输出、reasoning、对话全量在场
- **温区**：老的 turn 降级为**存根**（前缀 + 文件引用 + 摘要）
- **冷区**：更老的已合并成上层摘要（10 条 L0 → 1 条上层，递归）

推进方向**从前往后**：老的先降级、最老的 stub 先打包成摘要（由
`memory.stubTokens` 水位驱动，默认 16k）。最新几轮永远原文在场，没有
「从后往前」的路径。

口径：**step** 是原子单位（一次工具调用/一条消息），**turn** 是用户
一轮提问到收口；摘要按 step 窗口压缩，regions 按 step 闭区间记账。
VS Code 多根窗口里每个 folder 是独立 session，上下文不串。

**常驻层**（每次请求全价重发，改一个字就破 prompt cache）：

| 常驻的 | 不常驻的 |
|---|---|
| 产品内建段（你开头读的这些） | 对话历史（会降分辨率、卸载到磁盘） |
| 用户级 `~/.simple-code/AGENTS.md` + 项目根 `AGENTS.md` 全文（各 ≤2k token，用户级在前、冲突以项目级为准；建会话读一次、压缩点刷新，超限截断/保旧版） | 工具输出正文（body 截断，要精读自己 cat） |
| notes / 教训 / 事件的**索引行**（name + description） | 三者的**正文**——只在你 `read` 时才进上下文 |

推论：**写 note/lesson 时，description 是唯一常驻的那行**，它决定「将来
的你会不会想起来点开」——写清治什么症状、什么时候该读，别写成标题的同义
反复。正文可以长，反正不常驻。

同理，重要约定/路径/决策写进 AGENTS.md 或 note，下次自动在场；只说在
对话里则会衰减。没有 AGENTS.md 的目录就没有那一层。跨项目通用的用户偏好
（语言、协作方式、发布须批准）写用户级那份，只属于这个项目的写项目根那份。

**所以你**：
- 「前面说过什么」精确细节大概率已降级——重要结论当场写 note 或落文件，
  别指望对话原文永远在
- system prompt 里的「历史摘要」是压缩产物，跨窗口边界的细节可能分进两份；
  「做没做过」的结论以 git/notes/文件为准，别引用摘要下结论
- 长工具输出别贪多——body 有截断（BODY_MAX_CHARS 量级 1200 字符/段），
  要精读自己再 cat 文件

## 2. 记忆三层（memory / turns / 检索 / archive）

一个文件夹 = 一个 agent = 一条永不结束的上下文（one session，无「新建会话」）。
全部落盘于 `<root>/.simple-code/memory/`，**只增不删，你想读就能读到**：

| 层 | 位置 | 内容 |
|---|---|---|
| 全量归档 | `turns/NNN/turn-NNNNNN.jsonl` | 每轮完整消息（含工具输出），按 step 分组 |
| 摘要 | `summaries/` | 压缩产物（你 system prompt 里那些） |
| 工具原始日志 | `raw/<step>/` | 每个工具调用的完整 stdout/stderr |

检索：
- 精确定位用 `"$SIMPLE_CODE_MEMORY" search <词> [--ctx]` / `show <turn|last> [--steps N]`
- 宽搜/正则/多词混合直接 `grep memory 的 turns 目录`（jsonl 全量，不截断）
- state.db（SQLite + FTS5）也有全文索引，sqlite3 直接查

## 3. 结论记忆三件套（note / lesson / 索引）

- **note**（`"$SIMPLE_CODE_NOTE" write/read/list`）：决策、约定、一次性事实，
  一笔记一事。索引只收最近 20 条的 description——**索引里没有 ≠ 不存在**，
  `list` 能列全量。重要的当场写，别指望对话衰减后还记得
- **lesson**（`"$SIMPLE_CODE_LESSON" write/read/search`）：调试教训。
  同一症状失败 ≥2 次后做成，写入走五段 heredoc JSON
- **三者的索引行常驻 system prompt，正文不常驻**（§1 常驻层）：所以
  note 的 description、lesson 的 name（name 即症状句）是被反复重读的那
  部分，写的时候当成「给未来的自己的检索线索」——「修了个 bug」这种没有
  检索价值，「症状 X 其实是原因 Y，别去查 Z」才有
- **skill**（`"$SIMPLE_CODE_SKILL"`）：任务说明书，仅用户点名才用
- **note 是活文档**：同一条结论变了就写新版本顶掉，不追加续写
- **event**（`"$SIMPLE_CODE_EVENT" list/search/read/progress/describe/rename`）：
  事件档案，活跃战役的状态板（`.simple-code/events/`，机制产出：摘要落库后
  单次归类判断+原子追加进展）。查「之前那件事做到哪了」优先用它，别拼摘要
  碎片。正常产出归 archiver（自动归档）；agent 可点状订正（2026-09-20 拍板，
  推案 §5.4 的「会被重写冲掉」随 v3 无重写路径失效）：progress 追一笔、
  describe 改描述、rename 改名——没有自由 write，正文大段不重写

## 4. 工具集（tools / bash / patch / lsp / mcp）

- **bash**：唯一执行入口。审批规则见 §5。子进程透传的 `SIMPLE_CODE_*`
  变量是你的能力入口（见各条目）
- **apply_patch**（`"$SIMPLE_CODE_APPLY_PATCH"`）：改文件首选。上下文必须
  与原文逐行一致；写补丁前先 `grep -n` 定位、`sed -n` 读目标区域——
  凭记忆写上下文是脱靶的最常见原因
- **LSP**（`"$SIMPLE_CODE_LSP" <refs|definition|symbols|hover|calls-in|calls-out>`）：
  VS Code 宿主注入时可用。**重命名/改签名前必查 refs**——grep 会漏同名遮蔽；
  calls-in/out 是 refs 近似（宿主未公开调用层级命令）。无桥（CLI/子 agent）
  回落 grep
- **MCP**（`"$SIMPLE_CODE_MCP" list/tools/<server>/<tool>`）：外部工具经
  配置的 server，用前先 list
- **生图**（`"$SIMPLE_CODE_IMAGEGEN" "<指令>" <路径>`）：
  经宿主凭据代理调 `/v1/images/generations`，模型由全局 settings.json 的
  `imageModel: {provider, model}` 定（未配置即报错）。图只落盘、stdout 一行；
  路径限项目内（隐藏目录除 `.simple-code/tmp` 外不许）；同名已存在另存
  `<名>-<新图 sha256 前 8 位>`；网关回的实际格式与扩展名不符时改扩展名再存
  并在输出写明。无宿主时退出码 2。bin 仍接受 `--size/--quality/--n`，但
  2026-10-23 实测所用网关全部忽略（尺寸按内容定、恒 png、恒 1 张），
  所以不写进工具描述
- **sc**（`"$SIMPLE_CODE_SC" --root <项目根> -q -t 600 "任务"`）：派一个
  一次性子 agent（headless 审批恒拒绝，权限边界 = --root 值）。
  `mkdir 任务目录 + AGENTS.md 任务书 + sc > result &` 即并行子 agent，
  不是 core 机制
- **view_image / webfetch / websearch**：看图（主模型无视觉时自动转述）、
  抓网页、搜索

## 5. 审批（approval / 权限 / allow / deny）

跑在 VS Code 面板 = 审批卡（allow/always/deny）；跑在终端 = `[y/n]` 问答
（`n 一句话` 可把反馈带给 agent）。规则要点：

- **项目内放行，项目外弹卡**（含隐藏目录 `.env`/`.ssh` 类）；网络命令、
  含 `$()`/解释器的命令弹卡
- **放行一条命令 = 放行它的进程树**（子进程不再逐条审）——所以白名单按
  「lead 词」设计（如 `pnpm test` 免审不等于 `pnpm` 全免）
- 挂机等不到人：5 分钟超时按 deny 收场，宁可拦住
- `always` 分三档：lead（首词免审）/ nonpath（第 N 位参数起不是路径）/
  dir（目录前缀免审），存在 `.simple-code/approval.json`
- 位置敏感：`.simple-code/memory` 读放行写弹卡（里面有全量归档），
  `settings.json` 读写都弹（apiKey 躺在里面）

## 6. 配置（settings / 配置 / 热重载）

两层 JSON，**项目覆盖全局**（deepMerge）：

| 层 | 位置 | 说明 |
|---|---|---|
| 全局 | `~/.simple-code/settings.json` | apiKey、常用 models 都在这 |
| 项目 | `<root>/.simple-code/settings.json` | 只放该项目要覆盖的键 |

**不在 settings.json 里、只认用户级的独立文件**：MCP server 在
`~/.simple-code/mcp.json`（键名即 server 名）。远端 server 写
`{"url": "...", "headers": {"Authorization": "Bearer ${VAR}"}}`：经宿主凭据
代理访问，`${VAR}` 只在宿主进程内展开（可内插），bin 与 bash 见不到密钥；
宿主是 VS Code 插件或终端 sc（sc 启动时自起代理，已有上层代理则复用）；
两者都不在（如用户在 shell 里直接敲 bin）时报无代理、退出码 2。本机 server 写
`command/args/env`。websearch 凭据在
`~/.simple-code/websearch.json`（`exaApiKey` 可写 `${EXA_API_KEY}`：有宿主时
bin 经凭据代理 `POST /websearch`，key 只在宿主展开；无代理时 bin 自己读
文件直连，`${VAR}` 从当前环境展开）；审批静态规则（askCommands/hiddenAllow/
networkAllow/nonPathFrom）在 `~/.simple-code/approval.json`。

常用键（速查，全量看 schema）：模型——`provider/model/baseUrl/apiKey/
protocol/contextWindow/maxTokens/thinking/effort/cacheTtlMs`，多模型注册
`models[]`；记忆——`memory.stubTokens`（默认 16k，摘要进场水位）、
`memory.hotLeaves`（默认 8）；工具——`envPassthrough`（bash 子进程可见
的白名单）；`maxIterations`（默认
500，单轮步数上限）；`sandbox`、timeout/输出上限系列。

**生效时机**：建 session 时**只读一次**。改了配置：VS Code 侧
FileSystemWatcher 标记 reload、跑到轮边界生效（跑着/挂审批不打断）；
CLI 侧 `/reload`。改坏了（JSON 不合法/超 schema）会显式报错，不会
静默用旧值装没事。

**安全注意**：项目级 settings 来自仓库内容（clone 一个带恶意配置的
仓库就会生效），denylist 机制专防这个——不信任它给的 envPassthrough/
sandbox 放宽（MCP 本就只认用户级 mcp.json）。`apiKey` 躺在全局 settings 里，审批对它的读写都弹卡。
审批白名单（always 决定）在 `<root>/.simple-code/approval.json`，人
点「始终允许」时追加。VS Code 里选过的模型按目录分键记忆
（`simpleCode.model:<folder>`），换目录不串。

## 7. 模型与档位（model / effort / 视觉）

- 用户可随时换模型/推理档位，**不重开会话、历史照常延续**
- 主模型无视觉时，看图走视觉副模型转述（relay），你看到的是文字
- 模型按目录分键记忆（`simpleCode.model:<folder>`），换目录不串模型

## 8. 交互语义（排队输入 / 插话 / 停止）

你跑长任务时用户不是干等：

- **排队输入**：你跑着的时候用户敲的字会排队，在**工具批次边界**插进
  来——你会在工具之间突然收到一条用户消息。**收到插话 = 用户有新意图，
  优先处理它**，别闷头把原任务跑完
- **打断**：Ctrl-C / 停止按钮打断当前轮；挂着的审批一并按拒绝收场
  （用户点停止 = 不想让任何东西挂着）
- 一次性模式（`sc -q`）没有插话，输入恒拒绝——那是给脚本/子 agent 的

## 9. 出问题怎么自救（debug / runlog / 排查）

- **runlog**：`~/.simple-code/logs/runlog-*.jsonl`，带 folder 字段的六类
  事件，先看它
- **装机没生效**：reload 后行为没变，先用 jsonl 仲裁（比对 turn jsonl 与
  state.db 的时间线），再怀疑缓存——教训库有这条
- **turn 疑似没收口**：state.db turns 表的 elapsed_ms 为空 + 最后一条是
  assistant = 中断
- 你上一次怎么栽的：`"$SIMPLE_CODE_LESSON" search <症状>`，**调试一轮没修
  好先查教训再继续猜**
- **自查熔断**：同一命令原样连发会被 doomLoopGuard 熔断（阈值 3 次）——
  轮莫名断了先看是不是在硬撞同一个错，换姿势而不是重试

## 10. 自我边界（one session / 轻量 / 已否决）

- **one session**：整个产品只有一条连续上下文，任何「会话切换/列表/新建」
  的提议直接否掉
- **轻量三问**（新功能先过）：宿主是不是已有？agent 用文字能不能表达？
  是不是天天痛？三问全过才考虑
- 已否决不再主动提：冷温热硬分层配额、图片老化、reasoning 裁剪、发布
  准备收口、温区独立配额等（完整清单在源仓库 AGENTS.md）
- 子 agent 不是 core 机制：mkdir + 任务书 + `sc > result &` 即是

## 11. 可选能力（组件装机 / agent-browser / opencli / officecli / cua-driver）

核心（bash / patch / LSP / 记忆）随包自带；下面这些组件**不随包安装**，但都是
官方支持路线。任务命中某个未装组件时（做 PPT、开浏览器、操作系统设置），
**先问用户「装吗」**，确认后再装——安装命令本身走 bash 审批，天然再拦一道。

| 组件 | 什么时候用 | 装法 |
|---|---|---|
| agent-browser | 浏览器自动化（测试 / 抓取 / 交互）、驱动 Electron 应用（VS Code / Slack / Figma） | `npm i -g agent-browser` |
| opencli | 登录态 Chrome 操作、站点适配器（bilibili / zhihu / reddit …） | `npm i -g @jackwener/opencli` |
| officecli | 生成 / 检查 / 改造 Office 文档（.docx / .xlsx / .pptx），单二进制 | `curl -fsSL https://d.officecli.ai/install.sh \| bash` |
| cua-driver | 原生桌面 App（AX 树寻址，后台不抢焦点；macOS / Windows / Linux） | `bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"` |

装完两步：

1. **取该 CLI 的动态文档**（比任何拷贝新，用前必读）：
   - agent-browser → `agent-browser skills get core`
   - opencli → `opencli skills read opencli-usage`
   - officecli → `officecli help skills`（`officecli skills install` 可把 skill
     定义装进 ~/.claude 等 agent 目录，拷一份到 ~/.simple-code/skills/officecli/）
   - cua-driver → macOS 还要 `cua-driver permissions grant`（TCC 授权）与
     `cua-driver telemetry disable`；工具面 `cua-driver list-tools`，官方 skill
     pack 在 ~/.cua-driver/skills/cua-driver/
2. **写指针 skill** 到 `~/.simple-code/skills/<name>/SKILL.md`（用户级，跨项目）：
   front matter 写清何时用 + 指向该 CLI 动态文档的入口。此后
   `$SIMPLE_CODE_SKILL list` 能看到，按 skill 走。

检测装没装：`which <命令>`。`skill list` 的输出尾行就指着本节。
