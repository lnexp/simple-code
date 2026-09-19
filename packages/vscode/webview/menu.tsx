import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 手写轻量下拉。headless 库（base-ui Menu 那类）连 portal、collision
 * boundary、sticky 分节头都有——为「一列选项」引它不值：webview 至今
 * 零 UI 依赖（bundle 303KB），键盘/无障碍自己补 80 行就够了。
 * 形状：触发器 + 弹层 + 当前项打勾 + 分节标题。
 *
 * **弹层默认向上开**（触发器在输入框底栏，webview 最底部）。顶部的
 * FolderPicker 传 drop="down"——向上弹会飞出可视区，点了像没反应。
 *
 * 键盘：打开时焦点移进弹层（tabIndex=-1），方向键/Home/End 移动高亮，
 * Enter/空格选中，Escape/Tab 关闭并把焦点还给触发器。语义用
 * menuitemradio——两个选择器都是单选。
 */

/** 一行选项。payload 随选中回传，选择器不用再按下标反查 */
export type MenuOption<T> = {
  key: string
  label: string
  /** 副文案（如「默认」后面的「跟随配置（high）」），muted 小字 */
  sub?: string
  /** 有值则在该行前插一条节标题；相邻同值只出一条 */
  section?: string
  selected: boolean
  payload: T
}

/**
 * 选项序列 → 渲染行序列（节头 + 选项交错）。纯函数拎出来是为了可测：
 * 「相邻去重」这个逻辑在渲染里内联的话，改一次渲染就得真机验证一次
 */
export type MenuRow<T> = { head: string } | { opt: MenuOption<T>; at: number }

export const rowsOf = <T,>(options: MenuOption<T>[]): MenuRow<T>[] => {
  const rows: MenuRow<T>[] = []
  let prev: string | undefined
  for (const [at, opt] of options.entries()) {
    if (opt.section !== undefined && opt.section !== prev) rows.push({ head: opt.section })
    prev = opt.section
    rows.push({ opt, at })
  }
  return rows
}

export function Menu<T>({
  icon,
  cls,
  label,
  title,
  ariaLabel,
  disabled = false,
  on = false,
  drop = 'up',
  options,
  onPick,
}: {
  icon: string
  /** 挂在触发器上的类名（model-picker / effort-picker），测试和截断宽度都靠它 */
  cls: string
  label: string
  title?: string
  ariaLabel: string
  disabled?: boolean
  /** 手动覆盖过时点亮触发器（ctl-group data-on，同旧版） */
  on?: boolean
  /** 弹层方向。底栏选择器 up；顶部（folder-head）down */
  drop?: 'up' | 'down'
  options: MenuOption<T>[]
  onPick: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  /**
   * 打开瞬间把高亮放到当前选中项，焦点移进弹层。**不进依赖数组**：
   * options 每次渲染都是调用方现造的新数组，进了的话流式输出期间的
   * 每次重渲染都会把键盘移动重置回选中项
   */
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    if (!wasOpen.current) {
      const at = options.findIndex((o) => o.selected)
      setActive(at > 0 ? at : 0)
    }
    wasOpen.current = true
    listRef.current?.focus()
  })

  /** 点击弹层外关闭。pointerdown 而不是 click：后者会和选项的 onClick 抢 */
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  /** 高亮项滚进可视区（列表超过 max-height 时方向键导航用） */
  useEffect(() => {
    if (!open) return
    // jsdom 没实现 scrollIntoView，可选调用让接线测试能跑
    listRef.current?.querySelector(`[data-at="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  const pick = (at: number) => {
    const opt = options[at]
    if (opt === undefined) return
    setOpen(false)
    triggerRef.current?.focus()
    onPick(opt.payload)
  }

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open) return
    const n = options.length
    if (e.key === 'Escape') {
      setOpen(false)
      triggerRef.current?.focus()
      e.preventDefault()
    } else if (e.key === 'ArrowDown') {
      setActive((a) => (a + 1) % n)
      e.preventDefault()
    } else if (e.key === 'ArrowUp') {
      setActive((a) => (a - 1 + n) % n)
      e.preventDefault()
    } else if (e.key === 'Home') {
      setActive(0)
      e.preventDefault()
    } else if (e.key === 'End') {
      setActive(n - 1)
      e.preventDefault()
    } else if (e.key === 'Enter' || e.key === ' ') {
      pick(active)
      e.preventDefault()
    } else if (e.key === 'Tab') {
      // 不 preventDefault：让焦点自然离开，菜单收起就好
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="ctl-group picker" data-on={on} title={title} onKeyDown={onKey}>
      <button
        ref={triggerRef}
        type="button"
        className={`ctl trigger ${cls}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <i className={`codicon codicon-${icon}`} aria-hidden />
        <span className="trigger-label">{label}</span>
        <i className={`codicon codicon-chevron-${open ? 'up' : 'down'}`} aria-hidden />
      </button>
      {open && (
        <div ref={listRef} className={`menu ${cls} ${drop === 'down' ? 'drop-down' : ''}`} role="menu" aria-label={ariaLabel} tabIndex={-1}>
          {rowsOf(options).map((row) =>
            'head' in row ? (
              <div key={`h${row.head}`} className="menu-head">
                {row.head}
              </div>
            ) : (
              <div
                key={row.opt.key}
                data-at={row.at}
                className="menu-item"
                role="menuitemradio"
                aria-checked={row.opt.selected}
                data-active={active === row.at}
                onMouseEnter={() => setActive(row.at)}
                onClick={() => pick(row.at)}
              >
                <div className="menu-text">
                  <span className="menu-label">{row.opt.label}</span>
                  {row.opt.sub !== undefined && (
                    <span className="menu-sub">{row.opt.sub}</span>
                  )}
                </div>
                <i className="codicon codicon-check" aria-hidden />
              </div>
            ),
          )}
        </div>
      )}
    </div>
  )
}
