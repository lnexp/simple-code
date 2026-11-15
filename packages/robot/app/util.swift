// 路径、日志、颜色、皮肤、配置（docs/proposals/desktop-robot.md §6、§7）
import Cocoa
import ImageIO

let home = FileManager.default.homeDirectoryForCurrentUser.path
let runDir = home + "/.simple-code/run"
let sockPath = runDir + "/robot.sock"
/// {pid, version}：机器人插件据此判断在不在跑、要不要换新版（packages/robot/src/control.ts）
let pidPath = runDir + "/robot.pid"
let robotDir = home + "/.simple-code/robot"
let configPath = robotDir + "/config.json"
let userSkinDir = robotDir + "/skins"
let logPath = robotDir + "/robot.log"
let vscodeID = "com.microsoft.VSCode"
let stateNames = ["idle", "working", "waiting", "done", "error"]
let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"

func mkdirs(_ p: String, _ mode: Int) {
  try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true, attributes: [.posixPermissions: mode])
}

/// 启动时超过 1MB 就清空重来：日志只用来排查最近的事
func rotateLog() {
  let size = (try? FileManager.default.attributesOfItem(atPath: logPath)[.size] as? Int) ?? 0
  if size > 1 << 20 { try? FileManager.default.removeItem(atPath: logPath) }
}

/// O_APPEND：两个实例同时写（第二个启动后发现已有一个在跑）时每行整行追加，不互相覆盖
func log(_ s: String) {
  let line = Array("\(ISO8601DateFormatter().string(from: Date())) pid=\(getpid()) \(s)\n".utf8)
  let fd = open(logPath, O_WRONLY | O_APPEND | O_CREAT, 0o644)
  guard fd >= 0 else { return }
  _ = line.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
  close(fd)
}

func hex(_ s: String) -> NSColor {
  var v: UInt64 = 0
  Scanner(string: String(s.dropFirst())).scanHexInt64(&v)
  return NSColor(srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                 blue: CGFloat(v & 0xff) / 255, alpha: 1)
}

let kindColor: [String: NSColor] = ["approval": hex("#FFB020"), "done": hex("#3DDC84"), "error": hex("#FF5A4E")]
let kindLabel: [String: String] = ["approval": "待审批", "done": "已完成", "error": "出错"]

func baseName(_ p: String?) -> String { (p as NSString?)?.lastPathComponent ?? "?" }

/// 皮肤：内置只有 default（Resources/skins），用户皮肤是 ~/.simple-code/robot/skins 下的子目录
func skinList() -> [(name: String, path: String)] {
  var r: [(String, String)] = []
  if let res = Bundle.main.resourcePath { r.append(("default", res + "/skins/default")) }
  let fm = FileManager.default
  for n in ((try? fm.contentsOfDirectory(atPath: userSkinDir)) ?? []).sorted() where !n.hasPrefix(".") && n != "default" {
    var isDir: ObjCBool = false
    if fm.fileExists(atPath: userSkinDir + "/" + n, isDirectory: &isDir), isDir.boolValue { r.append((n, userSkinDir + "/" + n)) }
  }
  return r
}

/// 一个状态的图：image 是静态图（菜单栏图标用它）；frames 非空 = 动图（gif / APNG），按 delays 循环播放
struct SkinImage {
  let image: NSImage
  var frames: [CGImage] = []
  var delays: [Double] = []
}

/// 多帧图拆成帧序列；单帧或解不出来返回 nil。每帧时长读 gif / APNG 各自的字段，没写或过小按 0.1 秒
func animFrames(_ path: String) -> ([CGImage], [Double])? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  let n = CGImageSourceGetCount(src)
  guard n > 1 else { return nil }
  var frames: [CGImage] = [], delays: [Double] = []
  for i in 0..<n {
    guard let img = CGImageSourceCreateImageAtIndex(src, i, nil) else { continue }
    let p = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any] ?? [:]
    let g = p[kCGImagePropertyGIFDictionary] as? [CFString: Any]
    let a = p[kCGImagePropertyPNGDictionary] as? [CFString: Any]
    let d = (g?[kCGImagePropertyGIFUnclampedDelayTime] ?? g?[kCGImagePropertyGIFDelayTime]
             ?? a?[kCGImagePropertyAPNGUnclampedDelayTime] ?? a?[kCGImagePropertyAPNGDelayTime]) as? Double ?? 0
    frames.append(img)
    delays.append(d >= 0.02 ? d : 0.1)
  }
  return frames.count > 1 ? (frames, delays) : nil
}

/// 缺的状态先用本皮肤的 idle，再用默认皮肤的同名图；扩展名按 svg → png → gif 找。缺文件不报错
func loadSkin(_ name: String) -> [String: SkinImage] {
  let all = skinList()
  let dir = all.first { $0.name == name }?.path ?? all[0].path
  let def = all[0].path
  func find(_ d: String, _ s: String) -> SkinImage? {
    for e in ["svg", "png", "gif"] {
      let p = "\(d)/\(s).\(e)"
      guard let i = NSImage(contentsOfFile: p) else { continue }
      var r = SkinImage(image: i)
      if e != "svg", let (f, d) = animFrames(p) { r.frames = f; r.delays = d }
      return r
    }
    return nil
  }
  var out: [String: SkinImage] = [:]
  for s in stateNames { out[s] = find(dir, s) ?? find(dir, "idle") ?? find(def, s) }
  return out
}

/// config.json 由机器人（skin、position）和机器人插件（enabled）共写：
/// 改哪项只动哪项，读出来的其余字段原样写回
enum Config {
  static func read() -> [String: Any] {
    guard let d = FileManager.default.contents(atPath: configPath),
          let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
    return o
  }
  static func set(_ key: String, _ value: Any) {
    var o = read()
    o[key] = value
    mkdirs(robotDir, 0o755)
    if let d = try? JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys]) {
      FileManager.default.createFile(atPath: configPath, contents: d)
    }
  }
  static var skin: String { read()["skin"] as? String ?? "default" }
  /// 常驻桌面：没事时也显示机器人（默认关 = 有事才出现）
  static var pinned: Bool { read()["pinned"] as? Bool ?? false }
  /// 面板右下角（屏幕坐标）。不在任何屏幕上（换了显示器）就当没存过
  static var anchor: NSPoint? {
    guard let p = read()["position"] as? [String: Any], let x = p["x"] as? Double, let y = p["y"] as? Double else { return nil }
    let pt = NSPoint(x: x, y: y)
    return NSScreen.screens.contains { $0.visibleFrame.insetBy(dx: -1, dy: -1).contains(pt) } ? pt : nil
  }
}
