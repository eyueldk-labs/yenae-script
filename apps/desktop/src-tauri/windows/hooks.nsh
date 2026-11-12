; Installer hooks for the Windows setup (Tauri NSIS).
;
; Yenae Script runs scripts with its own bun.exe. Before installing over an old
; version (an update) or uninstalling, stop any of those still running, so their
; files can be replaced or removed. Only processes started from this install
; folder are stopped; any other Bun on the machine is left alone.
!macro StopBundledBun
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process bun -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopBundledBun
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopBundledBun
!macroend

; Uninstalling also removes "Start with Windows", so nothing is left trying to launch it.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Yenae Script"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "yenae-script"
!macroend

; After installing or updating, tell Windows its icons changed, so pinned taskbar buttons
; and shortcuts show the current icon instead of a cached old one.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
