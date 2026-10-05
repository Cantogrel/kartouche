# Audit des chaînes visibles (moteur de langues)

Méthode : recherche par script dans `src/renderer/src/**/*.ts(x)` (texte JSX, `title`/`placeholder`/`aria-label`/`alt`, chaînes JS accentuées ou en phrase), puis dans `src/main/**/*.ts` (champs `error|message|reason|note|label|detail`).

## Interface (renderer) : aucune chaîne en dur

Seule exception volontaire : le nom de marque « Kartouche » (barre de titre, `App.tsx`, `bigpicture/BigPicture.tsx`). Tout le reste passe par `t()` ; `locales/en.json` et `locales/fr.json` ont les mêmes clés (test `missingKeys`).

## Messages produits par le processus principal : en français seulement (écart connu)

Ces textes sont générés côté main puis affichés tels quels (erreurs d'import, d'installation de contenu, de téléchargement). Ils ne passent pas par les fichiers de langue. Les traduire demande de remplacer chaque texte par un code d'erreur que le renderer traduit : chantier à part, non fait ici.

45 occurrences repérées (liste indicative : la recherche ne capte pas les messages construits autrement).

### `src/main/downloads/engine.ts` (2)

- l.82 : source introuvable
- l.84 : aucun lien pour cette source

### `src/main/downloads/install.ts` (3)

- l.73 : source introuvable
- l.74 : aucun jeu du catalogue associé à cette source
- l.99 : le fichier téléchargé correspond, par empreinte officielle, à un autre jeu du catalogue que celui attendu

### `src/main/emulators/content/azahar.ts` (4)

- l.104 : fichier absent
- l.108 : installation refusée par Azahar (voir son journal)
- l.112 : installation incomplète (aucun TMD ou aucun .app dans le dossier du titre)
- l.125 : Azahar est ouvert : le fermer avant de désinstaller

### `src/main/emulators/content/cemu.ts` (2)

- l.51 : fichier absent
- l.59 : settings.xml de Cemu sans section <GamePaths> : configuration non modifiée

### `src/main/emulators/content/eden.ts` (1)

- l.50 : fichier absent

### `src/main/emulators/content/index.ts` (1)

- l.88 : contenu introuvable

### `src/main/emulators/content/rpcs3.ts` (5)

- l.114 : fichier absent
- l.125 : ${unsaved.length} fichier(s) existant(s) réécrits sans sauvegarde : originaux remis, installation non retenue
- l.135 : installation incomplète (fichier manquant ou tronqué : ${basename(f.path)})
- l.142 : RPCS3 est ouvert : le fermer avant de désinstaller
- l.162 : copie de sauvegarde d

### `src/main/emulators/content/vita3k.ts` (14)

- l.69 : mise à jour en .pkg : fusionnée dans le jeu sans moyen de la défaire — utiliser son archive .vpk/.zip
- l.72 : zRIF requis : le placer dans un fichier « <nom>.pkg.zrif » à côté du paquet (jamais téléchargé ni deviné)
- l.76 : identifiant de contenu du paquet illisible
- l.84 : installation du paquet non confirmée (dossier du DLC absent ou vide)
- l.111 : fichier absent
- l.113 : format non pris en charge par Vita3K
- l.122 : archive illisible (PARAM.SFO introuvable ou plusieurs contenus)
- l.125 : catégorie Vita non installable (${info.category})
- l.147 : installation annulée : ${unsaved.length} fichier(s) du jeu réécrits sans sauvegarde
- l.154 : installation refusée par Vita3K (voir son journal)
- l.161 : installation incomplète (fichier manquant ou tronqué : ${e.name})
- l.167 : Vita3K est ouvert : le fermer avant de désinstaller
- l.175 : une mise à jour plus récente est installée : la désinstaller d
- l.178 : copie de sauvegarde d

### `src/main/library/content/n3ds.ts` (1)

- l.39 : type de contenu 3DS non pris en charge (${tmd.titleId.slice(0, 8)})

### `src/main/library/content/switch.ts` (2)

- l.223 : identifiants contradictoires (${first.source} ${first.titleId} / ${clash.source} ${clash.titleId})
- l.232 : jeu parent non déterminable de façon fiable

### `src/main/library/content/wiiu.ts` (8)

- l.50 : type de titre Wii U non pris en charge (${titleId.slice(0, 8)})
- l.67 : archive .wua illisible
- l.75 : title.tmd illisible
- l.76 : title.tik manquant (Cemu en a besoin pour déchiffrer ce titre)
- l.79 : ${name} manquant (listé par le TMD)
- l.86 : meta/meta.xml manquant ou illisible
- l.87 : code/${f} manquant
- l.90 : ni titre NUS (title.tmd) ni dossier code/content/meta

### `src/main/library/importer.ts` (2)

- l.158 : extension non prise en charge
- l.326 : ${named.kind ===
