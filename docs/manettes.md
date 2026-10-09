# Manettes : détection, joueurs, Nintendo

État réel de la prise en charge des manettes dans Kartouche. Ce qui est écrit ici a été vérifié sur du matériel réel (Xbox One filaire, Switch Pro, paire de Joy-Con en Bluetooth) ; ce qui ne l'est pas est dit.
Relevés détaillés (formats de config, octets des rapports HID) : vault Obsidian, `projects/romvault/manettes-nintendo-phase0`.

## Détection (`src/main/emulators/padWatch.ts`, `padList.ts`)

- **Liste en direct** (Paramètres → Émulation et manette, Paramètres du Big Picture) : XInput (emplacements 0 à 3) + `RawGameController` de Windows, sans qu'il faille appuyer sur un bouton. Chaque manette est interprétée : manette XInput, Switch Pro, Joy-Con seul (gauche ou droit), paire de Joy-Con (gauche + droit = une seule manette).
- Une Xbox listée à la fois en XInput et en HID n'apparaît qu'une fois (appariement par constructeur : XInput expose l'interface 045E:02FF, Windows l'identité réelle 045E:02EA).
- **Manettes Nintendo** : pas du XInput. Lecture HID brute des rapports `0x30` (sans focus, sans initialisation), pour l'activité, la présence et la combinaison de fermeture.
- `HID_PADS_SCRIPT` (détection « une manette quelconque ») utilise encore `-PresentOnly` : un Joy-Con appairé mais endormi y compte comme branché. À corriger avec l'état `IsConnected` si cela devient un problème.

## Dernière manette utilisée (`padChoice.ts`)

- Le **joueur 1** est la dernière manette sur laquelle on a appuyé, toutes familles confondues (XInput par emplacement, Nintendo par PID), sinon XInput, Switch Pro, paire de Joy-Con, Joy-Con seul.
- **Les appuis ne comptent pas pendant qu'un jeu tourne** (`setPadActivityGate`) : à plusieurs, le joueur 2 qui appuie en pleine partie ne devient pas joueur 1 au lancement suivant ; le joueur 1 est la manette qui a servi à naviguer dans Kartouche pour lancer le jeu.

## Fermer un jeu à la manette

Retour + Start (XInput) ou **Moins + Plus** maintenus 1,5 s : sur la Switch Pro, ou Moins du Joy-Con gauche + Plus du Joy-Con droit. Un Joy-Con seul n'a pas de combinaison (SL/SR servent en jeu) : utiliser Ctrl + Alt + Q ou le bouton « Fermer le jeu ».

## Eden (`edenPads.ts`, `edenChoice.ts`, `configure.ts`)

- **Une manette par joueur**, assignée au lancement : joueur 1 = la dernière utilisée, les autres manettes détectées prennent les joueurs 2 à 8 dans un ordre stable (XInput par emplacement, Switch Pro, paires de Joy-Con, Joy-Con gauches seuls, Joy-Con droits seuls). Une paire de Joy-Con = une manette ; le rang (`port`) départage plusieurs manettes identiques.
- Profils d'après les formats qu'Eden 0.2.1 écrit lui-même : pilote Joy-Con propre à Eden (`engine:joycon`) pour les Joy-Con, SDL HIDAPI (`…6803`) pour la Switch Pro, SDL XInput comme avant. Le profil du joueur 2 et suivants n'est que le profil du joueur 1 sous d'autres clés ; vérifié contre un relevé réel du joueur 2 (Joy-Con droit seul).
- Un joueur configuré à la main dans Eden n'est jamais réécrit ; les autres le sont. La touche par défaut qu'Eden réécrit lui-même à sa première sauvegarde (`engine:keyboard,code:67`) ne compte pas comme un réglage de l'utilisateur.
- Eden refait toutes les manettes lui-même si on **désactive** son applet Contrôleur (journal : « deducing the best configuration ») : Kartouche ne la désactive donc jamais. À la place, `autoConfirmEdenApplet` (`quit.ts`) clique « OK » dans la vraie applet, repérée par l'identifiant UI Automation de son bouton (indépendant de la langue ; OK = bouton le plus à gauche). Si le jeu refuse la configuration (Paper Mario avec un Joy-Con seul), OK reste grisé : au bout de 1,5 s le script écrit « REFUSED », Kartouche **ferme le jeu** et affiche une erreur claire (`play.padRefusedJoycon` : ce jeu n'accepte pas un Joy-Con seul, brancher une Switch Pro, les deux Joy-Con ou une manette Xbox ; `play.padRefusedCount` : le jeu veut plus de manettes que celles branchées), en mode classique (`QuickExitNotice`) et dans la fiche du Big Picture. Seulement dans la **première minute** après le lancement : plus tard, l'applet s'ouvre pour une raison réparable sur place (manette déconnectée en pleine partie, menu à deux joueurs avec une seule manette) et fermer le jeu ferait perdre la progression. Trace de ce que l'applet a affiché : `<données>/cache/tools/eden-applet.log`.
- **Joy-Con seul** : vrai « Joy-Con seul » pour Eden (le jeu décide de l'orientation). Un jeu qui refuse ce type (Paper Mario) le lit comme une moitié de paire. Pas de conversion en Pro de côté (décision de l'utilisateur).

### Limites connues

- **Les manettes sont assignées une fois, au lancement.** Brancher ou allumer une manette pendant une partie ne change pas les touches (Eden peut changer le type de manette de lui-même, mais pas ses liaisons) : fermer le jeu et le relancer.
- Non testé : GUID de la Switch Pro en USB (relevé en Bluetooth seulement), deux manettes identiques (ports), plus de trois joueurs.
- Joy-Con séparés en deux joueurs : pas géré (une paire est toujours une seule manette).

## Dolphin (`dolphin.ts`, `dolphinChoice.ts`, `configure.ts`)

**Une manette par joueur, jusqu'à 4** (Wiimote 1 à 4, manettes GameCube 1 à 4 avec `SIDevice1-3` dans Dolphin.ini) : `pickDolphinPads` réutilise `pickEdenPads` (joueur 1 = dernière utilisée, les autres dans un ordre stable ; Joy-Con gauche seul ignoré, Joy-Con droit seul ignoré en GameCube), `applyDolphinPads` écrit une section par joueur et retire celles du lancement précédent. Joueur 2 et suivants vérifiés sur matériel (Wii Sports). Pour la manette du joueur 1 : une XInput principale garde exactement l'ancien profil (clavier + XInput). Dolphin lit les manettes Nintendo en SDL (HIDAPI) : périphériques `SDL/<rang>/Nintendo Switch Pro Controller`, `…Joy-Con (L/R)` (SDL réunit une paire en un seul périphérique), `…Joy-Con (R)`.

- **Wii, Switch Pro** : la disposition de la Wiimote avec une XInput (`dolphinWiimote`), noms SDL par position, la manette en périphérique par défaut (les liaisons clavier sont retirées : sur un périphérique SDL elles invalideraient l'expression entière). B = gâchette du fond (ZR) ou bouton du bas, Z du Nunchuk = bouton de devant (R). Pointeur au stick droit en relatif, zone morte 15 % (contre la dérive), recentrage sur le clic du stick.
- **Wii, paire de Joy-Con** : Joy-Con droit = Wiimote, gauche = Nunchuk. Pointeur au gyroscope (`IMUIR`, recentrage sur R, jamais `IRPassthrough`), vibreur `Motor R`, zone morte 15 % sur le stick du Nunchuk. Profil fait à la main dans Dolphin puis repris tel quel.
- **Wii, Joy-Con droit seul** : la Wiimote seule, **sans Nunchuk** (voulu : un jeu qui l'exige le réclame, comme avec une vraie Wiimote ; seul le Joy-Con gauche en plus donne un Nunchuk). SDL l'expose tourné d'un quart de tour : A = `Button S`, X = `Button E`, Y = `Button N`, R = `Paddle 1`, ZR = `Paddle 3`, SL = `Shoulder L`, SR = `Shoulder R`. Le stick fait la croix. Capteurs : tangage et roulis (gyroscope) et accélérations avant/arrière et gauche/droite sont **échangés** par rapport à la paire (relevé : paire réunie = repère « manette de face », monter le bout = x+, lacet = y+, rouler à gauche = z+ ; Joy-Con seul = monter le bout z+, rouler à gauche x-). Pointage validé sur Super Mario Galaxy.
- **GameCube, Switch Pro et paire de Joy-Con** : la disposition de la XInput mais avec les boutons à leur place Nintendo (A = `Button E`, B = `Button S`, X = `Button N`, Y = `Button W`). Un Joy-Con seul n'a pas de quoi faire une manette GameCube : Dolphin reste au clavier. La paire n'est pas testée à part (reprise de la Pro).
- Un fichier retouché à la main n'est jamais réécrit : `isUntouchedWiimoteFile` / `isUntouchedPadFile` reconnaissent la signature de Kartouche (section `[Wiimote1]` seulement, le fichier contient aussi Wiimote2 à 4). Journal du choix : `<données>/cache/tools/tools/dolphin-pad.log`.
- Piège : les noms de gâchettes SDL changent d'une manette à l'autre (Pro = `Trigger L/R`, Joy-Con seul = paddles) ; les relevés se font avec la vraie manette (SDL3 chargé en PowerShell, voir le vault).
- **Wii Sports** : le pointage reste mauvais (même avec la paire, alors que Galaxy est « niquel » avec le même profil) : à regarder côté jeu/réglages de Dolphin, pas côté profil.

### Manettes qui clignotent

Une manette Nintendo qui vient d'être allumée envoie un rapport « simple » (id 0x3F) tant qu'aucun programme ne l'a initialisée (LED qui clignotent). `HID_SCRIPT` le lit aussi, sinon ses appuis ne comptaient pas pour la « dernière manette utilisée ». Les LED s'attribuent quand Chromium interroge les manettes (`navigator.getGamepads()` dans les Paramètres ou le Big Picture) : ce n'est pas la détection PowerShell.

### Applet Contrôleur d'Eden : ne plus l'ouvrir à chaque + / -

Ce sont les jeux qui rappellent l'applet (journal Eden : « Initializing Controller Applet » à chaque appui sur + ou - dans un menu à plusieurs joueurs), et la fenêtre gelait le jeu à chaque fois, y compris pendant la fermeture à la manette (Moins + Plus). `applyEdenPads` écrit donc `[UI] disableControllerApplet=true` (marqueur `kartouche-applet-off` pour le rétablir) quand les manettes assignées comptent au moins une manette Nintendo et AUCUN Joy-Con seul (Eden refait alors Pro / paire, ce qui est déjà le cas) ; avec un Joy-Con seul l'applet reste active et validée par `autoConfirmEdenApplet`. XInput seule : inchangé. Un réglage fait à la main n'est jamais touché. Vérifié sur Mario Kart 8 (Pro, paire).

## Jeux Wii / GameCube en .zip

Dolphin ne lit pas les .zip. `importPaths` décompresse (UNE fois, `UNZIP_ON_IMPORT` = wii, gc) un zip d'une seule ROM vers `roms/<console>/`, vérifie CRC et taille (`unzipVerified`, jamais de fichier sous son vrai nom avant) et ne garde que le jeu décompressé (le zip d'origine n'est supprimé que si « supprimer la source », ou s'il était déjà dans le dossier de ROMs). Les jeux déjà importés en zip restent des zips : `resolveZippedRom` réutilise le fichier déjà extrait dans le cache (taille exacte, pas plus ancien que l'archive) au lieu de réextraire 3 Go à chaque lancement (Galaxy : 20 s → 8 s).

## Autres émulateurs (joueur 1 seulement)

Le principe « une manette par joueur » n'est mis en œuvre que par Eden et Dolphin ; les autres n'ont que le joueur 1 (joueurs 2 et suivants : à faire). Fonctions communes : `chooseMainNintendo` / `chooseSupportedMain(cacheDir, accepted)` (`mainPad.ts`) : la manette du joueur 1 = la première, dans l'ordre habituel (dernière utilisée en tête), que l'émulateur sait lire ; si des manettes sont branchées mais qu'aucune n'est lisible, `launchGame` renvoie l'erreur `padRefusedEmulator` (message `play.padRefusedEmulator`, classique et Big Picture) au lieu d'un jeu muet. Une XInput reste toujours acceptée et inchangée.

| Émulateur | Switch Pro | Paire de Joy-Con | Joy-Con seul |
|---|---|---|---|
| DuckStation, PCSX2 (SDL 3) | liaisons SDL-0..3 existantes ; vibration retirée | idem ; A/B et X/Y échangés sur DuckStation (`tuneSdlPad`) | non testé |
| Vita3K (SDL 3) | natif, rien à écrire | natif | non testé |
| Azahar (SDL 2.32) | 3e profil « Manette Nintendo » : 3DS A = bouton A (SDL2 nomme d'après l'étiquette), profil Xbox inchangé | idem, avec `SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS` (`emulatorEnv`) | refusé |
| melonDS (SDL 2.32) | `MELONDS_JOYSTICK_NINTENDO` (boutons HIDAPI relevés), env HIDAPI seul | mêmes indices (relevé) | refusé |
| Cemu (SDL 2.30) | bloc `SDLController` dans le profil Kartouche (GUID `0300b7e6…6803`) | bloc « Joy-Con (L/R) » (GUID `0300460f…6800`), env combine | refusé |
| RPCS3 (SDL 3) | handler SDL, « Nintendo Switch Pro Controller 1 » | « Nintendo Switch Joy-Con (L/R) 1 » | refusé |
| RetroArch | pilote `sdl2` + autoconfig fournis, stick gauche aussi sur la croix (`input_player1_analog_dpad_mode`, une fois) | SDL2 remplacé par la 2.32.10 officielle (`sdlUpdate.ts`, SHA-256 vérifié, ancienne DLL gardée) | refusé |
| PPSSPP | DirectInput, rien à écrire | refusé (deux manettes DirectInput, pas de SDL) | refusé |

- Relevés : sonde SDL2/SDL3 chargée en PowerShell avec la vraie manette (boutons, axes, noms d'appareil) et, pour Cemu / RPCS3 / melonDS / Dolphin, le fichier que l'émulateur écrit quand l'utilisateur mappe la manette lui-même.
- Un fichier retouché dans l'émulateur n'est jamais réécrit (Cemu `controller0.xml` sans le marqueur, RPCS3 `Default.yml` sans `# romvault:rpcs3-input`, liaisons melonDS qui ne sont plus celles de Kartouche).
- **Fermeture à la manette (Moins + Plus)** : `HID_SCRIPT` lit aussi les rapports simples 0x3F (octet 2, bit 0 = Moins, bit 1 = Plus), que la Pro envoie quand l'émulateur ne la passe pas en rapports complets (DuckStation, PCSX2).
- **Clavier à l'écran de Cemu** (`cemuKeyboard.ts`) : ImGui, sans navigation à la manette. Détecté par capture de la fenêtre du jeu (aplat 91,134,168 en au moins quatre bandes) ; tant qu'il est affiché, stick droit = souris, A = clic (XInput, Pro, Joy-Con droit de la paire).
