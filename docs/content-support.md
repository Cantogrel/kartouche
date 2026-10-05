# Jeux, mises à jour et DLC

Kartouche importe un lot de fichiers sans aucune question : il lit l'identifiant **natif** de chaque fichier (jamais le nom quand le format porte un identifiant),
importe les jeux principaux, rattache chaque mise à jour / DLC à son jeu parent, puis les rend visibles de l'émulateur par le mécanisme **propre à celui-ci**.
Un contenu n'est jamais une ligne de la bibliothèque : il s'affiche sur la fiche de son jeu (Mises à jour / Contenu additionnel, avec son état).

Code : `src/main/library/content/` (analyse, rattachement) et `src/main/emulators/content/` (une stratégie d'installation par émulateur). Le pipeline
d'import (`importer.ts`) ne connaît que les interfaces `ContentInfo` / `ContentInstaller` : ajouter une plateforme = une sonde + un installateur.

## État par plateforme

« Réelle » = vérifiée avec le **vrai émulateur** de cette machine (voir « Niveaux de validation » : la charge de contenu est parfois fabriquée, et c'est dit). « Source » = déduite du code source de
l'émulateur, jamais essayée.

| Plateforme | Identification | Installation | Désinstallation | Gestion des fichiers |
|---|---|---|---|---|
| **Switch / Eden** | **réelle** (vrais NSP + `prod.keys`) | **réelle** (Eden applique la vraie mise à jour : vérifié, avec témoin) | implémentée : rien à défaire chez Eden (il lit nos fichiers), on supprime ce que Kartouche a rangé | sûre |
| **3DS / Azahar** | structure du `.cia` : source + synthétique | **réelle** avec un `.cia` fabriqué que le vrai Azahar installe ; **pas de vrai `.cia` de mise à jour/DLC** | **réelle** (même `.cia`) | sûre |
| **PS3 / RPCS3** | en-tête du `.pkg` : source + synthétique ; liste des fichiers : **réelle** (RPCS3 décode un paquet fabriqué selon ce format) | **réelle** avec un `.pkg` fabriqué que le vrai RPCS3 installe en `--headless` ; **pas de vrai `.pkg` de patch/DLC** | **réelle** (même `.pkg`) | sûre |
| **Wii U / Cemu** | **réelle** pour les archives `.wua` (la vraie *Breath of the Wild* v208 : jeu + mise à jour + DLC lus) ; dossiers NUS/extraits : synthétique | mécanisme **réel** (le vrai Cemu découvre un titre extrait déclaré dans ses chemins de jeux) avec un titre fabriqué ; **titre NUS chiffré non essayé** (aucun dump) | implémentée : rien à défaire chez Cemu (aucun fichier écrit dans son espace), on supprime ce que Kartouche a rangé ; `mlc01` jamais touché | sûre |
| **Vita / Vita3K** | **réelle** pour le jeu (vrai `.zip` du jeu installé : `gd`, `TITLE_ID`) ; mise à jour/DLC en archive : lecture du même `param.sfo` | **réelle** pour archives (`.vpk`/`.zip`) : DLC et mise à jour fabriqués installés par le vrai Vita3K ; `.pkg` DLC + zRIF : **source, non essayé** ; `.pkg` mise à jour : **non installée** (voir limites) | **réelle** (dossier du jeu strictement identique à l'origine après mise à jour fabriquée puis désinstallation) | sûre |

Les autres consoles (NES, SNES, N64, GB/GBC/GBA, DS, GC, Wii, PS1, PS2, PSP) n'ont pas cette notion : aucune logique n'y est ajoutée.

## Pipeline

1. **Analyse** de tout le lot (`probeFile`, `probeWiiUFolder`) : type (jeu / mise à jour / DLC / inconnu), identifiant du contenu, identifiant du jeu parent.
2. **Tri** : contenus mis de côté ; un contenu non fiable (`unknown`) ou un `.pkg` de jeu complet est refusé.
3. **Jeux principaux** importés comme avant. Leur identifiant natif (`library.title_id`) est mémorisé, puis les contenus qui les attendaient (`library_orphans`) leur sont rattachés.
4. **Contenus** : rattachés au jeu (`library_content`) ; sans jeu parent → mis en attente (`library_orphans`), jamais un faux jeu, tracé dans `<logs>/content.log`.
5. **Installation** dans l'émulateur (`installPendingContent`) à l'import, puis à chaque lancement du jeu pour ce qui est resté en attente ou en échec.

L'ordre des fichiers du lot n'a aucune importance, y compris entre lots. Le **conteneur décide, pas le nom** : un jeu complet dont le nom évoque « update » ou « DLC » reste un jeu ; un DLC n'est jamais une
ligne de la bibliothèque. Un jeu importé avant cette fonctionnalité voit son identifiant lu dans son fichier au moment de rattacher un contenu.

## Les cinq mécanismes (vérifiés dans le code source de chaque émulateur)

### Switch — Eden : « External Content »
Eden parcourt récursivement les dossiers de `Paths\external_content_dirs` (`qt-config.ini`, section `[UI]`), lit les NSP/XCI (tickets compris) et propose mises à jour et DLC au jeu
(`registered_cache.cpp`, `ExternalContentProvider`). Kartouche range les NSP sous `<roms>/switch/.content/` et déclare ce dossier. **Rien n'est écrit dans le NAND.** Refusé tant qu'Eden tourne (il réécrit sa config).
Identité d'un NSP, par ordre de fiabilité : CNMT du NCA de métadonnées déchiffré (`prod.keys`), sinon `.cnmt.xml`, sinon ticket, sinon nom ; deux sources qui se contredisent → `unknown`.
Un « .nsp » sans aucun NCA (module système, ExeFS — ex. `exefs.nsp` d'emuiibo) n'est ni un jeu ni un contenu.

### 3DS — Azahar : `azahar -i`
Mises à jour (`0004000E`) et DLC (`0004008C`) sont des `.cia` installés dans la carte SD virtuelle : `user/sdmc/Nintendo 3DS/<32 zéros>/<32 zéros>/title/<haut>/<bas>/content/` + ticket
`user/nand/dbs/ticket.db/<TITLE ID>.<TICKET ID>.tik` (`am.cpp`). L'installation ouvre la fenêtre d'Azahar : elle n'a lieu qu'au **lancement du jeu**. Désinstaller = supprimer `content/` (geste de
`UninstallProgram`), jamais `data/` (sauvegardes).

### PS3 — RPCS3 : `rpcs3 --headless --installpkg`
En mode graphique l'option ouvre l'assistant d'installation ; en `--headless` elle installe sans fenêtre et journalise `Successfully installed <chemin>` (`rpcs3.cpp`, `main_window.cpp`). Un paquet « Game Data »
(type 4 ; drapeau PATCH → mise à jour, sinon DLC) s'installe dans `dev_hdd0/game/<dossier d'installation>/` (numéro de série du paquet, ou métadonnée 0xA). RPCS3 n'écrase un fichier existant que si l'entrée
porte le drapeau OVERWRITE.

### Wii U — Cemu : chemins de jeux
Cemu (`CafeTitleList::ScanGamePath`, `GetGameInfo`) parcourt chaque chemin de jeux et y découvre tout titre — extrait (`code/` `content/` `meta/`), NUS/WUP (`title.tmd` + `title.tik` + `.app`, déchiffré par Cemu avec la clé
commune qu'il embarque) ou `.wua` — puis associe lui-même la mise à jour (`0005000E-<même id bas>`) et le DLC (`0005000C-<même id bas>`) au jeu (journal : `Update: <chemin>`, `DLC: <chemin>`). Kartouche range le titre
sous `<roms>/wiiu/.content/` et déclare ce dossier dans `<GamePaths>` de `settings.xml` (refusé tant que Cemu tourne). **Aucune installation dans `mlc01`, aucun déchiffrement par Kartouche.**
Prérequis vérifiés comme Cemu les exige : NUS → `title.tik` + tous les `.app` listés par le TMD ; extrait → `meta/meta.xml`, `code/app.xml`, `code/cos.xml`. Ticket absent → « clé requise » (donnée de l'utilisateur,
jamais téléchargée) ; titre incomplet → échec avec le fichier manquant.

### Vita — Vita3K
- **Archive `.vpk`/`.zip`** (PARAM.SFO en clair) : `Vita3K.exe <archive>` installe selon `CATEGORY` — `ac` (DLC) → `ux0/addcont/<TITLE_ID>/<fin du CONTENT_ID>` ; `gp` (mise à jour) → `ux0/patch/<TITLE_ID>` puis **fusionnée dans
  `ux0/app/<TITLE_ID>`** où elle écrase les fichiers du jeu (`io.cpp`, `copy_path`). Aucune clé à fournir. La fenêtre s'ouvre : installation au lancement du jeu. Vita3K exige que le jeu soit déjà installé (« Install app before patch »).
  Comme la fusion écrase des fichiers, **l'original de chacun est sauvegardé avant l'installation** (hors de Vita3K) et remis à la désinstallation.
- **Paquet `.pkg` DLC** : `Vita3K.exe --pkg <fichier> --zrif <zRIF>` (headless : Vita3K se referme seul). Le zRIF est une donnée de l'**utilisateur**, lue dans un fichier voisin `<nom>.pkg.zrif` ou `<nom>.zrif` (copié avec le paquet) ; jamais
  deviné ni téléchargé. Sans lui : « clé requise », rien n'est lancé.
- **Paquet `.pkg` de mise à jour** : non installé (limite technique, ci-dessous).

## Suivi des fichiers installés (`library_content.emu_files`, `emu_backup`)

À l'installation, l'installateur renvoie la liste **exacte** de ce qu'il a CRÉÉ dans l'espace de l'émulateur (photographie avant/après des dossiers concernés, `snapshot.ts`) :

| `emu_files` | Sens | Désinstallation |
|---|---|---|
| liste de chemins | ce que l'installation a créé | exactement ces chemins, rien d'autre |
| `[]` | rien n'appartient à Kartouche (Eden, Cemu : rien d'écrit chez l'émulateur ; ou titre **déjà présent avant Kartouche**, installé à la main) | rien n'est supprimé ; dit à l'utilisateur |
| `NULL` | installé avant le suivi | provenance à PROUVER (ci-dessous), sinon refus |

Règles, toutes testées :
- **Un fichier déjà là n'est jamais compté**, même réécrit par l'installation (il appartient au jeu ou à un autre contenu).
- **Fichier partagé** avec un autre contenu (`splitShared`, avant toute suppression) : retiré avec son DERNIER propriétaire seulement ; un dossier qui porte les fichiers d'un autre contenu est examiné élément par élément.
- **Fichiers réécrits** par l'installation (mise à jour Vita3K, paquet PS3 avec OVERWRITE) : l'original est sauvegardé avant (`emu_backup`) et restauré ; si une copie manque, la désinstallation est refusée AVANT toute modification.
- **Installation partielle** jamais annoncée terminée : Azahar (TMD + au moins un `.app`), RPCS3 (tous les fichiers de la liste du paquet, à la bonne taille), Vita3K (tous les fichiers de l'archive), Cemu (prérequis du titre).
- **Émulateur ouvert** : toute opération qui écrirait ou supprimerait dans son espace est refusée/reportée.
- **Mises à jour Vita empilées** : seule la plus récente peut être désinstallée (chacune a écrasé ce que la précédente avait laissé).
- Aucun chemin enregistré hors de l'espace de l'émulateur n'est jamais supprimé ; une désinstallation refusée conserve la ligne et le fichier source.

**Contenu installé avant le suivi** (`emu_files` NULL) — jamais supprimé « parce que ça ressemble » :
- *Azahar* : retiré seulement si le dossier `content/` a été **créé pendant l'installation que Kartouche a enregistrée** (date de création du dossier dans la fenêtre de l'installation) ; sinon refus.
- *RPCS3* : la **liste des fichiers du paquet** est relue dans le paquet (même déchiffrement que RPCS3 : AES-128-CTR, clé publique du format, compteur = klicensee) ; un fichier n'est retiré que s'il est encore à la taille
  du paquet, date de l'installation enregistrée, et n'est écrit par aucun autre contenu du jeu. Paquet de type debug/IDU (liste non lisible) : refus, l'application dit pourquoi.

## Niveaux de validation

1. **Synthétique** (`pipeline.test.ts`, `emu-content.test.ts`, `uninstall*.test.ts`, `torrent*.test.ts`) : analyse, ordre du lot, rattachement, doublons, orphelins, sécurité, tracking, partage, provenance. Les processus d'émulateur y sont remplacés par
   des exécuteurs qui écrivent ce que l'émulateur écrirait. **Ne prouve jamais qu'un émulateur reconnaît le contenu.**
2. **Réel avec charge fabriquée** (`real-emulators.test.ts`, `npm run test:real`) : lance le VRAI émulateur installé dans `data/emulators/` avec un contenu fabriqué *au bon format*, sauvegarde puis restaure sa configuration.
   Valide le mécanisme (commande, journal, chemins, suivi, désinstallation) ; **ne valide pas** l'effet d'un vrai dump :
   - Cemu : `Update: …/maj-synthetique` découvert via `<GamePaths>` (témoin : `Update: Not present`) ;
   - Eden : « Update (v0.30.0) applied successfully » avec les vrais NSP (témoin : aucune ligne) ;
   - Azahar : `azahar -i` installe un `.cia` fabriqué, le suivi enregistre `content/` et le ticket, la désinstallation ramène l'espace à l'état d'avant ;
   - RPCS3 : `--headless --installpkg` installe un `.pkg` fabriqué (RPCS3 le décode avec le format que lit `listPkgFiles`), journal `Successfully installed … (title_id=…)` ;
   - Vita3K : DLC et mise à jour fabriqués installés par le CLI, dossier du jeu strictement identique (empreintes) après désinstallation (mise à jour : `ROMVAULT_REAL_EMU_VITA_PATCH=1`, modifie temporairement le dossier du jeu).
3. **Réel avec vrais fichiers** (`real-content.test.ts`) : l'outil à utiliser dès qu'on dispose d'un vrai contenu. Déposer les fichiers dans `E:\dev\Kartouche\test-content\` (ou `ROMVAULT_REAL_CONTENT_DIR`) :
   `3ds/*.cia`, `ps3/*.pkg`, `vita/*.vpk|*.zip|*.pkg(+.zrif)`, `wiiu/<dossiers NUS ou extraits>|*.wua` (`ROMVAULT_REAL_WIIU_BASE` = un jeu de base pour que le vrai Cemu le liste), puis `npm run test:real`. Sans fichier pour une
   plateforme, son test est **sauté** avec le message « plateforme NON validée avec un vrai contenu ». Il vérifie l'identification, puis (avec le vrai émulateur) installation → suivi → désinstallation → espace revenu à l'état d'avant.

**Rien de ce qui est marqué « source » ou « fabriqué » n'a été vu fonctionner avec un vrai dump.** Aucun vrai `.cia`, `.pkg` (PS3 ou Vita), titre Wii U NUS/extrait de mise à jour ou DLC n'était disponible ; seuls les NSP Switch
et l'archive `.wua` de *Breath of the Wild* sont de vrais contenus.

## Limites techniques réelles

- **Mise à jour Vita en `.pkg`** : Vita3K la fusionne dans le dossier du jeu (`copy_path`) ; la liste de ses fichiers n'est lisible qu'une fois la couche PFS déchiffrée avec le zRIF — impossible de sauvegarder d'avance ce qu'elle écrase,
  donc de pouvoir la défaire. Elle n'est pas installée ; son archive `.vpk`/`.zip` (PARAM.SFO lisible) l'est.
- **Fenêtre d'Azahar / de Vita3K** : installer un `.cia` ou une archive ouvre brièvement la fenêtre de l'émulateur (pas de mode sans fenêtre) : c'est fait au lancement du jeu, pas pendant un import.
- **Cemu** : un titre NUS chiffré n'a jamais été essayé (aucun dump) ; la clé commune est celle de Cemu, le ticket doit être fourni. Les titres NUS en dossier ne sont pas récupérés par les torrents (plusieurs fichiers : seul le jeu l'est).
- **RPCS3** : un paquet debug/IDU installe normalement mais sa liste de fichiers n'est pas lisible : le suivi par comparaison fonctionne, la désinstallation d'un contenu **sans** suivi est refusée.
- **XCI** Switch : seul le nom du fichier sert de repère (le conteneur HFS0 n'est pas lu).
- **3DS** : un DLC dont l'identifiant bas diffère de celui du jeu reste « en attente » (jamais rattaché au mauvais jeu).
- **BitTorrent** : une pièce chevauche deux fichiers ; au plus une pièce de voisins est reçue, jamais importée, supprimée avec le dossier de travail.

## Torrents : recherche de pairs

Le DHT public doit être amorcé avec des adresses IP : WebTorrent lui donne les routeurs par nom d'hôte et, sous Windows, leurs réponses sont ignorées (table DHT vide, aucun pair trouvé hors tracker — constaté : 0 nœud ; avec les adresses, 42 nœuds et 40 pairs). `src/main/downloads/torrent.ts` résout donc les routeurs avant de créer le client (partagé entre téléchargements, nœuds mémorisés dans `<cache>/dht-nodes.json`). Un magnet dont le tracker ne répond plus (« Torrent not registered ») ne dépend ainsi plus que du DHT.

## Switch : fichiers .nsz (NSP compressés)

Eden ne lit pas les `.nsz` ; l'import les **décompresse en `.nsp`** (`src/main/library/nsz.ts`, sans outil externe ni clé) avant tout le reste : le `.nsp` obtenu suit le chemin d'un `.nsp` ordinaire (identification native, jeu / mise à jour / DLC, rattachement). Chaque NCA reconstitué est vérifié par son nom (début du SHA-256 de son contenu) : un `.nsz` corrompu, tronqué ou mal rechiffré est refusé, jamais importé à moitié.
- Validé avec de vrais fichiers : Zelda Link's Awakening (jeu 5,84 Go + mise à jour avec sections BKTR) téléchargé depuis le catalogue puis importé de bout en bout ; mode « solid » seulement.
- Mode « blocs » (`NCZBLOCK`) : implémenté d'après le format, couvert par des tests synthétiques, pas encore vu sur un vrai fichier.
- `.xcz` (XCI compressé) : non pris en charge. Espace temporaire nécessaire : la taille du `.nsp` décompressé.

## Import et désinstallation depuis la fiche du jeu

La fiche d'un jeu a un bouton **Importer…** (et **Importer un dossier…** pour la Wii U) ainsi qu'une zone de glisser-déposer. Cet import (`library:importContent`, option `forGame`) n'accepte que les mises à jour/DLC
**de ce jeu** : le jeu parent lu dans le fichier doit être celui de la fiche. Un jeu, un contenu d'un autre jeu, un contenu dont le jeu n'est pas en bibliothèque ou un fichier illisible est refusé avec la raison.

Chaque ligne de contenu a un bouton **Désinstaller** (`uninstallContent`) : retiré de l'émulateur (suivi exact ou provenance prouvée), puis le fichier rangé sous `<roms>/` supprimé, puis la ligne. Désinstaller (ou supprimer) un jeu
désinstalle chacun de ses contenus de la même façon ; un contenu que l'émulateur refuse de retirer (ouvert…) est conservé avec son état. Retirer un jeu de la bibliothèque en gardant sa ROM, ou vider la bibliothèque,
met ses contenus en attente (`library_orphans`).

## Téléchargement d'un torrent à plusieurs fichiers

`planTorrent` ne demande que ce que l'import utilise pour le jeu demandé :

| Cas | Retenu | Écarté (jamais demandé) |
|---|---|---|
| Disque PS1/PS2 | le `.cue` du bon jeu, **ses pistes** (lues dans la feuille), son `.sbi` ; `.ccd` + `.img`/`.sub`, `.mds` + `.mdf` | les autres jeux, pochettes, notices |
| Archive en plusieurs volumes | tous les volumes de cette archive | les autres archives |
| Switch, 3DS, PS3, Vita, Wii U (`.wua`) | le jeu, puis ses mises à jour/DLC : identifiant natif du jeu lu dans le fichier téléchargé ; seuls les fichiers dont le nom porte le Title ID de ce jeu (sans Title ID : nom commençant par le titre) | l'autre jeu et ses mises à jour |
| Autres | le seul fichier du jeu (titre, puis taille) ; erreur claire si deux fichiers restent aussi plausibles | tout le reste |

L'installation suit l'import : le jeu comme un téléchargement ordinaire, ses mises à jour/DLC par l'import « ciblé » (`forGame`), qui **vérifie l'appartenance dans le fichier lui-même** (noté dans `InstallResult.notes` et `content.log`).

## Rejouer les validations réelles

`npm run test:real` (Windows). Il sauvegarde et restaure `qt-config.ini` (Eden), `settings.xml` et `log.txt` (Cemu) et nettoie les titres fabriqués (Azahar `0004000E00FFFE00`, RPCS3 `BLES99999`, Vita3K `PCSE00097` + contenu de test). Prérequis :
les émulateurs installés dans Kartouche, les NSP *Animal Crossing* dans `Downloads\Animal Crossing New Horizons [NSP]`, le jeu *Call of Duty Black Ops Declassified* installé dans Vita3K.
