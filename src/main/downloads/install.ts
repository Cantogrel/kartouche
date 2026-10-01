import type { DatabaseSync } from 'node:sqlite'
import type { AppPaths } from '@shared/ipc'
import { identify } from '../library/identify'
import { importPaths, prepare } from '../library/importer'
import { hashFile } from '../library/hash'

export interface InstallResult {
  ok: boolean
  error?: string
}

/**
 * Vérifie qu'un fichier téléchargé pour `sourceId` correspond, par hash, au jeu attendu avant de l'installer —
 * jamais d'installation silencieuse sur un hash qui ne correspond pas (P05-S1). Deux hash de référence possibles :
 * 1) celui du catalogue (DAT No-Intro/Redump officiel) → match 'hash', le cas normal ; 2) à défaut, celui que LA
 * LISTE DE SOURCES elle-même a déclaré pour cette entrée (`sources.crc`/`sha1`, posé à l'import de la liste) →
 * match 'source'. Le second cas couvre les ROMs volontairement modifiées (patch anti-piratage, traduction…) dont le
 * hash ne correspondra JAMAIS au dump d'origine : on fait alors confiance à l'auteur de la liste pour le contenu
 * (sous sa responsabilité, comme toute liste ajoutée par l'utilisateur), mais seulement après avoir vérifié que le
 * fichier reçu est bien celui que cette liste a annoncé — jamais une simple confiance au nom de fichier.
 *
 * Le hash déclaré par une liste porte sur le FICHIER TEL QUE TÉLÉCHARGÉ (le .zip lui-même quand l'archive en est un),
 * pas sur la ROM qu'il contient une fois extraite — vérifié en comparant le hash du .zip brut d'un vrai téléchargement
 * au hash déclaré par `nds_apfix.romvault.json` : identiques, alors que le hash de la ROM extraite (`prep.crc`, celui
 * que compare `identify()` contre le DAT officiel) diffère toujours. D'où un second calcul de hash sur le fichier brut
 * (`hashFile`, pas `prepare()`) pour cette comparaison précise. Réutilise le pipeline d'import existant (Phase 4,
 * `importPaths`) pour la copie et l'enregistrement en bibliothèque.
 */
export async function installDownload(db: DatabaseSync, sourceId: number, file: string, paths: AppPaths): Promise<InstallResult> {
  const source = db.prepare('SELECT game_id, console, title, crc, sha1 FROM sources WHERE id = ?').get(sourceId) as
    { game_id: number | null; console: string; title: string; crc: string | null; sha1: string | null } | undefined
  if (!source) return { ok: false, error: 'source introuvable' }
  if (source.game_id === null) return { ok: false, error: 'aucun jeu du catalogue associé à cette source' }

  const prep = await prepare(file, [])
  if (typeof prep === 'string') return { ok: false, error: prep }

  const identified = identify(db, prep)
  if (identified.match === 'hash' && identified.gameId === source.game_id) {
    const result = await importPaths(db, [file], { copy: true, deleteSource: true, romsDir: paths.roms })
    const item = result.items[0]
    if (!item || item.status === 'error') return { ok: false, error: item?.error ?? "échec de l'installation" }
    return { ok: true }
  }

  const raw = await hashFile(file)
  const declaredMatch = (source.crc && source.crc.toUpperCase() === raw.crc.toUpperCase())
    || (source.sha1 && source.sha1.toUpperCase() === raw.sha1.toUpperCase())
  if (!declaredMatch) {
    return { ok: false, error: 'le fichier téléchargé ne correspond pas au jeu attendu (hash différent du catalogue et de la liste de sources)' }
  }

  const result = await importPaths(db, [file], {
    copy: true, deleteSource: true, romsDir: paths.roms,
    expected: { gameId: source.game_id, console: source.console, title: source.title, match: 'source' }
  })
  const item = result.items[0]
  if (!item || item.status === 'error') return { ok: false, error: item?.error ?? "échec de l'installation" }
  return { ok: true }
}
