import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configSchema } from '../src/config/schema.ts'
import { readSettingsView, type SettingsEdit } from '../src/config/settings-edit.ts'
import { applyEdit, applySettingsEdit } from '../src/config/settings-write.ts'

let dir = ''
let path = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'simple-code-settings-'))
  path = join(dir, 'settings.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

/** 带注释与杂项字段的样本——验证「只动改到的键，其余原样」的底座 */
const SAMPLE = `// 顶部注释：这是我的配置
{
  "provider": "p",
  "model": "m1",
  "$comment": "别删我",
  "providers": {
    "p": {
      "protocol": "anthropic-messages",
      "baseUrl": "https://api.test",
      "apiKey": "\${MY_KEY}",
      "models": {
        "m1": {
          "contextWindow": 200000,
          "request": { "effort": "high" },
          "extraBody": { "providerId": 140 }
        },
        "m2": { "contextWindow": 128000 }
      }
    }
  },
  "memory": {
    "summaryModel": { "provider": "p", "model": "m2" }
  },
  "recall": {
    "mode": "on"
  }
}
`

const FIRST: Extract<SettingsEdit, { op: 'firstSave' }> = {
  op: 'firstSave',
  name: 'deepseek',
  protocol: 'openai-chat',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '${DEEPSEEK_KEY}',
  model: 'deepseek-flash',
  contextWindow: 1_000_000,
  images: true,
}

describe('settings-edit / 读视图', () => {
  it('文件不存在 → missing，协议清单来自 registry', async () => {
    const view = await readSettingsView(path)
    expect(view.missing).toBe(true)
    expect(view.providers).toEqual([])
    expect(view.protocols).toContain('openai-chat')
    expect(view.protocols).toContain('anthropic-messages')
  })

  it('apiKey 只报形态不带值：环境变量名 / 明文 / 缺失', async () => {
    await writeFile(path, SAMPLE)
    const view = await readSettingsView(path)
    expect(view.providers[0]?.apiKey).toEqual({ kind: 'env', name: 'MY_KEY' })
    expect(JSON.stringify(view)).not.toContain('sk-')
  })

  it('模型行带「高级参数」字段名与能看图位', async () => {
    await writeFile(path, SAMPLE)
    const view = await readSettingsView(path)
    const m1 = view.providers[0]?.models.find((m) => m.model === 'm1')
    expect(m1?.advanced).toEqual(['request', 'extraBody'])
    expect(m1?.images).toBe(false)
  })

  it('引用两侧：default / vision / summary / recall 全部解析', async () => {
    await writeFile(
      path,
      JSON.stringify({
        provider: 'p',
        model: 'm1',
        visionModel: 'm2',
        memory: { summaryModel: { provider: 'q', model: 'x' } },
        recall: { mode: 'off' },
        providers: { p: { models: { m1: {}, m2: {} } }, q: { models: { x: {} } } },
      }),
    )
    const view = await readSettingsView(path)
    expect(view.defaultRef).toEqual({ provider: 'p', model: 'm1' })
    expect(view.visionModel).toEqual({ provider: 'p', model: 'm2' }) // string 形态解析成显式二元组
    expect(view.summaryModel).toEqual({ provider: 'q', model: 'x' })
    expect(view.recallMode).toBe('off')
  })

  it('坏 JSON 折进 error，不抛', async () => {
    await writeFile(path, '{Oops')
    const view = await readSettingsView(path)
    expect(view.error).toContain('不是合法的 JSON')
  })
})

describe('settings-edit / 首开整份文件', () => {
  it('结构同 README 快速开始、过 strict schema、权限 600', async () => {
    const view = await applySettingsEdit(path, FIRST)
    expect(view.missing).toBe(false)
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    expect(parsed.provider).toBe('deepseek')
    expect(parsed.model).toBe('deepseek-flash')
    expect(parsed.providers.deepseek.models['deepseek-flash']).toEqual({
      contextWindow: 1_000_000,
      capabilities: { images: true },
    })
    expect(() => configSchema.parse(parsed)).not.toThrow()
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('文件已存在时拒绝走首开表单', async () => {
    await writeFile(path, SAMPLE)
    await expect(applySettingsEdit(path, FIRST)).rejects.toThrow('已经存在')
  })

  it('必填校验：协议没选 / URL 形态 / 空 key / 窗口非正整数', () => {
    expect(() => applyEdit(null, path, { ...FIRST, protocol: 'nope' })).toThrow('请选一个协议')
    expect(() => applyEdit(null, path, { ...FIRST, baseUrl: 'api.deepseek.com' })).toThrow('http')
    expect(() => applyEdit(null, path, { ...FIRST, apiKey: ' ' })).toThrow('API Key 必填')
    expect(() => applyEdit(null, path, { ...FIRST, contextWindow: 0 })).toThrow('正整数')
  })
})

describe('settings-edit / 增删改保留原样', () => {
  it('editModel 改窗口 + 勾看图：注释、$comment、request/extraBody 原样', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, {
      op: 'editModel',
      provider: 'p',
      model: 'm1',
      contextWindow: 300000,
      images: true,
      makeDefault: false,
    })
    const text = await readFile(path, 'utf8')
    expect(text).toContain('// 顶部注释：这是我的配置')
    expect(text).toContain('"$comment": "别删我"')
    expect(text).toContain('"providerId": 140')
    expect(text).toContain('"effort": "high"')
    expect(text).toContain('"contextWindow": 300000')
    expect(text).toContain('"images": true')
  })

  it('editModel 取消看图：capabilities 整个删掉，不留空对象', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, {
      op: 'editModel',
      provider: 'p',
      model: 'm2',
      contextWindow: 128000,
      images: true,
      makeDefault: false,
    })
    await applySettingsEdit(path, {
      op: 'editModel',
      provider: 'p',
      model: 'm2',
      contextWindow: 128000,
      images: false,
      makeDefault: false,
    })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('capabilities')
  })

  it('editModel 设默认：根上的 provider/model 一起改', async () => {
    await writeFile(path, SAMPLE)
    const view = await applySettingsEdit(path, {
      op: 'editModel',
      provider: 'p',
      model: 'm2',
      contextWindow: 128000,
      images: false,
      makeDefault: true,
    })
    expect(view.defaultRef).toEqual({ provider: 'p', model: 'm2' })
  })

  it('addProvider / addModel：新键落到正确位置、重复名报错', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, {
      op: 'addProvider',
      name: 'q',
      protocol: 'openai-chat',
      baseUrl: 'https://api.q.test',
      apiKey: 'sk-q',
      model: 'qm1',
      contextWindow: 64000,
      images: false,
    })
    const view = await readSettingsView(path)
    expect(view.providers.map((p) => p.name)).toEqual(['p', 'q'])
    expect(view.providers[1]?.apiKey).toEqual({ kind: 'literal' })
    await applySettingsEdit(path, {
      op: 'addModel',
      provider: 'p',
      model: 'm3',
      contextWindow: 32000,
      images: true,
    })
    const after = await readSettingsView(path)
    expect(after.models).toContainEqual({ provider: 'p', model: 'm3' })
    // 重复名
    await expect(
      applySettingsEdit(path, {
        op: 'addModel',
        provider: 'p',
        model: 'm3',
        contextWindow: 32000,
        images: false,
      }),
    ).rejects.toThrow('已经有')
    await expect(
      applySettingsEdit(path, {
        op: 'addProvider',
        name: 'q',
        protocol: 'openai-chat',
        baseUrl: 'https://x.test',
        apiKey: 'k',
        model: 'z',
        contextWindow: 1,
        images: false,
      }),
    ).rejects.toThrow('已有叫 q 的服务商')
    // 不存在的服务商
    await expect(
      applySettingsEdit(path, {
        op: 'addModel',
        provider: 'nope',
        model: 'x',
        contextWindow: 1,
        images: false,
      }),
    ).rejects.toThrow('没有叫 nope 的服务商')
  })

  it('deleteModel：被默认/看图/摘要引用的不让删，普通模型可删', async () => {
    await writeFile(path, SAMPLE)
    // m1 = 默认
    await expect(
      applySettingsEdit(path, { op: 'deleteModel', provider: 'p', model: 'm1' }),
    ).rejects.toThrow('默认模型')
    // m2 = 摘要模型
    await expect(
      applySettingsEdit(path, { op: 'deleteModel', provider: 'p', model: 'm2' }),
    ).rejects.toThrow('摘要模型')
    // 看图引用
    await applySettingsEdit(path, {
      op: 'setSide',
      key: 'visionModel',
      value: { provider: 'p', model: 'm2' },
    })
    await expect(
      applySettingsEdit(path, { op: 'deleteModel', provider: 'p', model: 'm2' }),
    ).rejects.toThrow('看图模型')
  })

  it('deleteModel：被 taskModels 引用也拦（11-18 实测删后 loadConfig 报 taskModels 悬空）', async () => {
    const root = {
      provider: 'p',
      model: 'm1',
      providers: {
        p: {
          protocol: 'openai-chat',
          baseUrl: 'https://a.test',
          apiKey: 'k',
          models: { m1: { contextWindow: 1 }, m2: { contextWindow: 2 } },
        },
      },
      taskModels: [{ provider: 'p', model: 'm2', use: '要快' }],
    }
    await writeFile(path, JSON.stringify(root))
    await expect(
      applySettingsEdit(path, { op: 'deleteModel', provider: 'p', model: 'm2' }),
    ).rejects.toThrow('taskModels')
    expect(JSON.parse(await readFile(path, 'utf8')).providers.p.models.m2).toBeDefined()
  })

  it('deleteModel 后 models 留空对象（providerSpec 必填），不炸 schema', async () => {
    await writeFile(
      path,
      JSON.stringify({
        provider: 'p',
        model: 'm1',
        providers: {
          p: {
            protocol: 'openai-chat',
            baseUrl: 'https://a.test',
            apiKey: 'k',
            models: { m1: { contextWindow: 1 } },
          },
          q: {
            protocol: 'openai-chat',
            baseUrl: 'https://b.test',
            apiKey: 'k',
            models: { m2: { contextWindow: 2 } },
          },
        },
      }),
    )
    // 默认模型在 p/m1 上，删 q 的最后一个模型：q.models 留 {}，schema 仍过
    await applySettingsEdit(path, { op: 'deleteModel', provider: 'q', model: 'm2' })
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    expect(parsed.providers.q.models).toEqual({})
    expect(() => configSchema.parse(parsed)).not.toThrow()
  })

  it('editProvider：协议/地址换、key 留空不改、填了替换', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, {
      op: 'editProvider',
      name: 'p',
      protocol: 'openai-chat',
      baseUrl: 'https://api2.test',
      apiKey: 'sk-new',
    })
    let view = await readSettingsView(path)
    expect(view.providers[0]?.protocol).toBe('openai-chat')
    expect(view.providers[0]?.baseUrl).toBe('https://api2.test')
    expect(view.providers[0]?.apiKey).toEqual({ kind: 'literal' })
    // 留空 = 不改
    await applySettingsEdit(path, {
      op: 'editProvider',
      name: 'p',
      protocol: 'openai-chat',
      baseUrl: 'https://api2.test',
      apiKey: '',
    })
    view = await readSettingsView(path)
    expect(view.providers[0]?.apiKey).toEqual({ kind: 'literal' })
  })
})

describe('settings-edit / 辅助模型与开关', () => {
  it('setSide 设 visionModel（对象形态）与 summaryModel（memory 下）', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, {
      op: 'setSide',
      key: 'visionModel',
      value: { provider: 'p', model: 'm2' },
    })
    let view = await readSettingsView(path)
    expect(view.visionModel).toEqual({ provider: 'p', model: 'm2' })
    await applySettingsEdit(path, {
      op: 'setSide',
      key: 'summaryModel',
      value: { provider: 'p', model: 'm1' },
    })
    view = await readSettingsView(path)
    expect(view.summaryModel).toEqual({ provider: 'p', model: 'm1' })
  })

  it('setSide 带推理档位：读出 effort；换模型带着 effort 写回；不带 = 删掉 effort', async () => {
    // 11-18 对照真实配置：summaryModel 带 effort:"none"，旧 opSetSide 整对象覆盖把它丢了
    await writeFile(
      path,
      SAMPLE.replace(
        '"summaryModel": { "provider": "p", "model": "m2" }',
        '"summaryModel": { "provider": "p", "model": "m2", "effort": "none" }',
      ),
    )
    let view = await readSettingsView(path)
    expect(view.summaryModel).toEqual({ provider: 'p', model: 'm2', effort: 'none' })
    expect(view.efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    await applySettingsEdit(path, {
      op: 'setSide',
      key: 'summaryModel',
      value: { provider: 'p', model: 'm1', effort: 'none' },
    })
    view = await readSettingsView(path)
    expect(view.summaryModel).toEqual({ provider: 'p', model: 'm1', effort: 'none' })
    await applySettingsEdit(path, {
      op: 'setSide',
      key: 'summaryModel',
      value: { provider: 'p', model: 'm1' },
    })
    expect(await readFile(path, 'utf8')).not.toContain('"effort": "none"')
  })

  it('setSide 拒绝 schema 外的推理档位与多余字段（webview 是不可信面）', async () => {
    await writeFile(path, SAMPLE)
    await expect(
      applySettingsEdit(path, {
        op: 'setSide',
        key: 'visionModel',
        value: { provider: 'p', model: 'm2', effort: 'turbo' as never },
      }),
    ).rejects.toThrow('推理档位')
    // 多余字段不落盘（旧实现把 value 整个写进文件）
    await applySettingsEdit(path, {
      op: 'setSide',
      key: 'visionModel',
      value: { provider: 'p', model: 'm2', extra: 1 } as never,
    })
    expect(await readFile(path, 'utf8')).not.toContain('"extra"')
  })

  it('setSide null：键删掉；memory 删空后整个不留', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, { op: 'setSide', key: 'summaryModel', value: null })
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('summaryModel')
    expect(text).not.toContain('"memory"')
    // recall.mode 还在（SAMPLE 里是 on），别误伤
    expect(text).toContain('"mode": "on"')
  })

  it('setRecall off：删键回默认，不写 "off"；on：写 "on"', async () => {
    await writeFile(path, SAMPLE)
    await applySettingsEdit(path, { op: 'setRecall', on: false })
    let view = await readSettingsView(path)
    expect(view.recallMode).toBeNull()
    expect(await readFile(path, 'utf8')).not.toContain('"recall"')
    await applySettingsEdit(path, { op: 'setRecall', on: true })
    view = await readSettingsView(path)
    expect(view.recallMode).toBe('on')
  })

  it('setRecall off 在没有 recall 键时是无操作，不抛', async () => {
    await writeFile(
      path,
      JSON.stringify({
        provider: 'p',
        model: 'm1',
        providers: { p: { models: { m1: { contextWindow: 1 } } } },
      }),
    )
    await applySettingsEdit(path, { op: 'setRecall', on: false })
    const view = await readSettingsView(path)
    expect(view.recallMode).toBeNull()
  })

  it('setRecall on 在没有 recall 键时创建', async () => {
    await writeFile(
      path,
      JSON.stringify({
        provider: 'p',
        model: 'm1',
        providers: { p: { models: { m1: { contextWindow: 1 } } } },
      }),
    )
    await applySettingsEdit(path, { op: 'setRecall', on: true })
    const view = await readSettingsView(path)
    expect(view.recallMode).toBe('on')
  })
})

describe('settings-edit / 明文密钥与文件权限', () => {
  /** 建一个 644 的现成配置——用户手建文件常见权限 */
  const make644 = async (): Promise<void> => {
    await writeFile(path, SAMPLE)
    await chmod(path, 0o644)
  }
  const mode = async (): Promise<number> => (await stat(path)).mode & 0o777

  it('已有 644 + 新服务商带明文密钥 → 写完收紧到 600', async () => {
    await make644()
    await applySettingsEdit(path, {
      op: 'addProvider',
      name: 'q',
      protocol: 'openai-chat',
      baseUrl: 'https://api.q.test',
      apiKey: 'sk-plain-secret',
      model: 'q1',
      contextWindow: 64000,
      images: false,
    })
    expect(await mode()).toBe(0o600)
  })

  it('已有 644 + 只改 recall 之类 → 权限不动', async () => {
    await make644()
    await applySettingsEdit(path, { op: 'setRecall', on: true })
    expect(await mode()).toBe(0o644)
  })

  it('已有 644 + 服务商换明文密钥 → 600；填 ${环境变量} → 不动', async () => {
    await make644()
    await applySettingsEdit(path, {
      op: 'editProvider',
      name: 'p',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.test',
      apiKey: 'sk-new-secret',
    })
    expect(await mode()).toBe(0o600)
    // 再改回环境变量形态：不收紧也不放宽（600 保持，不回 644）
    await chmod(path, 0o644)
    await applySettingsEdit(path, {
      op: 'editProvider',
      name: 'p',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.test',
      apiKey: '${Q_KEY}',
    })
    expect(await mode()).toBe(0o644)
  })
})
