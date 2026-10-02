import type { Gpu, GpuTier } from './gpu'

// Réglages Vita3K qui dépendent du matériel et du jeu. Données pures : configure.ts les écrit dans `config.yml` (que Vita3K crée lui-même au premier démarrage,
// puis fusion : jamais d'écrasement des réglages de l'utilisateur). Vérifié sur Vita3K v0.2.1 (4102) lancé avec un vrai jeu (journal détaillé).
//
// Fichiers et mécanismes :
// - `config.yml` (dossier de l'exécutable) : configuration globale. Vita3K en génère un complet avec ses défauts (Vulkan, GPU automatique `gpu-idx: 0`, cache de shaders
//   et compilation asynchrone des pipelines actifs, audio SDL au volume 100 sur le périphérique par défaut) ;
// - `<pref-path>/config/config_<TITLE_ID>.xml` : réglages par jeu natifs (« Custom config » de Vita3K), créés seulement pour une exception connue ;
// - manettes : Vita3K détecte seul les manettes SDL au lancement d'un jeu (journal : « 1 Controllers Connected — Controller 0: Xbox One Controller », y compris le pad
//   virtuel de Sunshine/Moonlight) ; `controller-binds` / `controller-axis-binds` sont des positions SDL par défaut, déjà A = Croix, B = Rond, X = Carré, Y = Triangle.
//   Le clavier (touches `keyboard-*`) et la souris (tactile avant) fonctionnent en parallèle ; `keyboard-gui-toggle-touch` (T) bascule le tactile avant/arrière.
//   Rien de cela n'est écrit : les défauts de Vita3K sont déjà ceux demandés.

/** Hauteur de l'image de la Vita (544 lignes) : un facteur n rend 544 n lignes. */
const VITA_HEIGHT = 544

/** Facteur maximal par niveau de GPU (Vita3K va jusqu'à 8x). */
const TIER_MAX_SCALE: Record<GpuTier, number> = { igpu: 1, low: 2, mid: 3, high: 8 }

/** Facteur de résolution : le plus petit qui remplit la hauteur de l'écran (2x sur 1080p, 3x sur 1440p, 4x sur 4K), borné par le GPU. */
export const vita3kScale = (gpu: Gpu, displayHeight: number): number =>
  Math.max(1, Math.min(TIER_MAX_SCALE[gpu.tier], Math.ceil((displayHeight * 0.95) / VITA_HEIGHT)))

/**
 * Clés de `config.yml` liées au matériel : Vulkan (OpenGL en repli) et résolution entière adaptée à l'écran et au GPU. Le GPU reste en choix automatique (`gpu-idx: 0` :
 * Vita3K prend le GPU dédié, vérifié sur une machine à trois GPU) ; cache de shaders, compilation asynchrone, filtre bilinéaire et ratio d'origine sont ses défauts.
 */
export const vita3kRenderer = (gpu: Gpu, displayHeight: number): Record<string, string | number | boolean> => ({
  'backend-renderer': gpu.vulkan ? 'Vulkan' : 'OpenGL',
  'resolution-multiplier': vita3kScale(gpu, displayHeight)
})

// --- Réglages par jeu : volontairement aucun ---------------------------------------------------------------------------
//
// Vérifié sur v0.2.1 : la « Custom config » native (`config/config_<TITLE_ID>.xml`, sections core/cpu/gpu/audio/emulator/network, une valeur par attribut) REMPLACE la
// configuration au lieu de la fusionner (une clé absente vaut 0 ou vide), est ignorée en silence dès qu'une valeur est invalide (ex. `screen-filter="Bilinear"`), et
// **Vita3K réécrit ensuite le config.yml global avec ses valeurs** à la fermeture : l'exception d'un jeu fuit chez tous les autres. Aucun fichier de ce genre n'est donc
// généré. Le mécanisme sûr, si une exception est un jour confirmée, est un fichier `.yml` complet par jeu lancé avec `-c <fichier>.yml -w` (« ne pas modifier la
// configuration après chargement »).
