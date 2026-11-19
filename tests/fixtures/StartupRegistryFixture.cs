using System;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class StartupRegistryFixture
{
    // 直接读取本产品的登录项，UTF-8 JSON 同时保留中文路径、空字符串和缺失状态。
    private static void Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
        {
            object value = key == null ? null : key.GetValue("Codex DragonGirl Startup", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            Console.Write(new JavaScriptSerializer().Serialize(value));
        }
    }
}
