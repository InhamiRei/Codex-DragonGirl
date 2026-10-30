import AppKit
import Darwin

// 启动助手只维护应用生命周期，不读取账户、会话或窗口内容。
struct StartupConfig: Decodable {
    let version: Int
    let revision: String
    let mode: String
    let executable: String
    let arguments: [String]
}

// 参数按位置解析，配置路径不会进入 shell。
func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

// JSON 读取失败由调用方决定重试或报告，不能将损坏的宿主快照当成全部退出。
func readJSON(_ url: URL) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
        throw NSError(domain: "DragonStartup", code: 1, userInfo: [NSLocalizedDescriptionKey: "无效的启动状态"])
    }
    return value
}

// 状态以原子替换方式发布，主程序只接受当前修订和新鲜心跳。
func writeJSON(_ value: [String: Any], to url: URL) throws {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url, options: .atomic)
}

// 时间戳统一采用毫秒，跨语言协议不依赖本机时区。
func milliseconds() -> Double { Date().timeIntervalSince1970 * 1000 }

// 桌面应用的进程与启动时间共同标识一次宿主生命周期。
func desktopHosts() -> [String] {
    return NSWorkspace.shared.runningApplications.compactMap { app in
        guard let bundle = app.bundleURL, ["Codex.app", "ChatGPT.app"].contains(bundle.lastPathComponent), !app.isTerminated else { return nil }
        return "\(app.processIdentifier):\(Int64((app.launchDate?.timeIntervalSince1970 ?? 0) * 1000))"
    }.sorted()
}

// 锁文件始终保留原 inode，进程退出时由系统释放，避免双助手同时启动。
func acquireLock(_ url: URL) throws -> Int32 {
    let descriptor = open(url.path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
    for _ in 0..<50 {
        if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return descriptor }
        usleep(100_000)
    }
    close(descriptor)
    return -1
}

// 常驻助手仅监听已登录用户的桌面应用，命令行 Codex 不属于联动宿主。
final class StartupSupervisor {
    let configURL: URL
    let directory: URL
    let initial: StartupConfig
    let testHosts: URL?
    var lastLaunch = -Double.infinity
    var attempts = 0
    var runningSince: Double?
    var lastHosts: [String] = []
    var message = ""
    var timer: Timer?
    var observers: [NSObjectProtocol] = []
    var fixtures: [Process] = []

    // 测试宿主必须显式开启，正式安装不接受测试输入。
    init(configURL: URL) throws {
        self.configURL = configURL
        directory = configURL.deletingLastPathComponent()
        initial = try JSONDecoder().decode(StartupConfig.self, from: Data(contentsOf: configURL))
        guard initial.version == 1, ["manual", "login", "codex"].contains(initial.mode), initial.executable.hasPrefix("/") else {
            throw NSError(domain: "DragonStartup", code: 2, userInfo: [NSLocalizedDescriptionKey: "启动配置无效"])
        }
        testHosts = ProcessInfo.processInfo.environment["DRAGONGIRL_TEST"] == "1"
            ? argument("--test-hosts").map { URL(fileURLWithPath: $0) } : nil
    }

    // 进程标识包含启动时间，即使 PID 被复用也不会继承旧会话的暂停。
    func hosts() throws -> [String] {
        if let testHosts {
            guard let rows = try readJSON(testHosts)["hosts"] as? [String] else {
                throw NSError(domain: "DragonStartup", code: 3, userInfo: [NSLocalizedDescriptionKey: "测试宿主状态无效"])
            }
            return rows.sorted()
        }
        return desktopHosts()
    }

    // 心跳与存活进程同时成立才认为龙娘已运行，磁盘上的旧 PID 不会用于终止进程。
    func runtimeAlive() -> Bool {
        guard let state = try? readJSON(directory.appendingPathComponent("runtime.json")),
              let updated = state["updatedAt"] as? Double, milliseconds() - updated < 12000, milliseconds() >= updated - 2000,
              let pid = state["pid"] as? Int32, kill(pid, 0) == 0 else { return false }
        if testHosts != nil { return true }
        guard let app = NSRunningApplication(processIdentifier: pid), let executable = state["executable"] as? String else { return false }
        return app.executableURL?.resolvingSymlinksInPath().standardizedFileURL.path
            == URL(fileURLWithPath: executable).resolvingSymlinksInPath().standardizedFileURL.path
    }

    // 暂停只绑定退出时仍存在的宿主，新一批 Codex 实例可以正常唤起龙娘。
    func paused(_ currentHosts: [String]) throws -> Bool {
        let file = directory.appendingPathComponent("pause.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return false }
        let pause = try readJSON(file)
        if pause["untilEmpty"] as? Bool == true && !currentHosts.isEmpty { return true }
        guard let blocked = pause["hosts"] as? [String] else { return true }
        if currentHosts.contains(where: { blocked.contains($0) }) { return true }
        try FileManager.default.removeItem(at: file)
        return false
    }

    // 正式应用交由系统启动，与 launchd 助手分离，切换设置不会杀掉正在使用的龙娘。
    func launch() throws {
        let process = Process()
        let flags = ["--dg-startup=\(initial.mode)", "--dg-startup-revision=\(initial.revision)"]
        if testHosts != nil {
            process.executableURL = URL(fileURLWithPath: initial.executable)
            process.arguments = initial.arguments + flags
        } else {
            let executable = URL(fileURLWithPath: initial.executable)
            let bundle = executable.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            guard bundle.pathExtension == "app", FileManager.default.isExecutableFile(atPath: executable.path) else {
                throw NSError(domain: "DragonStartup", code: 4, userInfo: [NSLocalizedDescriptionKey: "找不到龙娘应用，请手动打开一次以修复路径"])
            }
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-g", "-a", bundle.path, "--args"] + flags
        }
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        // 保留测试进程句柄，但绝不依据磁盘状态向其他进程发信号。
        fixtures.removeAll { !$0.isRunning }
        fixtures.append(process)
    }

    // 一秒一次的生命期检查独立于高频窗口跟随；失败次数有界，不形成反复拉起循环。
    func tick() {
        do {
            let current = try JSONDecoder().decode(StartupConfig.self, from: Data(contentsOf: configURL))
            if current.revision != initial.revision || current.mode == "manual" { exit(0) }
            let currentHosts = try hosts()
            if currentHosts != lastHosts { attempts = 0; lastHosts = currentHosts }
            let isPaused = try paused(currentHosts)
            let running = runtimeAlive()
            if running {
                runningSince = runningSince ?? milliseconds()
                if milliseconds() - (runningSince ?? 0) >= 60000 { attempts = 0 }
                message = ""
            } else { runningSince = nil }
            let eligible = initial.mode == "login" || !currentHosts.isEmpty
            if eligible && !running && !isPaused && attempts < 3 && milliseconds() - lastLaunch >= 15000 {
                lastLaunch = milliseconds(); attempts += 1
                do { try launch(); message = "" } catch { message = error.localizedDescription }
            }
            let phase = running ? "running" : isPaused ? "paused" : !eligible ? "waiting" : attempts >= 3 ? "error" : "starting"
            if phase == "error" && message.isEmpty { message = "龙娘未能启动，请手动打开应用检查安装位置" }
            try writeJSON(["version": 1, "revision": initial.revision, "pid": ProcessInfo.processInfo.processIdentifier,
                           "updatedAt": milliseconds(), "hosts": currentHosts, "phase": phase, "attempts": attempts, "message": message],
                          to: directory.appendingPathComponent("status.json"))
            if initial.mode == "login" && (running || attempts >= 3) { exit(0) }
        } catch {
            // 不发布虚假的空宿主状态，主程序会保留窗口并在设置中显示助手状态过期。
            fputs("启动助手暂时无法读取状态：\(error.localizedDescription)\n", stderr)
        }
    }

    // 应用启动和退出事件立即检查，定时检查同时覆盖唤醒与漏失通知。
    func run() {
        if initial.mode == "manual" { return }
        tick()
        for event in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification, NSWorkspace.didWakeNotification] {
            observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: event, object: nil, queue: .main) { [weak self] _ in self?.tick() })
        }
        timer = Timer.scheduledTimer(withTimeInterval: testHosts == nil ? 1 : 0.2, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.run()
    }
}

// 助手可以在新版本注册切换期间短暂等待锁，重复启动最终只保留一个观察进程。
do {
    if CommandLine.arguments.contains("--probe") {
        let data = try JSONSerialization.data(withJSONObject: ["hosts": desktopHosts()])
        FileHandle.standardOutput.write(data)
        exit(0)
    }
    let config = URL(fileURLWithPath: argument("--config") ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("config.json").path)
    let descriptor = try acquireLock(config.deletingLastPathComponent().appendingPathComponent("assistant.lock"))
    if descriptor >= 0 {
        defer { flock(descriptor, LOCK_UN); close(descriptor) }
        try StartupSupervisor(configURL: config).run()
    }
} catch {
    fputs("启动助手无法运行：\(error.localizedDescription)\n", stderr)
    exit(1)
}
