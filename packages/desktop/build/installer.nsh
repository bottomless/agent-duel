; Included by electron-builder into the Windows installer.

; A one-click per-user installer names its folder after the package (@getpaseodesktop), not the
; product. A first install goes to "Agent Duel" instead; an existing install, or a folder chosen
; with /D, keeps its location.
!macro customInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
  ${AndIf} $INSTDIR == "$LocalAppData\Programs\${APP_FILENAME}"
    StrCpy $INSTDIR "$LocalAppData\Programs\${PRODUCT_NAME}"
  ${EndIf}
!macroend
