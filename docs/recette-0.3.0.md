# Recette Kartouche 0.3.0 (2026-10-05)

Légende : OK = exécuté et constaté ; PARTIEL = vérifié en partie ; À FAIRE = non exécuté (matériel ou action réelle requise).

| # | Vérification | Résultat |
| --- | --- | --- |
| 1 | `npm run typecheck` | OK |
| 2 | `npm test` : 919 réussis, 11 ignorés (85 fichiers) | OK |
| 3 | `npm run build` | OK |
| 4 | `npm run dist:dir` : `release/win-unpacked/Kartouche.exe` produit | OK |
| 5 | Build packagé lancé sur profil isolé (`--user-data-dir` + `bootstrap.json`) avec une copie de la base 0.2.5 : démarre, migrations appliquées, bibliothèque existante affichée | OK |
| 6 | Aucune régression manette : `bigpicture/nav.ts` et `useNav.ts` inchangés depuis 0.2.5 (`git diff v0.2.5..dev`), tests de navigation verts | PARTIEL (pas de manette physique branchée) |
| 7 | Modifier un jeu, invariants d'identification (tests `overridesFlow`, `metadataMerge`) | OK (tests) |
| 8 | Connecteurs Steam, Epic, GOG, Hydra, Xbox sur la machine réelle | OK (jalon phase 6) |
| 9 | Connecteurs EA, Ubisoft, Battle.net, itch.io | PARTIEL (fixtures, non installés) |
| 10 | Lancement réel via Steam/Epic (démarrerait le client de l'utilisateur) | À FAIRE |
| 11 | Installateur NSIS par-dessus une installation RomVault réelle | À FAIRE (à tester avec un `appId` de test, jamais sur `C:\Games\RomVault`) |
| 12 | Mise à jour automatique 0.2.5 → 0.3.0 | À FAIRE (après publication) |
| 13 | Traductions es/de/it/pt-PT/zh-hans/ja relues par un natif | À FAIRE |
