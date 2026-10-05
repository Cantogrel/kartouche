# Kartouche

Bibliothèque de jeux d'émulation pour Windows : elle installe et configure les émulateurs, identifie vos ROMs, garde vos sauvegardes et se pilote à la souris comme à la manette (mode Big Picture).

Kartouche **ne télécharge jamais de ROMs**. Les BIOS et firmwares protégés sont importés par vous, via un assistant guidé ; seule exception : le firmware PS3 et PS Vita, téléchargé sur demande depuis les serveurs officiels de Sony.

## Installation

Téléchargez `Kartouche-Setup-<version>.exe` depuis les [releases](https://github.com/Cantogrel/kartouche/releases) et lancez-le. L'application se met à jour d'elle-même (Paramètres → À propos). Vos données (bibliothèque, sauvegardes, émulateurs) sont conservées lors d'une mise à jour ou d'une désinstallation.

## Utilisation

| Page | Rôle |
| --- | --- |
| Accueil | Continuer à jouer, favoris, récents, une rangée par collection, statistiques |
| Catalogue | ~75 000 jeux de 17 consoles, fiches (description, jaquette, genres), recherche, tri, filtres |
| Bibliothèque | Vos ROMs : glisser-déposer ou « Ajouter un jeu », identification automatique (hash puis nom), favoris, épingles, collections, menu clic droit |
| Émulateurs | Installation en un clic, configuration automatique (langue, plein écran, résolution, manette), mises à jour, assistant BIOS/firmware |
| Paramètres | Langue, dossiers surveillés, clés d'API personnelles (facultatives), sauvegardes automatiques, RetroAchievements |

- **Jouer** : bouton « Jouer » d'une fiche. Le temps de jeu est compté (30 s minimum). Pour quitter un jeu : `Ctrl+Alt+Q`, ou `Retour` + `Start` maintenus 1,5 s à la manette, ou le bouton « Fermer le jeu ».
- **Sauvegardes** : copies zip (5 maximum par jeu), automatiques après chaque partie, restaurables depuis la fiche.
- **Succès** : RetroAchievements (identifiant + clé Web API dans Paramètres).
- **Big Picture** : bouton en haut à droite, ou `--bigpicture` en ligne de commande, ou le réglage « démarrer en Big Picture ».

### Big Picture (manette)

| Action | Commande |
| --- | --- |
| Naviguer | Croix / stick gauche (ou flèches) |
| Valider / retour d'un niveau | A / B |
| Changer de section | LB / RB |
| Filtrer par console ou collection | LT / RT |
| Rechercher | Y |
| Menu (reprendre, quitter) | Start (clavier : Échap) |

### Accessibilité

Navigation complète au clavier (`Tab`, `Entrée`/`Espace`, `Échap` pour fermer une fenêtre), focus visible partout, lien « Aller au contenu », étiquettes pour les lecteurs d'écran, mouvement réduit respecté (réglage Windows « effets d'animation »), interface en français ou en anglais selon la langue de Windows (modifiable dans les Paramètres).

## Consoles et émulateurs

| Émulateur | Consoles |
| --- | --- |
| RetroArch | NES, SNES, Game Boy, Game Boy Color, Game Boy Advance, Nintendo 64 |
| DuckStation | PlayStation |
| PCSX2 | PlayStation 2 |
| RPCS3 | PlayStation 3 |
| PPSSPP | PSP |
| Vita3K | PS Vita |
| Dolphin | GameCube, Wii |
| melonDS | Nintendo DS |
| Azahar | Nintendo 3DS |
| Cemu | Wii U |
| Eden | Switch |

Archives : `.zip` (lecteur intégré), `.7z` et `.rar` (extraites automatiquement, y compris les volumes `.partN.rar` / `.7z.001`, sans 7-Zip ni WinRAR à installer). Une archive avec une seule ROM est extraite ; un jeu à plusieurs fichiers (`.cue` + pistes, paquet PS Vita) est reconditionné en `.zip` ; plusieurs ROM différentes ou une archive protégée par mot de passe sont refusées avec un message explicite. Non géré : zip64.

## Développement

Electron 44 + React 19 + TypeScript (electron-vite, Zustand), SQLite via `node:sqlite`.

```bash
npm install
node node_modules/electron/install.js   # si le binaire Electron manque
npm run dev          # application en développement
npm run typecheck
npm test             # vitest
npm run build
npm run dist         # installateur dans release/
```

- `src/main/` : processus principal (base, catalogue, bibliothèque, émulateurs, BIOS, sauvegardes, succès, mises à jour).
- `src/renderer/` : interface React (pages, Big Picture, i18n dans `locales/`).
- `src/shared/` : types et données communs (IPC, consoles, émulateurs, BIOS).
- `server/` : proxy Cloudflare Worker qui porte les clés de catalogue (voir `server/README.md`).
- `tools/` : lanceur de développement `Kartouche-Dev.exe` (`tools\build-dev-exe.cmd`) et générateur d'icône (`tools\make-icon.py`).
- Les migrations SQLite livrées (`src/main/db/migrations.ts`) ne se modifient jamais : on en ajoute une.
- Données en développement : `data/` (ignoré par git, contient la base réelle et les clés).

## Licence et crédits

Les métadonnées viennent des DAT Libretro, d'IGDB, de TheGamesDB, de SteamGridDB et de Wikipédia ; les succès de RetroAchievements. Kartouche s'inspire de l'ergonomie de Hydra Launcher sans en reprendre d'assets.

Extraction `.7z`/`.rar` : [7z-wasm](https://github.com/use-strict/7z-wasm) (7-Zip compilé en WebAssembly, LGPL-2.1 ou ultérieure avec la restriction unRAR — le moteur sert uniquement à extraire, jamais à créer d'archives RAR). Livré comme fichiers séparés et remplaçables (`resources/app.asar.unpacked/node_modules/7z-wasm/`, avec `License.txt` et `unRarLicense.txt`).
