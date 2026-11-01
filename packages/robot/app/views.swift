// 视图：机器人（拖动/单击/右键）、卡片（单击跳转，按钮自己吃点击）、按钮样式
import Cocoa

final class RobotPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// 不激活窗口时第一下点击也要生效，否则「允许」得点两次
class FirstClickButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// 机器人：拖动 > 3pt 不算点击；右键弹菜单
final class DragView: NSView {
  var onClick: (() -> Void)?
  var onRight: ((NSEvent) -> Void)?
  var onMoved: (() -> Void)?
  private var downAt = NSPoint.zero
  private var originAtDown = NSPoint.zero
  private var dragged = false
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) != nil ? self : nil }
  override func mouseDown(with e: NSEvent) {
    downAt = NSEvent.mouseLocation
    originAtDown = window?.frame.origin ?? .zero
    dragged = false
  }
  override func mouseDragged(with e: NSEvent) {
    let p = NSEvent.mouseLocation
    let dx = p.x - downAt.x, dy = p.y - downAt.y
    if abs(dx) + abs(dy) > 3 { dragged = true }
    window?.setFrameOrigin(NSPoint(x: originAtDown.x + dx, y: originAtDown.y + dy))
  }
  override func mouseUp(with e: NSEvent) {
    if dragged { onMoved?() } else { onClick?() }
  }
  override func rightMouseDown(with e: NSEvent) { onRight?(e) }
}

/// 卡片：点空白处 = 跳到对应窗口/目录/任务；按钮照常响应
final class CardView: NSVisualEffectView {
  var onClick: (() -> Void)?
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let v = super.hitTest(point) else { return nil }
    var p: NSView? = v
    while let x = p, x !== self { if x is NSButton { return x }; p = x.superview }
    return self
  }
  override func mouseUp(with e: NSEvent) { onClick?() }
}

let cardWidth: CGFloat = 320

func textLabel(_ s: String, size: CGFloat, mono: Bool = false, weight: NSFont.Weight = .regular,
               color: NSColor = .labelColor, lines: Int = 1) -> NSTextField {
  let t = lines == 1 ? NSTextField(labelWithString: s) : NSTextField(wrappingLabelWithString: s)
  t.font = mono ? .monospacedSystemFont(ofSize: size, weight: weight) : .systemFont(ofSize: size, weight: weight)
  t.textColor = color
  t.maximumNumberOfLines = lines
  // 多行标签设 byTruncatingTail 会被强制成单行：多行用换行 + 最后一行截断。
  // 命令按字符换（路径很长没有空格），文字按词换（不拆英文单词）
  t.lineBreakMode = lines == 1 ? .byTruncatingTail : (mono ? .byCharWrapping : .byWordWrapping)
  t.cell?.truncatesLastVisibleLine = true
  t.preferredMaxLayoutWidth = cardWidth - 24
  t.isSelectable = false
  t.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
  return t
}

/// 实底按钮：bezelColor 在不激活的面板里不生效（实测「允许」和「回窗口」一样灰），改用图层底色
final class FillButton: FirstClickButton {
  var padX: CGFloat = 14
  var height: CGFloat = 26
  override var intrinsicContentSize: NSSize {
    NSSize(width: super.intrinsicContentSize.width + padX * 2, height: height)
  }
  override var isEnabled: Bool { didSet { alphaValue = isEnabled ? 1 : 0.45 } }
}

func fillButton(_ title: String, bg: NSColor, size: CGFloat = 13, target: AnyObject, action: Selector) -> FillButton {
  let b = FillButton(title: title, target: target, action: action)
  b.isBordered = false
  b.wantsLayer = true
  b.layer?.backgroundColor = bg.cgColor
  b.layer?.cornerRadius = 7
  b.attributedTitle = NSAttributedString(string: title, attributes: [
    .foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: size, weight: .semibold)])
  return b
}

/// 文字按钮：次要动作（回窗口）
func linkButton(_ title: String, target: AnyObject, action: Selector) -> FirstClickButton {
  let b = FirstClickButton(title: title, target: target, action: action)
  b.isBordered = false
  b.attributedTitle = NSAttributedString(string: title, attributes: [
    .foregroundColor: NSColor.secondaryLabelColor, .font: NSFont.systemFont(ofSize: 12.5, weight: .medium)])
  return b
}

/// 卡片外壳：圆角毛玻璃 + 竖排内容，宽度固定
func cardShell(_ rows: [NSView], onClick: @escaping () -> Void) -> CardView {
  let card = CardView()
  card.material = .hudWindow   // 深色半透明，和机器人的深色面屏同一种风格（面板固定 darkAqua 外观）
  card.blendingMode = .behindWindow
  card.state = .active
  card.wantsLayer = true
  card.layer?.cornerRadius = 12
  card.layer?.masksToBounds = true
  card.onClick = onClick
  card.translatesAutoresizingMaskIntoConstraints = false
  let v = NSStackView(views: rows)
  v.orientation = .vertical
  v.alignment = .leading
  v.spacing = 6
  v.translatesAutoresizingMaskIntoConstraints = false
  card.addSubview(v)
  NSLayoutConstraint.activate([
    card.widthAnchor.constraint(equalToConstant: cardWidth),
    v.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
    v.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
    v.topAnchor.constraint(equalTo: card.topAnchor, constant: 10),
    v.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -10),
  ])
  return card
}

/// 一行横排；flex 之后的视图被推到右边
func hRow(_ left: [NSView], right: [NSView] = []) -> NSStackView {
  let flex = NSView()
  flex.setContentHuggingPriority(.init(1), for: .horizontal)
  let r = NSStackView(views: left + [flex] + right)
  r.orientation = .horizontal
  r.spacing = 6
  r.translatesAutoresizingMaskIntoConstraints = false
  r.widthAnchor.constraint(equalToConstant: cardWidth - 24).isActive = true
  return r
}
