import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listModels, loadConfig, selectModel } from '@simple-code/core'
import { afterEach, describe, expect, it } from 'vitest'
import { draftDefaults } from '../src/task-draft.ts'

/** 三个模型各不相同：档位、预设、收图、窗口；gone 的 key 引用一个不存在的
 *  环境变量（解析会失败） */
const CONFIG = {
  provider: 'p',
  model: 'alpha',
  providers: {
    p: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://p.invalid',
      apiKey: 'sk-p',
      models: {
        alpha: { contextWindow: 100_000, request: { effort: 'high' } },
        beta: {
          contextWindow: 32_000,
          capabilities: { images: true },
          request: { effort: 'low' },
          presets: { 线路2: { request: { maxTokens: 10 } } },
        },
      },
    },
    q: {
      protocol: 'openai-chat',
      baseUrl: 'https://q.invalid',
      apiKey: '${SC_TASK_DRAFT_TEST_NO_SUCH_KEY}',
      models: { gone: { contextWindow: 8_000 } },
    },
  },
}

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('draftDefaults：新任务状态的控件初值', () => {
  it('默认模型取传入的配置默认；各模型的档位/预设/收图/窗口按配置解析；解析失败的记 null', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sc-draft-'))
    dirs.push(dir)
    const globalPath = join(dir, 'global.json')
    await writeFile(globalPath, JSON.stringify(CONFIG), 'utf8')
    const loaded = await loadConfig(dir, { globalPath, env: {} })
    // 主任务切到了 beta：初值仍按各模型自己的配置算，不受当前模型影响
    const main = selectModel(loaded, { provider: 'p', model: 'beta' }, {})
    const models = listModels(loaded.config)
    const d = draftDefaults(main, { provider: 'p', model: 'alpha' }, models)
    expect(d.model).toEqual({ provider: 'p', model: 'alpha' })
    expect(models.map((m) => m.model)).toEqual(['alpha', 'beta', 'gone'])
    expect(d.perModel).toEqual([
      { effort: 'high', presets: [], imagesEnabled: false, contextWindow: 100_000 },
      { effort: 'low', presets: ['线路2'], imagesEnabled: true, contextWindow: 32_000 },
      null,
    ])
  })
})
