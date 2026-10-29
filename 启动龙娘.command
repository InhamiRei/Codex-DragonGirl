#!/bin/sh
# 备用终端入口使用非交互式脚本，日常双击请使用同目录的“启动龙娘.app”。
dragon_launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
exec /bin/sh "$dragon_launcher_dir/scripts/launch-macos.sh" --foreground "$@"
