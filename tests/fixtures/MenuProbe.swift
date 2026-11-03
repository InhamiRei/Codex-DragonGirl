import CoreGraphics
import Foundation

// 只检查隔离测试进程的原生菜单矩形，不读取窗口标题、截图或其他应用内容。
let owner = Int(CommandLine.arguments[1])!
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let menus = windows.compactMap { info -> [String: Any]? in
    guard (info[kCGWindowOwnerPID as String] as? Int) == owner,
          (info[kCGWindowLayer as String] as? Int ?? 0) >= CGWindowLevelForKey(.popUpMenuWindow),
          (info[kCGWindowAlpha as String] as? Double ?? 1) > 0.01,
          let bounds = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds), rect.width >= 80, rect.height >= 60 else { return nil }
    return ["id": info[kCGWindowNumber as String] ?? 0, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
            "alpha": info[kCGWindowAlpha as String] ?? 1]
}
let data = try! JSONSerialization.data(withJSONObject: menus)
FileHandle.standardOutput.write(data)
