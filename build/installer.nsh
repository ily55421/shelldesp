# 覆盖升级定位 (免安装/便携场景)
#
# 背景: 从解压目录直接运行(如 dist\win-unpacked)不会写入 NSIS 注册表记录,
#       安装包因此找不到"已安装位置", 只会给出默认目录。
# 方案: 应用启动时把自身 exe 所在目录写入 %APPDATA%\shelldesk\install-path.txt,
#       安装包在没有注册表记录时读取该文件, 命中已存在的 ShellDesk.exe 就装回原处。
#
# 注: 目录选择页已关闭(allowToChangeInstallationDirectory: false),
#     因为 electron-builder 的 instFilesPre 会给不含 "ShellDesk" 的目录自动追加 \ShellDesk。

!macro customInit
  # 注册表里已有安装记录时, 沿用 electron-builder 的标准升级逻辑
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $0 == ""
    IfFileExists "$APPDATA\shelldesk\install-path.txt" 0 customInitDone
      FileOpen $1 "$APPDATA\shelldesk\install-path.txt" r
      FileRead $1 $2
      FileClose $1

      # 去掉行尾换行与空白
      customInitTrim:
        StrCpy $3 $2 1 -1
        ${If} $3 == "$\r"
        ${OrIf} $3 == "$\n"
        ${OrIf} $3 == " "
          StrCpy $2 $2 -1
          Goto customInitTrim
        ${EndIf}

      ${If} $2 != ""
      ${AndIf} ${FileExists} "$2\${APP_EXECUTABLE_FILENAME}"
        StrCpy $INSTDIR "$2"
        DetailPrint "检测到免安装版本位置: $INSTDIR"
      ${EndIf}
    customInitDone:
  ${EndIf}
!macroend