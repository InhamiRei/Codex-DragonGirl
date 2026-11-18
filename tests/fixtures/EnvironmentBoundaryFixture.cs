using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// 在测试进程自己的内存中构造环境块，避免依赖真实账户或系统给环境块分配的位置。
internal static class EnvironmentBoundaryFixture
{
    // 分配相邻页面，显式控制区域边界。
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protect);

    // 切分只读和不可读区域，覆盖环境块末尾接近边界的情况。
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualProtect(IntPtr address, UIntPtr size, uint protect, out uint previous);

    // 完成后释放本次分配的测试页。
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFree(IntPtr address, UIntPtr size, uint type);

    // 使用本测试进程的句柄，原生桥走与 Windows 宿主相同的读取逻辑。
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    // 写入 UTF-16 环境块时只触碰明确分配的测试内存。
    private static void WriteBlock(IntPtr address, string block)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(block);
        Marshal.Copy(bytes, 0, address, bytes.Length);
    }

    // 页保护失败时立即报告 Win32 错误，避免测试因实际页面未分隔而误通过。
    private static void ProtectPage(IntPtr address, int pageSize, uint protect)
    {
        uint previous;
        if (!VirtualProtect(address, new UIntPtr((uint)pageSize), protect, out previous))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    // 直接验证编译后原生桥读取器，综合覆盖页边界、结束符和环境白名单。
    private static void Main(string[] args)
    {
        int page = Environment.SystemPageSize;
        IntPtr memory = VirtualAlloc(IntPtr.Zero, new UIntPtr((uint)(3 * page)), 0x3000, 0x04);
        if (memory == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            MethodInfo readBlock = Assembly.LoadFrom(args[0]).GetType("DragonBridge", true)
                .GetMethod("ReadEnvironmentBlock", BindingFlags.Static | BindingFlags.NonPublic);
            IntPtr unreadable = IntPtr.Add(memory, 2 * page);
            ProtectPage(unreadable, page, 0x01);
            IntPtr handle = GetCurrentProcess();
            const string home = "C:\\Users\\Fixture\\\u8d26\u53f7\U0001F642";

            // 首次 4096 字节之后仍有完整内容，固定读取第二个 4096 字节才会越界。
            IntPtr start = IntPtr.Add(memory, (page / 3) & ~1);
            WriteBlock(start, "IGNORED=" + new string('x', 2300) + "\0CODEX_HOME=" + home
                + "\0HTTPS_PROXY=http://127.0.0.1:9000\0PRIVATE_FIXTURE=hidden\0\0");
            var result = (Dictionary<string, string>)readBlock.Invoke(null, new object[] { handle, start });
            if (result == null || result.Count != 2 || result["CODEX_HOME"] != home
                || result["HTTPS_PROXY"] != "http://127.0.0.1:9000")
                throw new InvalidOperationException("Failed to read the complete block next to a no-access page.");

            // 双零的两个 UTF-16 字符分别位于读写页末尾和只读页开头。
            string split = "CODEX_HOME=" + home + "\0\0";
            IntPtr splitStart = IntPtr.Add(memory, page + 2 - Encoding.Unicode.GetByteCount(split));
            WriteBlock(splitStart, split);
            ProtectPage(IntPtr.Add(memory, page), page, 0x02);
            result = (Dictionary<string, string>)readBlock.Invoke(null, new object[] { handle, splitStart });
            if (result == null || result.Count != 1 || result["CODEX_HOME"] != home)
                throw new InvalidOperationException("Failed to recognize a terminator spanning readable regions.");
            if (readBlock.Invoke(null, new object[] { handle, unreadable }) != null)
                throw new InvalidOperationException("An unreadable page was accepted as an environment block.");
        }
        finally { VirtualFree(memory, UIntPtr.Zero, 0x8000); }
    }
}
