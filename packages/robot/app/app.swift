// 应用主体：启动、收消息、算状态、排版（机器人在右下，卡片往上长）
import Cocoa

func parseISO(_ s: String?) -> Date? {
  guard let s else { return nil }
  let f = ISO8601DateFormatter()
  if let d = f.date(from: s) { return d }
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f.date(from: s)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  var panel: RobotPanel!
  let root = NSView()
  let robot = DragView()
  let robotImg = NSView()
  let badge = NSTextField(labelWithString: "")
  let cards = NSStackView()
  let server = Server()
  var skinName = Config.skin
  var skin: [String: SkinImage] = [:]
  var shownSkin: String?               // 正在显示的「皮肤/状态」：没变就不重设，免得动图被 refresh 打断从头播
  var pinned = Config.pinned           // 常驻桌面：没事也显示
  var statusItem: NSStatusItem!
  var anchor = NSPoint.zero            // 面板右下角（屏幕坐标），拖动后写回 config.json 的 position
  var firstSeen: [String: Date] = [:]  // 卡片第一次出现的时间：1 秒内「允许」不响应（防误点，§5.2）
  var countdowns: [(NSTextField, Date)] = []
  var allowButtons: [(NSButton, String)] = []
  var failNotes: [String: String] = [:]
  var pending: [Int: (Conn, String)] = [:]
  var nextRef = 1
  var knownKeys = Set<String>()
  var lastConnAt = Date()
  var expanded = false                 // 收起：只显示最重要的一条；展开：全部
  var bubbleKey: String?               // 收起时正在当气泡显示的完成/出错（10 秒后收掉）
  var ownsPidFile = false

  func applicationDidFinishLaunching(_ n: Notification) {
    mkdirs(robotDir, 0o755)
    rotateLog()
    guard server.start() else { NSApp.terminate(nil); return }
    let pidJson = "{\"pid\":\(getpid()),\"version\":\"\(appVersion)\"}\n"
    ownsPidFile = FileManager.default.createFile(atPath: pidPath, contents: pidJson.data(using: .utf8))
    server.onMessage = { [weak self] c, m in self?.handle(c, m) }
    server.onDrop = { [weak self] _ in self?.refresh() }
    skin = loadSkin(skinName)

    panel = RobotPanel(contentRect: NSRect(x: 0, y: 0, width: 84, height: 84),
                       styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isFloatingPanel = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.appearance = NSAppearance(named: .darkAqua)
    root.frame = NSRect(x: 0, y: 0, width: 84, height: 84)
    panel.contentView = root

    robot.frame = NSRect(x: 6, y: 6, width: 72, height: 72)
    robot.wantsLayer = true
    robotImg.frame = robot.bounds
    robotImg.wantsLayer = true
    robotImg.layer?.contentsGravity = .resizeAspect
    robot.addSubview(robotImg)
    badge.frame = NSRect(x: 52, y: 52, width: 22, height: 22)
    badge.alignment = .center
    badge.font = .boldSystemFont(ofSize: 12)
    badge.textColor = .white
    badge.wantsLayer = true
    badge.layer?.backgroundColor = NSColor.systemRed.cgColor
    badge.layer?.cornerRadius = 11
    robot.addSubview(badge)
    robot.onClick = { [weak self] in self?.robotClicked() }
    robot.onRight = { [weak self] e in
      guard let self else { return }
      NSMenu.popUpContextMenu(self.buildMenu(), with: e, for: self.robot)
    }
    robot.onMoved = { [weak self] in
      guard let self else { return }
      self.anchor = NSPoint(x: self.panel.frame.maxX, y: self.panel.frame.minY)
      Config.set("position", ["x": Double(self.anchor.x), "y": Double(self.anchor.y)])
      log("moved anchor=\(self.anchor)")
    }
    root.addSubview(robot)

    cards.orientation = .vertical
    cards.alignment = .trailing
    cards.spacing = 8
    root.addSubview(cards)

    let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
    anchor = Config.anchor ?? NSPoint(x: vf.maxX - 16, y: vf.minY + 16)
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    log("launch pid=\(getpid()) skin=\(skinName) skins=\(skinList().map { $0.name })")
    refresh()
  }

  func applicationWillTerminate(_ n: Notification) {
    server.stop()
    // 只删自己写的：没起来（另一个在跑）时 pid 文件是别人的
    if ownsPidFile { unlink(pidPath) }
    log("exit")
  }

  func handle(_ c: Conn, _ m: [String: Any]) {
    switch m["type"] as? String {
    case "hello":
      c.pid = m["pid"] as? Int ?? 0
      c.windowName = m["windowName"] as? String ?? "VS Code"
      c.windowPath = m["windowPath"] as? String
      c.appPath = m["appPath"] as? String
      log("hello pid=\(c.pid) protocol=\(m["protocol"] ?? "") version=\(m["version"] ?? "") window=\(c.windowName)")
    case "status":
      c.items = m["items"] as? [[String: Any]] ?? []
      c.tasks = m["tasks"] as? [[String: Any]] ?? []
      log("status pid=\(c.pid) items=\(c.items.count) tasks=\(c.tasks.count)")
    case "ack":
      ackReceived(m)
    default:
      log("unknown message type=\(m["type"] ?? "")")
    }
    refresh()
  }

  /// 要提醒的条目（SC 已算好 seen，只要看不到的，§5.1）：审批在前，其次出错、完成；同类按到达顺序
  var allItems: [(Conn, [String: Any])] {
    let order = ["approval": 0, "error": 1, "done": 2]
    let flat = server.conns.values.sorted { $0.fd < $1.fd }
      .flatMap { c in c.items.filter { ($0["seen"] as? Bool) != true }.map { (c, $0) } }
    return flat.enumerated().sorted {
      let a = order[$0.element.1["kind"] as? String ?? ""] ?? 9, b = order[$1.element.1["kind"] as? String ?? ""] ?? 9
      return a != b ? a < b : $0.offset < $1.offset
    }.map { $0.element }
  }

  func robotState(_ items: [(Conn, [String: Any])]) -> String {
    let kinds = Set(items.map { $0.1["kind"] as? String ?? "" })
    if kinds.contains("approval") { return "waiting" }
    if kinds.contains("error") { return "error" }
    if kinds.contains("done") { return "done" }
    let running = server.conns.values.contains { $0.tasks.contains { ($0["state"] as? String) == "running" } }
    return running ? "working" : "idle"
  }

  func refresh() {
    let items = allItems
    let keys = Set(items.map { $0.1["key"] as? String ?? "" })
    let fresh = keys.subtracting(knownKeys)
    for k in fresh { firstSeen[k] = Date() }
    for k in knownKeys.subtracting(keys) { firstSeen[k] = nil }
    knownKeys = keys
    let st = robotState(items)
    showSkin(st)
    badge.stringValue = "\(items.count)"
    badge.isHidden = items.isEmpty
    cards.arrangedSubviews.forEach { $0.removeFromSuperview() }
    countdowns = []
    allowButtons = []
    bubbleKey = nil
    if items.isEmpty { expanded = false }
    if expanded {
      for (c, it) in items {
        cards.addArrangedSubview(it["kind"] as? String == "approval" ? approvalCard(c, it) : noticeRow(c, it))
      }
      cards.addArrangedSubview(footerPill("收起 ▴"))
    } else {
      var used = 0
      if let (c, it) = items.first, it["kind"] as? String == "approval" {
        cards.addArrangedSubview(approvalCard(c, it))
        used = 1
      } else if let (c, it) = items.filter({ Date().timeIntervalSince(firstSeen[$0.1["key"] as? String ?? ""] ?? .distantPast) < 10 }).last {
        cards.addArrangedSubview(noticeRow(c, it))
        bubbleKey = it["key"] as? String
        used = 1
      }
      let rest = items.count - used
      if rest > 0 { cards.addArrangedSubview(footerPill(used > 0 ? "还有 \(rest) 条 ▾" : "\(rest) 条 ▾")) }
    }
    layout(hasCards: !cards.arrangedSubviews.isEmpty)
    // 有事才出现（D3+D5，用户定 2026-10-31）：没事时只留菜单栏图标；开了「常驻桌面」就一直在（2026-11-09 加）
    let visible = pinned || !items.isEmpty
    if visible { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
    if visible && !fresh.isEmpty { pulse() }
    if let img = skin[st]?.image.copy() as? NSImage {
      img.size = NSSize(width: 18, height: 18)
      statusItem.button?.image = img
    }
    statusItem.menu = buildMenu()
    tick()
    log("refresh state=\(st) items=\(items.count) visible=\(visible) fresh=\(fresh.sorted())")
  }

  /// 换机器人的图：静态图直接放进 layer；动图（gif / APNG）用逐帧关键帧动画无限循环
  func showSkin(_ st: String) {
    let key = "\(skinName)/\(st)"
    guard key != shownSkin, let l = robotImg.layer else { return }
    shownSkin = key
    l.removeAnimation(forKey: "skin")
    guard let s = skin[st] else { l.contents = nil; return }
    guard !s.frames.isEmpty else { l.contents = s.image; return }
    l.contents = s.frames[0]
    let total = s.delays.reduce(0, +)
    var t = 0.0, times: [NSNumber] = []
    for d in s.delays { times.append(NSNumber(value: t / total)); t += d }
    times.append(1)   // discrete 模式 keyTimes 要比 values 多一个
    let a = CAKeyframeAnimation(keyPath: "contents")
    a.values = s.frames
    a.keyTimes = times
    a.calculationMode = .discrete
    a.duration = total
    a.repeatCount = .infinity
    a.isRemovedOnCompletion = false
    l.add(a, forKey: "skin")
  }

  func layout(hasCards: Bool) {
    cards.layoutSubtreeIfNeeded()
    let ch = hasCards ? cards.fittingSize.height : 0
    let w: CGFloat = hasCards ? cardWidth + 16 : 84
    let h: CGFloat = 84 + (hasCards ? ch + 4 : 0)
    root.frame = NSRect(x: 0, y: 0, width: w, height: h)
    robot.frame.origin = NSPoint(x: w - 78, y: 6)
    cards.frame = NSRect(x: w - cardWidth - 8, y: 84, width: cardWidth, height: ch)
    panel.setFrame(NSRect(x: anchor.x - w, y: anchor.y, width: w, height: h), display: true)
  }

  /// 有新条目时原地脉冲两下（旧版上下弹跳，2026-11-09 用户反馈晃眼，不挪位置）
  func pulse() {
    guard let l = robotImg.layer else { return }
    let a = CAKeyframeAnimation(keyPath: "transform.scale")
    a.values = [1, 1.2, 1, 1.15, 1]
    a.keyTimes = [0, 0.2, 0.45, 0.65, 1]
    a.duration = 0.5
    l.add(a, forKey: "pulse")
  }
}
