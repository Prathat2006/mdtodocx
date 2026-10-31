!macro NSIS_HOOK_POSTINSTALL
    DetailPrint "Checking MarkDoc export dependencies..."

    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-dependencies.ps1" -InstallRoot "$INSTDIR"' $0

    ${If} $0 != 0
        MessageBox MB_ICONSTOP "MarkDoc could not install or verify its export dependencies. See install-dependencies.log in the installation folder for details."
        Abort
    ${EndIf}

    DetailPrint "MarkDoc export dependencies are ready."
!macroend
