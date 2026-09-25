# RomVault

Bibliothèque de jeux d'émulation pour Windows, look Hydra Launcher. Spéc complète : vault `projects/romvault/SUMMARY`.

## Stack
Electron + React + TypeScript, Vite, Zustand, better-sqlite3. i18n EN/FR (fichiers de traduction, aucune chaîne en dur).

## Commandes
À renseigner après le prototype (Phase 1) : `npm run dev`, `npm run build`, `npm test`, `npm run typecheck`.

## Conventions
- Jamais de téléchargement de ROMs ; BIOS/firmware : import guidé par l'utilisateur uniquement.
- Clés API et données utilisateur hors dépôt (jamais commitées).
- Graphify : sortie dans `E:\Super IA\Graphify\RomVault\graphify-out\`.
- Studio OS : projet `romvault` (id fc05e6bd-f646-421c-bb90-37b18330ee1a).
- Ne pas copier d'assets Hydra (logos, textes) : identité RomVault.
