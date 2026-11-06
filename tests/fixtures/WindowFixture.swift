import AppKit
import CoreGraphics
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
let application = NSApplication.shared
application.setActivationPolicy(.regular)
// 多屏验收放到另一块显示器，不让用户正在使用的窗口持续覆盖测试宿主。
var initialFrame = NSRect(x: 150, y: 150, width: 1100, height: 760)
if ProcessInfo.processInfo.environment["DRAGONGIRL_FIXTURE_SECONDARY"] == "1", NSScreen.screens.count > 1,
   let screen = NSScreen.screens.max(by: { $0.frame.minX < $1.frame.minX }) {
    initialFrame.origin = NSPoint(x: screen.visibleFrame.minX + 100, y: screen.visibleFrame.minY + 80)
    initialFrame.size = NSSize(width: min(1100, screen.visibleFrame.width - 200), height: min(760, screen.visibleFrame.height - 160))
}
let window = NSWindow(contentRect: initialFrame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "龙娘窗口跟随测试"
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
// AppKit 首次显示可能将副屏初始坐标夹回主屏；显示后再定位，避免用户主屏窗口干扰隔离验收。
window.setFrameOrigin(initialFrame.origin)
var panel: NSOpenPanel?
var previous = ""
var orderTimer: Timer?

// 闪烁诊断只保留最前普通窗口与本测试角色的编号、层级和尺寸，不读取窗口标题或内容。
func diagnosticOrder(_ windows: [[String: Any]], _ overlays: [Int]) -> [[String: Any]] {
    let normal = windows.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }.prefix(6)
    let selected = Array(normal) + windows.filter { overlays.contains($0[kCGWindowNumber as String] as? Int ?? -1) }
    return selected.map { info in
        ["id": info[kCGWindowNumber as String] ?? 0, "pid": info[kCGWindowOwnerPID as String] ?? 0,
         "layer": info[kCGWindowLayer as String] ?? 0, "bounds": info[kCGWindowBounds as String] ?? [:]]
    }
}

// 在宿主重新置前的整个过程中按 8ms 采样，只保存本测试的窗口顺序，不能仅检查最终稳定状态。
func recordActivation() {
    guard let data = try? Data(contentsOf: directory.appendingPathComponent("watch.json")),
          let options = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let values = options["overlays"] as? [String] else { return }
    let overlays = values.compactMap(Int.init)
    let started = ProcessInfo.processInfo.systemUptime
    let generation = previous
    var samples = 0, covered = 0
    var firstCovered: Double?, lastCovered: Double?
    var firstBadOrder: [[String: Any]] = []
    orderTimer?.invalidate()
    let timer = Timer.scheduledTimer(withTimeInterval: 0.008, repeats: true) { timer in
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let order = windows.compactMap { $0[kCGWindowNumber as String] as? Int }
        samples += 1
        if let host = order.firstIndex(of: window.windowNumber), overlays.contains(where: { (order.firstIndex(of: $0) ?? Int.max) > host }) {
            covered += 1
            firstCovered = firstCovered ?? elapsed
            lastCovered = elapsed
            if firstBadOrder.isEmpty { firstBadOrder = diagnosticOrder(windows, overlays) }
        }
        if elapsed >= 0.4 {
            timer.invalidate()
            let result: [String: Any] = ["generation": generation, "samples": samples, "coveredSamples": covered,
                "coveredMilliseconds": ((lastCovered ?? 0) - (firstCovered ?? 0)) * 1000, "firstBadOrder": firstBadOrder]
            let output = try! JSONSerialization.data(withJSONObject: result)
            try! output.write(to: directory.appendingPathComponent("watch-result.json"), options: .atomic)
        }
    }
    orderTimer = timer
    RunLoop.main.add(timer, forMode: .common)
    window.orderFrontRegardless()
}

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
    case "raise": window.orderFrontRegardless(); report("raised")
    case "activate": window.makeKeyAndOrderFront(nil); application.activate(ignoringOtherApps: true); report("activated")
    case "pulse": recordActivation()
    case "partial": window.setContentSize(NSSize(width: 550, height: 760)); window.orderFrontRegardless(); report("partial")
    case "full": window.setContentSize(NSSize(width: 1100, height: 760)); window.orderFrontRegardless(); report("full")
    case "quit": application.terminate(nil)
    default: break
    }
}

// 定时读取仅属于测试目录的命令；面板关闭动画由实际窗口快照确认完成。
let timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    let command = (try? String(contentsOf: directory.appendingPathComponent("command"), encoding: .utf8)) ?? ""
    if command != previous {
        previous = command
        execute(command.components(separatedBy: "\n").first ?? "")
        try? command.write(to: directory.appendingPathComponent("command-complete"), atomically: true, encoding: .utf8)
    }
}
RunLoop.main.add(timer, forMode: .common)
report("ready")
application.run()
