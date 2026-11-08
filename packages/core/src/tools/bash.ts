import { spawn } from 'node:child_process'
import { appendFileSync, createWriteStream } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition } from '../llm/types.ts'
import { classify } from './approval.ts'
import {
  appendNonPathFrom,
  appendPath,
  dirHint,
  loadAlways,
  loadUserApproval,
} from './approval-always.ts'
import type { BgMeta } from './bg.ts'
import { LOG_DEFAULT_LINES } from './memory.ts'
import { truncateOutput } from './truncate.ts'
import type { Tool, ToolContext, ToolOutput } from './types.ts'

export type BashConfig = {
  defaultTimeoutMs: number
  maxTimeoutMs: number
  maxOutputChars: number
  /** SIGTERM 到 SIGKILL 之间的宽限期（3 秒） */
  killGraceMs: number
  /** 传给子进程的环境变量白名单。不在表里的一律不传（§12） */
  envPassthrough: string[]
}

/** 工具定义按配置生成——描述里的默认/上限秒数必须与实际行为一致
 * （「描述永远真话」：写死数字的话，用户改配置后模型拿到的还是旧数） */
const definitionOf = (config: BashConfig, env: NodeJS.ProcessEnv): ToolDefinition => ({
  name: 'bash',
  // description 要说清楚**什么时候该用**，不只是能干什么——这对触发率有实测影响
  // 结构化（2026-09-17 v2 拍板）：一行流水 1857 字符互相淹，【】节标题+换行
  // 让模型按需跳节——内容不变，只加结构
  description:
    '在工作区里执行一条 shell 命令：查看文件、运行构建与测试、检查 git 状态、' +
    '装依赖等一切要动命令行的事。输出合并 stdout 与 stderr 按时序返回。' +
    '命令固定在工作区根执行，要换目录就在 command 里写 cd <路径> && …。\n' +
    '【长任务/后台】测试/构建/install 直接跑：超时自动转后台、输出接进日志文件并给出路径，稍后 tail 回访。' +
    '主动起服务**必须重定向输出**——`mkdir -p .simple-code/tmp && (python3 -m http.server 8123 >.simple-code/tmp/sc.log 2>&1 & echo $! >.simple-code/tmp/sc.pid)`，' +
    '裸 `cmd &` 的输出没人接会在写满管道后卡住。调试用 curl，回看输出 `cat .simple-code/tmp/sc.log`，收尾 `kill $(cat .simple-code/tmp/sc.pid)`。' +
    '后台进程在用户界面显示、由用户决定是否关闭，agent 结束任务前应收尾自己的服务。\n' +
    '【临时文件】一律写 `.simple-code/tmp/`（项目内、随项目走、重启不丢），先 `mkdir -p`；' +
    '不写 /tmp——macOS 的 /tmp 重启即清。\n' +
    '【审批】路径出工作区（读放行仅限 .simple-code 子树，其余读也拦）、进隐藏目录（.env、.ssh 类）、' +
    '发布类命令（git push、gh，内置默认）与 approval.json askCommands 配置的命令（用户级 ~/.simple-code/ 与项目级 .simple-code/，含私有 CLI，如 appctl workloads apply）——执行前会请用户放行；被拒时如实转告用户、说明需要什么，不要换写法绕。网络命令与 $()/解释器不单独拦（2026-11-05 拆层拍板：默认全放、要拦自己配）：出网写、发布仍须按 AGENTS.md 先获批准，不要因「会弹卡」放松。\n' +
    '【网络】"$SIMPLE_CODE_WEBFETCH" <url>（HTML 转 markdown，可接管道）；"$SIMPLE_CODE_WEBSEARCH" <query>。\n' +
    '【自查】查 SC 自身运作（上下文分区/记忆/审批/排障）：grep "<关键词>" "$SIMPLE_CODE_DOC"。\n' +
    // LSP 命令格式按注入条件拼（2026-09-17 两次拍板）：env 里有桥才写这段——
    // 描述与实际能力永远一致。分工与 APPLY_PATCH 对齐（v2）：system prompt
    // 的工具约定管「该用哪个」（分流句+语言无关在那边），这里只留命令格式
    (env.SIMPLE_CODE_LSP !== undefined
      ? '【符号检索】"$SIMPLE_CODE_LSP" refs <file>:<行>:<列>（查符号引用；列须落在符号名上，先 grep -n 定位行再数列）；' +
        'definition（跳定义）；symbols <file>（文件符号表）；' +
        'hover（类型信息）；calls-in/calls-out（谁调用这里/这里调用谁）。报「无 LSP 桥」= 桥已不在（宿主窗口关闭），回落 grep。\n'
      : '') +
    // 生图同 LSP：宿主注入了 bin 且代理在才写，描述与实际能力一致
    // --size/--quality/--n bin 仍接受，但不写进描述：2026-10-23 实测网关全部忽略
    // （尺寸由模型按内容定、恒回 png、恒 1 张），写了 agent 会以为能控制；网关支持了再加回
    (env.SIMPLE_CODE_IMAGEGEN !== undefined && env.SIMPLE_CODE_PROXY_PORT !== undefined
      ? '【生图】"$SIMPLE_CODE_IMAGEGEN" "<指令>" <输出路径.png>（尺寸由模型按画面内容决定；图片只落盘、stdout 回一行路径；' +
        '路径限项目内，同名已存在会另存带 hash 的文件名，实际格式与扩展名不符会改扩展名并写明；看效果另用 view_image）。\n'
      : '') +
    // 派任务（task-trunk 规则 11）：只有 VS Code 宿主起了派任务桥才写——终端 sc 没有任务条
    (env.SIMPLE_CODE_TASK !== undefined && env.SIMPLE_CODE_TASK_PORT !== undefined
      ? '【派任务】"$SIMPLE_CODE_TASK" <<\'MD\' 任务书 MD（首行当任务名）：派一个并行任务进任务条，与用户开的任务一样跑、用户可切过去看；' +
        '立即返回任务名，不等跑完，可一次派多个。它看不到你当前的对话，任务书要自带背景、目标、交付物；' +
        '派出那一轮结束时结果以〔任务结果〕消息回到你这里，不用轮询；它的经历之后合回历史。' +
        // 规则 14：固定一句，列表不进描述——用户改 taskModels 不动 tools[0]
        '可加 --model <名> 指定模型（"$SIMPLE_CODE_TASK" --models 列出可选的及用途；不写 = 配置默认）。\n' +
        // 续派/闹钟（loop-interrupt 实现项 2/3）：同样只在宿主桥在时写；此前漏了这段，
        // 工具能调但模型不知道它们存在（2026-11-05 用户实测炸出）
        '【续派】"$SIMPLE_CODE_TASK_SEND"（无参列出任务：名字、状态、最近一句；带任务名和文本 = 往该任务发消息，' +
        'running 时入队插话、停着时点起新 turn）——追加指令、补背景都走它。\n' +
        '【闹钟】"$SIMPLE_CODE_WAKE" --after 30m / --at 08:00 / --until-ok "命令"（到点或条件满足时唤醒设闹钟的这个会话：' +
        '跑着=插话、停着=开新 turn；--note 留给自己的备忘；不持久化，重启即丢，周期靠醒来自己设下一个）\n'
      : '') +
    '【补丁】改既有文件用 "$SIMPLE_CODE_APPLY_PATCH" <<\'PATCH\'\n' +
    '*** Begin Patch\n*** Update File: 路径（相对工作区根）\n@@\n 照抄文件里已有的行（上下文）\n-要删的行\n+要加的行\n@@\n 另一处改动的上下文行\n-旧行\n+新行\n*** End Patch\nPATCH' +
    '（上下文与删除行须与文件逐行一致且各留一个前导空格，空行也不例外——写补丁前先用 grep -n 定位、' +
    "sed -n 'N,Mp' 读目标区域当前原文，上下文照抄，凭记忆写是脱靶的最常见原因；匹配不到即失败，错误指明文件与首行；" +
    '支持 Add/Delete/Update File、*** Move to: 改名、*** End of File 末尾锚、多 @@ 按序替换，整个补丁原子落盘）。\n' +
    '【记忆】"$SIMPLE_CODE_MEMORY" show <turn|last> [--steps 3-5]（turn jsonl 按 step 分组、长内容已裁剪）；' +
    'search <关键词> [--ctx]（跨 turns+summaries 窗口命中，--ctx 附所在 step 渲染，定位格式 turn-000012:step4；多个候选词用 OR：' +
    '「越权 OR 误弹 OR 抢戏」，同一件事的当时用词未必记得准，一次多试）；' +
    '分工：宽搜/正则/多词混合直接 grep memory 的 turns 目录（jsonl 全量落盘，不截断），' +
    'search 用于定位格式与渲染续接；' +
    `log [-n ${LOG_DEFAULT_LINES}]（每 turn 一行总览，先扫再下钻）。\n` +
    '【note】"$SIMPLE_CODE_NOTE" list [--all]（清单，默认收起超半年未用，--all 全量含被挤出索引的）| ' +
    'read <name>（全文+喂 LRU 心跳）| search <关键词> [--all] | ' +
    "write <<'MD'（heredoc 逐行写 name: <名>、title: <标题>、description: <单行描述>，" +
    '再一行 ---，其后是正文；新结论当场记一条）。' +
    '改内容用 "$SIMPLE_CODE_APPLY_PATCH"（.simple-code/notes/，免审批；write 撞同名拒绝，不覆盖）；' +
    '结论被推翻时不删，头里加 status: superseded 与 by: <接替的 note 名>，从此不进索引。\n' +
    '所有 note 操作可加 --type general|lesson|principle|goal；list/search 默认跨类型，write 默认 general。' +
    'lesson 正文五个 ## 节：症状、当时怎么误判的、根因、修法、怎么验证的；principle：判断、适用边界、依据（默认 candidate，核实认可后改 active）；' +
    'goal：这件事是什么、目标、当前范围与边界、怎样算达到目标；头 current: true 指定当前目标，仅一个，状态 active/paused/completed/superseded。' +
    '新文件在 notes/<type>/（general 在根）；旧目录原位兼容，不自动迁移。当前 goal 和入选原则完整常驻，其余 read 按需。\n' +
    '【技能】（点名或不确定怎么做时查用）"$SIMPLE_CODE_SKILL" list | read <name> | search <关键词>。' +
    '改项目级 SKILL.md 走 "$SIMPLE_CODE_APPLY_PATCH"（免审批）；用户级在 ~/.simple-code，写走 bash 审批。',
  parameters: {
    type: 'object',
    properties: {
      // desc 排在 command 前（2026-09-28 拍板）：模型大体按 schema 顺序
      // 生成参数，desc 先流出来，webview 就能在长命令还在生成时先显示标题
      // （webview/events.ts 的 tool_input_delta 分支）
      desc: {
        type: 'string',
        description:
          '4-10 字短语说明这条命令在干什么（如「跑全量测试」「迁移 mcp 配置」），' +
          'UI 标题位展示用。只写短语，不写句子。先于 command 写。',
      },
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: {
        type: 'number',
        description:
          `超时秒数，默认 ${Math.round(config.defaultTimeoutMs / 1000)}，最大 ${Math.round(config.maxTimeoutMs / 1000)}。` +
          '超时**不会杀掉命令**：自动转入后台，' +
          '输出继续写进日志文件，返回里带 pid 和日志路径——稍后 tail 回访进展、' +
          '判定卡死就 kill。长任务（全量测试、构建）可放心直接跑',
      },
    },
    // desc 标必填（2026-09-28 拍板）：可选时模型把它当建议，历史里没人填
    // 的项目就一直不填（另两个项目分别 0 条 vs 本项目 34/35）。parseArgs
    // 不因缺 desc 拒绝执行——漏填就是少个标题，不值得让模型白跑一轮重试；
    // 漏了在结果末尾提醒一句（见 MISSING_DESC）
    required: ['desc', 'command'],
  },
})

/** desc 只给后台进程条当行标签用（bg.ts）；执行本身不看它 */
type Args = { command: string; timeoutMs: number; desc?: string }

/**
 * 漏 desc 时追加在结果末尾（2026-09-29 用户拍板方案 B）。schema 必填挡不住
 * glm-5.3：9-28 改必填后某项目 0/554、另一项目当天 0/247，
 * opus 483/483。漏的根子是模仿——历史里满是不带 desc 的调用（含它自己刚写
 * 的），模型照抄。提醒留在上下文里才打得断这个循环；照常执行不白跑，
 * 纠正过来就不再出现，一次约 30 token
 */
export const MISSING_DESC =
  '\n[提醒] 这次调用漏了必填参数 desc（4-10 字短语说明命令在干什么，先于 command 写，界面标题位靠它）——后续 bash 调用请带上。'

/** description 同样算数：glm 照官方 Bash 工具的参数名写 description（9-28 起
 * 另两个项目 358/388 次），内容是填了的，只是
 * 键名不同——提醒「漏了 desc」它看不懂，164 次提醒 0 次改正 */
function hasDesc(input: unknown): boolean {
  const { desc, description } = input as Record<string, unknown>
  return [desc, description].some((d) => typeof d === 'string' && d.trim() !== '')
}

export function createBashTool(config: BashConfig, env: NodeJS.ProcessEnv = {}): Tool {
  return {
    name: 'bash',
    definition: definitionOf(config, env),
    async execute(input, ctx): Promise<ToolOutput> {
      const parsed = parseArgs(input, config)
      if (typeof parsed === 'string') {
        // 参数错误也是正常返回。写成模型读得懂的散文而不是校验器堆栈：
        // 前者模型会重新组织参数再试，后者通常只会重复同样的错（CLAUDE.md §4.2）
        return { output: parsed, exitCode: -1, isError: true }
      }
      const out = (await checkApproval(parsed, config, ctx)) ?? (await run(parsed, config, ctx))
      return hasDesc(input) ? out : { ...out, output: out.output + MISSING_DESC }
    },
  }
}

// ---------------------------------------------------------------- 审批

/** 审批闸门（approval.md §4.1）。没有 requestApproval 就连判定都不跑——
 * 注入审批是宿主的责任，core 的默认行为是不设防。返回非 null = 拦下 */
async function checkApproval(
  args: Args,
  config: BashConfig,
  ctx: ToolContext,
): Promise<ToolOutput | null> {
  if (!ctx.requestApproval) return null
  // always 白名单每条命令读一次盘：判定要拿它（allow 路径也走这），
  // 文件几十字节，频率可忽略
  const always = loadAlways(ctx.root)
  // 审批配置的三源组装（2026-09-27 拍板：settings 里不再出现 approval，
  // 只住用户级 ~/.simple-code/approval.json + 项目级 .simple-code/
  // approval.json 两个文件）：内置默认 ← 用户级（手写）← 项目级（手写
  // + 卡上采集）。例外面（askCommands）取并集
  // ——加是日常，减是拍板级变更，删行或卡上不点即是（命令维不给
  // always 键，2026-11-05 拍板）；nonPathFrom 同键项目级覆盖——卡上后
  // 拍的板是新决定，新决定盖旧的
  const user = loadUserApproval()
  const verdict = classify(args.command, ctx.root, {
    // askCommands 两级文件并集（内置默认已清空，2026-11-04 拍板）：
    // 需要拦什么用户自己配
    askCommands: [...new Set([...user.askCommands, ...(always.askCommands ?? [])])],
    // denyCommands（2026-11-04）：两级文件并集，命中直接拒（不弹卡）
    denyCommands: [...new Set([...user.denyCommands, ...(always.denyCommands ?? [])])],
    nonPathFrom: { ...user.nonPathFrom, ...always.nonPathFrom },
    alwaysPaths: always.paths,
    // 第 2 层算真实路径：$VAR 按 spawn 的同一份环境替换，相对路径从 root 起算
    env: spawnEnv(config, ctx),
    // 算不出的路径放行记日志（2026-11-04 拍板：不弹卡——冷启动窗口的
    // 代入失效、运行时值都落这里；带 folder 供回放分析）
    onUnparsed: (token, reason) => {
      try {
        appendFileSync(
          join(homedir(), '.simple-code/logs/approval-unparsed.jsonl'),
          `${JSON.stringify({ ts: new Date().toISOString(), folder: ctx.root, token, reason })}\n`,
        )
      } catch {
        /* 日志写不进去不拦放行 */
      }
    },
  })
  if (verdict.kind === 'allow') return null

  // 禁令档（v2 §2.2，2026-11-04）：memory 写、sudo——不弹卡直接拒绝。
  // 与「用户拒绝了这条命令」同形态的工具错误，模型读 reason 后自行调整
  if (verdict.kind === 'deny') {
    return {
      output: `命令被禁用：${verdict.reason}。如果任务确实需要这个操作，向用户说明需要做什么；不要换写法绕过禁令。`,
      exitCode: -1,
      isError: true,
    }
  }

  // always 预览：项目外
  // 路径记目录（dirHint 算：目录记本身、文件记父目录，过宽不给）；
  // multi 同质 external_dir 记一组目录（方案 1，approval.ts 算好带来）
  const alwaysHint =
    verdict.kind === 'ask'
      ? verdict.nonPathFrom !== undefined
        ? { kind: 'nonpath' as const, ...verdict.nonPathFrom }
        : verdict.alwaysPaths !== undefined
          ? {
              kind: 'paths' as const,
              dirs: verdict.alwaysPaths ?? [],
            }
          : verdict.category === 'external_dir'
            ? (() => {
                const dir = dirHint(verdict.detail)
                return dir === null ? undefined : { kind: 'path' as const, dir }
              })()
            : undefined
      : undefined

  // 中断兜底：宿主收到 abort 应自行 resolve 'deny'，但没做的话这里
  // race 一层，审批等待不至于变成「中断后还挂着」
  const aborted = new Promise<'deny'>((res) => {
    ctx.signal.addEventListener('abort', () => res('deny'), { once: true })
  })
  const decision = await Promise.race([
    ctx.requestApproval({
      command: args.command,
      toolCallId: ctx.toolCallId ?? '',
      category: verdict.category,
      detail: verdict.detail,
      reason: verdict.reason,
      ...(verdict.parts ? { parts: verdict.parts } : {}),
      ...(alwaysHint ? { always: alwaysHint } : {}),
    }),
    aborted,
  ])
  // always = 本次放行 + 落盘（下次起免审）。落盘失败不拦本次执行——
  // 白名单只是减烦机制，不该反过来阻塞干活
  if (decision === 'always' && alwaysHint) {
    try {
      if (alwaysHint.kind === 'nonpath')
        appendNonPathFrom(ctx.root, alwaysHint.lead, alwaysHint.from)
      else if ('dir' in alwaysHint) appendPath(ctx.root, alwaysHint.dir)
      else for (const d of alwaysHint.dirs) appendPath(ctx.root, d)
    } catch (err) {
      process.stderr.write(
        `approval.json 写入失败（本次仍放行）：${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
  // { deny: '...' }、裸 'deny'、'timeout' 同走拒绝，前者带用户的话
  if (decision === 'allow' || decision === 'always') return null
  const feedback = typeof decision === 'object' ? decision.deny.trim() : ''
  const note = ctx.signal.aborted
    ? '等待审批时被用户中断'
    : decision === 'timeout'
      ? '当前无人处理审批，不是用户拒绝'
      : '用户拒绝了这条命令'
  return {
    output:
      `审批被拒绝：${verdict.reason}。${note}。` +
      (feedback ? `用户反馈：${feedback}。` : '') +
      '如果任务确实需要这个操作，向用户说明需要做什么；不要换写法绕过审批。',
    exitCode: -1,
    isError: true,
  }
}

// ---------------------------------------------------------------- 参数

/** 返回字符串表示校验失败，内容就是给模型看的话 */
function parseArgs(input: unknown, config: BashConfig): Args | string {
  if (typeof input !== 'object' || input === null) {
    return '参数需要是一个对象，至少包含 command 字段。请重新组织参数后再试。'
  }
  const raw = input as Record<string, unknown>

  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    return '参数 command 需要是一个非空字符串，内容为要执行的 shell 命令。请重新组织参数后再试。'
  }

  // cwd 参数已移除（2026-10-15 拍板）：与命令里的 cd 是两套平行机制，
  // 语义一致要靠人肉维护（94cf55e 就是两者的漂移）。响亮拒绝而不是
  // 静默忽略——静默会让命令在工作区根执行，写错地方不报错
  if (raw.cwd !== undefined) {
    return (
      '参数 cwd 已移除：每条命令都是独立进程，cd 不会跨调用生效，' +
      '需要换目录就在 command 里写 cd <路径> && …。请重新组织参数后再试。'
    )
  }

  if (raw.timeout !== undefined && (typeof raw.timeout !== 'number' || !(raw.timeout > 0))) {
    return '参数 timeout 需要是一个正数，单位为秒。请重新组织参数后再试。'
  }
  const timeoutMs = raw.timeout
    ? Math.min(raw.timeout * 1000, config.maxTimeoutMs)
    : config.defaultTimeoutMs

  // 与 hasDesc 同口径：glm 把 desc 写成 description 键，内容一样算数
  const desc = [raw.desc, raw.description].find(
    (d): d is string => typeof d === 'string' && d.trim() !== '',
  )
  return { command: raw.command, timeoutMs, ...(desc === undefined ? {} : { desc }) }
}

// ---------------------------------------------------------------- 执行

type Outcome = { exitCode: number; note: string }

function run(args: Args, config: BashConfig, ctx: ToolContext): Promise<ToolOutput> {
  return new Promise((resolveOutput) => {
    // `exec 2>&1` 在 **fd 层**把 stderr 并进 stdout，必须这样做才能保住时序。
    // 在 Node 侧把 child.stdout 和 child.stderr 两个流拼起来是不行的：那是两条
    // 独立的 pipe，事件投递顺序和写入顺序无关。实测 `echo a; echo b>&2; echo c`
    // 稳定得到 a c b——错得很安静，看起来只是"偶尔顺序怪怪的"
    // 子 agent 权限上限（t6100 拍板「逐级只减不增」）：起子进程的这一层
    // 把自己的审批范围（root ∪ approval.json 的 alwaysPaths）写进环境，
    // 子 sc 启动时校验 --root 必须落在其中——父 agent 借 sc 把自己的
    // 审批范围扩大一圈（直接干会弹卡、借 sc 静默放行）的路在这里堵死。
    // 不走 envPassthrough：这值必须是本层的事实，从更外层继承来的值
    // 在这里被覆盖——每过一个 agent 层就收窄一次
    // 后台进程条的一行（bg.ts）：标签 desc、agent 写的原命令、开始时刻
    const bgMeta: BgMeta = {
      command: args.command,
      startedAt: Date.now(),
      ...(args.desc === undefined ? {} : { desc: args.desc }),
    }
    const spawnBash = () =>
      spawn('bash', ['-c', `exec 2>&1\n${args.command}`], {
        cwd: ctx.root,
        // 独立进程组。少了它 kill 只能杀掉 bash 自己，它派生的子进程会变成孤儿
        // 继续跑
        detached: true,
        env: spawnEnv(config, ctx),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    let child: ReturnType<typeof spawnBash>
    try {
      child = spawnBash()
    } catch (err) {
      // spawn 同步 throw（macOS 下偶发的 fd 失效，南夷非 7 天日志 70 次
      // spawn EBADF）：child.on('error') 接不到同步 throw，契约上「工具
      // 永不抛」（run.ts 工具调用只有 finally 没有 catch）——不接住就炸穿
      // 整轮 turn。瞬态故障，返回工具错误让模型自己重试（实测 51 秒后
      // 同进程同命令即成功），与下方 child.on('error') 的文案同一口径
      resolveOutput({
        output: `[命令无法启动：${err instanceof Error ? err.message : String(err)}]
这是瞬态故障，通常重试同一命令即可恢复。`,
        exitCode: -1,
        isError: true,
      })
      return
    }

    let output = ''
    const collect = (chunk: Buffer) => {
      // 非 UTF-8 用替换字符而不是抛——bash 输出二进制垃圾是常事
      const text = chunk.toString('utf8')
      output += text
      ctx.onRawOutput?.(text)
    }
    child.stdout.on('data', collect)
    // stderr 此时应该是空的（已在 fd 层重定向），但 bash 自身启动失败的报错
    // 会走这里，仍要收
    child.stderr.on('data', collect)

    const finish = (outcome: Outcome) => {
      cleanup()
      const body = truncateOutput(output, config.maxOutputChars, ctx.rawPath)
      resolveOutput({
        output: body + outcome.note || '(命令没有任何输出)',
        exitCode: outcome.exitCode,
        isError: outcome.exitCode !== 0,
      })
    }

    // 转后台：不杀（2026-09-08 拍板，取代「超时即杀」）。同步等待的价值
    // 归零的那一刻——超时，或用户插话要插队（2026-09-21）——进程多半仍有
    // 产出：构建慢、测试多、或卡在外部依赖上。输出接进日志文件、pid 交给
    // 登记簿，控制权还给调用方：稍后 tail 看进展还是判定卡死 kill 掉，
    // 都是 agent 的决策
    let detached = false
    const toBackground = (headline: string) => {
      detached = true
      const pid = child.pid ?? -1
      const logPath = join(tmpdir(), `sc-bg-${pid}.log`)
      let stream: ReturnType<typeof createWriteStream> | null = null
      try {
        stream = createWriteStream(logPath, { flags: 'w' })
        // 超时前已收的输出一并落盘——回访时 tail 一次看全，不用翻历史
        stream.write(output)
      } catch {
        stream = null // 磁盘满之类：接不了就不接，进程照跑
      }
      const intoFile = (chunk: Buffer): void => {
        stream?.write(chunk)
      }
      child.stdout.removeAllListeners('data')
      child.stdout.on('data', intoFile)
      child.stderr.removeAllListeners('data')
      child.stderr.on('data', intoFile)
      child.on('close', () => stream?.end())
      ctx.bg?.register(pid, { ...bgMeta, logPath })
      // 组长（这个 bash）随时可能先于组员退出——`... & echo; sleep; curl`
      // 跑完就走，nohup 起的服务被 init 收养继续跑（t886 实测 mvn 占着
      // 8081，UI 上却空空如也）。转后台这一刻先扫一次组，组长之后再死
      // 也有组员顶着；不 await——转后台的返回不该等一次 ps
      void ctx.bg?.collect(pid, bgMeta)
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      ctx.interjectSignal?.removeEventListener('abort', onInterject)
      resolveOutput({
        output:
          `${headline}，已转入后台继续运行，输出没有丢：\n` +
          `  进程组 pid  ${pid}\n  日志       ${logPath}\n` +
          `稍后回访进展：tail -30 '${logPath}'；判定卡死或不再需要：kill ${pid}（输入框上方的残留进程列表也能终止）。` +
          `超时前已有的输出：\n${truncateOutput(output, config.maxOutputChars, ctx.rawPath)}`,
        exitCode: -1,
        // 转后台是正常流不是失败——模型该做的是稍后回访，不是当错误善后
        isError: false,
      })
    }
    const timer = setTimeout(
      () => toBackground(`命令超过 ${Math.round(args.timeoutMs / 1000)} 秒未结束`),
      args.timeoutMs,
    )

    // 插话软中断：用户的消息排在队首等下轮迭代投递，别让一条长命令把
    // 它扣住——立刻转后台（不杀，进程照跑），问题先进上下文
    const onInterject = () => toBackground('用户插话（有新输入要处理）')
    ctx.interjectSignal?.addEventListener('abort', onInterject, { once: true })

    const onAbort = () => {
      if (detached) return // 已转后台的进程不属于本次调用，留给后续轮次/用户
      killGroup(child.pid, config.killGraceMs)
      finish({ exitCode: -1, note: '\n[用户中断，命令已终止]' })
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    // 所有退出路径收口到这里，清理只写一遍（CLAUDE.md §4.5）
    function cleanup() {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      ctx.interjectSignal?.removeEventListener('abort', onInterject)
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
    }

    child.on('error', (e) => {
      // spawn 本身失败（bash 不存在、cwd 不存在）。抛出去会打断 loop
      finish({ exitCode: -1, note: `\n[命令无法启动：${e.message}]` })
    })

    child.on('close', (code, signal) => {
      if (ctx.signal.aborted) return // onAbort 已经收过尾
      if (detached) {
        // 转后台后组长退出：流收尾挂在 detach 里，这里不 finish——但要把
        // 登记簿里那条死掉的组长换成还活着的组员（t886），否则 UI 上整条
        // 记录消失、用户看不到也关不掉真正还在跑的进程
        void ctx.bg?.reap()
        return
      }
      // 后台残留登记：只在命令文本含 `&` 时做——留孤儿的命令几乎必含 &，
      // 而每条命令都跑一次 ps（几十 ms）不值得。close 路径才有意义：超时/
      // 中断已 killGroup，组里不会有活口
      const outcome = {
        exitCode: code ?? -1,
        note: signal ? `\n[命令被信号 ${signal} 终止]` : '',
      }
      const noteBg =
        ctx.bg && args.command.includes('&') ? ctx.bg.collect(child.pid!, bgMeta) : undefined
      // collect 不 reject（ps 失败内部吞掉），但 finally 保险；undefined 分支
      // 必须直落 finish——可选链漏掉它的话前台命令永远不 resolve（测试抓的）
      if (noteBg) noteBg.finally(() => finish(outcome))
      else finish(outcome)
    })
  })
}

/**
 * 杀整个进程组，不是只杀直接子进程。
 *
 * 负号 pid 表示进程组。先 SIGTERM 给清理机会，宽限期后 SIGKILL 强杀。
 * 两次 kill 都可能因为进程已退出而抛 ESRCH，忽略即可。
 */
function killGroup(pid: number | undefined, graceMs: number): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return // 已经没了
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 已经退出了
    }
  }, graceMs)
  // 宽限期不该拖住进程退出
  timer.unref()
}

/**
 * 白名单构造 env，不继承父进程。
 *
 * 默认 spawn 会把全部环境变量传给 bash，其中包含 API key——agent 一句 `env`
 * 就能看到，并且可以把它写进任何地方（§12）。
 */
function buildEnv(passthrough: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of passthrough) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** bash 子进程的环境。审批判定用同一份替换 $VAR（real-path.ts），
 * 两边必须一致——判定时替换出的路径就是执行时的路径 */
function spawnEnv(config: BashConfig, ctx: ToolContext): Record<string, string> {
  return {
    ...buildEnv(config.envPassthrough),
    SIMPLE_CODE_ROOTS: JSON.stringify([ctx.root, ...loadAlways(ctx.root).paths]),
    // 记忆库实际位置：分身任务的 $SIMPLE_CODE_MEMORY 靠它查自己的库
    // （cwd 冒泡会找到主干的——分身 cwd 就是主 folder）
    SIMPLE_CODE_MEMORY_DIR: ctx.memoryRoot ?? ctx.root,
    // 本会话是谁：memory search 只给它看已合回段与它自己的轮；
    // $SIMPLE_CODE_TASK 派任务时记作父任务（task-trunk 规则 11/12）
    ...(ctx.owner !== undefined ? { SIMPLE_CODE_OWNER: ctx.owner } : {}),
  }
}
