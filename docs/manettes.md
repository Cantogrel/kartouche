# Manettes : détection, joueurs, Nintendo

État réel de la prise en charge des manettes dans Kartouche. Ce qui est écrit ici a été vérifié sur du matériel réel (Xbox One filaire, Switch Pro, paire de Joy-Con en Bluetooth) ; ce qui ne l'est pas est dit.
Relevés détaillés (formats de config, octets des rapports HID) : vault Obsidian, `projects/romvault/manettes-nintendo-phase0`.

## Détection (`src/main/emulators/padWatch.ts`, `padList.ts`)

- **Liste en direct** (Paramètres → Émulation et manette, Paramètres du Big Picture) : XInput (emplacements 0 à 3) + `RawGameController` de Windows, sans qu'il faille appuyer sur un bouton. Chaque manette est interprétée : manette XInput, Switch Pro, Joy-Con seul (gauche ou droit), paire de Joy-Con (gauche + droit = une seule manette).
- Une Xbox listée à la fois en XInput et en HID n'apparaît qu'une fois (appariement par constructeur : XInput expose l'interface 045E:02FF, Windows l'identité réelle 045E:02EA).
- **Manettes Nintendo** : pas du XInput. Lecture HID brute des rapports `0x30` (sans focus, sans initialisation), pour l'activité, la présence et la combinaison de fermeture.
- `HID_PADS_SCRIPT` (détection « une manette quelconque ») utilise encore `-PresentOnly` : un Joy-Con appairé mais endormi y compte comme branché. À corriger avec l'état `IsConnected` si cela devient un problème.

## Dernière manette utilisée (`padChoice.ts`)

- Le **joueur 1** est la dernière manette sur laquelle on a appuyé, toutes familles confondues (XInput par emplacement, Nintendo par PID), sinon XInput, Switch Pro, paire de Joy-Con, Joy-Con seul.
- **Les appuis ne comptent pas pendant qu'un jeu tourne** (`setPadActivityGate`) : à plusieurs, le joueur 2 qui appuie en pleine partie ne devient pas joueur 1 au lancement suivant ; le joueur 1 est la manette qui a servi à naviguer dans Kartouche pour lancer le jeu.

## Fermer un jeu à la manette

Retour + Start (XInput) ou **Moins + Plus** maintenus 1,5 s : sur la Switch Pro, ou Moins du Joy-Con gauche + Plus du Joy-Con droit. Un Joy-Con seul n'a pas de combinaison (SL/SR servent en jeu) : utiliser Ctrl + Alt + Q ou le bouton « Fermer le jeu ».

## Eden (`edenPads.ts`, `edenChoice.ts`, `configure.ts`)

- **Une manette par joueur**, assignée au lancement : joueur 1 = la dernière utilisée, les autres manettes détectées prennent les joueurs 2 à 8 dans un ordre stable (XInput par emplacement, Switch Pro, paires de Joy-Con, Joy-Con gauches seuls, Joy-Con droits seuls). Une paire de Joy-Con = une manette ; le rang (`port`) départage plusieurs manettes identiques.
- Profils d'après les formats qu'Eden 0.2.1 écrit lui-même : pilote Joy-Con propre à Eden (`engine:joycon`) pour les Joy-Con, SDL HIDAPI (`…6803`) pour la Switch Pro, SDL XInput comme avant. Le profil du joueur 2 et suivants n'est que le profil du joueur 1 sous d'autres clés ; vérifié contre un relevé réel du joueur 2 (Joy-Con droit seul).
- Un joueur configuré à la main dans Eden n'est jamais réécrit ; les autres le sont. La touche par défaut qu'Eden réécrit lui-même à sa première sauvegarde (`engine:keyboard,code:67`) ne compte pas comme un réglage de l'utilisateur.
- Eden refait toutes les manettes lui-même si on **désactive** son applet Contrôleur (journal : « deducing the best configuration ») : Kartouche ne la désactive donc jamais. À la place, `autoConfirmEdenApplet` (`quit.ts`) clique « OK » dans la vraie applet, repérée par l'identifiant UI Automation de son bouton (indépendant de la langue ; OK = bouton le plus à gauche). Si le jeu refuse la configuration (Paper Mario avec un Joy-Con seul), OK reste grisé : la fenêtre reste affichée.
- **Joy-Con seul** : vrai « Joy-Con seul » pour Eden (le jeu décide de l'orientation). Un jeu qui refuse ce type (Paper Mario) le lit comme une moitié de paire. Pas de conversion en Pro de côté (décision de l'utilisateur).

### Limites connues

- **Les manettes sont assignées une fois, au lancement.** Brancher ou allumer une manette pendant une partie ne change pas les touches (Eden peut changer le type de manette de lui-même, mais pas ses liaisons) : fermer le jeu et le relancer.
- Non testé : GUID de la Switch Pro en USB (relevé en Bluetooth seulement), deux manettes identiques (ports), plus de trois joueurs.
- Joy-Con séparés en deux joueurs : pas géré (une paire est toujours une seule manette).

## Autres émulateurs

Le principe (une manette par joueur, joueur 1 = dernière utilisée) est voulu pour tous. Aujourd'hui seul Eden le met en œuvre ; Dolphin (Wiimote avec Joy-Con : un Joy-Con droit = Wiimote, la paire = Wiimote + Nunchuk, pointage par gyroscope validé en configuration manuelle) et les autres émulateurs restent à faire.
