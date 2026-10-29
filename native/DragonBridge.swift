import AppKit
import CoreGraphics
import Foundation

// 原生桥只读取进程目录、有限网络环境及窗口几何，不截屏、不读取凭据。
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
    for app in apps where cachedProcesses[app.processIdentifier] == nil {
        let environment = processEnvironment(app.processIdentifier)
        let home = environment["CODEX_HOME"] ?? defaultHome
        guard home.hasPrefix("/") else { continue }
        cachedProcesses[app.processIdentifier] = ProcessInfoRow(pid: app.processIdentifier, appPath: app.bundleURL!.path, home: URL(fileURLWithPath: home).resolvingSymlinksInPath().path, environment: environment.filter { $0.key != "CODEX_HOME" })
    }
}
// 只发送变化后的窗口列表；Quartz 和 Electron 都使用左上角逻辑坐标。
func emitSnapshot() {
    if Date().timeIntervalSince(lastDiscovery) > 3 { discoverProcesses(); lastDiscovery = Date() }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let processes: [[String: Any]] = cachedProcesses.values.sorted { $0.pid < $1.pid }.map { row in
        let visible = windows.compactMap { window -> [String: Any]? in
            guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == row.pid,
                  (window[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds), rect.width >= 400, rect.height >= 300,
                  (window[kCGWindowAlpha as String] as? Double ?? 1) > 0.1 else { return nil }
            return ["id": window[kCGWindowNumber as String] ?? 0, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
        }
        return ["pid": row.pid, "appPath": row.appPath, "home": row.home, "networkEnv": row.environment, "frontmost": front == row.pid, "windows": visible]
    }
    let snapshot: [String: Any] = ["processes": processes, "screenPermission": CGPreflightScreenCaptureAccess()]
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
    let timer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { _ in emitSnapshot() }
    RunLoop.main.add(timer, forMode: .common)
    RunLoop.main.run()
}
