# Changelog

Notes affichées dans l'app après une mise à jour (Paramètres → À propos → Voir le changelog).
Une section `## <version>` par version ; le texte est repris tel quel dans le popup.

## 0.2.3

- Archives .7z et .rar : un téléchargement ou un import dans ce format est maintenant extrait automatiquement (plus
  besoin de 7-Zip ni de WinRAR), y compris les volumes .part1.rar / .7z.001. Un jeu à plusieurs fichiers (.cue +
  pistes, PS Vita) est reconditionné en .zip ; plusieurs ROM différentes, une archive corrompue, protégée par mot
  de passe ou à volume manquant sont refusées avec un message explicite. Les .zip fonctionnent comme avant.
- Sources : une entrée peut maintenant être un lien magnet: ou une URL .torrent (client BitTorrent intégré, aucun
  tracker ni lien fourni par RomVault, pas de partage après coup) ; l'état « Recherche de pairs… » s'affiche.
- Émulateurs : configuration automatique étendue (Cemu, Dolphin, DuckStation, PCSX2, PPSSPP, RPCS3, melonDS,
  Azahar, Eden, Vita3K, RetroArch) et identification des jeux (numéro de série, Title ID) y compris dans les
  images CHD, pour retrouver les sauvegardes de chaque jeu.
- Sauvegardes : copies automatiques par jeu d'après son identifiant ; un jeu non identifié est signalé comme
  partageant le dossier de sauvegardes de l'émulateur.
- Paramètres regroupés par sections (Application, Importation, Données, Sauvegardes, Manette, Comptes).

## 0.2.2

- Téléchargement : un jeu dont le fichier ne correspond ni au catalogue officiel ni à l'empreinte déclarée par la
  liste de sources est maintenant installé quand même, rattaché au jeu que la liste avait déjà associé à cette
  entrée — c'était auparavant refusé par défaut, alors que la plupart des listes ne déclarent pas d'empreinte.
  Reste refusé le seul cas où le fichier correspond, par empreinte officielle, à un AUTRE jeu du catalogue.
- Corrigé : un échec inattendu pendant la vérification ou l'installation d'un téléchargement (fichier verrouillé,
  disque plein…) le faisait disparaître sans aucun message ; une erreur est maintenant toujours affichée, et le
  fichier n'est plus laissé dans le cache.
- Nouveau bouton « Vider le cache » dans Paramètres → Général (téléchargements en attente ou en échec, archives
  d'installation d'émulateurs, fichiers temporaires), avec la taille actuelle affichée à côté. Les fiches et images
  du catalogue ne sont jamais vidées par ce bouton.
- Bouton « Désinstaller » directement sur la fiche d'un jeu installé via une liste de sources.
- Le clic droit sur une tuile ou dans la liste latérale ouvre un menu rapide simplifié (Jouer, Favori, Épingler,
  Collection, Désinstaller) ; le menu ⚙ Options complet de la fiche garde toutes les actions, maintenant groupées
  et séparées par des barres.
- Big Picture : possibilité de télécharger un jeu du catalogue directement depuis sa fiche, à la manette ; plusieurs
  versions disponibles se choisissent dans une fenêtre dédiée.

## 0.2.1

- Catalogue : nouveau filtre par source de téléchargement, avec une option « Toutes sources » pour lister d'un
  coup tous les jeux téléchargeables ; cumulable avec plusieurs sources précises à la fois.
- Catalogue : les éditeurs sans résultat pour la sélection actuelle restent affichés (à 0) au lieu de disparaître,
  comme le font déjà les consoles. Meilleure séparation visuelle entre le filtre « inclure bêtas/démos… » et les genres.
- Reconnaissance des fichiers : plusieurs extensions pourtant acceptées par l'émulateur assigné étaient refusées
  par RomVault — `.zcci` (Azahar), `.wia`/`.tgc`/`.nfs` (Dolphin), `.dsi`/`.srl`/`.ids` (melonDS), `.iso`/`.wad`
  (Cemu, Wii U), `.mds`/`.ccd`/`.psx` (DuckStation), `.mdf`/`.zso`/`.gz` (PCSX2), `.chd` (PPSSPP, PSP).
- Corrigé : le rapprochement d'une liste de sources pouvait s'attacher à une variante régionale masquée du
  catalogue plutôt qu'au jeu réellement affiché, faisant croire à tort qu'un jeu pourtant présent n'était « pas
  reconnu ».
- Corrigé : un suffixe ajouté par certaines collections de ROMs patchées (ex. « _apfix ») au nom de fichier
  empêchait toute reconnaissance par titre.
- Corrigé : le téléchargement d'une ROM volontairement modifiée (patch anti-piratage, traduction…) était toujours
  refusé même quand elle correspondait exactement à ce que la liste de sources annonçait ; accepté désormais,
  avec une étiquette distincte de la vérification officielle contre le catalogue. Cette vérification pouvait elle-
  même porter par erreur sur le contenu extrait d'une archive `.zip` plutôt que sur le fichier tel que téléchargé,
  la faisant échouer systématiquement.

## 0.2.0

- Listes de sources de téléchargement : dans Paramètres → Sources, ajoutez vos propres listes (URL ou fichier JSON
  local, format `romvault.sourcelist/v1`) — RomVault ne fournit, ne scrape ni n'agrège aucune source lui-même, c'est
  entièrement sous votre responsabilité. Chaque liste est rapprochée automatiquement du catalogue ; actualisation et
  suppression par liste, avec le nombre de jeux reconnus et la dernière erreur éventuelle.
- Bouton Télécharger directement sur la fiche d'un jeu non possédé, quand une de vos sources le propose : reprise en
  cas de coupure, essai d'un autre miroir si le premier échoue, annulation possible, progression affichée en direct.
  Le fichier téléchargé est vérifié par hash (CRC32/SHA1) contre le jeu attendu avant toute installation — jamais
  silencieux sur un hash qui ne correspond pas.
- Un seul jeu à la fois : lancer un jeu pendant qu'un autre tourne déjà propose maintenant de fermer l'autre
  d'abord, plutôt que de laisser deux émulateurs ouverts en même temps.
- RomVault ne s'ouvre plus en double si on clique plusieurs fois sur son icône ou son raccourci : l'instance déjà
  ouverte est juste remise au premier plan.
- Catalogue : nouveau filtre par éditeur (Nintendo, Sony, Microsoft, Electronic Arts, Rockstar, ou Autre).
- Corrigé : en Big Picture, changer de filtre très vite dans le Catalogue pouvait laisser des jaquettes vides
  pendant un bon moment, même en changeant d'écran ensuite.
- Corrigé : à la manette, remonter dans l'Accueil envoyait parfois le focus directement sur le menu ☰ au lieu de
  la rangée de jeux juste au-dessus ; les filtres/onglets du haut (gérés aux gâchettes) ne volent plus le focus
  du stick ; le bouton X bascule maintenant les favoris même sans avoir ouvert la fiche d'un jeu ; le stick droit
  fait défiler l'Accueil, la Bibliothèque et le Catalogue comme il le fait déjà sur une fiche.
- Corrigé : certains jeux (titres avec un sous-titre, ex. « Special Edition ») n'affichaient jamais d'icône dans
  la Bibliothèque alors que SteamGridDB l'a bien.
- Corrigé : importer une liste de sources dont le hash (CRC32/SHA1) est absent — valeur `null` plutôt qu'omise,
  un cas fréquent selon l'export — provoquait un message d'erreur interminable au lieu d'être simplement accepté ;
  ce champ reste optionnel. Les erreurs de format, quand il y en a, tiennent maintenant en quelques lignes lisibles.
- Catalogue : les jeux proposés par au moins une de vos sources affichent désormais un repère (nom de la liste)
  sous leurs genres.
- Sur la fiche d'un jeu, quand plusieurs options de téléchargement sont proposées, chacune affiche maintenant son
  propre intitulé (région, langues, révision…) au lieu d'options identiques impossibles à distinguer entre elles.
- Poids des fichiers affiché de façon plus lisible partout où il apparaît (ex. « 59.1 MB », « 2.84 GB »).
- Téléchargement : le bouton indique clairement qu'un téléchargement est en cours, et une tâche apparaît dans la
  barre d'état en bas de l'app — visible même en changeant de page entre-temps.
- Paramètres → Sources : un bouton d'aide (ⓘ) détaille le format JSON attendu pour une liste, avec un exemple.
- Le popup des nouveautés de version s'affiche maintenant comme une vraie liste plutôt qu'un bloc de texte brut.

## 0.1.8

- Nouvelle section « Zone dangereuse » dans Paramètres : vider la bibliothèque (les fichiers ROM restent sur le
  disque), supprimer tous les fichiers ROM (les jeux restent dans la liste, marqués sans fichier), désinstaller tous
  les émulateurs installés, ou tout réinitialiser (réglages, bibliothèque, catalogue et collections — fichiers ROM et
  émulateurs installés conservés).
- Vita3K : messages d'erreur au lancement plus clairs, notamment la détection d'un dump au format Vitamin (bloqué
  systématiquement par l'émulateur, connu pour corrompre les sauvegardes) avec l'explication à l'écran. Un jeu Vita
  relance désormais toujours par son Title ID une fois installé (le .vpk lui-même ne boote jamais seul).
- Jaquettes/images du catalogue : l'autocomplete SteamGridDB ne retient plus le premier résultat par défaut s'il ne
  correspond pas vraiment au jeu recherché (accents/ponctuation/casse ignorés pour la comparaison) — évite d'hériter
  de la jaquette d'un autre jeu de la même franchise.
- Import : n'accepte que les extensions de ROM réellement ouvrables par l'émulateur de la console ; un paquet PS Vita
  en .zip (eboot.bin + sce_sys/) est importé tel quel, sans être extrait comme une archive de ROM classique.
- Corrigé : melonDS pouvait planter à l'installation, au tout premier lancement d'un jeu DS (`toml::serializer: an
  implicit table cannot have non-table value`), en repassant ensuite normalement au lancement suivant.
- Dolphin (GameCube/Wii) : lancement et chargements accélérés (vitesse de lecture disque simulée plus rapide,
  particulièrement sensible sur Wii) ; les rares jeux qui en auraient besoin sont détectés automatiquement (un jeu
  qui plante au lancement est retenté une fois sans ce réglage) et exemptés durablement, sans intervention.

## 0.1.7

- Thème clair ajouté, détecté automatiquement depuis Windows ou choisi manuellement (Paramètres → Apparence → Thème :
  Automatique / Clair / Sombre). Le thème suit Windows en direct si vous le changez pendant que RomVault tourne.
- Corrigé : dans la Bibliothèque bien remplie, la dernière rangée de jeux pouvait passer par-dessus la barre d'état
  en bas de la fenêtre.
- Fiches BIOS/firmware/clés allégées : le détail technique (nom de fichier, taille) n'est plus affiché en clair sur
  chaque ligne, mais dans une icône ⓘ à côté — au survol, et copiable en un clic.
- Sélection de texte dans ces fiches limitée au texte utile (plus d'icônes ou de texte d'intro sélectionnés par erreur).
- Mises à jour et DLC Switch : détectés à l'import et refusés avec un message clair (à installer soi-même dans
  l'émulateur via son menu « Install Files to NAND… »), plutôt que mal identifiés comme un jeu à part.
- Corrigé : le badge de mise à jour en haut à droite redirigeait vers les paramètres généraux au lieu d'ouvrir
  directement « À propos », là où se fait la mise à jour.
- Corrigé : en mode Big Picture, les jaquettes des jeux laissaient un écart de chaque côté au lieu de remplir
  la tuile comme en mode classique.

## 0.1.6

- Mises à jour visibles partout, et changelog affiché après une installation.
- Accent violet et jaquettes adaptées au format des vignettes.
- Extensions de ROM acceptées précisées, avertissement pour les émulateurs en rodage.
- Temps de jeu affiché sur la fiche.
- Manette prise en charge pour Eden ; clés Azahar plus obligatoires.
- Filtre du catalogue Switch corrigé (des jeux complets comme Mario Kart 8 Deluxe étaient à tort exclus).
- Catalogue resynchronisé tout seul après une mise à jour, et jeux déjà importés reliés à leur fiche dès qu'elle apparaît.
- Changelog affiché même après une installation manuelle (pas seulement via la mise à jour automatique).
- Barre de progression fantôme au bas de la fenêtre pendant l'installation d'un émulateur, corrigée.
- Corrigé : la resynchro du catalogue ci-dessus changeait l'identifiant de chaque jeu à chaque fois, ce qui déliait
  toute la bibliothèque déjà importée (les jeux avaient l'air d'avoir disparu). Si ça vous est arrivé avec cette
  version, un clic sur « Actualiser » dans le Catalogue répare les jeux concernés sans rien réimporter.

## 0.1.5

- Import ZIP d'un disque en .cue + .bin.
- Diagnostic plus clair quand le lancement d'un jeu échoue.
- Langue DuckStation prise en compte.

## 0.1.4

- Clés Cemu et Azahar.
- Réglages automatiques Cemu et melonDS.
- Mode fenêtré et Big Picture.

## 0.1.3

- Corrections et stabilisation.

## 0.1.2

- Installation par machine (Program Files, dossier de données inscriptible).
- Réglages sans clé de catalogue (proxy).
