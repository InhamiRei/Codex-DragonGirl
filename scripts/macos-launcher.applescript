-- 通过系统应用入口启动，避免 Terminal 的交互提示截断启动命令。
on run
  try
    set launcherBundle to POSIX path of (path to me)
    set projectFolder to do shell script "/usr/bin/dirname " & quoted form of launcherBundle
    set shellLauncher to projectFolder & "/scripts/launch-macos.sh"

    -- 应用与项目一起移动时优先相对定位；单独移动应用时使用构建时记录的位置。
    try
      do shell script "/bin/test -f " & quoted form of shellLauncher
    on error
      set locationFile to POSIX path of (path to resource "project-path.txt")
      set projectFolder to read (POSIX file locationFile) as «class utf8»
      set shellLauncher to projectFolder & "/scripts/launch-macos.sh"
    end try

    -- 后台脱离与日志由固定脚本处理，所有路径都按 shell 参数安全引用。
    do shell script "/bin/sh " & quoted form of shellLauncher & " --background"
  on error launchError
    display alert "龙娘没有启动成功" message launchError as critical
  end try
end run

-- 连续双击启动器时再次唤出已有龙娘，不需要保留启动器进程。
on reopen
  run
end reopen
