; 当前用户安装器已写好新版程序与注册信息，此时可直接启动安装目录内的龙娘。
; 仅响应应用内明确选择的重启操作，免去通过桌面外壳或开始菜单快捷方式转发。
!macro customInstall
  ${If} ${Silent}
  ${AndIf} ${isUpdated}
    ${StdUtils.TestParameter} $0 "dg-restart"
    ${If} $0 == "true"
      ClearErrors
      Exec '"$appExe" --updated'
      IfErrors 0 +2
      MessageBox MB_OK|MB_ICONEXCLAMATION "新版已安装。请从开始菜单打开 GPT龙娘。"
    ${EndIf}
  ${EndIf}
!macroend
