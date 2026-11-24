import AppKit
import ApplicationServices
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
var panel: NSSavePanel?
var otherChat: NSWindow?
var floatingMenu: NSPanel?
var previewPanels: [NSPanel] = []
var previous = ""
var orderTimer: Timer?

// 独立保存面板和对照聊天窗口采用相同的偏移与大小。
var videoPanelFrame: NSRect {
    NSRect(x: window.frame.minX + 20, y: window.frame.minY + 60, width: 880, height: 448)
}

// 仅供测试进程读取自己文件面板的控件标识。
func fixtureAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

// 保存按钮由 AppKit 文件服务提供，用它的标识触发实际确认，兼容不同界面语言。
func pressSaveButton(in element: AXUIElement) -> Bool {
    if fixtureAttribute(element, kAXIdentifierAttribute) as? String == "OKButton" {
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }
    let children = fixtureAttribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    return children.contains { pressSaveButton(in: $0) }
}

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

// 用约 60Hz 的连续位移模拟拖动标题栏，再回到原位，便于识别低频采样造成的跳步。
func glideHost() {
    let origin = window.frame.origin
    let steps = 72
    var step = 0
    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { timer in
        step += 1
        let distance = CGFloat(min(step, steps - step) * 2)
        window.setFrameOrigin(NSPoint(x: origin.x - distance, y: origin.y))
        if step == steps {
            timer.invalidate()
            try? Data().write(to: directory.appendingPathComponent("glide-complete"), options: .atomic)
        }
    }
    RunLoop.main.add(timer, forMode: .common)
}

// 模拟以浮动面板实现的宿主菜单，与角色及气泡占用同一片屏幕区域。
func openFloatingMenu() {
    let frame = window.frame
    let popup = NSPanel(contentRect: NSRect(x: frame.maxX - 230, y: frame.minY + 15, width: 210, height: 250),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    popup.isFloatingPanel = true
    popup.hidesOnDeactivate = false
    popup.backgroundColor = .windowBackgroundColor
    popup.level = .floating
    popup.orderFrontRegardless()
    floatingMenu = popup
    try? String(popup.windowNumber).write(to: directory.appendingPathComponent("floating-menu"), atomically: true, encoding: .utf8)
}

// 模拟 Codex 画中画同尺寸、同层级的内容与控制面板，大小足以进入旧版宿主列表。
func openPreviewPanels(titled: Bool) {
    let host = window.frame
    let frame = NSRect(x: host.maxX - 544, y: host.maxY - 424, width: 520, height: 400)
    for title in ["Computer Use", "Computer Use Controls"] {
        let preview = NSPanel(contentRect: frame, styleMask: [.nonactivatingPanel], backing: .buffered, defer: false)
        preview.title = titled ? title : ""
        preview.hidesOnDeactivate = false
        preview.backgroundColor = .windowBackgroundColor
        preview.level = window.level
        window.addChildWindow(preview, ordered: .above)
        preview.setFrame(frame, display: true)
        preview.orderFrontRegardless()
        previewPanels.append(preview)
    }
    let ids = previewPanels.map(\.windowNumber)
    try? JSONEncoder().encode(ids).write(to: directory.appendingPathComponent("preview-windows.json"), options: .atomic)
}

// 两块面板一起移动，模拟拖动画中画时只改变预览容器的位置。
func movePreviewPanels() {
    for preview in previewPanels {
        let origin = preview.frame.origin
        preview.setFrameOrigin(NSPoint(x: origin.x - 160, y: origin.y - 100))
    }
}

// 从宿主解除并隐藏测试面板，避免残留窗口影响接下来的模态验收。
func closePreviewPanels() {
    for preview in previewPanels {
        window.removeChildWindow(preview)
        preview.orderOut(nil)
    }
    previewPanels.removeAll()
}

// 只报告自建窗口的编号，测试不选择或修改任何用户文件。
func report(_ stage: String) {
    var state: [String: Any] = ["stage": stage, "window": window.windowNumber]
    if let panel { state["panel"] = panel.windowNumber }
    let data = try! JSONSerialization.data(withJSONObject: state)
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
    case "save-video", "save-compact":
        // 独立保存面板可以偏离聊天窗口中心，也可以使用自定义标题。
        let picker = NSSavePanel()
        picker.title = "导出测试视频"
        picker.nameFieldStringValue = "fixture.mp4"
        picker.directoryURL = directory
        panel = picker
        // 只记录系统确认的临时视频路径，测试无需写出媒体文件。
        picker.begin { response in
            let expected = directory.appendingPathComponent("fixture.mp4").resolvingSymlinksInPath().path
            let destination = picker.url?.resolvingSymlinksInPath().path
            panel = nil
            if response == .OK { report(destination == expected ? "saved-video" : "other-destination") }
            else { report("closed") }
        }
        var frame = videoPanelFrame
        if command == "save-compact" { frame.size = NSSize(width: 370, height: 204) }
        picker.setFrame(frame, display: true)
        report(command)
    case "other-chat":
        // 普通聊天窗口故意复用保存面板的标题、位置和尺寸，确保仍能切换跟随目标。
        let chat = NSWindow(contentRect: .zero, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        chat.title = "导出测试视频"
        chat.setFrame(videoPanelFrame, display: false)
        chat.makeKeyAndOrderFront(nil)
        otherChat = chat
    case "close-other-chat": otherChat?.orderOut(nil); otherChat = nil
    case "confirm-save":
        // 只在当前测试进程的保存面板上操作，其他窗口无法接收确认动作。
        let windows = fixtureAttribute(AXUIElementCreateApplication(getpid()), kAXWindowsAttribute) as? [AXUIElement] ?? []
        guard let picker = windows.first(where: { fixtureAttribute($0, kAXIdentifierAttribute) as? String == "save-panel" }),
              pressSaveButton(in: picker) else { report("save-button-unavailable"); return }
    case "close": panel?.cancel(nil)
    case "move": window.setFrameOrigin(NSPoint(x: 260, y: 200)); report("moved")
    case "minimize": window.miniaturize(nil); report("minimized")
    case "restore": window.deminiaturize(nil); report("restored")
    case "raise": window.orderFrontRegardless(); report("raised")
    case "activate": window.makeKeyAndOrderFront(nil); application.activate(ignoringOtherApps: true); report("activated")
    case "pulse": recordActivation()
    case "glide": glideHost()
    case "open-floating-menu": openFloatingMenu()
    case "close-floating-menu": floatingMenu?.orderOut(nil); floatingMenu = nil
    case "open-preview": openPreviewPanels(titled: true)
    case "open-untitled-preview": openPreviewPanels(titled: false)
    case "move-preview": movePreviewPanels()
    case "close-preview": closePreviewPanels()
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
