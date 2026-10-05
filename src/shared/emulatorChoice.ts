import { customEmulatorAccepts, isCustomEmulatorId, type CustomEmulator } from './customEmulators'
import { EMULATORS, emulatorById, type EmulatorDef } from './emulators'

/** Émulateur retenu pour lancer un jeu : un des émulateurs intégrés (installés par Kartouche) ou un émulateur ajouté par l'utilisateur. */
export type EmulatorChoice = { kind: 'builtin'; def: EmulatorDef } | { kind: 'custom'; emulator: CustomEmulator }

export interface ChoiceContext {
  console: string
  /** Chemin ou nom du fichier du jeu : sert à vérifier l'extension acceptée par un émulateur personnalisé. */
  file: string
  /** Choix fait pour CE jeu (`library.emulator_id`), null si aucun. */
  entryChoice: string | null
  /** Émulateur par défaut de chaque console (réglage `emulatorDefaults`). */
  defaults: Record<string, string>
  customs: readonly CustomEmulator[]
}

/** Cet identifiant désigne-t-il un émulateur capable de lancer ce jeu ? Renvoie le choix correspondant, ou null. */
export function resolveEmulatorId(id: string | null | undefined, ctx: Pick<ChoiceContext, 'console' | 'file' | 'customs'>): EmulatorChoice | null {
  if (!id) return null
  if (isCustomEmulatorId(id)) {
    const emulator = ctx.customs.find((e) => e.id === id)
    return emulator && customEmulatorAccepts(emulator, ctx.console, ctx.file) ? { kind: 'custom', emulator } : null
  }
  const def = emulatorById(id)
  return def && def.consoles.includes(ctx.console) ? { kind: 'builtin', def } : null
}

/**
 * Quel émulateur lance ce jeu ? Dans l'ordre : celui choisi pour le jeu, celui par défaut de sa console, l'émulateur intégré de la console, puis le premier
 * émulateur personnalisé qui sait la lancer. Un choix devenu invalide (émulateur supprimé, console non gérée, extension refusée) est ignoré, jamais une erreur :
 * on retombe sur l'étape suivante. Null si rien ne sait lancer ce jeu.
 */
export function chooseEmulator(ctx: ChoiceContext): EmulatorChoice | null {
  return resolveEmulatorId(ctx.entryChoice, ctx)
    ?? resolveEmulatorId(ctx.defaults[ctx.console], ctx)
    ?? ((): EmulatorChoice | null => { const def = EMULATORS.find((e) => e.consoles.includes(ctx.console)); return def ? { kind: 'builtin', def } : null })()
    ?? ((): EmulatorChoice | null => { const emulator = ctx.customs.find((e) => customEmulatorAccepts(e, ctx.console, ctx.file)); return emulator ? { kind: 'custom', emulator } : null })()
}

export interface EmulatorOption { id: string; name: string; kind: 'builtin' | 'custom' }

/** Tous les émulateurs qui savent lancer ce jeu (pour « Jouer avec… »), l'intégré d'abord. */
export function emulatorOptions(ctx: Pick<ChoiceContext, 'console' | 'file' | 'customs'>): EmulatorOption[] {
  const builtin = EMULATORS.filter((e) => e.consoles.includes(ctx.console)).map((e): EmulatorOption => ({ id: e.id, name: e.name, kind: 'builtin' }))
  const custom = ctx.customs.filter((e) => customEmulatorAccepts(e, ctx.console, ctx.file)).map((e): EmulatorOption => ({ id: e.id, name: e.name, kind: 'custom' }))
  return [...builtin, ...custom]
}
