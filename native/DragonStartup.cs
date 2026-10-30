using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// 无控制台的启动助手只观察进程生命期，不读取账户和聊天记录。
internal static class DragonStartup
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunName = "Codex DragonGirl Startup";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Dictionary<int, string> KnownHosts = new Dictionary<int, string>();
    private static string directory, configFile, revision, mode, executable, testHosts;
    private static string[] launchArguments, lastHosts = new string[0];
    private static double lastLaunch = Double.NegativeInfinity;
    private static int attempts;
    private static double runningSince;
    private static string message = "";

    // 参数由系统直接传递，绝不拼成 PowerShell 或 cmd 脚本。
    private static string Argument(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    // 毫秒协议与主程序、其他平台保持一致。
    private static double Now() { return (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }

    // Windows 参数引号正确处理空格、双引号和末尾反斜线。
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    // 读取失败交由上层重试，不能据此判断所有宿主都已退出。
    private static Dictionary<string, object> Read(string file)
    {
        using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
            return Json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
    }

    // 固定字段访问集中校验，缺少字段时返回默认值。
    private static string Text(Dictionary<string, object> value, string key)
    {
        object result;
        return value.TryGetValue(key, out result) ? result as string : null;
    }

    // 数字只用于状态和心跳校验，从不用于结束磁盘记录中的进程。
    private static double Number(Dictionary<string, object> value, string key)
    {
        object result;
        return value.TryGetValue(key, out result) ? Convert.ToDouble(result) : 0;
    }

    // 数组成员必须是字符串，坏的宿主列表不能被当成空列表。
    private static string[] Strings(Dictionary<string, object> value, string key)
    {
        object result;
        if (!value.TryGetValue(key, out result) || !(result is System.Collections.IEnumerable) || result is string)
            throw new InvalidDataException("启动状态中的列表无效");
        return ((System.Collections.IEnumerable)result).Cast<object>().Select(item => {
            if (!(item is string)) throw new InvalidDataException("启动状态中的进程标识无效");
            return (string)item;
        }).ToArray();
    }

    // 替换状态文件时允许其他进程短暂读取，读者始终获得完整 JSON。
    private static void Write(string file, object value)
    {
        string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, Json.Serialize(value), new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(temporary, file, null);
            else File.Move(temporary, file);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    // 登录项仅注册当前用户，设置后立即读回核验，禁用时只删除本产品的值。
    private static void Registration(bool enabled)
    {
        string command = Quote(Assembly.GetExecutingAssembly().Location);
        if (enabled && command.Length > 260) throw new InvalidOperationException("用户数据路径过长，无法注册系统登录项");
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
        {
            if (enabled) key.SetValue(RunName, command, RegistryValueKind.String);
            else key.DeleteValue(RunName, false);
            string saved = key.GetValue(RunName) as string;
            if (enabled ? saved != command : saved != null) throw new IOException("系统未保存启动设置");
        }
    }

    // 只识别当前桌面会话里的主窗口进程，保留已识别但暂时关闭窗口的宿主。
    private static string[] Hosts()
    {
        if (testHosts != null) return Strings(Read(testHosts), "hosts").OrderBy(value => value, StringComparer.Ordinal).ToArray();
        List<string> found = new List<string>();
        Dictionary<int, string> next = new Dictionary<int, string>();
        int session;
        using (Process self = Process.GetCurrentProcess()) session = self.SessionId;
        foreach (string name in new[] { "Codex", "ChatGPT" })
        foreach (Process process in Process.GetProcessesByName(name))
        using (process)
        {
            try
            {
                if (process.SessionId != session) continue;
                string identity = process.Id + ":" + process.StartTime.ToUniversalTime().Ticks;
                string known;
                if (process.MainWindowHandle == IntPtr.Zero && (!KnownHosts.TryGetValue(process.Id, out known) || known != identity)) continue;
                // 同名 CLI 没有自己的桌面主窗口，首次识别时不会进入列表。
                string file = Path.GetFileNameWithoutExtension(process.MainModule.FileName);
                if (!String.Equals(file, name, StringComparison.OrdinalIgnoreCase)) continue;
                next[process.Id] = identity;
                found.Add(identity);
            }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception)
            {
                if (KnownHosts.ContainsKey(process.Id)) throw new IOException("暂时无法确认 Codex 进程状态");
            }
        }
        KnownHosts.Clear();
        foreach (KeyValuePair<int, string> row in next) KnownHosts[row.Key] = row.Value;
        return found.OrderBy(value => value, StringComparer.Ordinal).ToArray();
    }

    // 真实进程路径与新鲜心跳同时匹配才视为运行，旧版本仍运行时也不重复唤起。
    private static bool RuntimeAlive()
    {
        try
        {
            Dictionary<string, object> state = Read(Path.Combine(directory, "runtime.json"));
            double age = Now() - Number(state, "updatedAt");
            if (age < -2000 || age >= 12000) return false;
            using (Process process = Process.GetProcessById((int)Number(state, "pid")))
                return !process.HasExited && (testHosts != null || String.Equals(process.MainModule.FileName, Text(state, "executable"), StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception) { return false; }
    }

    // 主动退出只暂停当时的 Codex 实例，全部结束后自动解除，不依赖看到空窗口的瞬间。
    private static bool Paused(string[] hosts)
    {
        string file = Path.Combine(directory, "pause.json");
        if (!File.Exists(file)) return false;
        Dictionary<string, object> pause = Read(file);
        object untilEmpty;
        if (pause.TryGetValue("untilEmpty", out untilEmpty) && untilEmpty is bool && (bool)untilEmpty && hosts.Length > 0) return true;
        string[] blocked = Strings(pause, "hosts");
        if (hosts.Any(host => blocked.Contains(host))) return true;
        File.Delete(file);
        return false;
    }

    // 图形主程序直接启动，无命令行窗口；助手从不强制结束主程序或宿主。
    private static void Launch()
    {
        if (!File.Exists(executable)) throw new FileNotFoundException("找不到龙娘应用，请手动打开一次以修复路径");
        string[] flags = new[] { "--dg-startup=" + mode, "--dg-startup-revision=" + revision };
        ProcessStartInfo start = new ProcessStartInfo(executable, String.Join(" ", launchArguments.Concat(flags).Select(Quote))) {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(executable)
        };
        start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        using (Process child = Process.Start(start)) { }
    }

    // 生命周期每秒检查，失败最多重试三次；窗口隐藏不影响宿主进程的存活判定。
    private static bool Tick()
    {
        Dictionary<string, object> config = Read(configFile);
        if (Text(config, "revision") != revision || Text(config, "mode") == "manual") return false;
        string[] hosts = Hosts();
        if (!hosts.SequenceEqual(lastHosts)) { attempts = 0; lastHosts = hosts; }
        bool paused = Paused(hosts), running = RuntimeAlive(), eligible = mode == "login" || hosts.Length > 0;
        if (running)
        {
            if (runningSince == 0) runningSince = Now();
            if (Now() - runningSince >= 60000) attempts = 0;
            message = "";
        }
        else runningSince = 0;
        if (eligible && !paused && !running && attempts < 3 && Now() - lastLaunch >= 15000)
        {
            lastLaunch = Now(); attempts++;
            try { Launch(); message = ""; }
            catch (Exception error) { message = error.Message; }
        }
        string phase = running ? "running" : paused ? "paused" : !eligible ? "waiting" : attempts >= 3 ? "error" : "starting";
        if (phase == "error" && message.Length == 0) message = "龙娘未能启动，请手动打开应用检查安装位置";
        Write(Path.Combine(directory, "status.json"), new {
            version = 1, revision, pid = Process.GetCurrentProcess().Id, updatedAt = Now(), hosts, phase, attempts, message
        });
        return !(mode == "login" && (running || attempts >= 3));
    }

    // 文件锁以数据目录隔离，同一用户只运行一份助手，异常退出后由系统释放。
    private static int Main(string[] args)
    {
        try
        {
            if (args.Contains("--probe")) { Console.WriteLine(Json.Serialize(new { hosts = Hosts() })); return 0; }
            if (args.Contains("--enable")) { Registration(true); return 0; }
            if (args.Contains("--disable")) { Registration(false); return 0; }
            configFile = Path.GetFullPath(Argument(args, "--config") ?? Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "config.json"));
            directory = Path.GetDirectoryName(configFile);
            testHosts = Environment.GetEnvironmentVariable("DRAGONGIRL_TEST") == "1" ? Argument(args, "--test-hosts") : null;
            Dictionary<string, object> config = Read(configFile);
            revision = Text(config, "revision"); mode = Text(config, "mode"); executable = Text(config, "executable"); launchArguments = Strings(config, "arguments");
            if (Number(config, "version") != 1 || !new[] { "manual", "login", "codex" }.Contains(mode) || String.IsNullOrEmpty(revision) || !Path.IsPathRooted(executable))
                throw new InvalidDataException("启动配置无效");
            if (mode == "manual") return 0;
            using (FileStream lockFile = new FileStream(Path.Combine(directory, "assistant-win.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite))
            {
                bool owned = false;
                for (int attempt = 0; attempt < 50 && !owned; attempt++)
                {
                    try { lockFile.Lock(0, 1); owned = true; }
                    catch (IOException) { Thread.Sleep(100); }
                }
                if (!owned) return 0;
                try
                {
                    while (true)
                    {
                        try { if (!Tick()) break; }
                        catch (Exception error) { Console.Error.WriteLine("启动助手暂时无法读取状态：" + error.Message); }
                        Thread.Sleep(testHosts == null ? 1000 : 200);
                    }
                }
                finally { lockFile.Unlock(0, 1); }
            }
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine("启动助手无法运行：" + error.Message); return 1; }
    }
}
