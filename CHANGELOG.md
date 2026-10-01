# Changelog

Notes affichées dans l'app après une mise à jour (Paramètres → À propos → Voir le changelog).
Une section `## <version>` par version ; le texte est repris tel quel dans le popup.

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
