import type { DatabaseSync } from 'node:sqlite'
import { rm } from 'node:fs/promises'
import type { AppPaths } from '@shared/ipc'
import type { MatchKind } from '@shared/library'
import { archiveVolume, cleanupWorkDir, newWorkDir, unpackArchive } from '../library/archive'
import { identify } from '../library/identify'
import { importPaths, prepare } from '../library/importer'
import { hashFile } from '../library/hash'

export interface InstallResult {
  ok: boolean
  error?: string
}

/**
 * Installe un fichier téléchargé pour `sourceId`, avec le meilleur niveau de confiance possible — jamais d'échec
 * silencieux : toute exception (fichier verrouillé, disque plein…) est convertie en erreur renvoyée plutôt que de
 * remonter telle quelle, pour que l'UI puisse toujours l'afficher. Trois niveaux, du meilleur au moins bon :
 * 1) `hash` — empreinte identique au DAT officiel du catalogue (cas normal).
 * 2) `source` — à défaut, empreinte identique à celle que LA LISTE DE SOURCES elle-même a déclarée pour cette
 *    entrée (`sources.crc`/`sha1`, posée à l'import de la liste). Couvre les ROMs volontairement modifiées (patch
 *    anti-piratage, traduction…) dont le hash ne correspondra JAMAIS au dump d'origine.
 * 3) `unverified` — ni l'un ni l'autre (liste sans hash déclaré pour cette entrée — le cas le plus courant en
 *    pratique —, ou hash déclaré qui ne correspond pas) : installé quand même, rattaché au jeu que LA LISTE a déjà
 *    associé à cette entrée au moment de son import (rapprochement par titre, voir sources/import.ts). Cette
 *    association existe déjà qu'on puisse ou non vérifier le contenu par hash, et la liste reste de toute façon
 *    sous la responsabilité de son auteur, comme toute liste ajoutée par l'utilisateur (voir CLAUDE.md).
 *    Seule exception bloquante : l'empreinte officielle identifie sans ambiguïté un AUTRE jeu du catalogue que
 *    celui attendu — une preuve contraire positive, pas une simple absence de preuve, donc refusée.
 *
 * Le hash déclaré par une liste porte sur le FICHIER TEL QUE TÉLÉCHARGÉ (le .zip lui-même quand l'archive en est un),
 * pas sur la ROM qu'il contient une fois extraite — vérifié en comparant le hash du .zip brut d'un vrai téléchargement
 * au hash déclaré par `nds_apfix.romvault.json` : identiques, alors que le hash de la ROM extraite (`prep.crc`, celui
 * que compare `identify()` contre le DAT officiel) diffère toujours. D'où un second calcul de hash sur le fichier brut
 * (`hashFile`, pas `prepare()`) pour cette comparaison précise. Même règle pour une archive .7z/.rar : le hash déclaré porte
 * sur l'archive téléchargée, la ROM qu'elle contient est extraite (voir library/archive.ts) puis identifiée comme un fichier
 * ordinaire — une seule ROM, ou un .cue/paquet Vita reconditionné en .zip ; plusieurs ROM différentes sont refusées. Réutilise le pipeline d'import existant (Phase 4,
 * `importPaths`) pour la copie et l'enregistrement en bibliothèque.
 */
export async function installDownload(db: DatabaseSync, sourceId: number, download: string, paths: AppPaths): Promise<InstallResult> {
  let workDir: string | null = null
  try {
    const source = db.prepare('SELECT game_id, console, title, crc, sha1 FROM sources WHERE id = ?').get(sourceId) as
      { game_id: number | null; console: string; title: string; crc: string | null; sha1: string | null } | undefined
    if (!source) return { ok: false, error: 'source introuvable' }
    if (source.game_id === null) return { ok: false, error: 'aucun jeu du catalogue associé à cette source' }

    // Archive .7z/.rar : le hash déclaré par la liste porte sur le fichier téléchargé, donc calculé AVANT l'extraction.
    let file = download
    let rawHash: Awaited<ReturnType<typeof hashFile>> | null = null
    let volumes: string[] = []
    if (archiveVolume(download)) {
      rawHash = await hashFile(download)
      workDir = newWorkDir(paths.roms, `dl${sourceId}`)
      const unpacked = await unpackArchive(download, workDir)
      if (typeof unpacked === 'string') return { ok: false, error: unpacked }
      file = unpacked.file
      volumes = unpacked.volumes
    }

    const prep = await prepare(file, [])
    if (typeof prep === 'string') return { ok: false, error: prep }

    const identified = identify(db, prep)
    let match: Extract<MatchKind, 'hash' | 'source' | 'unverified'>
    if (identified.match === 'hash' && identified.gameId === source.game_id) {
      match = 'hash'
    } else if (identified.match === 'hash' && identified.gameId !== null) {
      return { ok: false, error: 'le fichier téléchargé correspond, par empreinte officielle, à un autre jeu du catalogue que celui attendu' }
    } else {
      const raw = rawHash ?? await hashFile(file)
      const declaredMatch = (source.crc && source.crc.toUpperCase() === raw.crc.toUpperCase())
        || (source.sha1 && source.sha1.toUpperCase() === raw.sha1.toUpperCase())
      match = declaredMatch ? 'source' : 'unverified'
    }

    const opts = { copy: true, deleteSource: true, romsDir: paths.roms, owned: file !== download }
    const result = await importPaths(db, [file], match === 'hash'
      ? opts
      : { ...opts, expected: { gameId: source.game_id, console: source.console, title: source.title, match } })
    const item = result.items[0]
    if (!item || item.status === 'error') return { ok: false, error: item?.error ?? "échec de l'installation" }
    for (const v of volumes) await rm(v, { force: true }).catch(() => undefined)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    if (workDir) await cleanupWorkDir(workDir)
  }
}
