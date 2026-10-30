import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 1100, height: 760), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "龙娘窗口跟随测试"
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
var panel: NSOpenPanel?
var previous = ""

// 只报告自建窗口的编号，测试不选择或修改任何用户文件。
func report(_ stage: String) {
    let data = try! JSONSerialization.data(withJSONObject: ["stage": stage, "window": window.windowNumber])
    try! data.write(to: directory.appendingPathComponent("ready.json"), options: .atomic)
}

// 隔离测试通过临时目录下的指令控制自己的窗口，不自动操作其他应用。
func execute(_ command: String) {
    switch command {
    case "open":
        let picker = NSOpenPanel()
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        picker.directoryURL = directory
        panel = picker
        picker.beginSheetModal(for: window) { _ in panel = nil; report("closed") }
        report("open")
    case "close": panel?.cancel(nil)
    case "move": window.setFrameOrigin(NSPoint(x: 260, y: 200)); report("moved")
    case "minimize": window.miniaturize(nil); report("minimized")
    case "restore": window.deminiaturize(nil); report("restored")
    case "quit": application.terminate(nil)
    default: break
    }
}

// 定时读取仅属于测试目录的命令；面板关闭动画由实际窗口快照确认完成。
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    let command = (try? String(contentsOf: directory.appendingPathComponent("command"), encoding: .utf8)) ?? ""
    if command != previous { previous = command; execute(command) }
}
RunLoop.main.add(timer, forMode: .common)
report("ready")
application.run()
