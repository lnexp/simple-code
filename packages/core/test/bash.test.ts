import { execFile, spawn as spawnRaw } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BashConfig, MISSING_DESC, createBashTool } from '../src/tools/bash.ts'
import { bashConfig } from '../src/config/schema.ts'
import { BgRegistry } from '../src/tools/bg.ts'

// schema 默认白名单（envPassthrough 不写时的值）。从 schema 现取而不是
// 在测试里抄一份——抄的会随默认值漂移，测的还是旧列表
const defaultPassthrough = (): string[] => bashConfig.shape.envPassthrough.parse(undefined)
import type { ToolContext } from '../src/tools/types.ts'

const config: BashConfig = {
  defaultTimeoutMs: 5000,
  maxTimeoutMs: 10_000,
  maxOutputChars: 16_000,
  killGraceMs: 200,
  envPassthrough: ['PATH', 'HOME'],
}

const bash = createBashTool(config)
const bgRegistry = new BgRegistry()
let root = ''

beforeAll(async () => {
  // macOS 上 /tmp 是 /private/tmp 的符号链接，比对路径时要用解析后的
  root = await mkdtemp(join(tmpdir(), 'simple-code-bash-'))
})
afterAll(() => rm(root, { recursive: true, force: true }))

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  root,
  signal: new AbortController().signal,
  bg: bgRegistry,
  ...over,
})

/** 默认带上 desc：多数用例比对精确输出，漏 desc 的提醒尾巴会搅进来。
 * 测漏 desc 的用例直接调 bash.execute */
const run = (input: unknown, over: Partial<ToolContext> = {}) =>
  bash.execute(
    typeof input === 'object' && input !== null && !('desc' in input) ? { desc: '测试', ...input } : input,
    ctx(over),
  )

describe('bash / 基本执行', () => {
  it('回传输出与退出码', async () => {
    const r = await run({ command: 'echo hello' })
    expect(r).toEqual({ output: 'hello\n', exitCode: 0, isError: false })
  })

  it('非 0 退出是 isError，但不抛异常', async () => {
    const r = await run({ command: 'exit 3' })
    expect(r.exitCode).toBe(3)
    expect(r.isError).toBe(true)
  })

  it('stdout 与 stderr 合并且保时序', async () => {
    const r = await run({ command: 'echo a; echo b >&2; echo c; echo d >&2; echo e' })
    expect(r.output).toBe('a\nb\nc\nd\ne\n')
  })

  it('对照组：在 Node 侧拼接两条 pipe 拿不到正确时序', async () => {
    // 这条不测我们的代码，测的是「为什么必须在 fd 层合并」。没有它，
    // 上一条测试通过时无法判断是实现对了还是碰巧
    const naive = await new Promise<string>((res) => {
      const child = spawnRaw('bash', ['-c', 'echo a; echo b >&2; echo c; echo d >&2; echo e'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout?.on('data', (b: Buffer) => {
        out += b.toString()
      })
      child.stderr?.on('data', (b: Buffer) => {
        out += b.toString()
      })
      child.on('close', () => res(out))
    })
    expect(naive).not.toBe('a\nb\nc\nd\ne\n')
  })

  it('cwd 相对工作区根解析', async () => {
    await execFileAsync('mkdir', ['-p', join(root, 'sub')])
    const r = await run({ command: 'pwd -P', cwd: 'sub' })
    expect(r.output.trim()).toBe(await realpath(join(root, 'sub')))
  })

  it('默认在工作区根执行', async () => {
    const r = await run({ command: 'pwd -P' })
    expect(r.output.trim()).toBe(await realpath(root))
  })

  it('cwd 不存在时不抛，返回可读的失败', async () => {
    const r = await run({ command: 'echo x', cwd: 'nope' })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('无法启动')
  })

  it('无输出时也给模型一句话，不返回空串', async () => {
    const r = await run({ command: 'true' })
    expect(r.output).toBe('(命令没有任何输出)')
  })

  it('非 UTF-8 输出不抛，坏字节替换成占位符', async () => {
    const r = await run({ command: 'printf "\\xff\\xfe"' })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('�')
  })
})

describe('bash / 参数校验', () => {
  const invalid = [
    ['不是对象', 'null'],
    ['缺 command', {}],
    ['command 不是字符串', { command: 123 }],
    ['command 是空串', { command: '   ' }],
    ['cwd 不是字符串', { command: 'true', cwd: 1 }],
    ['timeout 不是正数', { command: 'true', timeout: -1 }],
  ] as const

  for (const [name, input] of invalid) {
    it(`${name} → isError，且消息是给模型看的散文`, async () => {
      const r = await run(input === 'null' ? null : input)
      expect(r.isError).toBe(true)
      expect(r.exitCode).toBe(-1)
      // 关键不是「有错误消息」，是消息得让模型知道该怎么改（CLAUDE.md §4.2）
      expect(r.output).toMatch(/请重新组织参数后再试/)
      expect(r.output).not.toMatch(/Error:|at .*\.ts:\d+/)
    })
  }

  it('校验失败不会真的执行命令', async () => {
    const marker = join(root, 'should-not-exist')
    await run({ command: `touch ${marker}`, cwd: 42 })
    await expect(readFile(marker)).rejects.toThrow()
  })

  it('desc 在 schema 里必填，执行层不因缺 desc 拒绝，但结果末尾提醒补上（2026-09-29 方案 B）', async () => {
    const bash = createBashTool(config)
    expect((bash.definition.parameters as { required: string[] }).required).toEqual(['desc', 'command'])
    const r = await bash.execute({ command: 'echo ok' }, ctx())
    expect(r.isError).toBe(false)
    expect(r.output).toBe(`ok\n${MISSING_DESC}`)
    // 空白 desc 等于没写
    expect((await bash.execute({ command: 'echo ok', desc: '  ' }, ctx())).output).toContain(MISSING_DESC)
    // 带了就不提醒（对照组）
    expect((await bash.execute({ command: 'echo ok', desc: '回显' }, ctx())).output).toBe('ok\n')
  })

  it('写成 description（glm 照官方 Bash 工具参数名，真实项目入参）算带了，不提醒', async () => {
    const bash = createBashTool(config)
    const r = await bash.execute({ command: 'echo ok', description: '定位 writeChunk 所在测试文件', timeout: 15 }, ctx())
    expect(r.output).toBe('ok\n')
    // 空白 description 同样等于没写
    expect((await bash.execute({ command: 'echo ok', description: ' ' }, ctx())).output).toContain(MISSING_DESC)
  })

  it('审批被拒的结果也带提醒——模型下一条照样要写 desc', async () => {
    const r = await bash.execute(
      { command: 'curl https://example.com' },
      ctx({ requestApproval: async () => 'deny' }),
    )
    expect(r.isError).toBe(true)
    expect(r.output).toContain('拒绝')
    expect(r.output.endsWith(MISSING_DESC)).toBe(true)
  })
})

describe('bash / 超时与中断', () => {
  it('超时转后台：进程不死、输出接文件、返回里带 pid 和日志路径', async () => {
    const start = Date.now()
    const r = await run({ command: 'echo before; sleep 30', timeout: 0.4 })
    expect(Date.now() - start).toBeLessThan(5000)
    expect(r.isError).toBe(false) // 正常流：该做的是稍后回访，不是当错误善后
    expect(r.output).toContain('转入后台')
    expect(r.output).toContain('before') // 超时前的输出要保留
    const pid = Number(r.output.match(/pid\s+(\d+)/)?.[1])
    const logPath = r.output.match(/日志\s+(\S+)/)?.[1]
    expect(pid).toBeGreaterThan(1)
    expect(logPath).toMatch(/sc-bg-\d+\.log$/)
    // 进程还活着（转后台没杀）；登记簿里有它
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(bgRegistry.snapshot().some((p) => p.pid === pid)).toBe(true)
    expect(bgRegistry.snapshot().find((p) => p.pid === pid)?.logPath).toBe(logPath)
    // 超时后的输出继续落进日志文件
    expect(logPath).toBeDefined()
    await run({ command: `echo after >> ${logPath}` })
    const tail = await readFile(logPath ?? '', 'utf8')
    expect(tail).toContain('before')
    expect(tail).toContain('after')
    process.kill(pid, 'SIGKILL') // 收尾
  })

  it('插话软中断：不等超时，命令立刻转后台、进程不死、问题不被扣住', async () => {
    // 排队插话在 runLoop 迭代顶投递，但工具执行中（这里 sleep 30）用户的
    // 问题原本要等它跑完——插话信号让 bash 立刻走转后台路径（2026-09-21）
    const c = new AbortController()
    const start = Date.now()
    const p = run({ command: 'echo before; sleep 30', timeout: 60 }, { interjectSignal: c.signal })
    await new Promise((r) => setTimeout(r, 300)) // 让它真正进入执行中
    c.abort()
    const r = await p
    // 立刻返回（不是等 60 秒超时），走的是转后台文案
    expect(Date.now() - start).toBeLessThan(5_000)
    expect(r.output).toContain('插话')
    expect(r.output).toContain('转入后台')
    expect(r.output).toContain('before') // 转后台前的输出要保留
    const pid = Number(r.output.match(/pid\s+(\d+)/)?.[1])
    const logPath = r.output.match(/日志\s+(\S+)/)?.[1]
    expect(pid).toBeGreaterThan(1)
    expect(logPath).toMatch(/sc-bg-\d+\.log$/)
    // 进程还活着；登记簿里有它
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(bgRegistry.snapshot().some((x) => x.pid === pid)).toBe(true)
    process.kill(pid, 'SIGKILL') // 收尾
  })

  it('插话转后台后再中断（stop）不杀它——后台进程不随会话中断而死', async () => {
    const c = new AbortController()
    const stop = new AbortController()
    const p = run(
      { command: 'echo before; sleep 30', timeout: 60 },
      { interjectSignal: c.signal, signal: stop.signal },
    )
    await new Promise((r) => setTimeout(r, 300))
    c.abort() // 先插话转后台
    await p
    stop.abort() // 再模拟用户 stop：detached 后不应杀组
    await new Promise((r) => setTimeout(r, 300))
    // 上一个用例的进程已杀，这里从登记簿找本条的 pid
    const alive = bgRegistry.snapshot().filter((x) => /sleep/.test(x.command))
    expect(alive.length).toBeGreaterThan(0)
    for (const x of alive) process.kill(x.pid, 'SIGKILL') // 收尾
  })

  // t886 真机 bug：`... mvn ... & echo; sleep 55; curl` 转后台后，外层 bash
  // 跑完就退出、mvn 被 init 收养继续占着 8081，而登记簿按组长 pid 探活判它
  // 已死 → UI 上整条记录消失，用户看不到也关不掉
  it('**组长先退出、组员还在跑**：登记簿换成组员，不整条消失', async () => {
    const r = await run({
      // 形状照抄真机：后台起长命令，外层 shell 自己很快就结束
      command: 'nohup sleep 30 > /dev/null 2>&1 & echo started; sleep 20',
      timeout: 0.4,
    })
    const leader = Number(r.output.match(/pid\s+(\d+)/)?.[1])
    expect(bgRegistry.snapshot().some((p) => p.pid === leader)).toBe(true)

    // 等组长自己退出（sleep 20 还没完就被 kill，模拟组长先走）
    process.kill(leader, 'SIGTERM')
    await new Promise((r2) => setTimeout(r2, 500))
    await bgRegistry.reap()
    // 覆盖第二道防线：把组员那条也抹掉，只留死掉的组长——模拟「转后台那一刻
    // 组员还没起来（mvn 启动要几十秒），collect 扫了个空」。这时只有 reap
    // 按 pgid 重扫才能把它找回来；缺了 reap 这里就会是空列表
    bgRegistry.forget((pid) => pid !== leader)
    expect(bgRegistry.snapshot().length).toBe(0)
    bgRegistry.register(leader, 'nohup sleep 30 & ...')
    await bgRegistry.reap()

    const alive = bgRegistry.snapshot()
    // 组长没了，但 nohup 那个还在——列表不能空
    expect(alive.some((p) => p.pid === leader)).toBe(false)
    expect(alive.length).toBeGreaterThan(0)
    expect(alive.some((p) => p.command.includes('sleep 30'))).toBe(true)
    for (const p of alive) process.kill(p.pid, 'SIGKILL')
  })

  it('timeout 参数被 maxTimeoutMs 夹住（夹住后同样转后台而不是干等）', async () => {
    const start = Date.now()
    // 请求 9999 秒，但配置上限是 10 秒——这里只验证不会真的等 9999 秒
    const r = await run({ command: 'sleep 30', timeout: 9999 })
    expect(Date.now() - start).toBeLessThan(15_000)
    expect(r.output).toContain('转入后台')
    const pid = Number(r.output.match(/pid\s+(\d+)/)?.[1])
    process.kill(pid, 'SIGKILL') // 收尾
  }, 20_000)

  it('中断时立即返回并标注', async () => {
    const ac = new AbortController()
    const promise = run({ command: 'sleep 30' }, { signal: ac.signal })
    await delay(200)
    ac.abort()

    const r = await promise
    expect(r.isError).toBe(true)
    expect(r.output).toContain('用户中断')
  })

  it('转后台后的进程不随会话中断而死', async () => {
    const ac = new AbortController()
    const r = await run({ command: 'sleep 30', timeout: 0.3 }, { signal: ac.signal })
    const pid = Number(r.output.match(/pid\s+(\d+)/)?.[1])
    ac.abort() // 转后台之后才中断——进程是留给后续轮次/用户的
    await delay(100)
    expect(() => process.kill(pid, 0)).not.toThrow()
    process.kill(pid, 'SIGKILL') // 收尾
  })

  it('杀的是整个进程组，不留孤儿', async () => {
    // bash 派生一个后台子进程并把它的 pid 写进文件。只杀 bash 的话，
    // 这个子进程会活下来继续跑——这正是 detached + kill(-pid) 要防的
    const pidFile = join(root, 'child.pid')
    const marker = join(root, 'orphan.txt')
    const ac = new AbortController()

    const promise = run(
      { command: `(sleep 5; echo alive > ${marker}) & echo $! > ${pidFile}; wait` },
      { signal: ac.signal },
    )
    await delay(400)

    const childPid = Number((await readFile(pidFile, 'utf8')).trim())
    // 前提断言：这个后台进程此刻确实活着。它要是本来就没起来，
    // 后面的「已经死了」就什么也证明不了
    expect(isAlive(childPid)).toBe(true)

    ac.abort()
    await promise
    await delay(400)

    expect(isAlive(childPid)).toBe(false)
    await expect(readFile(marker)).rejects.toThrow() // 没跑完
  }, 15_000)
})

describe('bash / 环境变量白名单', () => {
  it('白名单外的变量传不进去——API key 不能被 env 看到', async () => {
    process.env.SIMPLE_CODE_TEST_SECRET = 'sk-must-not-leak'
    try {
      // 前提断言：这个变量在父进程里确实存在。不然「子进程看不到」
      // 只是因为它压根不存在，测了个空集合
      expect(process.env.SIMPLE_CODE_TEST_SECRET).toBe('sk-must-not-leak')

      const r = await run({ command: 'env' })
      expect(r.output).not.toContain('sk-must-not-leak')
      expect(r.output).not.toContain('SIMPLE_CODE_TEST_SECRET')

      // 对照组：白名单内的确实传进去了。两条都过才说明是白名单在起作用，
      // 而不是 env 根本没传任何东西
      expect(r.output).toContain('PATH=')
    } finally {
      process.env.SIMPLE_CODE_TEST_SECRET = undefined
    }
  })

  it('SIMPLE_CODE_WEBFETCH/SEARCH 在白名单里——宿主注入的网络 bin 路径能透传', async () => {
    // web-tools §10：模型在 bash 里靠这两个变量调网络工具。宿主（vscode
    // activate / cli main）负责注入；这里验证白名单确实放行
    process.env.SIMPLE_CODE_WEBFETCH = '/opt/bin/webfetch.js'
    try {
      expect(process.env.SIMPLE_CODE_WEBFETCH).toBe('/opt/bin/webfetch.js')
      // 顶部 fixture 的白名单是显式两项；这里用 schema 默认值建实例，
      // 测的是「默认白名单放行」而不是 fixture 的手写列表
      const withDefaults = createBashTool({ ...config, envPassthrough: defaultPassthrough() })
      const r = await withDefaults.execute({ command: 'env' }, ctx())
      expect(r.output).toContain('SIMPLE_CODE_WEBFETCH=/opt/bin/webfetch.js')
    } finally {
      process.env.SIMPLE_CODE_TEST_SECRET = undefined
    }
  })

  it('白名单里没有的名字不会凭空造出空变量', async () => {
    const tool = createBashTool({ ...config, envPassthrough: ['PATH', 'DEFINITELY_NOT_SET_XYZ'] })
    const r = await tool.execute({ command: 'env' }, ctx())
    expect(r.output).not.toContain('DEFINITELY_NOT_SET_XYZ')
  })

  it('SIMPLE_CODE_ROOTS 注入本层审批范围（root ∪ alwaysPaths），外层继承值被覆盖', async () => {
    // 子 agent 权限上限（t6100「逐级只减不增」）的注入侧：每过一个
    // agent 层，子进程看到的范围就是该层的事实——从更外层继承来的
    // 旧值必须被覆盖，否则「逐级收窄」退化为「最外层说了算」
    try {
      process.env.SIMPLE_CODE_ROOTS = JSON.stringify(['/inherited/from/outer'])
      const r = await bash.execute({ desc: '测试', command: 'echo "$SIMPLE_CODE_ROOTS"' }, ctx())
      expect(JSON.parse(r.output.trim())).toEqual([root])
    } finally {
      process.env.SIMPLE_CODE_ROOTS = undefined
    }
  })
})

  it('工具描述的 LSP 句按注入条件拼：env 有桥才教 LSP（2026-09-17 拍板——描述与实际能力一致）', () => {
    const withLsp = createBashTool(config, { SIMPLE_CODE_LSP: '/x/lsp.js' })
    const without = createBashTool(config, {})
    // 分工（v2 拍板）：分流句+语言无关在 system prompt 工具约定，描述只留命令格式
    expect(withLsp.definition.description).toContain('refs <file>:<行>:<列>')
    expect(withLsp.definition.description).toContain('列须落在符号名上')
    expect(withLsp.definition.description).not.toContain('优先于 grep')
    expect(withLsp.definition.description).not.toContain('语言无关')
    // 无桥环境（终端裸跑 sc 的子 agent）：整段不出现，模型不知道 LSP 存在也就不会试
    expect(without.definition.description).not.toContain('SIMPLE_CODE_LSP')
    // 默认参数（不传 env）= 空对象 = 不拼，老调用方行为不变
    expect(bash.definition.description).not.toContain('SIMPLE_CODE_LSP')
  })

  it('note write 的格式原样写进描述：前缀 + --- 分隔（note-bin 正则要的就是这个）', () => {
    // 原描述「heredoc 四段：name/title/description/正文」没写前缀和 ---，
    // 9-17~9-30 note write 格式失败 27 次，19 次是不带 name: 的裸行
    const d = bash.definition.description
    for (const s of ['name: ', 'title: ', 'description: ', '---']) expect(d).toContain(s)
    expect(d).not.toContain('heredoc 四段')
  })

describe('bash / 输出截断', () => {
  it('超过上限时两端保留，中间标注省略量', async () => {
    const tool = createBashTool({ ...config, maxOutputChars: 200 })
    const script = join(root, 'big.sh')
    await writeFile(script, 'printf "A%.0s" $(seq 1 500); printf "Z%.0s" $(seq 1 500)\n')

    const r = await tool.execute({ desc: '测试', command: `bash ${script}` }, ctx())
    expect(r.output.length).toBeLessThanOrEqual(200)
    expect(r.output).toMatch(/^A+/) // 头保留
    expect(r.output).toMatch(/Z+$/) // 尾保留——错误信息通常在末尾
    expect(r.output).toContain('省略')
  })

  it('落盘的是完整输出，进 context 的是截断版 —— 两者确实不同', async () => {
    // design.md §9.3 三层数据的第 ①② 层。这条必须用**真 spawn**：
    // 用假工具喂 onRawOutput 只能证明"管道通着"，证明不了真实输出确实
    // 比 tool_result 长——而第 3 步的卸载全靠"原文在磁盘上"这个前提
    const tool = createBashTool({ ...config, maxOutputChars: 200 })
    const script = join(root, 'big2.sh')
    await writeFile(script, 'printf "A%.0s" $(seq 1 500); printf "Z%.0s" $(seq 1 500)\n')

    let raw = ''
    const r = await tool.execute(
      { desc: '测试', command: `bash ${script}` },
      ctx({ onRawOutput: (chunk) => (raw += chunk), rawPath: '.simple-code/memory/raw/t1.log' }),
    )

    // 前提：确实截断了。没截断的话下面两条断言都没意义
    expect(r.output.length).toBeLessThanOrEqual(200)
    // 原始输出是完整的 1000 字符，不带任何省略标记
    expect(raw).toHaveLength(1000)
    expect(raw).not.toContain('省略')
    // 而且比进 context 的那份长得多
    expect(raw.length).toBeGreaterThan(r.output.length * 4)
  })

  it('截断提示里带着 raw 文件路径 —— 不然模型不知道去哪 cat', async () => {
    // 光落盘不给路径等于白落：文件在那儿，模型不知道（design.md:512）。
    // 踩过：truncateOutput 有 rawPath 参数，但一直没人传
    const tool = createBashTool({ ...config, maxOutputChars: 200 })
    const script = join(root, 'big3.sh')
    await writeFile(script, 'printf "A%.0s" $(seq 1 1000)\n')

    const withPath = await tool.execute(
      { command: `bash ${script}` },
      ctx({ rawPath: '.simple-code/memory/raw/toolu_x9.log' }),
    )
    expect(withPath.output).toContain('.simple-code/memory/raw/toolu_x9.log')

    // 对照组：没有 rawPath 时不能凭空编一个路径出来
    const noPath = await tool.execute({ command: `bash ${script}` }, ctx())
    expect(noPath.output).toContain('省略')
    expect(noPath.output).not.toContain('.log')
  })
})

// ---------------------------------------------------------------- 小工具

const execFileAsync = promisify(execFile)
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const realpath = async (p: string) => (await execFileAsync('realpath', [p])).stdout.trim()

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // 信号 0 只探测存活，不实际发信号
    return true
  } catch {
    return false
  }
}

describe('审批 always 白名单（approval.json）', () => {
  it('config.approval 为 prefault 形态（schema 保证存在）时白名单仍生效', async () => {
    // 回归：闸门曾写成 `config.approval ?? { …alwaysLeads… }`——schema 的
    // approval 段 prefault({})，真机 config.approval 永远是对象，右边从未
    // 执行，approval.json 从未进过判定（真机批了 python3 还弹）。测试里
    // config 不带 approval 字段走的是右边，测不出来——必须显式带上
    const preflight = createBashTool({
      ...config,
    })
    const root0 = mkdtempSync(join(tmpdir(), 'sc-bash-always-prefault-'))
    try {
      // 预置白名单：模拟用户此前点过「始终允许」
      mkdirSync(join(root0, '.simple-code'), { recursive: true })
      writeFileSync(join(root0, '.simple-code', 'approval.json'), JSON.stringify({ leads: ['python3'], paths: [] }))
      let asked = 0
      const ra = () => {
        asked++
        return Promise.resolve<'deny'>('deny')
      }
      const r = await preflight.execute(
        { command: 'python3 -c "print(99)"' },
        { ...ctx({ requestApproval: ra }), root: root0 },
      )
      expect(asked).toBe(0) // 白名单进了 cfg，不问
      expect(r.output).toContain('99')
    } finally {
      rmSync(root0, { recursive: true, force: true })
    }
  })

  it('lead 命中免审：批过 python3 后不再弹卡', async () => {
    let asked = 0
    let decision: 'allow' | 'always' | 'deny' = 'always'
    const raAlways = (q: Parameters<NonNullable<ToolContext['requestApproval']>>[0]) => {
      asked++
      void q
      return Promise.resolve(decision)
    }
    await run({ command: 'python3 -c "print(1)"' }, { requestApproval: raAlways })
    expect(asked).toBe(1) // 只问了第一次
    // 第二条 python3 命令：白名单已生效，不该再问
    decision = 'deny'
    const r = await run({ command: 'python3 -c "print(2)"' }, { requestApproval: raAlways })
    expect(asked).toBe(1) // 免问（若问了会 shift 到空 → deny → 报错）
    expect(r.isError).toBe(false)
    expect(r.output).toContain('2')
    // 卡上带 always 预览（执行器类）——UI 靠它出第三键
    // 落盘内容可读
    const data = JSON.parse(readFileSync(join(root, '.simple-code', 'approval.json'), 'utf8'))
    expect(data.leads).toContain('python3')
    // 清场：别的测试的 root 别被污染（本测试的 root 是同一个 beforeAll 的）
    rmSync(join(root, '.simple-code', 'approval.json'), { force: true })
  })

  it('隐藏路径始终允许：记读不记写，批过的读不再弹（2026-09-29）', async () => {
    writeFileSync(join(root, '.hp-probe'), 'secret-ish')
    const cards: Parameters<NonNullable<ToolContext['requestApproval']>>[0][] = []
    const ra = (q: (typeof cards)[number]) => {
      cards.push(q)
      return Promise.resolve<'always' | 'deny'>(cards.length === 1 ? 'always' : 'deny')
    }
    const r1 = await run({ command: 'cat .hp-probe' }, { requestApproval: ra })
    expect(cards[0]?.always).toEqual({ kind: 'hidden', path: '.hp-probe', write: false })
    expect(r1.output).toContain('secret-ish')
    const r2 = await run({ command: 'cat .hp-probe' }, { requestApproval: ra })
    expect(cards.length).toBe(1) // 读已批，免问
    expect(r2.output).toContain('secret-ish')
    // 写没批：照样弹（第二张卡 deny）
    const r3 = await run({ command: 'echo y > .hp-probe' }, { requestApproval: ra })
    expect(cards.length).toBe(2)
    expect(r3.isError).toBe(true)
    const data = JSON.parse(readFileSync(join(root, '.simple-code', 'approval.json'), 'utf8'))
    expect(data.hiddenRead).toEqual(['.hp-probe'])
    expect(data.hiddenWrite).toEqual([])
    rmSync(join(root, '.simple-code', 'approval.json'), { force: true })
    rmSync(join(root, '.hp-probe'), { force: true })
  })

  it('拒绝带反馈：{ deny: 话 } 的输出含用户的话，模型按它调整重试', async () => {
    const ra = (q: Parameters<NonNullable<ToolContext['requestApproval']>>[0]) => {
      void q
      return Promise.resolve<'allow' | 'always' | 'deny' | { deny: string }>({ deny: '别用 curl，用 webfetch' })
    }
    const r = await run({ command: 'curl https://example.com' }, { requestApproval: ra })
    expect(r.isError).toBe(true)
    expect(r.output).toContain('审批被拒绝')
    expect(r.output).toContain('用户反馈：别用 curl，用 webfetch')
  })

  it('裸 deny 不变：无反馈字段、输出与原来一致', async () => {
    const ra = () => Promise.resolve<'allow' | 'always' | 'deny' | { deny: string }>('deny')
    const r = await run({ command: 'curl https://example.com' }, { requestApproval: ra })
    expect(r.isError).toBe(true)
    expect(r.output).not.toContain('用户反馈')
    expect(r.output).toContain('不要换写法绕过审批')
  })

  it('路径白名单：批过外部目录后其子树免审、邻居仍弹', async () => {
    const outsideDir = join(root, '..', 'sc-always-outside')
    mkdirSync(outsideDir, { recursive: true })
    try {
      const decisions: Array<'allow' | 'always' | 'deny'> = []
      const ra = (q: Parameters<NonNullable<ToolContext['requestApproval']>>[0]) => {
        void q
        const d = decisions.shift() ?? 'deny'
        return Promise.resolve(d)
      }
      // 第一次：写外部目录弹卡，选 always（记该目录）——读侧已随
      // 2026-09-17 项目外读放行，白名单只对写有意义
      decisions.push('always')
      await run({ command: `touch ${outsideDir}/x` }, { requestApproval: ra })
      // 第二次：同目录下别的文件免审
      decisions.push('deny') // 若再问会被拒 → 报错；不问则放行
      const r = await run({ command: `touch ${outsideDir}/y` }, { requestApproval: ra })
      expect(r.isError).toBe(false)
      // 邻居目录不在前缀内，照弹（deny 生效证明问了）
      const r2 = await run({ command: `touch ${root}/../zz` }, { requestApproval: ra })
      expect(r2.isError).toBe(true)
      expect(r2.output).toContain('审批被拒绝')
    } finally {
      rmSync(join(root, '.simple-code', 'approval.json'), { force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('multi 卡的批量 always：一次记多个目录（2026-09-21 方案 1）', async () => {
    const d1 = join(root, '..', 'sc-multi-1')
    const d2 = join(root, '..', 'sc-multi-2')
    mkdirSync(d1, { recursive: true })
    mkdirSync(d2, { recursive: true })
    try {
      const seen: Array<Parameters<NonNullable<ToolContext['requestApproval']>>[0]> = []
      const ra = (q: Parameters<NonNullable<ToolContext['requestApproval']>>[0]) => {
        seen.push(q)
        return Promise.resolve<'allow' | 'always' | 'deny'>('always')
      }
      const r = await run({ command: `ls ${d1}; ls ${d2}` }, { requestApproval: ra })
      expect(r.isError).toBe(false)
      // 卡上带批量预览——UI 靠它出「始终允许这 N 个目录」。dirs 是链接
      // 解析后的真实形态（/var→/private/var，detail 侧同款），断言对齐它
      const real = (p: string) => realpathSync(p)
      expect(seen[0]!.always).toEqual({ kind: 'paths', dirs: [real(d1), real(d2)] })
      // 两个目录都落进白名单
      const data = JSON.parse(readFileSync(join(root, '.simple-code', 'approval.json'), 'utf8'))
      expect(data.paths).toContain(real(d1))
      expect(data.paths).toContain(real(d2))
      // 白名单生效：同两条命令不再问
      const r2 = await run({ command: `ls ${d1}; ls ${d2}` }, { requestApproval: () => Promise.resolve('deny') })
      expect(r2.isError).toBe(false)
    } finally {
      rmSync(join(root, '.simple-code', 'approval.json'), { force: true })
      rmSync(d1, { recursive: true, force: true })
      rmSync(d2, { recursive: true, force: true })
    }
  })

  it('隐藏路径不给 always：卡上没有第三键的语义（q.always 不出现）', async () => {
    const seen: Array<Parameters<NonNullable<ToolContext['requestApproval']>>[0] | undefined> = []
    const ra = (q: Parameters<NonNullable<ToolContext['requestApproval']>>[0]) => {
      seen.push(q)
      return Promise.resolve<'deny'>('deny')
    }
    await run({ command: `echo x > ${root}/.simple-code/probe.txt` }, { requestApproval: ra })
    expect(seen[0]?.always).toBeUndefined() // 隐藏路径不收敛，不给 always
    expect(seen[0]?.reason).toContain('.simple-code')
  })
})

describe('工具描述说真话', () => {
  it('timeout 描述里的默认/上限秒数来自配置，不是写死的数字', () => {
    // 2026-09-09 的真实事故：描述写死「默认 120，最大 600」，用户配了
    // defaultTimeoutMs: 60000——模型一直按 2 分钟规划任务，实际 60s 就转后台
    const spec = createBashTool({
      defaultTimeoutMs: 60_000,
      maxTimeoutMs: 300_000,
      maxOutputChars: 16_000,
      killGraceMs: 3_000,
      envPassthrough: [],
    }).definition.parameters as { properties?: { timeout?: { description?: string } } }
    const desc = spec.properties?.timeout?.description
    expect(desc).toContain('默认 60')
    expect(desc).toContain('最大 300')
  })
})
