import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// 原生桥只读取进程目录、有限网络环境、窗口类型及几何，不截屏、不读取凭据。
struct ProcessInfoRow {
    let pid: pid_t
    let appPath: String
    let home: String
    let environment: [String: String]
}
let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex").path
let permittedEnvironment = ["CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
var cachedProcesses: [pid_t: ProcessInfoRow] = [:]
var lastDiscovery = Date.distantPast
var lastOutput = ""
var cachedModality: [pid_t: (windowIDs: [Int], modal: Bool?, checkedAt: TimeInterval)] = [:]
// 拖动时加快窗口采样，静止时维持原先约 120 毫秒一次的查询频率。
let trackingInterval: TimeInterval = 0.04
var lastSnapshotAt: TimeInterval = -.infinity
var lastHostMoveAt: TimeInterval = -.infinity
var lastHostFrames: [Int: CGRect] = [:]

// 只读取窗口级类型和模态标记，不读取标题、正文或控件值，也不主动请求辅助功能权限。
func windowAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

// 使用公开位置与尺寸匹配屏幕上的窗口，不把其他桌面或最小化窗口的弹窗算进来。
func accessibilityWindowFrame(_ window: AXUIElement) -> CGRect? {
    guard let position = windowAttribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = windowAttribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

// 系统文件面板可能直接是模态窗口，也可能作为主窗口的 sheet 子节点出现。
func modalWindowState(_ pid: pid_t, _ visible: [[String: Any]]) -> Bool? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.08)
    guard let windows = windowAttribute(application, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty else { return nil }
    var complete = true
    var matched = Set<Int>()
    for window in windows {
        guard let rect = accessibilityWindowFrame(window) else { complete = false; continue }
        guard let index = visible.firstIndex(where: { frame in
            guard let x = frame["x"] as? CGFloat, let y = frame["y"] as? CGFloat,
                  let width = frame["width"] as? CGFloat, let height = frame["height"] as? CGFloat else { return false }
            return abs(rect.minX - x) <= 2 && abs(rect.minY - y) <= 2 && abs(rect.width - width) <= 2 && abs(rect.height - height) <= 2
        }) else { continue }
        matched.insert(index)
        guard let modal = windowAttribute(window, kAXModalAttribute) as? Bool else { complete = false; continue }
        if modal { return true }
        guard let children = windowAttribute(window, kAXChildrenAttribute) as? [AXUIElement] else { complete = false; continue }
        for child in children {
            guard let role = windowAttribute(child, kAXRoleAttribute) as? String else { complete = false; continue }
            if role == kAXSheetRole { return true }
        }
    }
    // 新面板已出现在 Quartz、无障碍树却尚未更新时保持未知，让几何兜底立即收起角色。
    return complete && matched.count == visible.count ? false : nil
}

// 移动同一个窗口时复用模态结果，新面板出现或缓存到期时重新查询。
func cachedModalWindowState(_ pid: pid_t, _ windows: [[String: Any]], _ now: TimeInterval) -> Bool? {
    let windowIDs = windows.compactMap { $0["id"] as? Int }
    if let cached = cachedModality[pid], cached.windowIDs == windowIDs, now - cached.checkedAt < 0.5 { return cached.modal }
    let modal = windows.isEmpty ? false : modalWindowState(pid, windows)
    cachedModality[pid] = (windowIDs: windowIDs, modal: modal, checkedAt: now)
    return modal
}

// 进程环境只解析白名单；完整 ps 输出只存在于本次函数内存。
func processEnvironment(_ pid: pid_t) -> [String: String] {
    let task = Process(), pipe = Pipe()
    task.executableURL = URL(fileURLWithPath: "/bin/ps")
    task.arguments = ["eww", "-p", String(pid), "-o", "command="]
    task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
    do { try task.run() } catch { return [:] }
    let data = pipe.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
    guard let value = String(data: data, encoding: .utf8), task.terminationStatus == 0 else { return [:] }
    var result: [String: String] = [:]
    for key in permittedEnvironment {
        let expression = try? NSRegularExpression(pattern: "(?:^| )" + NSRegularExpression.escapedPattern(for: key) + "=(.*?)(?= [A-Za-z_][A-Za-z_0-9]*=|$)")
        if let match = expression?.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)), let range = Range(match.range(at: 1), in: value) { result[key] = String(value[range]).trimmingCharacters(in: .whitespacesAndNewlines) }
    }
    return result
}
// 使用真实 App 主进程识别多个实例，排除渲染器及同名命令行工具。
func discoverProcesses() {
    let apps = NSWorkspace.shared.runningApplications.filter { app in
        guard let url = app.bundleURL else { return false }
        return ["ChatGPT.app", "Codex.app"].contains(url.lastPathComponent)
    }
    let active = Set(apps.map(\.processIdentifier))
    cachedProcesses = cachedProcesses.filter { active.contains($0.key) }
    cachedModality = cachedModality.filter { active.contains($0.key) }
    for app in apps where cachedProcesses[app.processIdentifier] == nil {
        let environment = processEnvironment(app.processIdentifier)
        let home = environment["CODEX_HOME"] ?? defaultHome
        guard home.hasPrefix("/") else { continue }
        cachedProcesses[app.processIdentifier] = ProcessInfoRow(pid: app.processIdentifier, appPath: app.bundleURL!.path, home: URL(fileURLWithPath: home).resolvingSymlinksInPath().path, environment: environment.filter { $0.key != "CODEX_HOME" })
    }
}
// 只发送变化后的窗口编号、层级与必要几何，不读取其他应用的标题或内容。
func emitSnapshot() {
    let now = ProcessInfo.processInfo.systemUptime
    lastSnapshotAt = now
    if Date().timeIntervalSince(lastDiscovery) > 3 { discoverProcesses(); lastDiscovery = Date() }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var hostFrames: [Int: CGRect] = [:]
    let processes: [[String: Any]] = cachedProcesses.values.sorted { $0.pid < $1.pid }.map { row in
        let visible = windows.compactMap { window -> [String: Any]? in
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == row.pid,
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let id = window[kCGWindowNumber as String] as? Int,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds), rect.width >= 400, rect.height >= 300,
                  (window[kCGWindowAlpha as String] as? Double ?? 1) > 0.1 else { return nil }
            hostFrames[id] = rect
            return ["id": id, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        var process: [String: Any] = ["pid": row.pid, "appPath": row.appPath, "home": row.home, "networkEnv": row.environment, "frontmost": front == row.pid, "windows": visible, "platform": "darwin"]
        if let modal = cachedModalWindowState(row.pid, visible, now) { process["modalOpen"] = modal }
        return process
    }
    if hostFrames != lastHostFrames {
        lastHostFrames = hostFrames
        lastHostMoveAt = now
    }
    let windowOrder = windows.compactMap { window -> Int? in
        guard (window[kCGWindowAlpha as String] as? Double ?? 1) > 0.1 else { return nil }
        return window[kCGWindowNumber as String] as? Int
    }
    // 未被普通窗口遮挡的宿主可使用浮动层保持连续显示，窗口几何同时排除其他显示器的无关窗口。
    let normalWindows = windows.compactMap { window -> [String: Any]? in
        guard (window[kCGWindowLayer as String] as? Int) == 0,
              (window[kCGWindowAlpha as String] as? Double ?? 1) > 0.1,
              let bounds = window[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds), rect.width > 0, rect.height > 0 else { return nil }
        return ["id": window[kCGWindowNumber as String] ?? 0, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
    }
    let snapshot: [String: Any] = ["processes": processes, "windowOrder": windowOrder, "normalWindows": normalWindows, "screenPermission": CGPreflightScreenCaptureAccess()]
    guard let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8), output != lastOutput else { return }
    lastOutput = output
    FileHandle.standardOutput.write(data + Data([10]))
}
// 权限和聚焦操作均需用户在应用中点击固定入口，不提供任意系统执行。
if CommandLine.arguments.contains("--permission") {
    print(CGRequestScreenCaptureAccess() ? "true" : "false")
} else if let index = CommandLine.arguments.firstIndex(of: "--focus"), CommandLine.arguments.count > index + 1, let pid = Int32(CommandLine.arguments[index+1]) {
    _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
} else if CommandLine.arguments.contains("--once") {
    emitSnapshot()
} else {
    signal(SIGPIPE, SIG_IGN)
    emitSnapshot()
    // 应用切换立即同步；普通轮询继续覆盖不激活应用的置前、最小化与窗口移动。
    _ = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in emitSnapshot() }
    // 按住左键或检测到连续移动时，以 40 毫秒间隔更新窗口位置。
    let timer = Timer(timeInterval: trackingInterval, repeats: true) { _ in
        let now = ProcessInfo.processInfo.systemUptime
        let tracking = !lastHostFrames.isEmpty && ((NSEvent.pressedMouseButtons & 1) != 0 || now - lastHostMoveAt < 0.2)
        if tracking || now - lastSnapshotAt >= trackingInterval * 2.5 { emitSnapshot() }
    }
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.run()
}
