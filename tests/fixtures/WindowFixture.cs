using System;
using System.Windows.Forms;
using System.IO;

// Windows 原生桥回归测试使用独立窗口，不读取真实应用或账户。
internal static class WindowFixture
{
    // 可选最小化状态用于验证隐藏和聚焦恢复行为。
    [STAThread]
    private static void Main(string[] args)
    {
        Form form = new Form { Text = "窗口桥测试", Width = 900, Height = 600 };
        // 就绪文件确保测试在真实窗口完成初始化后才开始检查。
        form.Shown += delegate {
            if (args.Length > 0 && args[0] == "--minimized") form.WindowState = FormWindowState.Minimized;
            string ready = Environment.GetEnvironmentVariable("DRAGONGIRL_FIXTURE_READY");
            if (!string.IsNullOrEmpty(ready)) File.WriteAllText(ready, "ready");
        };
        Application.Run(form);
    }
}
