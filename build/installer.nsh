; ATTENTION : le nom RomVault-data.keep reste celui de l'ancien produit. Pendant une mise à jour depuis RomVault 0.2.x, c'est l'ANCIEN désinstalleur qui
; met data de côté sous ce nom ; le nouvel installateur doit donc le chercher sous le même nom (voir docs/rename-kartouche.md, §5).
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
  ; Installé dans Program Files (droits admin), l'app tourne sans admin : data doit rester inscriptible pour les utilisateurs.
  CreateDirectory "$INSTDIR\data"
  nsExec::Exec 'icacls "$INSTDIR\data" /grant *S-1-5-32-545:(OI)(CI)M /C /Q'
  Pop $0
!macroend
