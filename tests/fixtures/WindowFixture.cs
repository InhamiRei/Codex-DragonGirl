using System;
using System.Windows.Forms;
using System.IO;
using System.Drawing;
using System.Runtime.InteropServices;

// Windows 原生桥回归测试使用独立窗口，不读取真实应用或账户。
internal static class WindowFixture
{
    // 非激活置前用于复现焦点与几何都没有变化、只有覆盖顺序变化的场景。
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    // CI 用真实标题栏点击取得前台，不给被测应用额外授权；下一次消息循环恢复原来的鼠标位置。
    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

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
        form.FormClosed += delegate { if (restoreCursor.HasValue) Cursor.Position = restoreCursor.Value; };
        timer.Start();
        Application.Run(form);
        timer.Dispose();
    }
}
