<p align="center">
  <img src="packages/vscode/assets/marketplace-icon.png" width="96" alt="SimpleCode">
</p>

<h1 align="center">SimpleCode</h1>

<p align="center">长期协作的编码 coworker。VS Code 侧边栏与终端 <code>sc</code> 两个入口。</p>

<p align="center"><a href="https://github.com/lnexp/simple-code/blob/main/README_EN.md">English</a></p>

---

## 定位

SimpleCode（以下简称 SC）是一个编码 agent：接收需求，读取代码、执行命令、修改文件，并报告改动内容。

SC 不追求单次任务最强，追求做一个**长期协作的 coworker**——同一个项目合作得越久，它越清楚你定过什么、否过什么、在哪里吃过亏。为此只围绕三件事投入：

- **连续性：记住，而且想得起来。** 你上周否掉的方案，这周不应该再被端出来；它上次改坏审批逻辑的教训，下次碰同一个文件时应该自己冒出来。SC 只有一条连续的上下文，决策、教训、事件档案都落成项目里的文件，动手时按关键词与触及的文件把相关条目提示给它。
- **边界：信任与风险对齐。** 工作区内读写不打扰，越界才问；`git push` 默认要你点头；MCP 的密钥只在宿主进程里展开，agent 执行的 bash 看不到。放得开的地方放开，该拦的一处不漏。
- **验证：成长要拿得出证据。** 协作是否越来越顺不能靠感觉。反思时 SC 会回看这段时间你纠正过它的地方，统计**同一类错误第二次出现的次数**，记进项目里的账本文件。

不做的事同样明确：不提供「新建会话」，不堆单次任务的功能，不为某个模型当下的短板做长期投入。

## 设计哲学

两条哲学贯穿始终，上面三件事都由此落地。

### One session

整个产品只有一条连续的上下文，不提供「新建会话」。

新建会话并不解决问题，只是将问题隐藏：需要新建，恰恰是因为原有会话过长、过乱或已偏离主题；而新建之后，此前得出的结论、遇到的问题、确立的约定，都留在了无法访问的另一侧。SC 的做法是让上下文自行代谢——历史对话自动摘要、降低分辨率、卸载至磁盘，需要时再行检索。**降低的是分辨率，而非数据本身。**

支撑这一机制的是 **file system is memory**：记忆不存放于向量数据库或私有格式中，而是磁盘上的普通文件。对话按轮次写入 JSONL，摘要为 markdown，结论、教训、事件档案各自对应一个目录下的 `.md` 文件。agent 检索记忆所用的正是 `grep`、`sed`、`cat`——文件系统本身即是一套久经检验的记忆系统。这同时意味着全部内容人可以随时直接查看与修改。

### One tool

向模型暴露的工具只有一个：`bash`。（严格而言是一个半——另有 `view_image` 用于读图，因为二进制像素无法经由管道进入上下文。）

**bash only** 的要点不在于「工具数量少」，而在于工具面本身即应为命令行：网页抓取、补丁应用、记忆检索、符号查询、MCP 调用、生图，在 SC 中均为 bash 内的命令，而非逐条注入上下文的工具定义。由此可管道串联、可自由组合、新增命令无需改动模型的工具表。

更根本的理由在于，命令行是模型最为熟悉的接口。为 agent 另行发明一套工具协议，模型需要重新学习；而提供一个 shell，模型已然掌握。

## 快速开始

### 1. 安装

支持 macOS 与 Linux；Windows 建议在 WSL 内使用。

在 VS Code 扩展面板搜索 `SimpleCode` 安装（Cursor、VSCodium 等编辑器从 Open VSX 安装，同名）。无需单独安装 Node.js，工具脚本用编辑器内置的 Node 运行。

### 2. 配置模型

新建 `~/.simple-code/settings.json`。下面以 DeepSeek 为例，走 OpenAI Chat Completions 协议：

```json
{
  "provider": "deepseek",
  "model": "deepseek-flash",
  "providers": {
    "deepseek": {
      "protocol": "openai-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "${SIMPLE_CODE_API_KEY}",
      "models": {
        "deepseek-flash": { "contextWindow": 1000000 }
      }
    }
  }
}
```

密钥放环境变量，写进 `~/.zshrc`（bash 用户写 `~/.bashrc`）后**完全退出并重开 VS Code**：

```bash
export SIMPLE_CODE_API_KEY=sk-...
```

- **没有默认模型**：`provider`、`model`、`protocol`、`baseUrl`、`apiKey` 五项必填，每个模型必须写 `contextWindow`（上下文卸载的触发点由它推算）。缺一项启动即报错，不猜。
- `baseUrl` 写到 `/v1` 之前为止，SC 自己拼 `/v1/chat/completions`。其他兼容这个路径的服务同样写法。
- 三种协议：`openai-chat`、`anthropic-messages`、`openai-responses`。
- `apiKey` 写 `${环境变量名}` 读环境变量，其余按字面量处理——别把密钥明文写进文件。
- 完整示例（多 provider、推理档位、超时、记忆参数）见 [`settings.example.json`](settings.example.json)，顶部 `$comment` 逐项说明。

### 3. 开始用

点侧边栏的 SimpleCode 图标，直接说需求，比如「看下这个项目的结构，跑一遍测试」。项目第一次使用时会在根目录建 `.simple-code/`，记忆都在这里；SC 会自动把它写进 `.git/info/exclude`，不会被误提交（不改你的 `.gitignore`）。

想让它从一开始就守你的规矩，在项目根写一份 `AGENTS.md`（见下文「约定」）。

## 记忆

### 分级压缩

对话增长时，历史部分会被**分级**压缩：

| 分区 | 状态 | 可用操作 |
|---|---|---|
| 热 | 原文位于上下文内 | 直接读取 |
| 温 | 摘要在上下文内，原文已卸载至磁盘 | 依摘要中的线索检索回原文 |
| 冷 | 归入事件档案 | 按事件名或关键词检索 |

温区摘要携带原文位置，冷区档案携带事件名称——**上下文中保留的始终是「如何找回」的线索**，而非内容本身。点底栏「上下文」可查看一次请求的分区快照，停止时可在那里手动「立即压缩」。

### 目录

全部在项目目录内，绝大多数为纯文本：

```
.simple-code/
├── memory/
│   ├── turns/000/turn-000123.jsonl   # 逐轮原文，全量，不截断
│   ├── summaries/                    # 分段摘要，markdown
│   └── state.db                      # SQLite：运行时索引与全文检索
├── notes/                            # 根目录存普通记录
│   ├── lesson/                       # 教训：一个症状一个文件
│   ├── principle/                    # 原则：判断、边界与依据
│   └── goal/                         # 目标：事、目标、边界、完成依据
├── events/                           # 事件档案：按事归档，一事一文件
├── skills/                           # 技能：某类事该怎么做
├── diagnosis/                        # 自我诊断账本
├── tmp/                              # agent 的临时文件
└── approval.json                     # 项目级审批规则
```

SQLite 仅为**加速层**；同一份内容同时按轮次写入 JSONL，**纯文本副本才是正本**。数据库可以重建，可读性并不依赖于它。

note 统一管理普通记录、教训、原则、目标，使用 `"$SIMPLE_CODE_NOTE" list/read/search/write`
和 `--type general|lesson|principle|goal`。旧项目的 `lessons/`、`principles/` 仍可原位读取，
升级不自动搬迁；同名冲突会列出路径，不覆盖。旧 LESSON 命令已移除。

当前 goal 的事、目标、边界和完成依据，以及按 LRU 入选的生效原则常驻；引用和经过按需读取。
在 goal 文件头设 `current: true`，且 `status: active`，仅一个目标可为当前；读历史目标不切换当前目标。
暂停/完成分别改 `status: paused/completed`。原则新写为 `candidate`，核实用户认可后才改为 `active`；
被否决则 `superseded` 并保留依据。文件立即可读，常驻内容在既有压缩点刷新。
四类共享 `memory.noteBudgetTokens`（默认 2100 估算 token），`memory.noteRatios` 默认
35%/10%/20%/35%。当前目标超份额时可借其他类额度，总量不增、边界不截断。

### 想得起来

记住不难，难的是该用的时候想起来。SC 在两处主动提示，都以 `〔recall·async〕` 行贴在工具结果之后：

- **按话题**：你发消息后，一个副模型对照你的话，从四类 note、skills、events 的描述里挑出相关条目，并用它给出的关键词匹配历史摘要。
- **按动作**：agent 执行命令时碰到某个文件或程序（比如改 `approval.ts`、跑 `gh`），描述里写到它的条目会被提示「先读这条」，行尾标「触及」。

只给线索，读不读由 agent 判断。这项**默认不开**：按话题挑条目每轮要多一次副模型请求，在配置里写 `"recall": { "mode": "on" }` 开启（按动作的提示也随它开关）。

### 约定

`AGENTS.md` 每次请求都会进 system prompt，写「会反复用到、且从代码里读不出来」的东西：

- 项目根 `AGENTS.md`：本项目的约定、否决过的提案。
- `~/.simple-code/AGENTS.md`：跨项目通用的个人约定。

两份都加载，用户级在前，冲突以项目级为准；各限 2048 token，超出截断，放不下的拆进 notes。

### 反思

底栏「记忆」按钮打开记忆面板，其中的「反思」会派一个后台任务整理 notes、lessons、events：订正过时条目、合并事件碎片、选一个主题写综述，并做自我诊断——回看上次反思以来你的纠正，判断哪些是「库里明明有、却又犯了」的重复错误，记进 `.simple-code/diagnosis/self-diagnosis.md`。做完交一份报告：写了什么、改了什么、放弃了什么，你可以当场订正。

## 审批

默认规则：**工作区内自由执行，越界须经确认**。

- **项目内**读写：直接执行。`cd` 后的相对路径（如 `cd packages && ls ..`）按实际位置判断。
- **项目外**：读与写都要确认——其他项目源码、`~/.ssh`、`/etc` 的泄露面在读取一侧。用户级配置 `~/.simple-code/settings.json` 也在项目外，同样要确认。
- **隐藏路径**（`.env`、`.ssh`、`.git`、`src/.env` 这类中间层级的）：要确认；只拦真实存在的。
- **`.simple-code/`**：`notes/ lessons/ events/ skills/ tmp/ diagnosis/` 读写都免审，是 agent 自助成长的区域；其余部分读放行、写要确认——向 turn 文件植入虚假记忆是真实的攻击面。
- **网络命令**（`curl`、`wget`、`ssh`、`scp`、`rsync` 等）、**解释器**（`python`、`sudo`、`osascript`）、**含 `$( )` 或 `node -e` 这类内联代码的命令**：要确认。`npm`、`pnpm`、`yarn`、`git` 虽会联网，日常使用不弹。
- **发布类**：`git push`、`gh` 默认永远要确认；`approval.json` 的 `askCommands` 可追加自己的命令（如私有部署 CLI）。

审批卡可选「总是允许」，按命令形态记入 `approval.json`（用户级 `~/.simple-code/`、项目级 `.simple-code/` 两份）。

底栏的审批开关默认开；关掉后**所有**审批直接放行（包括 `git push`），适合你在场盯着、不想被打断的时候。

## 终端 `sc`

扩展激活时在 `~/.simple-code/bin/` 下建命令入口，加入 `PATH` 即可：

```bash
export PATH="$HOME/.simple-code/bin:$PATH"
```

```bash
sc                         # 交互式对话，/exit 退出
sc "把 utils.ts 的测试补齐"   # 执行一轮后退出
sc -m deepseek/deepseek-flash -e high "重构这个模块"
cat error.log | sc "这个报错什么原因"
sc --models                # 列出可用模型
```

与面板共用同一份配置，记忆按目录走：在哪个目录运行，就读写哪个目录下的 `.simple-code/`。**同一目录同时只能一个会话使用**——面板正开着这个项目时，在同一目录运行 `sc` 会报「该目录已被另一个 simple-code 进程占用」。

终端不继承 VS Code 的环境，配置里引用的密钥要在 shell 中导出。一次性模式下**审批恒为拒绝**（无人在场放行），活动范围限于工作区内——这也让 `sc` 适合作为子 agent：新建目录、写入任务书、`sc > result.md &`。

## 多文件夹工作区

VS Code 工作区挂多个文件夹时，SC 为**每个文件夹运行一条独立的 agent**，经顶部标签栏切换，各自有独立的历史、记忆、模型选择与后台进程。切出的 agent **不会停止**，可以在 A 启动长任务，切到 B 做别的事。

后台文件夹的审批卡不会弹到当前界面，只在标签上显示待批角标，切过去才能看内容并答复（5 分钟无人答复自动拒绝）——审批要结合对话上下文判断，搬到别处只会降低判断质量。

## 图片与生图

- **给它看图**：输入框直接粘贴（Cmd/Ctrl+V）；agent 也可以用 `view_image` 读磁盘上的图，或经 `webfetch` 抓到网页里的图。发送前统一压缩到长边 2048、5MB 以内。
- **模型能否看图要自己声明**：默认按不支持处理。支持的模型（如上面的 `deepseek-flash`）在模型配置里加 `"capabilities": { "images": true }`。
- **主模型不支持视觉**：配一个视觉模型，图片先由它逐字转写成文字再交给主模型：

  ```json
  { "visionModel": { "provider": "provider 名", "model": "模型名" } }
  ```

- **生图**：配 `imageModel`（写法同 `visionModel`）后，agent 可以用 `$SIMPLE_CODE_IMAGEGEN` 出图，图片落在项目目录内。目前只支持 OpenAI 图片接口格式（`/v1/images/generations`）的服务。

## MCP

MCP server 配在 `~/.simple-code/mcp.json`（只认用户级，克隆来的仓库不能借配置塞可执行命令），agent 在 bash 里用 `$SIMPLE_CODE_MCP` 调用。远端 server 的 `headers` 写 `${VAR}`，只在宿主进程内展开，密钥不进 agent 的 bash 环境。

## 开发

```bash
pnpm install
pnpm test
pnpm run build
node scripts/deploy.mjs   # 安装至 ~/.vscode/extensions
```

## License

MIT
