import { Menu, type MenuOption } from './menu.tsx'

/**
 * 设置页的下拉（看图/摘要模型、服务商、协议）：用底栏模型/推理深度同一个
 * 自绘 Menu（menu.tsx）。原生 select 的弹出列表在 macOS 上由系统绘制、不读
 * VS Code 主题色——深色主题里弹出白底列表（2026-11-17 用户截图）。
 * 触发器画成输入框样式（style.ts .set-dd），弹层向下、与触发器同宽。
 */

export type DropdownOption<T> = {
  key: string
  label: string
  /** 弹层里按它分节（如模型按服务商）；相邻同值只出一条节标题 */
  section?: string
  /** 触发器上显示的文字；不给用 label（分节后行内省掉的前缀要在这里补回） */
  trigger?: string
  payload: T
}

export function Dropdown<T>({
  cls,
  ariaLabel,
  options,
  selectedKey,
  disabled = false,
  bad = false,
  onPick,
}: {
  /** 挂在触发器与弹层上的类名（vision-picker 等），测试按它找 */
  cls: string
  ariaLabel: string
  options: DropdownOption<T>[]
  selectedKey: string
  disabled?: boolean
  /** 校验不过：触发器描红（同输入框的 .bad） */
  bad?: boolean
  onPick: (value: T) => void
}) {
  const shown = options.find((o) => o.key === selectedKey)
  const menuOptions: MenuOption<T>[] = options.map((o) => ({
    key: o.key,
    label: o.label,
    ...(o.section !== undefined ? { section: o.section } : {}),
    selected: o.key === selectedKey,
    payload: o.payload,
  }))
  return (
    <Menu
      cls={`set-dd ${cls}${bad ? ' bad' : ''}`}
      ariaLabel={ariaLabel}
      label={shown?.trigger ?? shown?.label ?? ''}
      drop="down"
      disabled={disabled}
      options={menuOptions}
      onPick={onPick}
    />
  )
}
