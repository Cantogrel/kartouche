import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'

// Liaisons SDL de la manette PlayStation de DuckStation (settings.ini) et PCSX2 (inis/PCSX2.ini), un joueur par port (deux ports). Une manette = « SDL-n » (voir sdlOrder.ts) ; une clé répétée
// = plusieurs liaisons. Seules les lignes « SDL-n/… » sont réécrites, le clavier et le reste du fichier restent tels quels.

/** Liaisons du joueur sur la manette SDL 0, dans les noms que DuckStation et PCSX2 ont en commun (les boutons de face diffèrent, voir `PS_FACE`). */
const SDL_NAMES: Record<string, string> = {
  Up: 'SDL-0/DPadUp', Down: 'SDL-0/DPadDown', Left: 'SDL-0/DPadLeft', Right: 'SDL-0/DPadRight', Select: 'SDL-0/Back', Start: 'SDL-0/Start',
  L1: 'SDL-0/LeftShoulder', R1: 'SDL-0/RightShoulder', L2: 'SDL-0/+LeftTrigger', R2: 'SDL-0/+RightTrigger', L3: 'SDL-0/LeftStick', R3: 'SDL-0/RightStick',
  LUp: 'SDL-0/-LeftY', LDown: 'SDL-0/+LeftY', LLeft: 'SDL-0/-LeftX', LRight: 'SDL-0/+LeftX',
  RUp: 'SDL-0/-RightY', RDown: 'SDL-0/+RightY', RLeft: 'SDL-0/-RightX', RRight: 'SDL-0/+RightX'
}

/** Noms SDL des boutons de face : DuckStation parle de A/B/X/Y, PCSX2 (qui refuse ces noms : « Invalid binding ») de FaceSouth/East/West/North. */
const PS_FACE: Record<'duckstation' | 'pcsx2', Record<string, string>> = {
  duckstation: { Cross: 'A', Circle: 'B', Square: 'X', Triangle: 'Y' },
  pcsx2: { Cross: 'FaceSouth', Circle: 'FaceEast', Square: 'FaceWest', Triangle: 'FaceNorth' }
}
/** Paire de Joy-Con sur DuckStation : croix/rond et carré/triangle sont inversés (SDL3 donne A et B dans l'autre sens : constaté sur le matériel). */
const SWAPPED: Record<string, string> = { Cross: 'Circle', Circle: 'Cross', Square: 'Triangle', Triangle: 'Square' }

/** Les quatre premières manettes SDL : « n'importe laquelle » (un seul joueur, ou numéros inconnus). */
export const ANY_SDL = [0, 1, 2, 3]

/** Un joueur de la manette PlayStation : les numéros « SDL-n » à lire, et le type de sa manette (vibration retirée pour une manette Nintendo, boutons de face échangés pour la paire). */
export interface PsPlayer { indexes: number[]; nintendo: boolean; swapFace: boolean }

/**
 * Réécrit les liaisons SDL d'une section [PadN]. `p` = null : port sans manette (`Type = None`). Une section qu'un utilisateur a retouchée (autre chose que clavier et « SDL-n ») n'est jamais
 * touchée ; créée, sans clavier, quand elle n'existe pas et qu'il y a un joueur (`type` = type de manette du port 1).
 */
export function rebuildPsPad(text: string, section: string, emulator: 'duckstation' | 'pcsx2', p: PsPlayer | null, type: string | null): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const head = lines.findIndex((l) => l.trim() === `[${section}]`)
  if (head < 0 && !p) return text
  let end = head < 0 ? lines.length : lines.findIndex((l, i) => i > head && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  const body = head < 0 ? [] : lines.slice(head + 1, end)
  const ours = body.every((l) => l.trim() === '' || /^Type\s*=/.test(l) || /^\w+\s*=\s*(Keyboard\/\S*|SDL-\d+\/[+-]?\w+|)\s*$/.test(l))
  if (!ours) return text
  const kept = body.filter((l) => l.trim() !== '' && !/^\s*\w+\s*=\s*SDL-\d+\//.test(l) && !/^\s*(LargeMotor|SmallMotor)\s*=/.test(l))
  const out: string[] = []
  if (!p) {
    out.push(...kept.filter((l) => !/^Type\s*=/.test(l)), 'Type = None')
  } else {
    const typeLine = kept.find((l) => /^Type\s*=/.test(l))
    // « Type = None » (port laissé vide par un lancement précédent) redevient le type de manette du port 1.
    const rest = typeLine && /^Type\s*=\s*None\s*$/.test(typeLine) && type ? kept.filter((l) => l !== typeLine) : kept
    if ((!typeLine || rest !== kept) && type) out.push(`Type = ${type}`)
    out.push(...rest)
    const face = PS_FACE[emulator]
    const write = (key: string, value: string): void => { for (const i of p.indexes) out.push(`${key} = ${value.replace('SDL-0', `SDL-${i}`)}`) }
    for (const [key, value] of Object.entries(SDL_NAMES)) write(key, value)
    for (const key of Object.keys(face)) write(key, `SDL-0/${face[p.swapFace ? SWAPPED[key] : key]}`)
    // Vibration : retirée pour une manette Nintendo (gênante sur les jeux Sony), sinon sur la manette du joueur.
    out.push(`LargeMotor = ${p.nintendo ? '' : `SDL-${p.indexes[0]}/LargeMotor`}`, `SmallMotor = ${p.nintendo ? '' : `SDL-${p.indexes[0]}/SmallMotor`}`)
  }
  const block = [`[${section}]`, ...out]
  if (head < 0) {
    const base = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    return [...base, '', ...block, ''].join(nl)
  }
  return [...lines.slice(0, head), ...block, ...(end < lines.length ? [''] : []), ...lines.slice(end)].join(nl)
}

/**
 * Une manette par joueur (deux ports). Un seul joueur : le joueur 1 lit « n'importe laquelle des quatre premières » (comme avant), le port 2 est vide. Plusieurs joueurs : chacun lit SA manette
 * (`SDL-n`), le clavier reste au joueur 1.
 */
export async function applyPsPlayers(file: string, emulator: 'duckstation' | 'pcsx2', players: readonly PsPlayer[]): Promise<void> {
  if (!existsSync(file)) return
  const text = await readFile(file, 'utf8')
  if (!text) return
  const multi = players.length >= 2
  const first: PsPlayer = players[0] ?? { indexes: ANY_SDL, nintendo: false, swapFace: false }
  let next = rebuildPsPad(text, 'Pad1', emulator, multi ? first : { ...first, indexes: ANY_SDL }, null)
  const tail = next.split(/\r?\n/)
  const at = tail.findIndex((l) => l.trim() === '[Pad1]')
  const type = at < 0 ? null : (/^Type\s*=\s*(\w+)\s*$/m.exec(tail.slice(at, at + 40).join('\n'))?.[1] ?? null)
  next = rebuildPsPad(next, 'Pad2', emulator, multi ? players[1] : null, type && type !== 'None' ? type : null)
  if (next !== text) await writeFile(file, next)
}
