// unix socket 服务端（desktop-robot.md §4）：一行一条 JSON；每个连接 = 一个 VS Code 窗口的 SC，
// 断开即删掉它的条目
import Foundation

final class Conn {
  let fd: Int32
  var src: DispatchSourceRead?
  var buf = Data()
  var pid = 0
  var windowName = "VS Code"
  /// 回这个窗口要打开的路径：工作区文件或单文件夹窗口的文件夹；nil = 只激活应用（§5.5）
  var windowPath: String?
  /// 用哪个应用打开（VS Code / Insiders / Cursor 各回各的）
  var appPath: String?
  var items: [[String: Any]] = []
  var tasks: [[String: Any]] = []
  init(fd: Int32) { self.fd = fd }

  func send(_ obj: [String: Any]) {
    guard var d = try? JSONSerialization.data(withJSONObject: obj) else { return }
    d.append(0x0A)
    d.withUnsafeBytes { raw in
      var off = 0
      while off < raw.count {
        let n = write(fd, raw.baseAddress! + off, raw.count - off)
        if n <= 0 { return }   // 对端已关：读端会收到 EOF 并 drop
        off += n
      }
    }
  }
}

private func withSockaddr<T>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
  var a = sockaddr_un()
  a.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  withUnsafeMutableBytes(of: &a.sun_path) { raw in
    for (i, b) in bytes.prefix(raw.count - 1).enumerated() { raw[i] = b }
  }
  return withUnsafePointer(to: &a) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
}

/// 一行的上限（§4.1 定 64KB）。status 里命令截 300 字、原因截 200 字，正常远够；
/// 攒了 1MB 还没换行 = 对端坏了，断开它
private let maxBuffered = 1 << 20

final class Server {
  var conns: [Int32: Conn] = [:]
  var onMessage: ((Conn, [String: Any]) -> Void)?
  var onDrop: ((Conn) -> Void)?
  private var lfd: Int32 = -1
  private var acceptSrc: DispatchSourceRead?

  /// 连得上 = 已有一个机器人在跑 → 返回 false，调用方退出；连不上 = 残留文件 → 删掉重建
  func start() -> Bool {
    mkdirs(runDir, 0o700)
    let probe = socket(AF_UNIX, SOCK_STREAM, 0)
    let alive = withSockaddr(sockPath) { connect(probe, $0, $1) } == 0
    close(probe)
    if alive { log("another robot is listening, exit"); return false }
    unlink(sockPath)
    lfd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard withSockaddr(sockPath, { bind(lfd, $0, $1) }) == 0, listen(lfd, 16) == 0 else {
      log("bind/listen failed errno=\(errno)"); return false
    }
    chmod(sockPath, 0o600)
    let s = DispatchSource.makeReadSource(fileDescriptor: lfd, queue: .main)
    s.setEventHandler { [weak self] in self?.acceptOne() }
    s.resume()
    acceptSrc = s
    log("listening \(sockPath) version=\(appVersion)")
    return true
  }

  /// 退出前删掉 socket 文件。只删自己 bind 的：探到已有机器人在跑而退出的那个实例，
  /// 删的就是正在用的那个文件，之后所有 SC 都连不上（2026-10-31 实测踩到）
  func stop() {
    guard lfd >= 0 else { return }
    for c in conns.values { close(c.fd) }
    close(lfd)
    unlink(sockPath)
  }

  private func acceptOne() {
    let fd = accept(lfd, nil, nil)
    guard fd >= 0 else { return }
    let c = Conn(fd: fd)
    conns[fd] = c
    let s = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
    s.setEventHandler { [weak self] in self?.readFrom(c) }
    s.resume()
    c.src = s
    log("conn open fd=\(fd) total=\(conns.count)")
  }

  private func readFrom(_ c: Conn) {
    var tmp = [UInt8](repeating: 0, count: 65536)
    let n = read(c.fd, &tmp, tmp.count)
    if n <= 0 { drop(c); return }
    c.buf.append(contentsOf: tmp[0..<n])
    while let i = c.buf.firstIndex(of: 0x0A) {
      let line = c.buf.subdata(in: c.buf.startIndex..<i)
      c.buf.removeSubrange(c.buf.startIndex...i)
      if let o = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] { onMessage?(c, o) }
    }
    if c.buf.count > maxBuffered { log("line too long pid=\(c.pid), drop"); drop(c) }
  }

  private func drop(_ c: Conn) {
    guard conns[c.fd] === c else { return }
    c.src?.cancel()
    close(c.fd)
    conns[c.fd] = nil
    log("conn closed pid=\(c.pid) total=\(conns.count)")
    onDrop?(c)
  }
}
