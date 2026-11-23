// @vitest-environment jsdom
import type { SettingsView } from '@simple-code/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToHost, ToWebview } from '../src/protocol.ts'
import { App } from '../webview/App.tsx'

/**
 * 设置页从最外层驱动的接线（同 current-file-wiring 范式）：齿轮入口、
 * 首开表单代替红框报错、写回消息、被引用模型的删除拦截。
 */

const sent: ToHost[] = []
let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
  sent.length = 0
})

function mount() {
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => ({ postMessage: (msg: unknown) => sent.push(msg as ToHost) }),
    configurable: true,
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(createElement(App)))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  const send = (msg: ToWebview): void =>
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: msg }))
    })
  const el = (sel: string): HTMLElement | null => host.querySelector(sel)
  const all = (sel: string): HTMLElement[] => [...host.querySelectorAll(sel)] as HTMLElement[]
  const click = (target: HTMLElement | null | undefined): void => {
    if (target === null || target === undefined) throw new Error(`点不到：节点没渲染`)
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  const input = (
    target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    value: string,
  ): void => {
    act(() => {
      const proto =
        target instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : target instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : (HTMLTextAreaElement.prototype as object)
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value)
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }
  const check = (target: HTMLInputElement, on: boolean): void => {
    act(() => {
      // jsdom 对 checkbox 的 click 会翻 checked，React 的 onChange 正好挂在这
      // 条路径上——不要先手动设 checked（会把这一翻抵消掉）
      if (target.checked !== on) target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }
  /** 设置页下拉（settings-dropdown.tsx 自绘 Menu）：点开触发器、按文字点一项 */
  const pick = (cls: string, label: string): void => {
    click(el(`.trigger.${cls}`))
    click(
      all(`.menu.${cls} .menu-item`).find(
        (i) => i.querySelector('.menu-label')?.textContent === label,
      ),
    )
  }
  return { send, el, all, click, input, check, pick, sent: () => sent, host }
}

const state: ToWebview = {
  type: 'state',
  running: false,
  folder: '/proj',
  current: { provider: 'p', model: 'm1' },
  models: [
    { provider: 'p', model: 'm1' },
    { provider: 'p', model: 'm2' },
  ],
  effort: 'high',
  effortOverridden: false,
  presets: [],
  attendance: 'attended',
  summaryInContext: true,
  imagesEnabled: false,
  contextWindow: 200_000,
}

const folders: ToWebview = {
  type: 'folders',
  folders: [{ path: '/proj/simple-code', running: false, pendingApprovals: 0 }],
  active: '/proj/simple-code',
}

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  missing: false,
  error: null,
  path: '/home/u/.simple-code/settings.json',
  defaultRef: { provider: 'p', model: 'm1' },
  visionModel: { provider: 'p', model: 'm2' },
  summaryModel: null,
  recallMode: null,
  providers: [
    {
      name: 'p',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.test',
      apiKey: { kind: 'env', name: 'MY_KEY' },
      models: [
        { model: 'm1', contextWindow: 200_000, images: false, advanced: ['presets'] },
        { model: 'm2', contextWindow: 128_000, images: true, advanced: [] },
      ],
    },
  ],
  models: [
    { provider: 'p', model: 'm1' },
    { provider: 'p', model: 'm2' },
  ],
  protocols: ['anthropic-messages', 'openai-chat', 'openai-responses'],
  efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  ...over,
})

describe('齿轮入口与目录栏', () => {
  it('单文件夹也显示目录栏：一个 tab + 最右齿轮', () => {
    const t = mount()
    t.send(state)
    t.send(folders)
    const tabs = t.all('.folder-tab')
    // 单 tab + 齿轮（齿轮也是 folder-tab 类）
    expect(tabs.length).toBe(2)
    expect(t.el('.folder-gear')?.getAttribute('aria-label')).toBe('设置')
    // 对话主体还在（没开设置页）
    expect(t.el('.composer')).not.toBeNull()
  })

  it('点齿轮发 settings_get、主区换成设置页；再点返回对话', () => {
    const t = mount()
    t.send(state)
    t.send(folders)
    t.click(t.el('.folder-gear'))
    expect(t.sent().at(-1)).toEqual({ type: 'settings_get' })
    t.send({ type: 'settings_view', view: view() })
    expect(t.el('.page-head .title')?.textContent).toBe('设置')
    // 目录栏（含齿轮）必须在 .page 前面：.page 是 flex:1，排到它前面
    // 会把目录栏压到面板底部（e4b4b91 回归，主任务实测退回）
    const head = t.el('.folder-head')
    const page = t.el('.page')
    expect(
      (head?.compareDocumentPosition(page ?? document.body) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // Composer 不卸载（保草稿），只是整块隐藏
    expect(t.el('.composer')).not.toBeNull()
    expect((t.el('.conversation') as HTMLElement).style.display).toBe('none')
    t.click(t.el('.folder-gear'))
    expect(t.el('.composer')).not.toBeNull()
    expect((t.el('.conversation') as HTMLElement).style.display).toBe('contents')
  })

  it('进设置页再返回：输入框草稿还在（Composer 不卸载）', () => {
    const t = mount()
    t.send(state)
    t.send(folders)
    const ta = t.el('.composer textarea') as HTMLTextAreaElement
    t.input(ta, '写了一半还没发')
    t.click(t.el('.folder-gear'))
    t.send({ type: 'settings_view', view: view() })
    expect((t.el('.conversation') as HTMLElement).style.display).toBe('none')
    t.click(t.el('.folder-gear'))
    expect((t.el('.conversation') as HTMLElement).style.display).toBe('contents')
    const back = t.el('.composer textarea') as HTMLTextAreaElement
    expect(back).toBe(ta) // 同一节点 = 没重挂，state 没丢
    expect(back.value).toBe('写了一半还没发')
  })

  it('多文件夹：齿轮排在溢出按钮之后（DOM 顺序）', () => {
    const t = mount()
    t.send(state)
    t.send({
      type: 'folders',
      folders: ['/proj/a', '/proj/b', '/proj/c'].map((path) => ({
        path,
        running: false,
        pendingApprovals: 0,
      })),
      active: '/proj/a',
    })
    const head = t.el('.folder-head')
    const children = [...(head?.children ?? [])]
    // tabs 容器在前，齿轮是最后一个孩子
    expect(children[0]?.className).toContain('folder-tabs')
    expect(children.at(-1)?.className).toContain('folder-gear')
  })
})

describe('设置页列表', () => {
  const open = (over: Partial<SettingsView> = {}) => {
    const t = mount()
    t.send(state)
    t.send(folders)
    t.click(t.el('.folder-gear'))
    t.send({ type: 'settings_view', view: view(over) })
    return t
  }
  /** 点左栏分区（按文字找，左栏是两栏改版后进看图/摘要/记忆线索的唯一入口） */
  const goSection = (t: ReturnType<typeof open>, label: string): void =>
    t.click(t.all('.snav-item').find((b) => b.textContent === label))

  it('左右两栏：默认停在「模型」，右栏只显示选中分区；点左栏换内容', () => {
    const t = open()
    const labels = t.all('.snav-item').map((b) => b.textContent)
    expect(labels).toEqual(['模型', '看图模型', '摘要模型', '记忆线索'])
    expect(t.el('.snav-item[aria-current="page"]')?.textContent).toBe('模型')
    expect(t.all('.row').length).toBe(2)
    expect(t.el('.trigger.vision-picker')).toBeNull()
    expect(t.el('.switch')).toBeNull()
    // 页脚按分区（2026-11-18）：模型讲导引+字段清单，摘要讲摘要开关，
    // 其余分区没有页脚，项目级提示在页头那行
    expect(t.el('.foot')?.textContent).toContain('推理档位')
    expect(t.el('.page-sub')?.textContent).toContain('项目级 .simple-code/settings.json')
    goSection(t, '摘要模型')
    expect(t.el('.snav-item[aria-current="page"]')?.textContent).toBe('摘要模型')
    expect(t.el('.trigger.summary-picker')).not.toBeNull()
    expect(t.all('.row').length).toBe(0)
    expect(t.el('.trigger.vision-picker')).toBeNull()
    expect(t.el('.foot')?.textContent).toContain('历史摘要开关')
    goSection(t, '记忆线索')
    expect(t.el('.foot')).toBeNull()
  })

  it('飞书推送：网关启用（gateway_push 非 null）才多出这一项；开关发 gateway_push_set', () => {
    const t = open()
    t.send({ type: 'gateway_push', on: true })
    expect(t.all('.snav-item').map((b) => b.textContent)).toEqual([
      '模型',
      '看图模型',
      '摘要模型',
      '记忆线索',
      '飞书推送',
    ])
    goSection(t, '飞书推送')
    const sw = t.el('.switch')
    expect(sw?.getAttribute('aria-checked')).toBe('true')
    // 飞书推送分区没有页脚（页脚只放本分区相关的导引，2026-11-18）
    expect(t.el('.foot')).toBeNull()
    t.click(sw)
    expect(t.sent().at(-1)).toEqual({ type: 'gateway_push_set', on: false })
    t.send({ type: 'gateway_push', on: false })
    expect(t.el('.switch')?.getAttribute('aria-checked')).toBe('false')
    // 网关被关掉（config 改了）→ null：这一项消失，右栏退回模型内容
    t.send({ type: 'gateway_push', on: null })
    expect(t.all('.snav-item').map((b) => b.textContent)).not.toContain('飞书推送')
    expect(t.all('.row').length).toBe(2)
  })

  it('飞书推送：检测按钮发 gateway_check，结果回填显示登录态；失败显示原因与安装提示', () => {
    const t = open()
    t.send({ type: 'gateway_push', on: true, larkCli: '/nvm/bin/lark-cli' })
    goSection(t, '飞书推送')
    // 检测卡：路径来自 gateway_push，未检测时只有说明行
    expect(t.el('.sbody-in')?.textContent).toContain('/nvm/bin/lark-cli')
    expect(t.el('.sbody-in')?.textContent).not.toContain('登录正常')
    const btn = t.all('.btn').find((b): b is HTMLButtonElement => b.textContent === '检测')
    t.click(btn)
    expect(t.sent().at(-1)).toEqual({ type: 'gateway_check' })
    // 检测中：按钮禁用、文案换
    expect(btn?.textContent).toBe('检测中…')
    expect(btn?.disabled).toBe(true)
    t.send({
      type: 'gateway_check_result',
      result: {
        larkCli: '/nvm/bin/lark-cli',
        installed: true,
        version: 'lark-cli version 1.0.97',
        auth: 'ready',
      },
    })
    expect(t.el('.sbody-in')?.textContent).toContain('已安装，登录正常')
    expect(btn?.disabled).toBe(false)
    // 不可用（路径悬空）：原因 + 安装提示
    t.send({
      type: 'gateway_check_result',
      result: { larkCli: '/nvm/bin/lark-cli', installed: false, error: 'spawn ENOENT' },
    })
    const body = t.el('.sbody-in')?.textContent ?? ''
    expect(body).toContain('✗ lark-cli 不可用：spawn ENOENT')
    expect(body).toContain('npm i -g @larksuite/cli')
  })

  it('桌面机器人：mac 已装显示开关，点击发 robot_toggle；robot_state 更新；非 mac 分区消失', () => {
    const t = open()
    t.send({ type: 'robot_state', mac: true, installed: true, on: true })
    expect(t.all('.snav-item').map((b) => b.textContent)).toContain('桌面机器人')
    goSection(t, '桌面机器人')
    const sw = t.el('.switch')
    expect(sw?.getAttribute('aria-checked')).toBe('true')
    t.click(sw)
    expect(t.sent().at(-1)).toEqual({ type: 'robot_toggle', on: false })
    // 关要等 app 退出（最多 3s），期间开关停旧值，robot_state 回推才翻
    t.send({ type: 'robot_state', mac: true, installed: true, on: false })
    expect(t.el('.switch')?.getAttribute('aria-checked')).toBe('false')
    // 非 mac（robot_state mac=false）：整个分区不显示
    t.send({ type: 'robot_state', mac: false, installed: false, on: true })
    expect(t.all('.snav-item').map((b) => b.textContent)).not.toContain('桌面机器人')
  })

  it('桌面机器人：未装显示安装按钮，点击发 robot_install；装完换成开关', () => {
    const t = open()
    t.send({ type: 'robot_state', mac: true, installed: false, on: true })
    goSection(t, '桌面机器人')
    expect(t.el('.switch')).toBeNull()
    expect(t.el('.sbody-in')?.textContent).toContain('未安装')
    const btn = t.all('.btn').find((b): b is HTMLButtonElement => b.textContent === '安装')
    t.click(btn)
    expect(t.sent().at(-1)).toEqual({ type: 'robot_install' })
    // 装完 robot_state 回推 installed=true：按钮接替成开关
    t.send({ type: 'robot_state', mac: true, installed: true, on: true })
    expect(t.el('.switch')?.getAttribute('aria-checked')).toBe('true')
  })

  it('即改即存写回成功后停在原分区，不跳回「模型」；表单取消回来左栏还在', () => {
    const t = open()
    goSection(t, '看图模型')
    t.pick('vision-picker', 'm2')
    t.send({ type: 'settings_result', ok: true, view: view() })
    expect(t.el('.snav-item[aria-current="page"]')?.textContent).toBe('看图模型')
    expect(t.el('.trigger.vision-picker')).not.toBeNull()
    goSection(t, '模型')
    t.click(t.all('.row')[1])
    expect(t.el('.snav')).toBeNull() // 表单仍是整页
    t.click(t.all('button').find((b) => b.textContent?.trim() === '取消'))
    expect(t.el('.snav-item[aria-current="page"]')?.textContent).toBe('模型')
  })

  it('模型卡：协议、host、密钥形态、高级参数标记、默认、看图图标', () => {
    const t = open()
    expect(t.el('.prov-head .name')?.textContent).toBe('p')
    expect(t.el('.prov-head .meta')?.textContent).toContain('anthropic-messages')
    expect(t.el('.prov-key')?.textContent).toContain('环境变量 MY_KEY')
    const rows = t.all('.row')
    expect(rows.length).toBe(2)
    expect(rows[0]?.textContent).toContain('高级参数')
    expect(rows[0]?.textContent).toContain('默认')
    expect(rows[1]?.querySelector('.codicon-eye')).not.toBeNull()
  })

  it('换看图模型下拉 → setSide 写回（对象形态）', () => {
    // 先验形态：自绘下拉（原生 select 的弹出列表 macOS 上是白底，2026-11-17）
    const s = open({ summaryModel: { provider: 'p', model: 'm2' } })
    goSection(s, '摘要模型')
    expect(s.all('select')).toHaveLength(0)
    expect(s.el('.trigger.summary-picker .trigger-label')?.textContent).toBe('p / m2')
    s.click(s.el('.trigger.summary-picker'))
    expect(s.all('.menu.summary-picker .menu-head').map((h) => h.textContent)).toEqual(['p'])
    expect(
      s.all('.menu.summary-picker .menu-item[aria-checked="true"] .menu-label')[0]?.textContent,
    ).toBe('m2')

    const t = open()
    goSection(t, '看图模型')
    t.pick('vision-picker', 'm2')
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: { op: 'setSide', key: 'visionModel', value: { provider: 'p', model: 'm2' } },
    })
  })

  it('摘要模型选「跟对话模型一样」→ setSide null（删键回默认）', () => {
    const t = open({ summaryModel: { provider: 'p', model: 'm2' } })
    goSection(t, '摘要模型')
    t.pick('summary-picker', '跟对话模型一样')
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: { op: 'setSide', key: 'summaryModel', value: null },
    })
  })

  it('推理档位下拉：显示当前 effort；选一档写回；选「默认」去掉 effort', () => {
    // 11-18 用户：「界面上加一个推理档位下拉框」——摘要模型的 effort:"none" 原先改一次就丢
    const t = open({ summaryModel: { provider: 'p', model: 'm2', effort: 'none' } })
    goSection(t, '摘要模型')
    expect(t.el('.trigger.summary-effort .trigger-label')?.textContent).toBe('none（关推理）')
    t.pick('summary-effort', 'high')
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: {
        op: 'setSide',
        key: 'summaryModel',
        value: { provider: 'p', model: 'm2', effort: 'high' },
      },
    })
    // 写回期间下拉禁用（busy），宿主回执后才能再选
    t.send({
      type: 'settings_result',
      ok: true,
      view: view({ summaryModel: { provider: 'p', model: 'm2', effort: 'high' } }),
    })
    expect(t.el('.trigger.summary-effort .trigger-label')?.textContent).toBe('high')
    t.pick('summary-effort', '默认（沿用模型的推理设置）')
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: { op: 'setSide', key: 'summaryModel', value: { provider: 'p', model: 'm2' } },
    })
  })

  it('换摘要模型带着当前推理档位（不丢 effort）；看图模型同样有档位下拉', () => {
    const t = open({ summaryModel: { provider: 'p', model: 'm2', effort: 'none' } })
    goSection(t, '摘要模型')
    t.pick('summary-picker', 'm1')
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: {
        op: 'setSide',
        key: 'summaryModel',
        value: { provider: 'p', model: 'm1', effort: 'none' },
      },
    })
    goSection(t, '看图模型')
    expect(t.el('.trigger.vision-effort .trigger-label')?.textContent).toBe(
      '默认（沿用模型的推理设置）',
    )
  })

  it('没选摘要模型（跟对话模型一样）时推理档位不可选——effort 挂在模型引用上', () => {
    const t = open()
    goSection(t, '摘要模型')
    expect((t.el('.trigger.summary-effort') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('recall 开关 → setRecall on（没写 = 默认关，拨一下是开）', () => {
    const t = open()
    goSection(t, '记忆线索')
    t.click(t.el('.switch'))
    expect(t.sent().at(-1)).toEqual({ type: 'settings_write', edit: { op: 'setRecall', on: true } })
    const on = open({ recallMode: 'on' })
    goSection(on, '记忆线索')
    on.click(on.el('.switch'))
    expect(on.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: { op: 'setRecall', on: false },
    })
  })

  it('settings.json 按钮 → settings_openFile', () => {
    const t = open()
    t.click(
      t.all('.page-head .icon-btn').find((b) => b.textContent?.includes('settings.json')) ?? null,
    )
    expect(t.sent().at(-1)).toEqual({ type: 'settings_openFile' })
  })

  it('点模型行进编辑表单：改窗口 + 设默认保存 → editModel 写回', () => {
    const t = open()
    t.click(t.all('.row')[1])
    expect(t.all('.page-head .title').some((x) => x.textContent?.includes('编辑 m2'))).toBe(true)
    t.input(t.el('input[type=number]') as HTMLInputElement, '64000')
    const def = t.all('input[type=checkbox]')[1] as HTMLInputElement | undefined
    if (!def) throw new Error('设默认勾框没渲染')
    t.check(def, true)
    ;(t.all('.btns .btn')[0] as HTMLElement).click()
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: {
        op: 'editModel',
        provider: 'p',
        model: 'm2',
        contextWindow: 64000,
        images: true,
        makeDefault: true,
      },
    })
  })

  it('被引用模型不让删：默认模型的删除被拦，无写回', () => {
    const t = open()
    t.click(t.all('.row')[0]) // m1 = 默认
    const danger = t.el('.btn.danger')
    if (danger === null) throw new Error('删除按钮没渲染')
    t.click(danger)
    expect(t.sent().filter((m) => m.type === 'settings_write')).toHaveLength(0)
    expect(t.host.textContent).toContain('它现在是默认模型')
  })

  it('普通模型可删：发 deleteModel', () => {
    const t = open({ visionModel: null, summaryModel: null }) // m2 没被引用
    t.click(t.all('.row')[1])
    const danger = t.el('.btn.danger')
    if (danger === null) throw new Error('删除按钮没渲染')
    t.click(danger)
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: { op: 'deleteModel', provider: 'p', model: 'm2' },
    })
  })

  it('添加模型：选已有服务商 → 四项字段收起、只剩模型三项', () => {
    const t = open()
    t.click(t.el('.add-row .icon-btn'))
    const labels = t.all('.field > label').map((l) => l.textContent)
    expect(labels).toEqual(['服务商', '模型名', '上下文窗口'])
  })

  it('添加模型：选新服务商 → 服务商名称/协议/Base URL/API Key 出现', () => {
    const t = open()
    t.click(t.el('.add-row .icon-btn'))
    t.pick('provider-picker', '新服务商…')
    const labels = t.all('.field > label').map((l) => l.textContent)
    expect(labels).toEqual([
      '服务商',
      '服务商名称',
      '协议',
      'Base URL',
      'API Key',
      '模型名',
      '上下文窗口',
    ])
  })

  it('编辑服务商：协议/地址/密钥留空不改', () => {
    const t = open()
    t.click(t.el('.prov-head .icon-btn'))
    expect(t.all('.page-head .title').some((x) => x.textContent?.includes('编辑服务商 p'))).toBe(
      true,
    )
    const inputs = t.all('input')
    t.input(inputs[0] as HTMLInputElement, 'https://api2.test')
    ;(t.all('.btns .btn')[0] as HTMLElement).click()
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: {
        op: 'editProvider',
        name: 'p',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api2.test',
      },
    })
  })
})

describe('首开表单（缺配置）', () => {
  it('settings_view.missing → 代替对话主区显示表单，不发 fatal 红框', () => {
    const t = mount()
    t.send(folders)
    t.send({
      type: 'settings_view',
      view: view({
        missing: true,
        providers: [],
        models: [],
        defaultRef: null,
        visionModel: null,
      }),
    })
    expect(t.el('.welcome .t')?.textContent).toContain('还没有配置模型')
    // 首开也不卸 Composer——草稿不因缺配置丢掉，只是隐藏
    expect(t.el('.composer')).not.toBeNull()
    expect((t.el('.conversation') as HTMLElement).style.display).toBe('none')
    expect(t.el('.fatal')).toBeNull()
  })

  it('必填校验：空表单点「保存并开始」→ 错误提示、无写回', () => {
    const t = mount()
    t.send(folders)
    t.send({ type: 'settings_view', view: view({ missing: true, providers: [], models: [] }) })
    const save = t.all('.btns .btn')[0] as HTMLElement
    t.click(save)
    expect(t.sent().filter((m) => m.type === 'settings_write')).toHaveLength(0)
    const errs = t.all('.field .err').map((e) => e.textContent)
    expect(errs).toContain('必填')
  })

  it('按 README 示例填好保存 → firstSave 写回；ok 后回对话 + notice', () => {
    const t = mount()
    t.send(folders)
    t.send({ type: 'settings_view', view: view({ missing: true, providers: [], models: [] }) })
    const inputs = t.all('input')
    t.input(inputs[0] as HTMLInputElement, 'deepseek') // 服务商名称
    t.pick('protocol-picker', 'openai-chat') // 协议
    t.input(inputs[1] as HTMLInputElement, 'https://api.deepseek.com') // baseUrl
    t.input(inputs[2] as HTMLInputElement, '${DEEPSEEK_KEY}') // apiKey
    t.input(inputs[3] as HTMLInputElement, 'deepseek-flash') // 模型名
    t.input(inputs[4] as HTMLInputElement, '1000000') // 上下文窗口
    t.click(t.all('.btns .btn')[0] as HTMLElement)
    expect(t.sent().at(-1)).toEqual({
      type: 'settings_write',
      edit: {
        op: 'firstSave',
        name: 'deepseek',
        protocol: 'openai-chat',
        baseUrl: 'https://api.deepseek.com',
        apiKey: '${DEEPSEEK_KEY}',
        model: 'deepseek-flash',
        contextWindow: 1_000_000,
        images: false,
      },
    })
    // 宿主回 ok + 新视图（missing 翻 false）→ 对话回来，带一条 notice
    t.send({ type: 'settings_result', ok: true, view: view() })
    expect(t.el('.composer')).not.toBeNull()
    expect(t.host.textContent).toContain('已写入')
    expect(t.host.textContent).toContain('模型配好了')
  })

  it('保存失败 → 停在表单里，错误可见', () => {
    const t = mount()
    t.send(folders)
    t.send({ type: 'settings_view', view: view({ missing: true, providers: [], models: [] }) })
    const inputs = t.all('input')
    t.input(inputs[0] as HTMLInputElement, 'deepseek')
    t.pick('protocol-picker', 'openai-chat')
    t.input(inputs[1] as HTMLInputElement, 'https://api.deepseek.com')
    t.input(inputs[2] as HTMLInputElement, 'k')
    t.input(inputs[3] as HTMLInputElement, 'deepseek-flash')
    t.input(inputs[4] as HTMLInputElement, '1000000')
    t.click(t.all('.btns .btn')[0] as HTMLElement)
    t.send({ type: 'settings_result', ok: false, error: '已经存在，不能走首开表单' })
    expect(t.el('.welcome')).not.toBeNull()
    expect(t.host.textContent).toContain('已经存在')
  })
})
