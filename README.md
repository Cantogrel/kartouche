# RomVault

Bibliothèque de jeux d'émulation pour Windows : elle installe et configure les émulateurs, identifie vos ROMs, garde vos sauvegardes et se pilote à la souris comme à la manette (mode Big Picture).

RomVault **ne télécharge jamais de ROMs**. Les BIOS et firmwares protégés sont importés par vous, via un assistant guidé ; seule exception : le firmware PS3 et PS Vita, téléchargé sur demande depuis les serveurs officiels de Sony.

## Installation

Téléchargez `RomVault-Setup-<version>.exe` depuis les [releases](https://github.com/Cantogrel/romvault/releases) et lancez-le. L'application se met à jour d'elle-même (Paramètres → À propos). Vos données (bibliothèque, sauvegardes, émulateurs) sont conservées lors d'une mise à jour ou d'une désinstallation.

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

Non gérés pour l'instant : archives 7z/rar, zip64 et zip multi-fichiers pour l'import.

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
- `tools/` : lanceur de développement `RomVault-Dev.exe` (`tools\build-dev-exe.cmd`) et générateur d'icône (`tools\make-icon.ps1`).
- Les migrations SQLite livrées (`src/main/db/migrations.ts`) ne se modifient jamais : on en ajoute une.
- Données en développement : `data/` (ignoré par git, contient la base réelle et les clés).

## Licence et crédits

Les métadonnées viennent des DAT Libretro, d'IGDB, de TheGamesDB, de SteamGridDB et de Wikipédia ; les succès de RetroAchievements. RomVault s'inspire de l'ergonomie de Hydra Launcher sans en reprendre d'assets.
