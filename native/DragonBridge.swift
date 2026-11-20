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

// 跟随候选只保留窗口几何与画中画标记，标题不进入快照。
private struct CodexWindowCandidate {
    let id: Int
    let frame: CGRect
    let hasTitle: Bool
    let isPreview: Bool

    // 小尺寸文件面板也参与避让，只有达到宿主尺寸的窗口才能用于定位。
    var canHost: Bool { frame.width >= 400 && frame.height >= 300 }
}

let defaultHome = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex").path
let permittedEnvironment = ["CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
var cachedProcesses: [pid_t: ProcessInfoRow] = [:]
var lastDiscovery = Date.distantPast
var lastOutput = ""
var cachedModality: [pid_t: (windowIDs: [Int], modal: Bool?, checkedAt: TimeInterval)] = [:]
// 单次诊断可只读 Quartz，用同一个原生桥验收没有辅助功能权限的路径。
let quartzOnly = CommandLine.arguments.contains("--once") && CommandLine.arguments.contains("--quartz-only")
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

// 系统文件面板可以是独立窗口、模态窗口或主窗口的 sheet。
private func modalWindowState(_ pid: pid_t, _ visible: [CodexWindowCandidate]) -> Bool? {
    guard !quartzOnly, AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(application, 0.08)
    guard let windows = windowAttribute(application, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty else { return nil }
    var complete = true
    var matched = Set<Int>()
    for window in windows {
        guard let rect = accessibilityWindowFrame(window) else { complete = false; continue }
        guard let index = visible.firstIndex(where: { candidate in
            let frame = candidate.frame
            return abs(rect.minX - frame.minX) <= 2 && abs(rect.minY - frame.minY) <= 2
                && abs(rect.width - frame.width) <= 2 && abs(rect.height - frame.height) <= 2
        }) else { continue }
        matched.insert(index)
        // 独立打开的 NSSavePanel 可以同时报告 AXStandardWindow 和 AXModal=false；系统标识不随标题语言改变。
        let identifier = windowAttribute(window, kAXIdentifierAttribute) as? String
        if identifier == "save-panel" || identifier == "open-panel" { return true }
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

// 窗口跟随、层级和文件面板配对使用相同的普通窗口编号与坐标。
private func normalWindowGeometry(_ row: [String: Any]) -> (id: Int, frame: CGRect)? {
    guard (row[kCGWindowLayer as String] as? Int) == 0, (row[kCGWindowAlpha as String] as? Double ?? 1) > 0.1,
          let id = row[kCGWindowNumber as String] as? Int, let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds), frame.width > 0, frame.height > 0 else { return nil }
    return (id, frame)
}

// 无辅助功能权限时，AppKit 文件面板服务的离屏窗口可用来识别宿主代为显示的面板。
private func quartzFilePanelIDs() -> Set<Int> {
    let services = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.appkit.xpc.openAndSavePanelService")
    let servicePIDs = Set(services.map(\.processIdentifier))
    guard !servicePIDs.isEmpty,
          let all = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }

    // 在同一份快照中配对，面板拖动或关闭时不会混用前后两帧的位置。
    let visible = all.compactMap { row in row[kCGWindowIsOnscreen as String] as? Bool == true ? normalWindowGeometry(row) : nil }
    let primary = CGDisplayBounds(CGMainDisplayID())
    var panels = Set<Int>()
    for row in all {
        guard let pid = row[kCGWindowOwnerPID as String] as? pid_t, servicePIDs.contains(pid),
              row[kCGWindowIsOnscreen as String] as? Bool != true, let (id, frame) = normalWindowGeometry(row) else { continue }
        // 通常两扇窗口依次创建；折叠、展开或改尺寸时，服务窗口仍与可见面板共用左下角。
        let aligned = visible.filter { $0.frame.minX == frame.minX && $0.frame.maxY == frame.maxY }
        if let paired = aligned.first(where: { $0.id + 1 == id }) {
            panels.insert(paired.id)
        } else {
            // 服务的空闲窗口也停在 AppKit 坐标原点，此处只接受上面能明确配对的窗口。
            if frame.minX == primary.minX && frame.maxY == primary.maxY { continue }
            // 编号分配可能被穿插，先匹配完整矩形；调整尺寸时仍可凭唯一的共同左下角认领面板。
            let sameFrame = aligned.filter { $0.frame == frame }
            let matches = sameFrame.isEmpty ? aligned : sameFrame
            if matches.count == 1, matches[0].id < id { panels.insert(matches[0].id) }
        }
    }
    return panels
}

// 移动同一个窗口时复用模态结果，新面板出现或缓存到期时重新查询。
private func cachedModalWindowState(_ pid: pid_t, _ windows: [CodexWindowCandidate], _ now: TimeInterval,
                                    filePanelIDs: () -> Set<Int>) -> Bool? {
    let windowIDs = windows.map(\.id)
    if let cached = cachedModality[pid], cached.windowIDs == windowIDs, now - cached.checkedAt < 0.5 { return cached.modal }
    var modal = windows.isEmpty ? false : modalWindowState(pid, windows)
    if modal == nil, !filePanelIDs().isDisjoint(with: windowIDs) { modal = true }
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

// Codex 把画中画的内容和控制放进两块同尺寸的普通层面板，排在聊天窗口上方。
private func visibleCodexWindows(_ windows: [[String: Any]], pid: pid_t) -> [CodexWindowCandidate] {
    let candidates = windows.compactMap { window -> CodexWindowCandidate? in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let (id, frame) = normalWindowGeometry(window) else { return nil }
        // 系统提供标题时，只比对 Codex 原生预览使用的两个固定名称。
        let title = window[kCGWindowName as String] as? String ?? ""
        return CodexWindowCandidate(id: id, frame: frame, hasTitle: !title.isEmpty,
                                    isPreview: title == "Computer Use" || title == "Computer Use Controls")
    }
    let hosts = candidates.filter(\.canHost)
    var excluded = Set(candidates.filter(\.isPreview).map(\.id))
    // 系统省略标题时，用相邻同框面板和后方更大的宿主识别预览，保留普通窗口的原有顺序。
    for index in hosts.indices.dropLast() {
        let controls = hosts[index], content = hosts[index + 1]
        guard controls.frame == content.frame,
              !controls.hasTitle || controls.isPreview,
              !content.hasTitle || content.isPreview else { continue }
        let hasLargerHost = hosts.dropFirst(index + 2).contains { candidate in
            !candidate.isPreview && candidate.frame.width > content.frame.width && candidate.frame.height > content.frame.height
        }
        if controls.isPreview || content.isPreview || hasLargerHost {
            excluded.insert(controls.id)
            excluded.insert(content.id)
        }
    }
    return candidates.filter { !excluded.contains($0.id) }
}

// 只发送变化后的窗口编号、层级与必要几何，不读取其他应用的标题或内容。
func emitSnapshot() {
    let now = ProcessInfo.processInfo.systemUptime
    lastSnapshotAt = now
    if Date().timeIntervalSince(lastDiscovery) > 3 { discoverProcesses(); lastDiscovery = Date() }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let normal = windows.compactMap(normalWindowGeometry)
    // 一份快照中所有实例共用一次按需查询，正常的辅助功能路径不扫描离屏窗口。
    lazy var filePanels = quartzFilePanelIDs()
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var hostFrames: [Int: CGRect] = [:]
    let processes: [[String: Any]] = cachedProcesses.values.sorted { $0.pid < $1.pid }.map { row in
        // 屏幕层级保留预览，跟随与模态判断使用筛选后的宿主列表。
        let candidates = visibleCodexWindows(windows, pid: row.pid)
        let visible: [[String: Any]] = candidates.filter(\.canHost).map { window in
            let id = window.id, rect = window.frame
            hostFrames[id] = rect
            return ["id": id, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        var process: [String: Any] = ["pid": row.pid, "appPath": row.appPath, "home": row.home, "networkEnv": row.environment, "frontmost": front == row.pid, "windows": visible, "platform": "darwin"]
        if let modal = cachedModalWindowState(row.pid, candidates, now, filePanelIDs: { filePanels }) { process["modalOpen"] = modal }
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
    let normalWindows = normal.map { id, rect -> [String: Any] in
        ["id": id, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
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
