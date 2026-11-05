; ---------------------------------------------------------------------------
; 灵动岛 自定义 NSIS 片段（被 electron-builder 自动 !include）
;
; 接线方式：build/installer.nsh 是 electron-builder 约定的文件名，构建时会被
; 自动追加到 installer.nsi 之前（见 node_modules/app-builder-lib/out/targets/
; nsis/NsisTarget.js 的 computeCommonInstallerScriptHeader）。同一份脚本既用于
; 构建安装器，也用于构建「卸载器」，因此下面用 BUILD_UNINSTALLER 限定作用范围，
; 保证安装器界面完全不受影响。
;
; 关键事实（读 Modern UI 2 源码确认）：
;   Welcome.nsh:70-71  MUI_DEFAULT MUI_WELCOMEPAGE_TITLE / MUI_WELCOMEPAGE_TEXT
;   Finish.nsh:154-155 MUI_DEFAULT MUI_FINISHPAGE_TITLE   / MUI_FINISHPAGE_TEXT
;   MUI_DEFAULT 等价于 !define /ifndef，所以只要在页面声明之前先定义，
;   就能覆盖默认文案。符号名本身不带 UN 前缀，UN 只出现在语言字符串里。
;
; 目的（US-028）：卸载时明确告诉用户「只删程序，不删你的数据」，并给出数据位置。
; 本文件不改变任何删除逻辑，只改卸载器的两页文案。
; ---------------------------------------------------------------------------

!ifdef BUILD_UNINSTALLER
  !define MUI_WELCOMEPAGE_TITLE "卸载 灵动岛"
  !define MUI_WELCOMEPAGE_TEXT "卸载只会删除程序文件，不会动你的数据。$\r$\n$\r$\n待办、日程和置物架记录都保存在：$\r$\n$APPDATA\lingdong-island$\r$\n$\r$\n卸载完成后它仍然在，重新安装会自动读回来。"

  !define MUI_FINISHPAGE_TITLE "灵动岛 已卸载"
  !define MUI_FINISHPAGE_TEXT "程序文件已删除，你的数据还在。$\r$\n$\r$\n数据位置：$\r$\n$APPDATA\lingdong-island$\r$\n$\r$\n重新安装后会自动读回来；如果确实要彻底清除，请手动删除上面这个文件夹。"
!endif
