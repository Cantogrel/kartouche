; Le dossier data (base, ROMs, sauvegardes, émulateurs) vit dans le dossier d'installation. La mise à jour et la désinstallation
; vident ce dossier : on met data de côté à côté (même volume, donc instantané) puis on le remet après l'installation.
!macro customUnInstall
  IfFileExists "$INSTDIR\data\*.*" 0 +5
    IfFileExists "$INSTDIR\..\RomVault-data.keep\*.*" 0 +3
      Rename "$INSTDIR\data" "$INSTDIR\..\RomVault-data.keep2"
      Goto +2
    Rename "$INSTDIR\data" "$INSTDIR\..\RomVault-data.keep"
!macroend

!macro customInstall
  IfFileExists "$INSTDIR\..\RomVault-data.keep\*.*" 0 +3
    IfFileExists "$INSTDIR\data\*.*" +2 0
      Rename "$INSTDIR\..\RomVault-data.keep" "$INSTDIR\data"
!macroend
