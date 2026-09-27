import type { Effort, ModelRef } from '@simple-code/core'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { FolderState } from '../src/protocol.ts'
import { Menu, type MenuOption } from './menu.tsx'
import { post } from './vscode.ts'

/**
 * 输入框底栏右侧的两个选择器。从 App.tsx 分出来的——那边超了 300 行
 * （CLAUDE.md §2），而「调参数」和「聊天记录渲染」本来就是两件事。
 *
 * **底栏布局**：
 * `justify-between`，左边放状态信息，右边 `justify-end` 依次排
 * 推理深度 → 模型 → 发送/停止。发送按钮在最右，选择器紧挨着它
 * （原来发送在最左，控件离手最远，改过来是因为它们每轮都要瞄一眼）。
 *
 * **控件是自绘下拉（menu.tsx），不是原生 select。** 原生那版是「只有
 * 一列扁平选项时不引库」的取舍，换掉是用户点的头——要的观感：
 * 下拉按 provider 分节、「默认」档带副文案、当前项打勾，这三样原生
 * select 都做不了。仍然不引 base-ui Menu 那类 headless 库：portal、
 * sticky 分节头全都有，为一列选项不值，键盘导航手写 80 行补齐（见 menu.tsx）。
 */

/**
 * 触发器上显示的名字。**同名模型配在两个 provider 下时才带 provider 前缀**
 * ——网关 + 直连并存是真实场景（core 的 ModelRef 注释），触发器显示两个
 * 一模一样的「claude-opus-4-8」没法分。只有一个的时候带前缀纯属噪音。
 * 下拉**行内**不带前缀：行按 provider 分节，节头已经说了这是哪家的
 */
const labelOf = (ref: ModelRef, all: ModelRef[]): string =>
  all.filter((m) => m.model === ref.model).length > 1 ? `${ref.provider}/${ref.model}` : ref.model

/**
 * 模型选择器。**跑的时候禁用**——core 那边跑着切是安全的（下一轮才生效），
 * 我们仍然禁，理由见 bridge.ts 的 switchModel：选择器一改就
 * 显示新模型，而正在流式输出的那段是旧模型说的，界面骗不起
 */
export function ModelPicker({
  current,
  models,
  running,
  task,
}: {
  current: ModelRef | null
  models: ModelRef[]
  running: boolean
  /** 控件跟分支走（2026-09-22 拍板）：选择打到分支 session。undefined = 主干 */
  task: string | undefined
}) {
  // 配置还没加载完（session 是惰性建的）时整个不显示，不显示一个空下拉
  if (models.length === 0) return null

  const at = models.findIndex((m) => m.provider === current?.provider && m.model === current?.model)

  // findIndex 命中时一定存在，但 noUncheckedIndexedAccess 下得说出来
  const showing = at >= 0 ? models[at] : undefined

  const options: MenuOption<ModelRef>[] = models.map((ref, i) => ({
    key: `${ref.provider}/${ref.model}`,
    label: ref.model,
    section: ref.provider,
    payload: ref,
    selected: i === at,
  }))

  return (
    <Menu
      icon="chip"
      cls="model-picker"
      ariaLabel="模型"
      label={showing === undefined ? '' : labelOf(showing, models)}
      title={running ? '跑完这一轮才能换模型' : '换模型'}
      disabled={running}
      options={options}
      // payload 直接带 ModelRef，不用下标/拼接串反查——模型名本身可以含
      // `/`，拼了还要猜从哪断（同 core ModelRef 的理由）
      onPick={(choice) => post({ type: 'setModel', choice, ...(task !== undefined ? { task } : {}) })}
    />
  )
}

/**
 * 参数预设（t885）。同一个模型挂多组请求参数——典型是网关的多条线路，
 * 某条慢了或不通就换一条。**换的是线路不是模型**：core 的 setModel 认出
 * 同模型后不清 effort、不剥 reasoning 签名。
 *
 * 当前模型没配 presets 就整个不渲染：没有的东西不占那块地方（同 modelRules
 * 的条件拼）。label 只显示值不显示「预设」二字——与模型/档位一致，字段名
 * 靠图标和 title 表达。
 */
export function PresetPicker({
  preset,
  presets,
  running,
  current,
  task,
}: {
  preset: string | undefined
  presets: string[]
  running: boolean
  current: ModelRef | null
  /** 同 ModelPicker：选择打到分支 session */
  task: string | undefined
}) {
  if (presets.length === 0 || current === null) return null

  const options: MenuOption<string | undefined>[] = [
    {
      key: 'default',
      label: '默认',
      sub: '模型本体参数',
      payload: undefined,
      selected: preset === undefined,
    },
    ...presets.map((name) => ({
      key: name,
      label: name,
      payload: name as string | undefined,
      selected: preset === name,
    })),
  ]

  return (
    <Menu
      icon="plug"
      cls="preset-picker"
      ariaLabel="预设"
      label={preset ?? '默认'}
      title={preset === undefined ? '预设：默认（模型本体参数）' : `预设：${preset}`}
      on={preset !== undefined}
      disabled={running}
      options={options}
      // 带上当前模型：预设从属于模型，core 要靠 provider/model 判断是不是
      // 「同模型换预设」（那条路径不清 effort）
      // `current` 自带 preset（readModel 带上了——不然 switchEffort 会把
      // 线路选择洗掉），所以选「默认」必须显式构造干净的选择，展开 current
      // 会带着旧 preset 发出去，等于没切
      onPick={(name) =>
        post({
          type: 'setModel',
          choice: name === undefined
            ? { provider: current.provider, model: current.model }
            : { ...current, preset: name },
          ...(task !== undefined ? { task } : {}),
        })
     }
    />
  )
}

/** core 的 Effort 联合，从浅到深。跟 types.ts 的顺序一致，别打乱 */
const LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * 推理深度。
 *
 * **对所有模型都显示，不按能力过滤。** 这一条推翻过本文件的更早一版——那版
 * 拿配置里的 `capabilities.reasoning` 当开关（模型没有对应能力就隐藏控件）。
 *
 * 推翻的理由：**design.md §724 早就定过相反的规矩**——thinking / effort /
 * reasoningDisplay 不做本地能力校验，「能力矩阵会随模型迭代不断变化，维护
 * 一份必然过时的表不如让 API 自己说话」。§726 给 capabilities 开的例外只
 * 针对 `images`，判据是「配错了会污染历史」（400 的图片留在 context 里，
 * 之后每轮再 400，loop 卡死）。effort 不满足这个判据：配错最多是这次请求
 * 行为不如预期。
 *
 * 代价是诚实的：端点不认 `reasoning_effort` 时，控件看着能调而实际没效果。
 * 但那个风险本来就在（`openai-chat.ts` 无条件发这个字段），过滤也挡不住
 * ——布尔说的是「支持推理」，不是「认这五档」。
 *
 * **「默认」是一个真实的档位选项**，不是「随便选一个」。选它 = 撤掉覆盖，
 * 跟着配置走；而配置值会随模型变，所以这不等于选中当前那一档。
 * 副文案「跟随配置（high）」把配置值直接写在
 * 行里——原生 select 时代做不到（触发器就是选中项，信息塞不下），这次
 * 换自绘一起补上
 */
export function EffortPicker({
  effort,
  overridden,
  running,
  task,
}: {
  effort: Effort | null
  overridden: boolean
  running: boolean
  /** 同 ModelPicker：选择打到分支 session */
  task: string | undefined
}) {
  // session 还没建起来时才不渲染。**不按模型能力过滤**——见上
  if (effort === null) return null

  const options: MenuOption<Effort | null>[] = [
    {
      key: 'default',
      label: '默认',
      sub: `跟随配置（${effort}）`,
      payload: null,
      selected: !overridden,
    },
    ...LEVELS.map((level) => ({
      key: level,
      label: level,
      payload: level,
      selected: overridden && effort === level,
    })),
  ]

  return (
    <Menu
      icon="lightbulb"
      cls="effort-picker"
      ariaLabel="推理深度"
      label={overridden ? effort : `默认 · ${effort}`}
      title={overridden ? `推理深度：${effort}（手动设置）` : `推理深度：跟随配置（${effort}）`}
      on={overridden}
      disabled={running}
      options={options}
      onPick={(value) =>
        post({ type: 'setEffort', effort: value, ...(task !== undefined ? { task } : {}) })
      }
    />
  )
}

/**
 * 多根工作区的文件夹平铺 tab（design.md §7）。**放消息列表顶部**（对话头）。
 * 原来是下拉——切换两步、弹层挡内容、哪个文件夹在跑要点开才见，用户
 * 拍板换成 VS Code 编辑器 tab 模式：全部平铺单击直达，放不下折进「»」
 * 菜单；不横向滚动、不自动换序（①A ②A：位置稳定建立肌肉记忆）。
 *
 * 溢出测量：tab 全部真实渲染后逐个累计 offsetWidth，超出容器宽的收进
 * 「»」。两遍：先按全宽试（全放得下就不渲染「»」，limit 不虚减），不够
 * 再减去按钮宽（32px 估）重算，收敛后 ResizeObserver 不再触发。jsdom
 * 里 offsetWidth 恒 0 → 永远全平铺，测试可直接断言 tab 文案。
 *
 * 切换不打断后台轮（B 方案，用户拍板）——tab 只决定记忆存哪、UI 显示
 * 哪条上下文，agent 照样能 cd 到别的文件夹干活，tooltip 讲明这一点。
 */
export function FolderTabs({
  folders,
  active,
}: {
  folders: FolderState[]
  active: string
}) {
  const base = (p: string): string => p.split('/').filter(Boolean).pop() ?? p
  const rowRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [visible, setVisible] = useState(folders.length)

  const measure = useCallback(() => {
    const el = rowRef.current
    if (!el) return
    const fits = (limit: number): number => {
      let used = 0
      let n = 0
      for (const t of tabRefs.current) {
        if (!t) break
        used += t.offsetWidth
        if (used > limit) break
        n++
      }
      return n
    }
    const all = fits(el.clientWidth)
    setVisible(all >= folders.length ? folders.length : fits(el.clientWidth - 32))
  }, [folders.length])

  useLayoutEffect(() => {
    tabRefs.current = tabRefs.current.slice(0, folders.length)
    measure()
    const el = rowRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, folders])

  const shown = folders.slice(0, visible)
  const overflow = folders.slice(visible)
  // 溢出项激活（点了「»」里的文件夹）：提到平铺区，挤掉平铺最后一个。
  // 选中的 tab 必须可见（VS Code tab 语义）——否则切过去后顶部没有任何
  // 高亮，看起来「点了没反应、平铺的没了」。位置稳定（肌肉记忆）优先，
  // 只在选中项不可见时才换位，且只换平铺末位这一个
  const at = overflow.findIndex((f) => f.path === active)
  if (at !== -1) {
    const [pick] = overflow.splice(at, 1)
    if (pick) {
      const bumped = shown.pop()
      if (bumped) overflow.push(bumped)
      shown.push(pick)
    }
  }
  return (
    <div className="folder-tabs" ref={rowRef}>
      {shown.map((f, i) => (
        <button
          key={f.path}
          ref={(el) => { tabRefs.current[i] = el }}
          className={'folder-tab' + (f.path === active ? ' active' : '')}
          title={`${f.path}\n切换只换记忆和显示，不拦 agent 访问别的文件夹`}
          onClick={() => post({ type: 'switchFolder', folder: f.path })}
        >
          {f.running && <span className="tab-dot" aria-label="跑着" />}
          <span className="tab-label">{base(f.path)}</span>
          {f.pendingApprovals > 0 && (
            <span className="tab-badge" aria-label={`${f.pendingApprovals} 个待审批`}>
              {f.pendingApprovals}
            </span>
          )}
        </button>
      ))}
      {overflow.length > 0 && (
        <Menu
          icon="codicon-folder"
          cls="folder-overflow"
          drop="down"
          label="»"
          title="更多文件夹"
          ariaLabel="更多文件夹"
          options={overflow.map((f): MenuOption<string> => ({
            key: f.path,
            label: base(f.path),
            ...(f.pendingApprovals > 0
              ? { sub: `⚠ ${f.pendingApprovals} 个待审批` }
              : f.running
                ? { sub: '● 跑着' }
                : {}),
            selected: f.path === active,
            payload: f.path,
          }))}
          onPick={(folder) => post({ type: 'switchFolder', folder })}
        />
      )}
      {/* 影子测量层：溢出 tab 的影子副本。absolute + visibility:hidden
          不占 flex 布局但保留 shrink-to-fit 宽度——fits() 在已折叠状态
          下也能测到全量宽度。没有它，溢出 tab 卸载后 tabRefs 后面全是
          null，拖宽窗口也永远收不回来（死锁）。ref 索引接在 shown 之后，
          不是 visible 之后——active 提升会改写两个分区的实际长度 */}
      {overflow.map((f, i) => (
        <button
          key={f.path}
          ref={(el) => { tabRefs.current[shown.length + i] = el }}
          className="folder-tab tab-shadow"
          aria-hidden
          tabIndex={-1}
        >
          {f.running && <span className="tab-dot" aria-hidden />}
          <span className="tab-label">{base(f.path)}</span>
          {f.pendingApprovals > 0 && <span className="tab-badge">{f.pendingApprovals}</span>}
        </button>
      ))}
    </div>
  )
}
