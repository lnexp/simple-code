import { describe, expect, it } from 'vitest'
import { asSavedChoice } from '../src/saved-choice.ts'

/** 持久化选择的读回校验。关键属性：**字段透传，不丢**——丢字段 =
 * 存了也白存（preset 被剥是 2026-09-20 的实锤 bug：切目录再回来线路
 * 选择回默认，用户以为还选着） */
describe('asSavedChoice', () => {
  it('preset 透传：存什么读回什么', () => {
    const saved = asSavedChoice({
      provider: 'modelbest',
      model: 'claude-opus-5',
      preset: 'pulsarwave-claude',
    })
    expect(saved).toEqual({ provider: 'modelbest', model: 'claude-opus-5', preset: 'pulsarwave-claude' })
  })

  it('模型 + 档位 + 预设同时在场，全透传', () => {
    const saved = asSavedChoice({
      provider: 'modelbest-openai',
      model: 'glm-5.3',
      effort: 'xhigh',
      preset: 'sudocode',
    })
    expect(saved).toEqual({
      provider: 'modelbest-openai',
      model: 'glm-5.3',
      effort: 'xhigh',
      preset: 'sudocode',
    })
  })

  it('preset 非字符串（脏数据）剥掉而不是炸；模型字段坏返回 null', () => {
    expect(asSavedChoice({ provider: 'a', model: 'b', preset: 42 })).toEqual({ provider: 'a', model: 'b' })
    expect(asSavedChoice({ provider: 'a', preset: 'x' })).toBeNull()
    expect(asSavedChoice(null)).toBeNull()
  })

  it('effort 非法值剥掉（既有行为不变）', () => {
    expect(asSavedChoice({ provider: 'a', model: 'b', effort: 'ultra' })).toEqual({ provider: 'a', model: 'b' })
  })
})
