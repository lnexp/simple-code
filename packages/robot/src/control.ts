import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 机器人进程的开关与拉起判断（docs/proposals/desktop-robot.md §7、§8）。
 * 不认 vscode，能直接测；extension.ts 只做接线。
 */

export const robotPaths = (home = homedir()) => ({
  /** 机器人与本插件共写：机器人改皮肤/位置，本插件只改 enabled */
  config: join(home, '.simple-code/robot/config.json'),
  /** 机器人启动后写 {pid, version}，正常退出时删 */
  pid: join(home, '.simple-code/run/robot.pid'),
})

const readJson = (file: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 默认开（用户定 2026-10-31）：文件不存在、写坏了、没有这一项都算开 */
export const readEnabled = (file: string): boolean => readJson(file).enabled !== false

/** 只改 enabled，皮肤、显示方式、位置原样保留 */
export function writeEnabled(file: string, on: boolean): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ ...readJson(file), enabled: on }, null, 2)}\n`)
}

export type Running = { pid: number; version: string }

/**
 * 正在跑的机器人。pid 文件可能是崩溃留下的、pid 已被别的进程复用——
 * 「替换旧版」要给它发 SIGTERM，认错进程就是误杀，所以按进程名再核一次
 */
export function readRunning(
  file: string,
  isRobot: (pid: number) => boolean = isRobotProcess,
): Running | null {
  const j = readJson(file)
  if (typeof j.pid !== 'number' || typeof j.version !== 'string') return null
  return isRobot(j.pid) ? { pid: j.pid, version: j.version } : null
}

export function isRobotProcess(pid: number): boolean {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' })
      .trim()
      .endsWith('/SimpleCodeRobot')
  } catch {
    return false // ps 找不到这个 pid 时退出码 1
  }
}

/**
 * 每个 VS Code 窗口激活时都会问一次。同版本已在跑 = 不动（多窗口共用一个）；
 * 版本不同 = 插件升级了、旧进程还在，换掉它
 */
export function plan(
  enabled: boolean,
  running: Running | null,
  version: string,
): 'none' | 'launch' | 'replace' {
  if (!enabled) return 'none'
  if (running === null) return 'launch'
  return running.version === version ? 'none' : 'replace'
}
