import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import { BIOS_SLOTS, type BiosImportResult } from '@shared/bios'
import type { EmulatorProgress } from '@shared/emulators'
import type { AppPaths } from '@shared/ipc'
import { download } from '../emulators/installer'
import { importBiosFile } from './bios'

/**
 * Sources officielles des firmwares que Sony distribue gratuitement (les émulateurs eux-mêmes renvoient vers elles).
 * Chaque liste de mise à jour donne l'adresse du dernier firmware ; on n'écrit donc aucune version en dur.
 */
export const OFFICIAL_FIRMWARE: Record<string, { lists: string[]; file: RegExp; name: string }> = {
  // Liste de mise à jour utilisée par les consoles, puis page de téléchargement officielle de Sony (repli).
  ps3: { lists: ['http://f01.ps3.update.playstation.net/update/ps3/list/us/ps3-updatelist.txt', 'https://www.playstation.com/en-us/support/hardware/ps3/system-software/'], file: /(https?:\/\/[^\s;<>"']+PS3UPDAT\.PUP)/i, name: 'PS3UPDAT.PUP' },
  vita: { lists: ['https://fus01.psp2.update.playstation.net/update/psp2/list/us/psp2-updatelist.xml', 'https://www.playstation.com/en-us/support/hardware/psvita/system-software/'], file: /(https?:\/\/[^\s;<>"']+PSVUPDAT\.PUP)/i, name: 'PSVUPDAT.PUP' }
}

/** Adresse du firmware complet dans le texte d'une liste de mise à jour ; null si absente. */
export const parseFirmwareUrl = (slotId: string, text: string): string | null => {
  const o = OFFICIAL_FIRMWARE[slotId]
  return o ? o.file.exec(text)?.[1] ?? null : null
}

/** « fetch failed » seul ne dit rien : on y ajoute la cause réseau (ENOTFOUND, ECONNRESET, certificat…). */
const errorText = (e: unknown): string => {
  const c = (e as { cause?: { code?: string; message?: string } }).cause
  return `${e instanceof Error ? e.message : String(e)}${c ? ` (${c.code ?? c.message})` : ''}`
}

const UA = 'PS3Update-agent/1.0.0 libhttp/1.0.0'

/** Télécharge le firmware de l'émulateur depuis la source officielle, puis l'installe comme un fichier importé (mêmes contrôles). */
export async function autoInstallFirmware(ctx: { db: DatabaseSync; paths: AppPaths }, emulator: string, report: (p: EmulatorProgress) => void): Promise<BiosImportResult> {
  const slot = BIOS_SLOTS.find((s) => s.emulator === emulator && s.auto)
  const o = slot && OFFICIAL_FIRMWARE[slot.id]
  if (!slot || !o) return { path: '', ok: false, error: 'unknown' }
  const fail = (detail: string): BiosImportResult => ({ path: '', ok: false, slot: slot.id, error: 'failed', detail })
  const tmp = await mkdtemp(join(tmpdir(), 'rv-fw-'))
  try {
    report({ id: emulator, phase: 'resolve', done: 0, total: 0 })
    let url: string | null = null
    const errors: string[] = []
    for (const list of o.lists) {
      try {
        const res = await fetch(list, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) })
        if (!res.ok) { errors.push(`${new URL(list).host} : HTTP ${res.status}`); continue }
        url = parseFirmwareUrl(slot.id, await res.text())
        if (url) break
        errors.push(`${new URL(list).host} : no link`)
      } catch (e) { errors.push(`${new URL(list).host} : ${errorText(e)}`) }
    }
    if (!url) return fail(errors.join(' ; '))
    const file = join(tmp, o.name)
    await download(url, file, (done, total) => report({ id: emulator, phase: 'download', done, total }), UA)
    report({ id: emulator, phase: 'firmware', done: 0, total: 0 })
    return await importBiosFile(ctx, emulator, file)
  } catch (e) {
    return fail(errorText(e))
  } finally {
    await rm(tmp, { recursive: true, force: true })
    report({ id: emulator, phase: 'done', done: 0, total: 0 })
  }
}
