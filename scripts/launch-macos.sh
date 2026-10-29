#!/bin/sh
set -eu

# 使用脚本自身定位项目，兼容 Finder 的空工作目录与带空格、中文的路径。
dragon_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
dragon_project_dir=$(CDPATH= cd -- "$dragon_script_dir/.." && pwd -P)
dragon_electron="$dragon_project_dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
dragon_mode=${1:---background}
if [ "$#" -gt 0 ]; then shift; fi

# 直接使用 Electron 自带运行时，不读取交互式 shell，也不要求 Finder 能找到 Node 或 npm。
if [ ! -x "$dragon_electron" ]; then
  printf '%s\n' '没有找到 Electron 桌面运行时。请先在项目目录运行 npm install 和 npm start，完成首次运行时下载后重试。' >&2
  exit 1
fi
unset ELECTRON_RUN_AS_NODE
cd -- "$dragon_project_dir"

# 检查模式不启动窗口，供构建与最小环境回归测试使用。
if [ "$dragon_mode" = '--check' ]; then
  printf '%s\n' "$dragon_electron"
  exit 0
fi

# 终端备用入口仍可显示日志，但无需 npm 或用户的 Node 环境。
if [ "$dragon_mode" = '--foreground' ]; then
  exec "$dragon_electron" "$dragon_project_dir" "$@"
fi
if [ "$dragon_mode" != '--background' ]; then
  printf '不支持的启动选项：%s\n' "$dragon_mode" >&2
  exit 1
fi

# 后台启动日志留在项目的忽略目录，启动失败时能找到实际原因。
dragon_log_dir="$dragon_project_dir/.artifacts/logs"
if ! /bin/mkdir -p "$dragon_log_dir"; then
  printf '%s\n' '无法创建启动日志目录，请检查项目目录的写入权限。' >&2
  exit 1
fi
dragon_log_file="$dragon_log_dir/launcher.log"
dragon_status_file="$dragon_log_dir/launch-$$.status"
printf '\n[%s] 启动龙娘\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" >> "$dragon_log_file"
trap '/bin/rm -f "$dragon_status_file"' EXIT

# 关闭三个标准描述符后再后台运行，启动器退出不会连带关闭挂件。
DRAGONGIRL_LAUNCH_STATUS="$dragon_status_file" /usr/bin/nohup "$dragon_electron" "$dragon_project_dir" "$@" </dev/null >> "$dragon_log_file" 2>&1 &
dragon_child_pid=$!
printf '%s\n' "$dragon_child_pid" > "$dragon_log_dir/last-launch.pid"

# 等待界面就绪握手，不能仅凭后台进程存在就宣布启动成功。
dragon_attempt=0
while [ "$dragon_attempt" -lt 150 ]; do
  if [ -f "$dragon_status_file" ]; then
    dragon_start_state=''
    IFS= read -r dragon_start_state < "$dragon_status_file" || true
    if [ "$dragon_start_state" = 'ready' ]; then
      printf '[%s] 启动完成，已确认界面就绪或已唤出已有实例\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" >> "$dragon_log_file"
      printf '%s\n' "$dragon_child_pid"
      exit 0
    fi
    if [ "$dragon_start_state" = 'error' ]; then
      /usr/bin/tail -n +2 "$dragon_status_file" >&2
      printf '\n请查看启动日志：%s\n' "$dragon_log_file" >&2
      exit 1
    fi
  fi
  if ! kill -0 "$dragon_child_pid" 2>/dev/null; then
    dragon_status=0
    wait "$dragon_child_pid" || dragon_status=$?
    printf '龙娘启动失败（退出码 %s），界面没有就绪。请查看日志：%s\n' "$dragon_status" "$dragon_log_file" >&2
    if [ "$dragon_status" -eq 0 ]; then exit 1; fi
    exit "$dragon_status"
  fi
  dragon_attempt=$((dragon_attempt + 1))
  /bin/sleep 0.2
done
printf '龙娘没有在预期时间内完成启动。请查看日志：%s\n' "$dragon_log_file" >&2
exit 1
