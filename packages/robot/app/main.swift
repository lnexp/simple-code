import Cocoa

signal(SIGPIPE, SIG_IGN)   // 对端窗口关了还往里写，不能把机器人带崩
let app = NSApplication.shared
let appDelegate = AppDelegate()
app.delegate = appDelegate
app.setActivationPolicy(.accessory)
// 机器人插件换新版、关闭命令都发 SIGTERM：走正常退出，删掉 socket 与 pid 文件
signal(SIGTERM, SIG_IGN)
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { log("SIGTERM"); NSApp.terminate(nil) }
term.resume()
app.run()
