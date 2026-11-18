import { type LoadedConfig, type ModelRef, selectModel } from '@simple-code/core'
import type { TaskDraftDefaults } from './protocol.ts'

/**
 * 「+ 任务」新任务状态的控件初值（task-trunk.md 规则 13，2026-11-14 改为第一条
 * 消息即开）。任务发第一条消息时才建——在那之前没有任务 session 可读，控件要
 * 显示的「默认模型、各模型的配置档位/预设/收图/窗口」由宿主按配置先算好。
 *
 * 用主任务的配置解析：同一目录的任务读的是同一份配置，selectModel 换掉
 * provider/model 后的结果与任务 session 建立时一致。默认模型取配置默认（规则
 * 13 用户选 b），不是主任务当前切到的那个。
 *
 * 解析抛错的模型（缺 key 等）记 null：那项不显示档位/预设，选了照样能开，
 * 真错误由任务建会话时报——不在这里替它判
 */
export function draftDefaults(
  loaded: LoadedConfig,
  defaultModel: ModelRef,
  models: ModelRef[],
): TaskDraftDefaults {
  return {
    model: defaultModel,
    perModel: models.map((ref) => {
      try {
        const c = selectModel(loaded, ref, process.env)
        return {
          effort: c.request.effort,
          presets: Object.keys(c.model.presets),
          // 同 bridge refresh 的判据：直收图或走 visionRelay 转述
          imagesEnabled: c.model.capabilities.images || c.vision !== null,
          contextWindow: c.model.contextWindow,
        }
      } catch {
        return null
      }
    }),
  }
}
