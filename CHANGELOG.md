# Changelog

Notes affichées dans l'app après une mise à jour (Paramètres → À propos → Voir le changelog).
Une section `## <version>` par version ; le texte est repris tel quel dans le popup.

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
