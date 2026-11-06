using System;
using System.Windows.Forms;
using System.IO;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Collections.Generic;

// Windows 原生桥回归测试使用独立窗口，不读取真实应用或账户。
internal static class WindowFixture
{
    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    private static System.Threading.Thread dragThread;
    private static volatile bool stopping;

    // 只用窗口编号和可见性采样遮挡，不读取其他应用的文字或内容。
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    // 隐藏的角色不能被当成层级正确。
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    // 拖动不能让龙娘抢走宿主的键盘焦点。
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    // 发送真实输入前确认标题栏仍属于本次测试窗口。
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);
    // 将标题栏命中的子窗口还原为所属顶层窗口。
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    // 读取实际窗口位置，避免把没有进入系统拖动循环的测试误判为通过。
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rectangle);

    // Win32 窗口矩形保持原始物理像素。
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { internal int Left, Top, Right, Bottom; }

    // 非激活置前用于复现焦点与几何都没有变化、只有覆盖顺序变化的场景。
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    // CI 用真实标题栏点击取得前台，不给被测应用额外授权；下一次消息循环恢复原来的鼠标位置。
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    // 输入和采样放在独立线程，宿主 UI 线程才能真正进入 Windows 标题栏拖动循环。
    private static void RecordDrag(Form form, string directory, int distance)
    {
        if (dragThread != null && dragThread.IsAlive) return;
        IntPtr host = form.Handle;
        Point caption = new Point(form.Left + 100, form.Top + SystemInformation.FrameBorderSize.Height + SystemInformation.CaptionHeight / 2);
        long[] overlays = Array.ConvertAll(File.ReadAllLines(Path.Combine(directory, "watch-windows")), long.Parse);
        dragThread = new System.Threading.Thread(delegate() {
            Point cursor = Cursor.Position;
            Rect before, after;
            GetWindowRect(host, out before);
            int samples = 0, covered = 0, focusLost = 0;
            bool pressed = false, failed = false;
            try
            {
                if (GetForegroundWindow() != host || GetAncestor(WindowFromPoint(caption), 2) != host)
                    throw new InvalidOperationException("测试标题栏没有位于前台");
                Cursor.Position = caption;
                mouse_event(0x2, 0, 0, 0, UIntPtr.Zero);
                pressed = true;
                // 连续拖动后继续采样松手阶段，覆盖短暂压住和松手后无法恢复两类故障。
                for (int step = 0; step < 100 && !stopping; step++)
                {
                    if (step < 60) Cursor.Position = new Point(caption.X + distance * (step + 1) / 60, caption.Y + distance * (step + 1) / 240);
                    if (step == 60)
                    {
                        mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
                        pressed = false;
                    }
                    List<long> order = new List<long>();
                    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
                        if (IsWindowVisible(window)) order.Add(window.ToInt64());
                        return true;
                    }, IntPtr.Zero);
                    int hostIndex = order.IndexOf(host.ToInt64());
                    if (hostIndex < 0 || Array.Exists(overlays, delegate(long id) {
                        int index = order.IndexOf(id);
                        return index < 0 || index > hostIndex;
                    })) covered++;
                    if (GetForegroundWindow() != host) focusLost++;
                    samples++;
                    System.Threading.Thread.Sleep(8);
                }
            }
            catch (Exception) { failed = true; }
            finally
            {
                // 失败、窗口关闭或中途停止也必须松开鼠标并恢复原位置。
                if (pressed) mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
                Cursor.Position = cursor;
            }
            GetWindowRect(host, out after);
            string result = "{\"samples\":" + samples + ",\"coveredSamples\":" + covered
                + ",\"focusLostSamples\":" + focusLost + ",\"movedX\":" + (after.Left - before.Left)
                + ",\"failed\":" + (failed ? "true" : "false") + "}";
            // 先写临时文件再替换，测试端不会读到尚未写完的 JSON。
            File.WriteAllText(Path.Combine(directory, "drag-result.tmp"), result);
            File.Move(Path.Combine(directory, "drag-result.tmp"), Path.Combine(directory, "drag-result.json"));
        });
        dragThread.IsBackground = true;
        dragThread.Start();
    }

    // 可选最小化状态用于验证隐藏和聚焦恢复行为。
    [STAThread]
    private static void Main(string[] args)
    {
        Form form = new Form { Text = "窗口桥测试", StartPosition = FormStartPosition.Manual, Bounds = new Rectangle(150, 150, 1100, 792) };
        string directory = args.Length == 2 && args[0] == "--controlled" ? args[1] : null;
        string previous = "";
        Point? restoreCursor = null;
        Timer timer = new Timer { Interval = 50 };
        // 控制文件只影响自建测试窗口，所有命令都在窗口线程执行。
        timer.Tick += delegate {
            if (restoreCursor.HasValue) { Cursor.Position = restoreCursor.Value; restoreCursor = null; }
            if (directory == null) return;
            string command;
            try { command = File.ReadAllText(Path.Combine(directory, "command")); }
            catch (IOException) { return; }
            if (command == previous) return;
            previous = command;
            command = command.Split('\n')[0];
            switch (command)
            {
                case "raise": SetWindowPos(form.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x13); break;
                case "lower": SetWindowPos(form.Handle, new IntPtr(1), 0, 0, 0, 0, 0x13); break;
                case "activate": form.Activate(); break;
                case "click":
                    restoreCursor = Cursor.Position;
                    Cursor.Position = new Point(form.Left + 100, form.Top + 10);
                    mouse_event(0x2, 0, 0, 0, UIntPtr.Zero);
                    mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
                    break;
                case "drag-right": RecordDrag(form, directory, 120); break;
                case "drag-left": RecordDrag(form, directory, -120); break;
                case "partial": form.Width = 550; SetWindowPos(form.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x13); break;
                case "full": form.Width = 1100; SetWindowPos(form.Handle, IntPtr.Zero, 0, 0, 0, 0, 0x13); break;
                case "topmost": form.TopMost = true; break;
                case "normal": form.TopMost = false; break;
                case "move": form.Location = new Point(260, 200); break;
                case "minimize": form.WindowState = FormWindowState.Minimized; break;
                case "restore": form.WindowState = FormWindowState.Normal; break;
                case "quit": form.Close(); break;
            }
            File.WriteAllText(Path.Combine(directory, "command-complete"), previous);
        };
        // 就绪文件确保测试在真实窗口完成初始化后才开始检查。
        form.Shown += delegate {
            if (args.Length > 0 && args[0] == "--minimized") form.WindowState = FormWindowState.Minimized;
            string ready = Environment.GetEnvironmentVariable("DRAGONGIRL_FIXTURE_READY");
            if (!string.IsNullOrEmpty(ready)) File.WriteAllText(ready, "ready");
            if (directory != null) File.WriteAllText(Path.Combine(directory, "ready.json"), "{\"window\":" + form.Handle.ToInt64() + "}");
        };
        // 异常关闭也恢复本测试临时移动的系统鼠标，不留下测试状态。
        form.FormClosed += delegate {
            stopping = true;
            if (dragThread != null) dragThread.Join(1500);
            if (restoreCursor.HasValue) Cursor.Position = restoreCursor.Value;
        };
        timer.Start();
        Application.Run(form);
        timer.Dispose();
    }
}
