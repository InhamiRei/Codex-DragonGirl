using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Windows 桥只读取目录、网络白名单和窗口几何；层级控制仅作用于父进程创建的角色窗口。
internal static class DragonBridge
{
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    private static readonly string[] NetworkKeys = { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS" };
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static List<ProcessRow> processes = new List<ProcessRow>();
    private static DateTime discoveredAt = DateTime.MinValue;
    private static volatile bool inputClosed;
    // 仅在按住鼠标键或宿主连续移动时提高采样频率，静止时维持原有查询间隔。
    private const int TrackingIntervalMs = 40;
    private const int IdleIntervalMs = 120;
    private const int RecentMovementMs = 200;
    private static readonly Stopwatch hostMovement = new Stopwatch();
    private static Dictionary<long, Rect> lastHostFrames = new Dictionary<long, Rect>();

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

    // 一份快照中的句柄、物理边界和置顶状态来自同一次枚举，顺序从屏幕前方向后。
    private sealed class ScreenWindow
    {
        internal IntPtr Handle;
        internal Rect Bounds;
        internal bool Topmost;
    }

    // Windows x64 的 MEMORY_BASIC_INFORMATION 按指针宽度对齐，区域长度使用 SIZE_T。
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryRegion
    {
        internal IntPtr BaseAddress, AllocationBase;
        internal uint AllocationProtect;
        internal ushort PartitionId;
        internal UIntPtr RegionSize;
        internal uint State, Protect, Type;
    }
    private static readonly UIntPtr MemoryRegionSize = new UIntPtr((uint)Marshal.SizeOf(typeof(MemoryRegion)));

    // 枚举顶层窗口，不截屏、不读取窗口文字。
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    // 获取所属进程以排除辅助进程与其他应用。
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    // 获取系统窗口几何。
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    // 通过系统类名识别原生右键菜单，不读取标题或菜单文字。
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    // 只检查鼠标键当前是否按下，兼容交换了左右键的用户。
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
    // 忽略隐藏窗口。
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    // 模态文件框、确认框由系统禁用其宿主，桌宠在宿主重新启用之前收起。
    [DllImport("user32.dll")]
    private static extern bool IsWindowEnabled(IntPtr window);
    // 区分宿主与它拥有的非模态工具窗，并在用户要求聚焦时找到可用的模态窗口。
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);
    // 最小化窗口不显示关联角色。
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    // 区分系统置顶窗口与普通窗口，避免相对排序意外继承置顶属性。
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    // 只调整本应用角色的层级，不激活、不移动、不显示隐藏窗口，也不改变所有者层级。
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
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
    private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    // 读取前查询可读区域的实际边界，避免 ReadProcessMemory 跨到下一段不可读的内存。
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr VirtualQueryEx(IntPtr process, IntPtr address, out MemoryRegion region, UIntPtr size);
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
            if (peb == IntPtr.Zero) return null;
            IntPtr parameters = ReadPointer(handle, new IntPtr(peb.ToInt64() + 0x20));
            if (parameters == IntPtr.Zero) return null;
            IntPtr environment = ReadPointer(handle, new IntPtr(parameters.ToInt64() + 0x80));
            return environment == IntPtr.Zero ? null : ReadEnvironmentBlock(handle, environment);
        }
        finally { CloseHandle(handle); }
    }

    // 只读取已提交且允许读取的当前区域；保护页和空闲页不会因探测而被触碰。
    private static int ReadableBytes(IntPtr handle, IntPtr address, int limit)
    {
        MemoryRegion region;
        if (VirtualQueryEx(handle, address, out region, MemoryRegionSize) != MemoryRegionSize
            || region.State != 0x1000 || (region.Protect & 0x100) != 0) return 0; // MEM_COMMIT、PAGE_GUARD。
        switch (region.Protect & 0xff)
        {
            // PAGE_READONLY、PAGE_READWRITE、PAGE_WRITECOPY 及对应的可执行可读页。
            case 0x02: case 0x04: case 0x08: case 0x20: case 0x40: case 0x80:
                long offset = address.ToInt64() - region.BaseAddress.ToInt64();
                ulong size = region.RegionSize.ToUInt64();
                return offset >= 0 && (ulong)offset < size ? (int)Math.Min((ulong)limit, size - (ulong)offset) : 0;
            default: return 0;
        }
    }

    // 分段读取 UTF-16 环境块，保留跨段的 Unicode 字符与双零结束符，上限仍为 128 KiB。
    private static Dictionary<string, string> ReadEnvironmentBlock(IntPtr handle, IntPtr environment)
    {
        const int maxBytes = 128 * 1024;
        byte[] buffer = new byte[4096];
        StringBuilder block = new StringBuilder();
        bool previousZero = false;
        int offset = 0;
        while (offset < maxBytes)
        {
            IntPtr address = IntPtr.Add(environment, offset);
            int length = ReadableBytes(handle, address, Math.Min(buffer.Length, maxBytes - offset)) & ~1;
            UIntPtr count;
            // 区域可能在查询后被释放，只接受完整读取，避免把部分环境误当成默认实例。
            if (length == 0 || !ReadProcessMemory(handle, address, buffer, new UIntPtr((uint)length), out count) || count.ToUInt64() != (uint)length)
                return null;
            for (int i = 0; i < length; i += 2)
            {
                char character = (char)(buffer[i] | (buffer[i + 1] << 8));
                if (character == '\0' && previousZero) return ParseEnvironment(block.ToString());
                block.Append(character);
                previousZero = character == '\0';
            }
            offset += length;
        }
        return null;
    }

    // Windows 环境变量名不区分大小写；将白名单字段统一为标准键名后再识别实例和代理。
    private static Dictionary<string, string> ParseEnvironment(string block)
    {
        Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string entry in block.Split('\0'))
        {
            int separator = entry.IndexOf('=');
            if (separator < 1) continue;
            string key = entry.Substring(0, separator).ToUpperInvariant();
            if (key == "CODEX_HOME" || Array.IndexOf(NetworkKeys, key) >= 0)
                result[key] = entry.Substring(separator + 1);
        }
        return result;
    }

    // 只接受完整的 64 位指针读取，防止部分结果变成错误地址。
    private static IntPtr ReadPointer(IntPtr handle, IntPtr address)
    {
        byte[] buffer = new byte[8];
        UIntPtr count;
        if (!ReadProcessMemory(handle, address, buffer, new UIntPtr(8), out count) || count.ToUInt64() != 8) return IntPtr.Zero;
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
                    if (!IsTarget(process) || FirstHostWindow(process.Id, true) == IntPtr.Zero) continue;
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

    // 过滤同进程工具窗、附属面板和菜单，小型最小化窗口仍可供用户从管理页恢复。
    private static bool CanHost(IntPtr window, Rect rect, bool minimized)
    {
        if (!minimized && (rect.Right - rect.Left < 400 || rect.Bottom - rect.Top < 300)) return false;
        if ((GetWindowLongPtr(window, -20).ToInt64() & 0x80) != 0) return false; // WS_EX_TOOLWINDOW。
        IntPtr parent = GetWindow(window, 4); // GW_OWNER。
        if (parent != IntPtr.Zero && IsWindowVisible(parent)) return false;
        StringBuilder className = new StringBuilder(64);
        return GetClassName(window, className, className.Capacity) == 0 || className.ToString() != "#32768";
    }

    // 发现或聚焦进程只需要最前面的宿主，第一个命中后就结束系统枚举。
    private static IntPtr FirstHostWindow(int pid, bool includeMinimized)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)pid || !IsWindowVisible(window)) return true;
            bool minimized = IsIconic(window);
            int cloaked;
            if (!includeMinimized && (minimized || DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0)) return true;
            Rect rect;
            if (!GetWindowRect(window, out rect) || !CanHost(window, rect, minimized)) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // 普通遮挡窗和宿主用相同的物理矩形，序列化时可以复用同一次采样得到的记录。
    private static Dictionary<string, object> WindowFrame(long id, Rect rect)
    {
        return new Dictionary<string, object> {
            { "id", id }, { "x", rect.Left }, { "y", rect.Top },
            { "width", rect.Right - rect.Left }, { "height", rect.Bottom - rect.Top }
        };
    }

    // 只比较宿主几何，角色自移动与其他窗口变动不会延长高频采样。
    private static bool HostFramesChanged(Dictionary<long, Rect> frames)
    {
        if (frames.Count != lastHostFrames.Count) return true;
        foreach (KeyValuePair<long, Rect> frame in frames)
        {
            Rect previous;
            if (!lastHostFrames.TryGetValue(frame.Key, out previous) || !frame.Value.Equals(previous)) return true;
        }
        return false;
    }

    // 仅发布屏幕上窗口的前后编号；层级变化也触发快照，不读取其他应用的标题或内容。
    private static List<ScreenWindow> VisibleWindows()
    {
        List<ScreenWindow> windows = new List<ScreenWindow>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window) || IsIconic(window)) return true;
            int cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            // 输入法等辅助窗口可能带有可见标志却没有绘制区域，不能因此把前台宿主误判为被覆盖。
            Rect rect;
            if (!GetWindowRect(window, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
            windows.Add(new ScreenWindow { Handle = window, Bounds = rect, Topmost = IsTopmost(window) });
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
        Dictionary<long, Rect> frames = new Dictionary<long, Rect>();
        var hostsByPid = new Dictionary<uint, List<Dictionary<string, object>>>();
        foreach (ProcessRow row in processes) hostsByPid[(uint)row.Pid] = new List<Dictionary<string, object>>();
        List<long> topmost = new List<long>(), order = new List<long>();
        List<Dictionary<string, object>> normalWindows = new List<Dictionary<string, object>>();
        // 同一次 EnumWindows 既提供遮挡顺序也提供各实例的宿主，拖动时不会为每个进程重扫整桌面。
        foreach (ScreenWindow window in VisibleWindows())
        {
            long id = window.Handle.ToInt64();
            order.Add(id);
            Dictionary<string, object> frame = null;
            if (window.Topmost) topmost.Add(id);
            else
            {
                frame = WindowFrame(id, window.Bounds);
                normalWindows.Add(frame);
            }
            if (hostsByPid.Count == 0) continue;
            uint owner;
            GetWindowThreadProcessId(window.Handle, out owner);
            List<Dictionary<string, object>> hosts;
            if (hostsByPid.TryGetValue(owner, out hosts) && CanHost(window.Handle, window.Bounds, false))
            {
                hosts.Add(frame ?? WindowFrame(id, window.Bounds));
                frames[id] = window.Bounds;
            }
        }
        foreach (ProcessRow row in processes)
        {
            List<Dictionary<string, object>> hosts = hostsByPid[(uint)row.Pid];
            bool blocked = hosts.Count > 0 && !IsWindowEnabled(new IntPtr((long)hosts[0]["id"]));
            rows.Add(new Dictionary<string, object> {
                { "pid", row.Pid }, { "appPath", row.AppPath }, { "home", row.Home },
                { "networkEnv", row.Network }, { "frontmost", front == (uint)row.Pid },
                { "coordinateSpace", "physical" }, { "windows", hosts }, { "modalOpen", blocked }
            });
        }
        if (HostFramesChanged(frames))
        {
            lastHostFrames = frames;
            hostMovement.Restart();
        }
        return Json.Serialize(new Dictionary<string, object> { { "processes", rows }, { "windowOrder", order }, { "topmostWindows", topmost }, { "normalWindows", normalWindows }, { "screenPermission", true } });
    }

    // 聚焦只允许目标应用，窗口恢复后再请求系统激活。
    private static int Focus(int pid)
    {
        using (Process process = Process.GetProcessById(pid))
        {
            if (!IsTarget(process)) return 1;
            IntPtr window = FirstHostWindow(pid, false);
            if (window == IntPtr.Zero) window = FirstHostWindow(pid, true);
            if (window == IntPtr.Zero) return 1;
            if (IsIconic(window)) ShowWindow(window, 9); // SW_RESTORE 也会取消最大化，仅用于最小化窗口。
            if (!IsWindowEnabled(window))
            {
                IntPtr popup = GetWindow(window, 6); // GW_ENABLEDPOPUP。
                if (popup == IntPtr.Zero || !IsWindowVisible(popup) || !IsWindowEnabled(popup)) return 1;
                window = popup;
            }
            return SetForegroundWindow(window) ? 0 : 1;
        }
    }

    // 命令中的每个角色编号都必须属于启动桥的 Electron 进程，拒绝操作其他应用窗口。
    private static List<IntPtr> OwnedHandles(object value, int owner)
    {
        object[] values = value as object[];
        if (values == null || values.Length > 256) throw new ArgumentException();
        List<IntPtr> result = new List<IntPtr>();
        foreach (object item in values)
        {
            long id = Convert.ToInt64(item);
            uint pid;
            IntPtr window = new IntPtr(id);
            // 气泡或特效可能已销毁；只丢弃失效或不属于本应用的编号，让仍有效的角色继续排序。
            if (id <= 0 || GetWindowThreadProcessId(window, out pid) == 0 || pid != (uint)owner) continue;
            if (!result.Contains(window)) result.Add(window);
        }
        return result;
    }

    // 始终读取系统实际置顶样式，避免 Electron 缓存与外部原生排序结果不一致。
    private static bool IsTopmost(IntPtr window)
    {
        return window != IntPtr.Zero && (GetWindowLongPtr(window, -20).ToInt64() & 0x8) != 0;
    }

    // 比较物理像素的开区间；另一台显示器上的窗口或刚好相接的边界都不会遮住桌宠。
    private static bool Overlaps(Rect a, Rect b)
    {
        return a.Left < b.Right && b.Left < a.Right && a.Top < b.Bottom && b.Top < a.Bottom;
    }

    // 只用本次真正显示的窗口排序。收起的气泡不能充当角色的锚点，其他应用的前台焦点保持原样。
    private static void StackWindows(Dictionary<string, object> request, int owner)
    {
        List<IntPtr> overlays = OwnedHandles(request["overlays"], owner);
        if (overlays.Count == 0) return;
        List<IntPtr> owned = OwnedHandles(request["owned"], owner);
        IntPtr host = new IntPtr(Convert.ToInt64(request["host"]));
        const uint flags = 0x213; // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER。
        // 桌面模式的恢复命令也通过同一管道排队，覆盖模式切换前尚未执行的跟随请求。
        if (host == IntPtr.Zero)
        {
            foreach (IntPtr window in overlays)
                if (!IsTopmost(window)) SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, flags);
            return;
        }
        uint hostPid;
        if (GetWindowThreadProcessId(host, out hostPid) == 0 || !IsWindowVisible(host) || IsIconic(host) || !IsWindowEnabled(host)) return;
        using (Process process = Process.GetProcessById((int)hostPid)) if (!IsTarget(process)) return;
        List<ScreenWindow> visible = VisibleWindows();
        int hostIndex = visible.FindIndex(w => w.Handle == host);
        if (hostIndex < 0) return;
        // 上次在前台收起的气泡先退回普通层，下次在后台弹出通知时也不会带着旧置顶样式出现。
        foreach (IntPtr window in overlays)
            if (!IsWindowVisible(window) && IsTopmost(window)) SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, flags);
        // 请求按波纹、角色、气泡从后到前排列；隐藏窗口重新显示时会触发新的排序请求。
        List<int> layers = overlays.ConvertAll(handle => visible.FindIndex(w => w.Handle == handle));
        layers.RemoveAll(index => index < 0);
        if (layers.Count == 0) return;

        // 前台只考虑真正挡住桌宠的窗口；后台连同宿主一起排在遮挡者后面，露出的部分由系统自然合成。
        bool hostForeground = GetForegroundWindow() == host;
        int cover = -1;
        for (int i = 0; i < hostIndex; i++)
        {
            ScreenWindow candidate = visible[i];
            if (owned.Contains(candidate.Handle) || overlays.Contains(candidate.Handle)) continue;
            if ((!hostForeground && Overlaps(candidate.Bounds, visible[hostIndex].Bounds))
                || layers.Exists(index => Overlaps(candidate.Bounds, visible[index].Bounds))) cover = i;
        }
        bool floating = cover < 0 || visible[cover].Topmost;
        int upper = hostIndex;
        bool placed = true;
        foreach (int index in layers)
        {
            if (index <= cover || index >= upper || visible[index].Topmost != floating) placed = false;
            upper = index;
        }
        if (placed) return;

        // 每个窗口都插在同一个可见遮挡者之后，后放的气泡自然在角色前方。无需依赖另一扇桌宠窗口已就位。
        IntPtr anchor = cover < 0 ? new IntPtr(-1) : visible[cover].Handle;
        foreach (int index in layers)
        {
            IntPtr window = visible[index].Handle;
            // 跨组时显式撤销置顶，单纯对普通窗口做相对排序可能留下旧样式。
            if (!floating && IsTopmost(window) && !SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, flags)) return;
            if (SetWindowPos(window, anchor, 0, 0, 0, 0, flags) && IsTopmost(window) == floating) continue;
            // 跨组失败时显式提升，再排回可见菜单之后。若菜单刚刚关闭，交由下一份实时快照选锚点。
            if (!floating || cover < 0 || !SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, flags)) return;
            if (!SetWindowPos(window, anchor, 0, 0, 0, 0, flags)) return;
        }
    }

    // 只接受父进程私有标准输入中的小型层级请求；一次陈旧句柄失败不影响下一次心跳恢复。
    private static void ReadCommands(int owner)
    {
        JavaScriptSerializer parser = new JavaScriptSerializer();
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (line.Length > 16384) continue;
                try { StackWindows(parser.DeserializeObject(line) as Dictionary<string, object>, owner); }
                catch (Exception) { /* 窗口可能已关闭或更换；由下一份有效快照重试。 */ }
            }
        }
        catch (IOException) { /* 父进程关闭管道时正常结束，不留下控制线程。 */ }
        finally { inputClosed = true; }
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
            if (args.Length == 2 && args[0] == "--owner" && int.TryParse(args[1], out pid) && pid > 0)
            {
                Thread controls = new Thread(delegate() { ReadCommands(pid); });
                controls.IsBackground = true;
                controls.Start();
            }
            else if (args.Length != 0) return 1;
            string previous = null;
            // 排序可能被系统暂时拒绝且不报错；稳定状态每秒补发一次，松手后无需再移动其他窗口也能重试。
            Stopwatch heartbeat = Stopwatch.StartNew();
            Stopwatch snapshotAge = Stopwatch.StartNew();
            while (!inputClosed)
            {
                bool tracking = lastHostFrames.Count > 0 && (hostMovement.ElapsedMilliseconds < RecentMovementMs
                    || GetAsyncKeyState(0x01) < 0 || GetAsyncKeyState(0x02) < 0);
                if (tracking || previous == null || snapshotAge.ElapsedMilliseconds >= IdleIntervalMs)
                {
                    snapshotAge.Restart();
                    string current = Snapshot();
                    if (current != previous || heartbeat.ElapsedMilliseconds >= 1000)
                    {
                        Console.WriteLine(current);
                        Console.Out.Flush();
                        previous = current;
                        heartbeat.Restart();
                    }
                }
                Thread.Sleep(TrackingIntervalMs);
            }
            return 0;
        }
        catch (IOException) { return 0; }
        catch (Exception) { Console.Error.WriteLine("窗口桥暂不可用，请重新打开应用。"); return 1; }
    }
}
