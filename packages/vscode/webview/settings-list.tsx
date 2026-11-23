import type { SettingsEdit, SettingsView } from '@simple-code/core'
import type { GatewayCheck } from '../src/protocol.ts'
import { ModelSection } from './settings-models.tsx'
import type { Nav, RobotState, Section } from './settings-shared.tsx'
import {
  PushSection,
  RecallSection,
  RobotSection,
  SummarySection,
  VisionSection,
} from './settings-side.tsx'

/**
 * 设置页的列表形态：左侧分区列表，右侧只显示选中分区的内容。2026-11-17 用户
 * 看过单页版后改版：「左侧是可点击的列表，比如模型，摘要模型，回忆这些，点击后
 * 可以看到内容，而不是所有配置都在一个页面上」，并定「不管宽窄一律左右两栏」
 * ——窄侧栏只把左栏收窄（style.ts .snav），不改成先列表再点进去。
 * 当前分区与表单跳转（Nav）都由 SettingsPage 持有：从表单回来停在原分区。
 */

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'models', label: '模型' },
  { id: 'vision', label: '看图模型' },
  { id: 'summary', label: '摘要模型' },
  { id: 'recall', label: '记忆线索' },
]
/** 飞书网关启用时才有这一项（push !== null）——没用飞书的人看不到 */
const PUSH_SECTION = { id: 'push', label: '飞书推送' } as const
/** mac 上才有（robot !== null）——机器人插件只发 mac 版 */
const ROBOT_SECTION = { id: 'robot', label: '桌面机器人' } as const

type MainProps = {
  view: SettingsView
  section: Section
  busy: boolean
  serverError: string | null
  onSection: (section: Section) => void
  onWrite: (edit: SettingsEdit) => void
  push: boolean | null
  onPush: (on: boolean) => void
  /** 飞书推送分区的检测卡（2026-11-18）：路径 + 检测结果 */
  larkCli: string | null
  check: GatewayCheck | null
  checking: boolean
  onCheck: () => void
  /** 桌面机器人分区（2026-11-18）：null = 非 mac，整个分区不显示 */
  robot: RobotState
  onRobot: (on: boolean) => void
  onRobotInstall: () => void
  onNav: (nav: Nav) => void
  onBack: () => void
  onOpenFile: () => void
}

export function SettingsMain(props: MainProps) {
  const {
    view,
    section,
    serverError,
    push,
    robot,
    onSection,
    onBack,
    onOpenFile,
  } = props
  const sections = [
    ...SECTIONS,
    ...(push === null ? [] : [PUSH_SECTION]),
    ...(robot === null ? [] : [ROBOT_SECTION]),
  ]
  return (
    <div className="page split-page">
      <div className="page-head">
        <button type="button" className="icon-btn" title="返回对话" onClick={onBack}>
          <span className="codicon codicon-chevron-left" />
        </button>
        <span className="title">设置</span>
        <button
          type="button"
          className="icon-btn muted"
          title={`在编辑器里打开 ${view.path}`}
          onClick={onOpenFile}
        >
          <span className="codicon codicon-go-to-file" />
          settings.json
        </button>
      </div>
      <div className="page-sub">
        {view.path} · 保存后立即生效 · 项目级 .simple-code/settings.json 不在这里改
      </div>
      <div className="split">
        <nav className="snav" aria-label="设置分区">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="snav-item"
              aria-current={s.id === section ? 'page' : undefined}
              onClick={() => onSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="sbody">
          <div className="sbody-in">
            {serverError !== null && (
              <div className="field">
                <div className="err">{serverError}</div>
              </div>
            )}
            <SectionBody {...props} />
            <ListFoot section={section} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** 右栏：按选中分区分发 */
function SectionBody({
  view,
  section,
  busy,
  onWrite,
  push,
  onPush,
  robot,
  onRobot,
  onRobotInstall,
  larkCli,
  check,
  checking,
  onCheck,
  onNav,
}: MainProps) {
  switch (section) {
    case 'models':
      return <ModelSection view={view} onNav={onNav} />
    case 'vision':
      return <VisionSection view={view} busy={busy} onWrite={onWrite} />
    case 'summary':
      return <SummarySection view={view} busy={busy} onWrite={onWrite} />
    case 'recall':
      return <RecallSection view={view} busy={busy} onWrite={onWrite} />
    case 'push':
      // 停在这一项时网关被关掉（config 改了）→ 推来 null：退回模型分区的内容
      return push === null ? (
        <ModelSection view={view} onNav={onNav} />
      ) : (
        <PushSection
          on={push}
          onPush={onPush}
          larkCli={larkCli}
          check={check}
          checking={checking}
          onCheck={onCheck}
        />
      )
    case 'robot':
      // 停在这一项时机器人被卸载/非 mac 推来 null → 退回模型分区的内容
      return robot === null ? (
        <ModelSection view={view} onNav={onNav} />
      ) : (
        <RobotSection robot={robot} onRobot={onRobot} onInstall={onRobotInstall} />
      )
  }
}

/** 每个分区自己的补充说明（2026-11-18 用户：不能每个设置项下面都是模型
 *  的说明）。没话说的分区（看图/记忆线索/飞书推送）不渲染；「项目级不在这里
 *  改」是全局的，放页头 path 那行 */
function ListFoot({ section }: { section: Section }) {
  const text =
    section === 'models'
      ? '对话模型的推理档位、值守模式在输入框底栏，这里不重复。预设（presets）、任务模型（taskModels）、请求参数（extraBody）等请直接编辑 settings.json。'
      : section === 'summary'
        ? '历史摘要开关在上下文面板，这里不重复。'
        : null
  if (text === null) return null
  return (
    <div className="foot">
      <p>{text}</p>
    </div>
  )
}
