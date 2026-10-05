; Le dossier data (base, ROMs, sauvegardes, émulateurs) vit dans le dossier d'installation. La mise à jour et la désinstallation
; vident ce dossier : on met data de côté à côté (même volume, donc instantané) puis on le remet après l'installation.
;
; Deux noms de dossier de mise à l'abri :
;  - Kartouche-data.keep : posé par le désinstalleur de CETTE version (désinstallation, ou mise à jour depuis une version Kartouche) ;
;  - RomVault-data.keep  : posé par le désinstalleur de l'ancien produit. Pendant une mise à jour depuis RomVault 0.2.x, c'est l'ANCIEN
;    désinstalleur qui s'exécute (le nouvel installateur le lance) : le nouvel installateur doit donc aussi chercher ce nom-là.
; Voir docs/rename-kartouche.md, §5.
; electron-builder ajoute « \Kartouche » à un dossier d'installation qui ne contient pas déjà ce nom (instFilesPre) : une mise à jour d'une
; installation existante (ex. C:\Games\RomVault) se retrouvait dans C:\Games\RomVault\Kartouche, sans retrouver data ni la mise à l'abri.
; Cette macro remplace le contrôle « application en cours » (début de la section d'installation, avant le retrait de l'ancienne version)
; et, si le dossier prévu est exactement « <installation existante>\Kartouche », revient à l'installation existante. Le contrôle d'origine
; est rejoué ensuite à l'identique.
; Quand cette macro existe, electron-builder n'inclut plus getProcessInfo.nsh ni ne déclare `pid` (allowOnlyOneInstallerInstance.nsh) : on le fait ici.
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  ; Le désinstalleur insère aussi cette macro : $appExe et le dossier d'installation n'y sont pas concernés.
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R8 != ""
    ${AndIf} "$R8\${APP_FILENAME}" == "$INSTDIR"
      StrCpy $INSTDIR "$R8"
      StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\data\*.*" 0 +5
    IfFileExists "$INSTDIR\..\Kartouche-data.keep\*.*" 0 +3
      Rename "$INSTDIR\data" "$INSTDIR\..\Kartouche-data.keep2"
      Goto +2
    Rename "$INSTDIR\data" "$INSTDIR\..\Kartouche-data.keep"
!macroend

!macro customInstall
  ; data déjà en place (installation par-dessus, sans désinstallation préalable) : on n'y touche pas.
  IfFileExists "$INSTDIR\data\*.*" keepDone
  IfFileExists "$INSTDIR\..\Kartouche-data.keep\*.*" 0 +3
    Rename "$INSTDIR\..\Kartouche-data.keep" "$INSTDIR\data"
    Goto keepDone
  IfFileExists "$INSTDIR\..\RomVault-data.keep\*.*" 0 keepDone
    Rename "$INSTDIR\..\RomVault-data.keep" "$INSTDIR\data"
  keepDone:
  ; Installé dans Program Files (droits admin), l'app tourne sans admin : data doit rester inscriptible pour les utilisateurs.
  CreateDirectory "$INSTDIR\data"
  nsExec::Exec 'icacls "$INSTDIR\data" /grant *S-1-5-32-545:(OI)(CI)M /C /Q'
  Pop $0
!macroend
