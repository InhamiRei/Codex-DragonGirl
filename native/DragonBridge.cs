using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Windows 桥仅发布所属目录、网络白名单和窗口几何，不读取会话正文或登录文件。
internal static class DragonBridge
{
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    private static readonly string[] NetworkKeys = { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS" };
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static List<ProcessRow> processes = new List<ProcessRow>();
    private static DateTime discoveredAt = DateTime.MinValue;

    // 每个记录只保留识别和聚焦所需的信息，完整环境读取后立即释放。
    private sealed class ProcessRow
    {
        internal int Pid;
        internal string AppPath;
        internal string Home;
        internal Dictionary<string, string> Network;
    }

    // Win32 矩形使用物理像素，由 Electron 按显示器 DPI 转换。
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { internal int Left, Top, Right, Bottom; }

    // 枚举顶层窗口，不截屏、不读取窗口文字。
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    // 获取所属进程以排除辅助进程与其他应用。
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    // 获取系统窗口几何。
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    // 忽略隐藏窗口。
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    // 最小化窗口不显示关联角色。
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    // 前台窗口用于选择当前实例。
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    // 用户点击入口后才聚焦目标窗口。
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    // 聚焦时恢复已最小化的主窗口。
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    // 排除其他虚拟桌面中被系统隐藏的窗口。
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    // 只申请读取目标进程的权限，不申请写入或调试权限。
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    // 查询进程参数位置，失败时不猜测账户目录。
    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int type, byte[] information, int size, out int returned);
    // 读取有长度上限的环境块，仅在内存中解析白名单。
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
    // 及时关闭每次查询打开的系统句柄。
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    // 明确使用每显示器 DPI，避免系统对物理窗口坐标重复缩放。
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    // 只识别正式应用主进程，CLI 和其他 Electron 应用不进入跟随列表。
    private static bool IsTarget(Process process)
    {
        return string.Equals(process.ProcessName, "Codex", StringComparison.OrdinalIgnoreCase)
            || string.Equals(process.ProcessName, "ChatGPT", StringComparison.OrdinalIgnoreCase);
    }

    // Windows x64 参数布局读取失败时直接跳过，避免把多开实例误归入默认账户。
    private static Dictionary<string, string> ReadEnvironment(int pid)
    {
        IntPtr handle = OpenProcess(0x410, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            byte[] basic = new byte[48];
            int returned;
            if (NtQueryInformationProcess(handle, 0, basic, basic.Length, out returned) != 0) return null;
            IntPtr peb = new IntPtr(BitConverter.ToInt64(basic, 8));
            IntPtr parameters = ReadPointer(handle, new IntPtr(peb.ToInt64() + 0x20));
            IntPtr environment = ReadPointer(handle, new IntPtr(parameters.ToInt64() + 0x80));
            if (peb == IntPtr.Zero || parameters == IntPtr.Zero || environment == IntPtr.Zero) return null;
            StringBuilder block = new StringBuilder();
            // 限制最多读取 128 KiB，遇到双零终止符立即停止。
            for (int offset = 0; offset < 131072; offset += 4096)
            {
                byte[] buffer = new byte[4096];
                IntPtr count;
                ReadProcessMemory(handle, new IntPtr(environment.ToInt64() + offset), buffer, buffer.Length, out count);
                int length = (int)count.ToInt64() & ~1;
                if (length <= 0) return null;
                block.Append(Encoding.Unicode.GetString(buffer, 0, length));
                string text = block.ToString();
                int end = text.IndexOf("\0\0", StringComparison.Ordinal);
                if (end < 0) continue;
                Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (string entry in text.Substring(0, end).Split('\0'))
                {
                    int separator = entry.IndexOf('=');
                    if (separator < 1) continue;
                    string key = entry.Substring(0, separator);
                    if (key == "CODEX_HOME" || Array.IndexOf(NetworkKeys, key) >= 0)
                        result[key] = entry.Substring(separator + 1);
                }
                return result;
            }
            return null;
        }
        finally { CloseHandle(handle); }
    }

    // 只接受完整的 64 位指针读取，防止部分结果变成错误地址。
    private static IntPtr ReadPointer(IntPtr handle, IntPtr address)
    {
        byte[] buffer = new byte[8];
        IntPtr count;
        if (!ReadProcessMemory(handle, address, buffer, 8, out count) || count.ToInt64() != 8) return IntPtr.Zero;
        return new IntPtr(BitConverter.ToInt64(buffer, 0));
    }

    // 每三秒重新识别主进程，进程退出和权限失败互不阻塞。
    private static void Discover()
    {
        List<ProcessRow> next = new List<ProcessRow>();
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    if (!IsTarget(process) || Windows(process.Id, true).Count == 0) continue;
                    Dictionary<string, string> environment = ReadEnvironment(process.Id);
                    if (environment == null) continue;
                    string home;
                    if (!environment.TryGetValue("CODEX_HOME", out home))
                        home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
                    if (!Path.IsPathRooted(home)) continue;
                    environment.Remove("CODEX_HOME");
                    next.Add(new ProcessRow { Pid = process.Id, AppPath = process.MainModule.FileName, Home = Path.GetFullPath(home), Network = environment });
                }
                catch (Exception) { /* 已退出或不可读取的进程不进入当前快照。 */ }
            }
        }
        next.Sort((a, b) => a.Pid.CompareTo(b.Pid));
        processes = next;
        discoveredAt = DateTime.UtcNow;
    }

    // 保留可见主窗口；最小化和其他虚拟桌面的窗口返回空列表。
    private static List<Dictionary<string, object>> Windows(int pid, bool includeMinimized)
    {
        List<Dictionary<string, object>> windows = new List<Dictionary<string, object>>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)pid || !IsWindowVisible(window) || (!includeMinimized && IsIconic(window))) return true;
            int cloaked;
            if (!includeMinimized && DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            Rect rect;
            if (!GetWindowRect(window, out rect)) return true;
            if (!includeMinimized && (rect.Right - rect.Left < 400 || rect.Bottom - rect.Top < 300)) return true;
            windows.Add(new Dictionary<string, object> {
                { "id", window.ToInt64() }, { "x", rect.Left }, { "y", rect.Top },
                { "width", rect.Right - rect.Left }, { "height", rect.Bottom - rect.Top }
            });
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    // 输出与 macOS 一致的行分隔 JSON 协议，物理坐标显式标记。
    private static string Snapshot()
    {
        if ((DateTime.UtcNow - discoveredAt).TotalSeconds >= 3) Discover();
        uint front;
        GetWindowThreadProcessId(GetForegroundWindow(), out front);
        List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
        foreach (ProcessRow row in processes)
            rows.Add(new Dictionary<string, object> {
                { "pid", row.Pid }, { "appPath", row.AppPath }, { "home", row.Home },
                { "networkEnv", row.Network }, { "frontmost", front == (uint)row.Pid },
                { "coordinateSpace", "physical" }, { "windows", Windows(row.Pid, false) }
            });
        return Json.Serialize(new Dictionary<string, object> { { "processes", rows }, { "screenPermission", true } });
    }

    // 聚焦只允许目标应用，窗口恢复后再请求系统激活。
    private static int Focus(int pid)
    {
        using (Process process = Process.GetProcessById(pid))
        {
            if (!IsTarget(process)) return 1;
            List<Dictionary<string, object>> windows = Windows(pid, true);
            if (windows.Count == 0) return 1;
            IntPtr window = new IntPtr((long)windows[0]["id"]);
            ShowWindow(window, 9);
            return SetForegroundWindow(window) ? 0 : 1;
        }
    }

    // 桥随父进程关闭管道而结束，不留下后台常驻服务。
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            if (args.Length == 1 && args[0] == "--permission") { Console.WriteLine("true"); return 0; }
            int pid;
            if (args.Length == 2 && args[0] == "--focus" && int.TryParse(args[1], out pid)) return Focus(pid);
            if (args.Length == 1 && args[0] == "--once") { Console.WriteLine(Snapshot()); return 0; }
            if (args.Length != 0) return 1;
            string previous = null;
            while (true)
            {
                string current = Snapshot();
                if (current != previous) { Console.WriteLine(current); Console.Out.Flush(); previous = current; }
                Thread.Sleep(120);
            }
        }
        catch (IOException) { return 0; }
        catch (Exception) { Console.Error.WriteLine("窗口桥暂不可用，请重新打开应用。"); return 1; }
    }
}
