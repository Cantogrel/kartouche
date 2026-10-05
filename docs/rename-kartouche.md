# Renommage RomVault → Kartouche : audit et décisions

Audit réalisé pour la tâche Studio OS `e26574c3` (étape P01-audit, roadmap « Kartouche 0.3.0 »). Aucun code modifié.
Périmètre : 86 fichiers, 301 occurrences de « romvault » (insensible à la casse), hors `node_modules`, `out`, `release`, `.git`, `package-lock.json`.

Règle : tout ce que l'utilisateur voit devient **Kartouche**. Tout identifiant stocké sur disque ou lu par d'anciennes versions est **conservé** (ou accepté en double) : le renommer ferait perdre des données ou casserait la mise à jour.

## 1. Visible par l'utilisateur → RENOMMER (étape P01-visible)

| Où | Occurrences |
|---|---|
| `src/renderer/index.html` (`<title>`) | titre de fenêtre |
| `src/renderer/src/App.tsx:69` | nom dans la barre de titre |
| `src/renderer/src/bigpicture/BigPicture.tsx:188` | `<h1>` du Big Picture |
| `src/renderer/src/pages/Settings.tsx:195` | « À propos » (nom + version) |
| `locales/en.json`, `locales/fr.json` | 12 chaînes chacune : `emu.subtitle`, `sources.hint`, `settings.restartNeeded`, `settings.importCopy`, `content.leftover`, `danger.uninstallAllEmulatorsHint`, `sources.copyOf`, `bp.quitApp`, `settings.startBigPictureHint`, `action.saveShared`, `update.none`, et `sources.formatIntro` (cite le nom de format, voir §3) |
| `README.md`, `CHANGELOG.md`, `docs/content-support.md` | texte et noms de fichiers d'installation |
| `tools/make-icon.ps1` | commentaire ; **l'icône elle-même est un coffre-fort (cadran) : ne colle plus au nom** → nouvelle icône cartouche à proposer à l'utilisateur |
| Noms de profils visibles DANS les émulateurs (`RomVault Clavier`, `RomVault Manette`, `RomVault Pro Controller`, `RomVault GamePad`) | **CONSERVER** pour les profils existants (voir §4) |

## 2. Build, distribution, dépôt → RENOMMER (étape P01-build)

| Élément | Aujourd'hui | Décision |
|---|---|---|
| `package.json` `name` | `romvault` | `kartouche` |
| `electron-builder.yml` `productName` / `shortcutName` | `RomVault` | `Kartouche` |
| `electron-builder.yml` `artifactName` | `RomVault-Setup-${version}.${ext}` | `Kartouche-Setup-${version}.${ext}` |
| `electron-builder.yml` `publish.repo` | `romvault` | `kartouche` (après renommage du dépôt GitHub) |
| `electron-builder.yml` **`appId`** | `com.binagames.romvault` | **CONSERVER** : NSIS dérive son identifiant d'installation de l'`appId` ; le garder = la mise à jour 0.2.x → 0.3.0 se fait sur place, au même dossier, donc avec `data/` |
| `tools/RomVaultDev.cs`, `tools/build-dev-exe.cmd`, `RomVault-Dev.exe` | | `KartoucheDev.cs`, `Kartouche-Dev.exe` ; mettre à jour `.gitignore` et README |
| `package.json` script `test:real` | `ROMVAULT_REAL_EMU` | `KARTOUCHE_REAL_EMU` (+ tests concernés) |
| Dépôt GitHub `Cantogrel/romvault` | | renommer en `kartouche` ; GitHub redirige l'ancienne URL (API et téléchargements) |

## 3. Identifiants techniques

| Identifiant | Fichiers | Décision | Raison |
|---|---|---|---|
| `romvault.db` (fichier de base) | `src/main/index.ts:72`, `src/main/ipc.ts:101` | **CONSERVER** | Nom interne, jamais montré ; le renommer ne rapporte rien et expose à un échec de migration |
| `appId` | `electron-builder.yml` | **CONSERVER** | voir §2 |
| `romvault.sourcelist/v1` (nom du format JSON des listes) | `Settings.tsx`, locales, `CLAUDE.md` | **RENOMMÉ** `kartouche.sourcelist/v1` dans l'aide et les exemples | **Correction de l'audit** : ce nom n'est qu'un libellé de documentation. La validation ne lit que `schemaVersion` (=1) et ignore les champs inconnus : une liste qui porte l'un ou l'autre nom, ou aucun, est acceptée (test de non-régression dans `validate.test.ts`). |
| Protocole `rvimg://` (**fait**) | `index.html` (CSP), `index.ts`, `ui/index.tsx`, `ConsoleTile.tsx`, commentaires | **RENOMMER** en `kimg://` | Non persisté (ni base ni réglages) ; aucune compatibilité à garder |
| Type `RomVaultApi` | `src/shared/ipc.ts:190`, `preload/index.ts`, `env.d.ts` | **RENOMMER** `KartoucheApi` | Interne |
| `BiosFound.source: 'romvault'` | `src/shared/bios.ts:106`, `bios.ts:88` | **RENOMMER** (`'app'`) après vérification qu'aucun libellé ne l'utilise comme clé | Valeur calculée à la volée, non persistée |
| Variables `ROMVAULT_HASH`, `ROMVAULT_REAL_EMU` | `index.ts:35`, `package.json`, tests réels | **RENOMMER** `KARTOUCHE_*` | Développement seulement |
| User-agent `RomVault`, `RomVault/0.1` | `engine.ts`, `torrent.ts`, `precheck.ts`, `installer.ts`, `source.ts`, `cemu.ts`, `import.ts`, `retroachievements.ts`, `l10n.ts` | **RENOMMER** `Kartouche` | Aucun serveur n'est filtré sur ce nom (à revérifier pour `update.rpcs3.net`, paramètre `c=RomVault` de `source.ts:86`) |

## 4. Marqueurs et noms écrits sur le disque ou dans les émulateurs → CONSERVER

Tout cela est relu pour reconnaître « un fichier que nous avons écrit » ou retrouver des sauvegardes. Changer le nom orphelinerait les fichiers existants (par exemple des cartes mémoire PS2).

| Élément | Fichier |
|---|---|
| Cartes mémoire PCSX2 `RomVault-<série>[-2]`, `romvault-<…>.ini`, marqueur `.romvault-migrated` | `pcsx2Cards.ts` (+ `saves.ts`) |
| Profils PCSX2 `RomVault Manette` / `RomVault Clavier` | `pcsx2.ts` |
| Marqueur RPCS3 `# romvault:rpcs3-input`, fonction `isRomvaultInput` | `rpcs3.ts` |
| Marqueur Cemu `<!-- romvault:cemu-profile=… -->`, profils `RomVault Pro Controller` / `GamePad` | `cemu.ts` |
| Profil Eden `RomVault Clavier` | `configure.ts:539`, `eden.ts` |
| Fichier `romvault-melonds-layout.json` | `configure.ts:560` |
| Fichiers temporaires `*.romvault-tmp` | `content/eden.ts`, `content/cemu.ts` |

À faire éventuellement plus tard (hors 0.3.0) : écrire les nouveaux fichiers sous le nom Kartouche en acceptant les deux. Les noms de variables et de fonctions internes (`isRomvaultInput`, `createdByRomVault`) peuvent être renommés sans effet sur les données.

## 5. Données utilisateur et mise à jour → COMPATIBILITÉ OBLIGATOIRE (étape P01-compat)

Deux constats qui changent le plan de la migration :

1. **Le dossier de données packagé est à côté de l'exécutable** (`<dossier d'installation>\data`, `paths.ts:11`), pas dans `userData` comme les notes du vault le laissaient croire. Installation par machine (`perMachine: true`), dossier par défaut dérivé de `productName`.
2. **L'installateur met `data/` de côté sous le nom `RomVault-data.keep`** pendant la désinstallation de l'ancienne version, puis le remet. Si le script de la nouvelle version cherche `Kartouche-data.keep`, il ne retrouve rien : la base resterait orpheline dans `RomVault-data.keep` et l'app démarrerait vide. **`build/installer.nsh` doit continuer à utiliser `RomVault-data.keep`** (ou chercher les deux noms). Le test d'une mise à jour réelle 0.2.5 → 0.3.0 est indispensable.

Autres points :

| Sujet | Décision |
|---|---|
| Dossier d'installation | Avec le même `appId`, la mise à jour reste dans l'ancien dossier (`…\RomVault`) : l'exécutable devient `Kartouche.exe` dans un dossier encore nommé RomVault. Une installation neuve ira dans `…\Kartouche`. Documenté, accepté. |
| `userData` (`%APPDATA%\<nom>`) | Le nom change avec `productName` : `bootstrap.json` (chemin de données choisi par l'utilisateur) et le stockage local de Chromium ne seront plus retrouvés. **Fait** (`src/main/legacy.ts`, appelé avant `whenReady`) : copie `bootstrap.json` et `Local Storage` depuis `%APPDATA%\RomVault` (jamais déplacés, jamais écrasés, idempotent). Vérifié sur un vrai lancement : `Local Storage` repris dans le profil isolé. |
| Raccourcis | Le désinstalleur de l'ancienne version retire le raccourci `RomVault`, le nouvel installateur crée `Kartouche`. À vérifier. |
| Proxy Cloudflare `romvault-proxy.mathc83.workers.dev` (`src/shared/proxy.ts`, `server/`) | **CONSERVER l'URL** : les versions 0.2.x installées l'appellent encore, et un nouveau worker demanderait de recréer les secrets (clés). Renommer les commentaires seulement. Un `kartouche-proxy` pourra venir plus tard avec les deux en service. |
| Mise à jour automatique | Les installations 0.2.x pointent vers `Cantogrel/romvault` ; GitHub redirige vers le dépôt renommé. À tester avant publication. |
| Dossier du projet local `E:\dev\RomVault` | **CONSERVER** (renommer casserait worktrees, mémoire de Claude Code et scripts) |

## 6. Écosystème interne (étape P01-ecosystem)

`CLAUDE.md` (titre, vault, Graphify `E:\Super IA\Graphify\RomVault\graphify-out\`, projet Studio OS `romvault`), notes du vault `projects/romvault/*`, projet Studio OS (slug `romvault`, id inchangé), mémoire de Claude Code. Le slug et les chemins peuvent rester tant que le titre affiché change ; décision à prendre à cette étape pour Graphify (nouveau dossier ou conservation).

## Décisions résumées

| Sujet | Décision |
|---|---|
| `rvimg://` | renommer en `kimg://` |
| `romvault.db` | conserver |
| Format de liste de sources | accepter `romvault.sourcelist/v1` et `kartouche.sourcelist/v1`, émettre le nouveau |
| `appId` | conserver |
| `userData` | migrer `bootstrap.json` et `Local Storage` |
| `build/installer.nsh` | garder `RomVault-data.keep` (ou gérer les deux) |
| Marqueurs d'émulateurs, cartes mémoire, profils | conserver |
| URL du proxy | conserver |
| Icône | à refaire (cartouche) — à valider avec l'utilisateur |

## Points qui demandent l'accord de l'utilisateur

- Renommer le dépôt GitHub (action visible de l'extérieur) : au démarrage de P01-build.
- Nouvelle icône (le coffre-fort ne correspond plus au nom).
- Publier le nouvel installateur : uniquement à P08-release.
