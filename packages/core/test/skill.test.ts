import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listSkills, readSkill } from '../src/tools/skill.ts'

let project: string
let userHome: string
const dirs: string[] = []

/** 把 homedir() 钉到临时目录，用户级 skills 不碰真 HOME */
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'sc-skill-p-'))
  userHome = await mkdtemp(join(tmpdir(), 'sc-skill-u-'))
  dirs.push(project, userHome)
  vi.spyOn(console, 'error').mockImplementation(() => {}) // skill.ts 不打印，保险
})
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
  dirs.length = 0
})

// skill.ts 用 homedir() 定位用户级——测试里 monkey-patch 它
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>()
  return { ...orig, homedir: () => userHome }
})

const put = async (home: string, name: string, body: string) => {
  await mkdir(join(home, '.simple-code', 'skills', name), { recursive: true })
  await writeFile(join(home, '.simple-code', 'skills', name, 'SKILL.md'), body, 'utf8')
}

describe('skill 检索（只读，两级覆盖）', () => {
  it('空态：两个目录都没有时给位置提示，不是错', () => {
    const out = listSkills(project)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('没有已装的 skill')
  })

  it('list：两级合并、front matter description 提取、来源标注', async () => {
    await put(project, 'deploy', '---\nname: deploy\ndescription: 部署到测试环境\n---\n\n步骤……')
    await put(project, 'format', '第一条正文行当描述')
    await put(userHome, 'audit', '---\ndescription: 审计依赖\n---\n')
    const out = listSkills(project)
    expect(out.find((l) => l.startsWith('audit'))).toContain('[用户]')
    expect(out.find((l) => l.startsWith('audit'))).toContain('审计依赖')
    expect(out.find((l) => l.startsWith('deploy'))).toContain('[项目]')
    expect(out.find((l) => l.startsWith('deploy'))).toContain('部署到测试环境')
    // 无 front matter：正文首个非空、非标题行
    expect(out.find((l) => l.startsWith('format'))).toContain('第一条正文行当描述')
  })

  it('同名覆盖：用户级盖项目级，read 取生效的那份', async () => {
    await put(project, 'deploy', '项目版内容')
    await put(userHome, 'deploy', '用户版内容')
    expect(readSkill(project, 'deploy')).toContain('用户版内容')
    const out = listSkills(project)
    expect(out.find((l) => l.startsWith('deploy'))).toContain('[用户]')
  })

  it('read 不存在：报错列出查过的两个候选路径', () => {
    expect(() => readSkill(project, 'nope')).toThrow(/nope 不存在/)
    try {
      readSkill(project, 'nope')
    } catch (e) {
      expect(String(e)).toContain(join(userHome, '.simple-code', 'skills', 'nope', 'SKILL.md'))
      expect(String(e)).toContain(join(project, '.simple-code', 'skills', 'nope', 'SKILL.md'))
    }
  })
})
