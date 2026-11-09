// 卡片内容、按钮动作、右键/菜单栏菜单（desktop-robot.md §5.2–§5.5）
import Cocoa
import ApplicationServices

/// 辅助功能授权提示只弹一次
private var axPrompted = false

final class FocusTarget: NSObject {
  let fd: Int32, folder: String?, task: String?
  init(_ fd: Int32, _ folder: String?, _ task: String?) { self.fd = fd; self.folder = folder; self.task = task }
}

extension AppDelegate {
  /// 审批卡：项目·任务、命令、允许。弹卡原因放悬停提示；倒计时只在剩不到 1 分钟时出现
  func approvalCard(_ c: Conn, _ it: [String: Any]) -> NSView {
    let key = it["key"] as? String ?? ""
    let folder = it["folder"] as? String, task = it["task"] as? String
    let id = NSUserInterfaceItemIdentifier(key)
    let dot = textLabel("●", size: 10, color: kindColor["approval"]!)
    let title = textLabel("\(baseName(folder)) · \(task ?? "主任务")", size: 11.5, weight: .medium, color: .secondaryLabelColor)
    let left = textLabel("", size: 11, mono: true, color: .systemOrange)
    if let d = parseISO(it["expiresAt"] as? String) { countdowns.append((left, d)) }
    var rows: [NSView] = [hRow([dot, title], right: [left])]
    if let note = failNotes[key] {
      rows.append(textLabel("✕ \(note)", size: 12.5, weight: .medium, color: .systemRed))
    } else {
      rows.append(textLabel(it["command"] as? String ?? "", size: 12, mono: true, color: .labelColor, lines: 2))
      let back = linkButton("回窗口", target: self, action: #selector(backClicked(_:)))
      back.identifier = id
      // D1（用户定 2026-10-31）：git push、gh、askCommands、出网命令只能回窗口处理，由 SC 判好
      if (it["canAllow"] as? Bool) == true {
        let allow = fillButton("允许", bg: .systemBlue, target: self, action: #selector(allowClicked(_:)))
        allow.identifier = id
        allow.isEnabled = Date().timeIntervalSince(firstSeen[key] ?? .distantPast) >= 1
        allowButtons.append((allow, key))
        rows.append(hRow([allow, back]))
      } else {
        rows.append(hRow([back], right: [textLabel("这类命令要在窗口里处理", size: 11, color: .tertiaryLabelColor)]))
      }
    }
    let card = cardShell(rows) { [weak self, weak c] in if let c { self?.focus(c, folder, task) } }
    card.toolTip = it["reason"] as? String
    return card
  }

  /// 完成/出错：一行。收起时当气泡用（10 秒后收掉），展开列表里也是这一行
  func noticeRow(_ c: Conn, _ it: [String: Any]) -> NSView {
    let kind = it["kind"] as? String ?? ""
    let key = it["key"] as? String ?? ""
    let folder = it["folder"] as? String, task = it["task"] as? String
    let dot = textLabel("●", size: 10, color: kindColor[kind] ?? .gray)
    dot.setContentCompressionResistancePriority(.required, for: .horizontal)   // 文字长时圆点不能被挤没
    let text = textLabel("\(baseName(folder))：\(it["headline"] as? String ?? "")", size: 12.5, weight: .medium, lines: 2)
    text.preferredMaxLayoutWidth = cardWidth - 70
    let x = FirstClickButton(title: "✕", target: self, action: #selector(dismissClicked(_:)))
    x.isBordered = false
    x.identifier = NSUserInterfaceItemIdentifier(key)
    let card = cardShell([hRow([dot, text], right: [x])]) { [weak self, weak c] in if let c { self?.focus(c, folder, task) } }
    card.toolTip = "\(baseName(folder)) · \(task ?? "主任务") · \(kindLabel[kind] ?? kind)\n\(it["detail"] as? String ?? "")"
    return card
  }

  /// 「还有 N 条 ▾」/「收起 ▴」：贴在机器人上方右侧
  func footerPill(_ title: String) -> NSView {
    let b = fillButton(title, bg: NSColor(white: 0.16, alpha: 0.92), size: 11.5, target: self, action: #selector(toggleExpand))
    b.padX = 10
    b.height = 22
    return b
  }

  @objc func toggleExpand() {
    expanded.toggle()
    refresh()
  }

  func find(_ key: String) -> (Conn, [String: Any])? {
    for c in server.conns.values {
      if let it = c.items.first(where: { ($0["key"] as? String) == key }) { return (c, it) }
    }
    return nil
  }

  /// 跳转（§5.5）：先让窗口到前台，再沿同一条连接让 SC 展开面板、切目录、选任务。
  /// VS Code：open 它自己的身份路径，VS Code 找到已开的窗口就聚焦它，不新开。
  /// 其他宿主（Cursor 等）：3.27 起 open 文件夹会被发给一个新的 agent window
  /// （2026-11-02 官方论坛确认 known behavior），改用 AX 按窗口标题提窗，
  /// 完全不经过 open；提不了（无授权/找不到窗口）就只到激活应用为止
  func focus(_ c: Conn, _ folder: String?, _ task: String?) {
    let ws = NSWorkspace.shared
    let app = c.appPath.map { URL(fileURLWithPath: $0) } ?? ws.urlForApplication(withBundleIdentifier: vscodeID)
    if let app {
      let oc = NSWorkspace.OpenConfiguration()
      oc.activates = true
      if (Bundle(url: app)?.bundleIdentifier ?? vscodeID).hasPrefix("com.microsoft.VSCode") {
        if let p = c.windowPath {
          ws.open([URL(fileURLWithPath: p)], withApplicationAt: app, configuration: oc) { _, err in
            if let err { log("open \(p) failed: \(err.localizedDescription)") }
          }
        } else {
          ws.openApplication(at: app, configuration: oc) { _, err in
            if let err { log("activate app failed: \(err.localizedDescription)") }
          }
        }
      } else {
        raiseWindow(app, oc, c.windowName)
      }
    }
    c.send(["type": "focus", "folder": folder ?? NSNull(), "task": task ?? NSNull()])
    log("focus pid=\(c.pid) folder=\(baseName(folder)) task=\(task ?? "主任务")")
  }

  /// AX 提窗：激活应用后按标题找出连接对应的编辑器窗口（形如「文件 — 目录」「目录 — App」），
  /// 还原最小化、AXRaise、设为 main。只激活不 open 路径——那会被 Cursor 开成 agent window。
  /// workspace.name 对工作区文件带「 (Workspace)」后缀，窗口标题不带（如
  /// 「file — ultradata-acquire — Cursor」），contains 会永远匹配不上——先剥掉再比
  private func raiseWindow(_ app: URL, _ oc: NSWorkspace.OpenConfiguration, _ windowName: String) {
    guard let bundleId = Bundle(url: app)?.bundleIdentifier,
          let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
      log("raise: \(app.lastPathComponent) 没在跑")
      return
    }
    if !AXIsProcessTrusted() && !axPrompted {
      axPrompted = true   // 只提示一次，别每次点击都弹系统设置
      let o = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(o)
    }
    NSWorkspace.shared.openApplication(at: app, configuration: oc) { _, err in
      if let err { log("raise: activate failed \(err.localizedDescription)") }
      Thread.sleep(forTimeInterval: 0.15)   // 等应用到前台，避免提窗和激活竞争
      let axApp = AXUIElementCreateApplication(running.processIdentifier)
      var winsRef: CFTypeRef?
      guard AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &winsRef) == .success,
            let wins = winsRef as? [AXUIElement] else { return log("raise: 拿不到窗口（缺辅助功能授权？）") }
      let key = windowName.hasSuffix(" (Workspace)")
        ? String(windowName.dropLast(" (Workspace)".count)) : windowName
      var hit: AXUIElement?
      for w in wins {
        var sub: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXSubroleAttribute as CFString, &sub) == .success,
              (sub as? String) == "AXStandardWindow" else { continue }
        var t: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t) == .success,
              let title = t as? String, !title.isEmpty else { continue }
        if title == key { hit = w; break }
        if hit == nil && title.contains(key) { hit = w }
      }
      guard let win = hit else { return log("raise: 没有标题含「\(key)」的窗口") }
      var mini: CFTypeRef?
      if AXUIElementCopyAttributeValue(win, kAXMinimizedAttribute as CFString, &mini) == .success,
         (mini as? Bool) == true {
        AXUIElementSetAttributeValue(win, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
      }
      AXUIElementPerformAction(win, "AXRaise" as CFString)
      AXUIElementSetAttributeValue(win, kAXMainAttribute as CFString, kCFBooleanTrue)
      log("raise: 「\(windowName)」已提到前台")
    }
  }

  func robotClicked() {
    if let (c, it) = allItems.first { focus(c, it["folder"] as? String, it["task"] as? String) }
  }

  @objc func allowClicked(_ b: NSButton) {
    guard let key = b.identifier?.rawValue, let (c, _) = find(key) else { return }
    if Date().timeIntervalSince(firstSeen[key] ?? .distantPast) < 1 { log("allow ignored <1s"); return }
    b.isEnabled = false
    b.title = "处理中…"
    let ref = nextRef
    nextRef += 1
    pending[ref] = (c, key)
    c.send(["type": "allow", "ref": ref, "key": key])
    log("allow sent ref=\(ref) key=\(key)")
  }

  /// ok：SC 随后推的 status 里卡就没了，这里不用动。失败（卡已被处理/超时）：那一行显示原因 2 秒后消失
  func ackReceived(_ m: [String: Any]) {
    guard let ref = m["ref"] as? Int, let (c, key) = pending.removeValue(forKey: ref) else { return }
    let ok = m["ok"] as? Bool ?? false
    log("ack ref=\(ref) ok=\(ok) reason=\(m["reason"] ?? "")")
    if ok { return }
    failNotes[key] = m["reason"] as? String ?? "未能处理"
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      self?.failNotes[key] = nil
      c.items.removeAll { ($0["key"] as? String) == key }
      self?.refresh()
    }
  }

  @objc func backClicked(_ b: NSButton) {
    guard let key = b.identifier?.rawValue, let (c, it) = find(key) else { return }
    focus(c, it["folder"] as? String, it["task"] as? String)
  }

  @objc func dismissClicked(_ b: NSButton) {
    guard let key = b.identifier?.rawValue, let (c, _) = find(key) else { return }
    c.items.removeAll { ($0["key"] as? String) == key }
    c.send(["type": "dismiss", "key": key])
    log("dismiss \(key)")
    refresh()
  }

  func tick() {
    for (l, d) in countdowns {
      let s = Int(d.timeIntervalSinceNow)
      l.stringValue = s >= 60 ? "" : s > 0 ? String(format: "还剩 0:%02d", s) : "已超时"
    }
    if let k = bubbleKey, Date().timeIntervalSince(firstSeen[k] ?? .distantPast) >= 10 { refresh() }
    for (b, key) in allowButtons where !b.isEnabled && b.title == "允许" {
      if Date().timeIntervalSince(firstSeen[key] ?? .distantPast) >= 1 { b.isEnabled = true }
    }
    // 所有窗口的 SC 都断开超过 60 秒（VS Code 全关了）就退出；下次 VS Code 启动由机器人插件拉起
    if !server.conns.isEmpty { lastConnAt = Date() }
    if server.conns.isEmpty && Date().timeIntervalSince(lastConnAt) > 60 { log("no SC for 60s, exit"); NSApp.terminate(nil) }
  }

  func stateText(_ t: [String: Any]) -> String {
    let mins = parseISO(t["since"] as? String).map { "\(max(0, Int(-$0.timeIntervalSinceNow) / 60))" } ?? "?"
    switch t["state"] as? String {
    case "running": return "在跑 \(mins) 分钟"
    case "waiting": return "等审批"
    case "done": return "已完成 \(mins) 分钟前"
    case "error": return "出错"
    default: return "空闲"
    }
  }

  func menuItem(_ title: String, _ action: Selector?, _ obj: Any? = nil) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
    i.target = self
    i.representedObject = obj
    i.isEnabled = action != nil
    return i
  }

  /// 总览（§5.4）+ 设置：右键机器人与菜单栏图标是同一份
  func buildMenu() -> NSMenu {
    let m = NSMenu()
    m.autoenablesItems = false
    let conns = server.conns.values.sorted { $0.fd < $1.fd }
    if conns.isEmpty { m.addItem(menuItem("没有连接的 VS Code 窗口", nil)) }
    for c in conns {
      m.addItem(menuItem("\(c.windowName)（VS Code 窗口）", nil))
      for t in c.tasks {
        let folder = t["folder"] as? String, task = t["task"] as? String
        m.addItem(menuItem("    \(baseName(folder)) · \(task ?? "主任务")　—　\(stateText(t))",
                           #selector(menuFocus(_:)), FocusTarget(c.fd, folder, task)))
      }
    }
    m.addItem(.separator())
    let skins = NSMenu()
    for s in skinList() {
      let i = menuItem(s.name, #selector(pickSkin(_:)), s.name)
      i.state = s.name == skinName ? .on : .off
      skins.addItem(i)
    }
    let si = menuItem("皮肤", nil)
    si.isEnabled = true
    si.submenu = skins
    m.addItem(si)
    m.addItem(menuItem("打开皮肤目录", #selector(openSkinDir)))
    m.addItem(.separator())
    m.addItem(menuItem("关闭机器人", #selector(disable)))
    return m
  }

  @objc func menuFocus(_ i: NSMenuItem) {
    guard let t = i.representedObject as? FocusTarget, let c = server.conns[t.fd] else { return }
    focus(c, t.folder, t.task)
  }
  @objc func pickSkin(_ i: NSMenuItem) {
    skinName = i.representedObject as? String ?? "default"
    Config.set("skin", skinName)
    skin = loadSkin(skinName)   // 选中时重新读文件：改了图再选一次就生效
    log("skin -> \(skinName)")
    refresh()
  }
  @objc func openSkinDir() {
    mkdirs(userSkinDir, 0o755)
    NSWorkspace.shared.open(URL(fileURLWithPath: userSkinDir))
  }
  /// 与命令「关闭桌面机器人」同效：写 enabled:false 再退出，VS Code 下次启动不再拉起
  @objc func disable() {
    Config.set("enabled", false)
    log("disabled by menu")
    NSApp.terminate(nil)
  }
}
