import type { SettingsEdit, SettingsView, SideModelView } from '@simple-code/core'
import type { GatewayCheck } from '../src/protocol.ts'
import { Dropdown, type DropdownOption } from './settings-dropdown.tsx'
import { refKey, type SideRef } from './settings-shared.tsx'

/**
 * 设置页里即改即存的分区：看图模型、摘要模型（各一个下拉）、记忆线索、
 * 飞书推送（开关）。从 settings-list.tsx 拆出（2026-11-17 左右两栏改版：原
 * 「辅助模型」一节拆成两个分区，用户举例「模型，摘要模型，回忆这些」各占左侧一项）。
 */

export type SectionProps = {
  view: SettingsView
  busy: boolean
  onWrite: (edit: SettingsEdit) => void
}

type Effort = SideModelView['effort']

/** 下拉选中值摊成写回操作；null = 删键回默认。effort 每次带上当前值——换
 *  模型不丢推理档位（11-18 对照真实配置：旧写法把 effort:"none" 丢了） */
function setSide(
  key: 'visionModel' | 'summaryModel',
  value: SideRef,
  effort: Effort,
  onWrite: (edit: SettingsEdit) => void,
): void {
  onWrite({
    op: 'setSide',
    key,
    value:
      value === null
        ? null
        : {
            provider: value.provider,
            model: value.model,
            ...(effort !== undefined ? { effort } : {}),
          },
  })
}

/** 「看图模型」分区：只列出能看图的模型 */
export function VisionSection({ view, busy, onWrite }: SectionProps) {
  const vision = view.models.filter((m) => {
    const p = view.providers.find((x) => x.name === m.provider)
    return p?.models.some((x) => x.model === m.model && x.images) ?? false
  })
  return (
    <>
      <div className="sec">看图模型</div>
      <div className="card">
        <SideSelect
          cls="vision-picker"
          label="看图模型"
          hint="主模型不能看图时，图片先交给它转成文字。只列出勾了「能看图」的模型。"
          empty="不转述（主模型自己看）"
          options={vision}
          value={view.visionModel}
          disabled={busy}
          onChange={(v) => setSide('visionModel', v, view.visionModel?.effort, onWrite)}
        />
        <EffortSelect
          cls="vision-effort"
          efforts={view.efforts}
          value={view.visionModel}
          disabled={busy}
          onPick={(e) => setSide('visionModel', view.visionModel, e, onWrite)}
        />
      </div>
    </>
  )
}

/** 「摘要模型」分区 */
export function SummarySection({ view, busy, onWrite }: SectionProps) {
  return (
    <>
      <div className="sec">摘要模型</div>
      <div className="card">
        <SideSelect
          cls="summary-picker"
          label="摘要模型"
          hint="后台写历史摘要用。选便宜、快的模型能省钱。"
          empty="跟对话模型一样"
          options={view.models}
          value={view.summaryModel}
          disabled={busy}
          onChange={(v) => setSide('summaryModel', v, view.summaryModel?.effort, onWrite)}
        />
        <EffortSelect
          cls="summary-effort"
          efforts={view.efforts}
          value={view.summaryModel}
          disabled={busy}
          onPick={(e) => setSide('summaryModel', view.summaryModel, e, onWrite)}
        />
      </div>
    </>
  )
}

/** 「记忆线索」分区：recall 开关 */
export function RecallSection({ view, busy, onWrite }: SectionProps) {
  return (
    <>
      <div className="sec">记忆线索</div>
      <div className="card">
        <div className="toggle-row">
          <div className="txt">
            <div>记忆线索（recall）</div>
            <div className="hint">
              每轮按你的话，从笔记、技能、事件里挑相关条目提示给 agent。每轮多一次副模型请求。
            </div>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={view.recallMode === 'on'}
            aria-label="记忆线索"
            disabled={busy}
            onClick={() => onWrite({ op: 'setRecall', on: view.recallMode !== 'on' })}
          />
        </div>
      </div>
    </>
  )
}

/** 「飞书推送」分区（im-gateway.md §5.6，2026-11-17 用户：推送开关「配置页面
 *  上也要有」）。值在 gateway/state.json 的 push 键，不在 settings.json——
 *  不走 onWrite；手机上 /推送 开|关 改的是同一个值。检测卡（2026-11-18 用户：
 *  lark-cli 坏了静默失效）显示安装/登录态，按钮跑 --version + auth status */
export function PushSection({
  on,
  onPush,
  larkCli,
  check,
  checking,
  onCheck,
}: {
  on: boolean
  onPush: (on: boolean) => void
  larkCli: string | null
  check: GatewayCheck | null
  checking: boolean
  onCheck: () => void
}) {
  const status =
    check === null
      ? '收发都走 lark-cli（装在网关配置写的路径上）。检测跑 --version 和 auth status。'
      : check.installed
        ? check.auth === 'ready'
          ? `✓ 已安装，登录正常（${check.version ?? ''}）`
          : check.auth === null
            ? `已安装（${check.version ?? ''}），但登录态读不到——在终端跑 lark-cli auth status 看`
            : `已安装（${check.version ?? ''}），登录态：${check.auth}`
        : `✗ lark-cli 不可用：${check.error ?? '跑不起来'}`
  return (
    <>
      <div className="sec">飞书推送</div>
      <div className="card">
        <div className="toggle-row">
          <div className="txt">
            <div>推送到手机</div>
            <div className="hint">
              {'开着时，完成、出错、审批卡都推到飞书，不管电脑前有没有人在看。' +
                '手机上发「/推送 开」「/推送 关」也能切换。'}
            </div>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={on}
            aria-label="飞书推送"
            onClick={() => onPush(!on)}
          />
        </div>
      </div>
      <div className="card">
        <div className="toggle-row">
          <div className="txt">
            <div>飞书连接（lark-cli）</div>
            <div className="hint">{larkCli ?? '网关配置里没写 larkCli'}</div>
            <div className="hint">{status}</div>
            {check !== null && !check.installed && (
              <div className="hint">
                安装：npm i -g @larksuite/cli，登录：lark-cli auth login；路径写进
                ~/.simple-code/gateway/config.json 的 larkCli。
              </div>
            )}
          </div>
          <button type="button" className="btn secondary" disabled={checking} onClick={onCheck}>
            {checking ? '检测中…' : '检测'}
          </button>
        </div>
      </div>
    </>
  )
}

export function RobotSection({
  robot,
  onRobot,
  onInstall,
}: {
  robot: { installed: boolean; on: boolean }
  onRobot: (on: boolean) => void
  onInstall: () => void
}) {
  if (!robot.installed)
    return (
      <>
        <div className="sec">桌面机器人</div>
        <div className="card">
          <div className="toggle-row">
            <div className="txt">
              <div>机器人插件未安装</div>
              <div className="hint">
                {'浮在屏幕上层的机器人：审批直接在它身上点允许，任务结束推结论第一句。' +
                  '点安装走 VS Code 市场，装完 Reload Window 后机器人出现。'}
              </div>
            </div>
            <button type="button" className="btn secondary" onClick={onInstall}>
              安装
            </button>
          </div>
        </div>
      </>
    )
  return (
    <>
      <div className="sec">桌面机器人</div>
      <div className="card">
        <div className="toggle-row">
          <div className="txt">
            <div>启用机器人</div>
            <div className="hint">
              {'关了就从屏幕上退出，VS Code 重启也不再拉起；命令面板的「开启/关闭桌面' +
                '机器人」与右键机器人菜单改的是同一个开关。'}
            </div>
          </div>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={robot.on}
            aria-label="桌面机器人"
            onClick={() => onRobot(!robot.on)}
          />
        </div>
      </div>
    </>
  )
}

/** 看图/摘要同构的下拉，只差 label/hint/候选。分区标题已写了名字，
 * label 不再重复显示，只给读屏用（aria-label）。弹层按服务商分节（同底栏
 * 模型选择器），触发器上带「服务商 / 模型」 */
function SideSelect({
  cls,
  label,
  hint,
  empty,
  options,
  value,
  disabled,
  onChange,
}: {
  cls: string
  label: string
  hint: string
  empty: string
  options: { provider: string; model: string }[]
  value: SideRef
  disabled: boolean
  onChange: (value: SideRef) => void
}) {
  const opts: DropdownOption<SideRef>[] = [
    { key: '', label: empty, payload: null },
    ...options.map((m) => ({
      key: refKey(m),
      label: m.model,
      section: m.provider,
      trigger: `${m.provider} / ${m.model}`,
      payload: m,
    })),
  ]
  return (
    <div className="side-row">
      <Dropdown
        cls={cls}
        ariaLabel={label}
        options={opts}
        selectedKey={refKey(value)}
        disabled={disabled}
        onPick={onChange}
      />
      <div className="hint">{hint}</div>
    </div>
  )
}

/** 副模型的推理档位（ref 上的 effort，schema sideModelRef，比主模型多一档
 *  none）。没选模型时不可选：effort 只挂在对象形态的引用上，删键回默认时
 *  一起删。2026-11-18 用户：「界面上加一个推理档位下拉框」 */
function EffortSelect({
  cls,
  efforts,
  value,
  disabled,
  onPick,
}: {
  cls: string
  efforts: SettingsView['efforts']
  value: SideModelView | null
  disabled: boolean
  onPick: (effort: Effort) => void
}) {
  const opts: DropdownOption<Effort>[] = [
    { key: '', label: '默认（沿用模型的推理设置）', payload: undefined },
    ...efforts.map((e) => ({ key: e, label: e === 'none' ? 'none（关推理）' : e, payload: e })),
  ]
  return (
    <div className="side-row">
      <div className="side-lab">推理档位</div>
      <Dropdown
        cls={cls}
        ariaLabel="推理档位"
        options={opts}
        selectedKey={value?.effort ?? ''}
        disabled={disabled || value === null}
        onPick={onPick}
      />
      <div className="hint">
        不选就沿用模型的推理设置（没配是 high）。none 是关推理，只有部分服务端支持，不支持的会报错。
      </div>
    </div>
  )
}
