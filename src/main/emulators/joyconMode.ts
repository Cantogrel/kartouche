// Deux Joy-Con branchés (un gauche, un droit) : assemblés en une seule manette (par défaut), ou séparés en deux Joy-Con seuls (un joueur chacun). Réglage de l'utilisateur
// (Paramètres → Manette), recopié ici par le processus principal : la déduction des manettes (`classifyPads`) et l'environnement SDL des émulateurs le lisent sans passer par la base.
let split = false

export const joyconsSplit = (): boolean => split
export const setJoyconsSplit = (value: boolean): void => { split = value }
