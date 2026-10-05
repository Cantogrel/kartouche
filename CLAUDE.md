# RomVault

Bibliothèque de jeux d'émulation pour Windows, look Hydra Launcher. Spéc complète : vault `projects/romvault/SUMMARY`.

## Stack
Electron 44 + React 19 + TS via electron-vite (vite 7 épinglé), Zustand, SQLite via `node:sqlite` (pas better-sqlite3). Pas d installateur avant la fin du projet : on teste sur les sources.

## Commandes
`npm run dev` (electron-vite dev), `npm run build`, `npm run typecheck`, `npm test` (vitest). Première install : `node node_modules/electron/install.js` si le binaire manque.

## Conventions
- RomVault n'agrège ni ne scrape aucune source de téléchargement de jeux : chaque utilisateur ajoute ses propres listes (URL JSON, format `romvault.sourcelist/v1`, Paramètres → Sources) sous sa responsabilité — voir `src/main/sources/`. BIOS/firmware : import guidé par l'utilisateur, seule exception le firmware PS3/Vita téléchargé au clic depuis les serveurs officiels Sony (`src/main/bios/official.ts`).
- Une `uri` de source peut être HTTP(S), `magnet:` ou une URL `.torrent` : `src/main/downloads/torrent.ts` (client WebTorrent embarqué, MIT, aucun tracker/magnet fourni par RomVault, pas de semis après coup). Torrent multi-fichiers : `planTorrent` (`src/main/downloads/torrentPlan.ts`) ne demande que ce que l'import utilise pour CE jeu — fichier principal choisi par `title`/`sizeBytes` (erreur si ambigu), pistes d'un `.cue`, `.sbi`, volumes d'archive, et pour Switch/3DS/PS3 les mises à jour/DLC du jeu (identifiant natif lu dans le fichier principal) ; le reste n'est pas téléchargé (hors octets voisins d'une même pièce), et l'import refuse tout contenu d'un autre jeu.
- Mises à jour et DLC (Switch, 3DS, PS3, Wii U, Vita) : identifiant natif, un installateur par émulateur, suivi exact des fichiers installés (`library_content.emu_files`), désinstallation sûre — état réel et niveaux de validation dans `docs/content-support.md` ; `npm run test:real` pour les essais avec les vrais émulateurs.
- Big Picture (`src/renderer/src/bigpicture/`) : pour chaque tâche UI, vérifier si elle concerne aussi le mode Big Picture (tuiles, fiche `Detail.tsx`, navigation manette) et l'y adapter ; il a ses propres composants, un correctif fait côté classique n'y arrive pas tout seul.
- Clés API et données utilisateur hors dépôt (jamais commitées).
- Graphify : sortie dans `E:\Super IA\Graphify\RomVault\graphify-out\`.
- Studio OS : projet `romvault` (id fc05e6bd-f646-421c-bb90-37b18330ee1a).
- Ne pas copier d'assets Hydra (logos, textes) : identité RomVault.
