# Guide Kartouche 0.3.0 — personnalisation et intégration

## Modifier un jeu
Bibliothèque → clic droit → **Modifier…** (ou ✎ sur la fiche). Une valeur vide rétablit l'origine. Les modifications sont une
surcouche : l'identification, le téléchargement et la fiche du catalogue ne changent pas.

## Exécutables locaux
Glissez un `.exe`, `.bat`, `.cmd` ou `.lnk` dans la bibliothèque (ou « Ajouter un jeu »). L'icône et le titre sont déduits ;
les champs de lancement se changent dans Modifier. Kartouche ne supprime jamais les fichiers d'une entrée de ce type.

## Émulateurs personnalisés
Émulateurs → **Mes émulateurs**. Kartouche ne les installe ni ne les configure : il les lance avec vos arguments.

| Jeton | Remplacé par |
| --- | --- |
| `{rom}` | chemin complet du fichier |
| `{dir}` | dossier du fichier |
| `{file}` | nom du fichier |
| `{name}` | nom sans extension |
| `{console}` | identifiant de la console |

Modèle par défaut : `"{rom}"`. Ordre de choix d'un émulateur : celui du jeu (« Jouer avec… »), puis celui de la console, puis l'intégré.

## Launchers
Paramètres → **Launchers**. Rien n'est lu tant que vous n'activez pas un launcher. Détectés : Steam, Epic, GOG, Hydra,
Xbox, EA app, Ubisoft Connect, Battle.net, itch.io (jeux installés uniquement). Aucun identifiant de compte n'est lu ni
stocké, aucun réseau n'est utilisé pour la détection. Les jeux disparus restent dans la bibliothèque, sans fichier.
Jouer passe par le launcher d'origine, avec repli sur l'exécutable.

## Accueil et apparence
Paramètres → Apparence : blocs de l'accueil (ordre, masquage), accent, arrondi, contraste renforcé, thème clair/sombre,
export/import de thème.

## Ajouter une langue
Paramètres → Langue : exportez le modèle (toutes les clés de l'anglais), traduisez les valeurs, puis importez le fichier.
Format :

```json
{ "format": "kartouche.lang/v1", "code": "nl", "name": "Nederlands", "strings": { "clé": "texte" } }
```

Le code est en minuscules (`pt-br`, `nl`) et ne peut pas reprendre une langue intégrée. Gardez les variables `{x}`
telles quelles. Une clé absente retombe sur l'anglais. Fichiers stockés dans `<données>\languages\`.

## Mise à jour depuis RomVault
Rien à faire : l'installateur reprend le dossier d'installation et les données. Ne déplacez pas ce dossier (la base
et les configurations d'émulateurs contiennent des chemins absolus). Voir `docs/rename-kartouche.md`.
