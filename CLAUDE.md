# RomVault

Bibliothèque de jeux d'émulation pour Windows, look Hydra Launcher. Spéc complète : vault `projects/romvault/SUMMARY`.

## Stack
Electron 44 + React 19 + TS via electron-vite (vite 7 épinglé), Zustand, SQLite via `node:sqlite` (pas better-sqlite3). Pas d installateur avant la fin du projet : on teste sur les sources.

## Commandes
`npm run dev` (electron-vite dev), `npm run build`, `npm run typecheck`, `npm test` (vitest). Première install : `node node_modules/electron/install.js` si le binaire manque.

## Conventions
- RomVault n'agrège ni ne scrape aucune source de téléchargement de jeux : chaque utilisateur ajoute ses propres listes (URL JSON, format `romvault.sourcelist/v1`, Paramètres → Sources) sous sa responsabilité — voir `src/main/sources/`. BIOS/firmware : import guidé par l'utilisateur, seule exception le firmware PS3/Vita téléchargé au clic depuis les serveurs officiels Sony (`src/main/bios/official.ts`).
- Clés API et données utilisateur hors dépôt (jamais commitées).
- Graphify : sortie dans `E:\Super IA\Graphify\RomVault\graphify-out\`.
- Studio OS : projet `romvault` (id fc05e6bd-f646-421c-bb90-37b18330ee1a).
- Ne pas copier d'assets Hydra (logos, textes) : identité RomVault.
