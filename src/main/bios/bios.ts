import type { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { BIOS_SLOTS, fitsSlot, matchBios, needsMd5, type BiosImportResult, type BiosSlot, type BiosSlotStatus } from '@shared/bios'
import { emulatorById } from '@shared/emulators'
import type { AppPaths } from '@shared/ipc'
import { readZip } from '../library/hash'
import { getRow } from '../emulators/emulatorStore'
import { extract } from '../emulators/installer'
import { setTomlKeys } from '../emulators/configure'

export { setTomlKeys }

const md5File = (path: string): Promise<string> => new Promise((resolve, reject) => {
  const h = createHash('md5')
  createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')))
})

const nonEmptyDir = async (dir: string, pred: (name: string) => boolean = () => true): Promise<boolean> => {
  try { return (await readdir(dir)).some(pred) } catch { return false }
}

/** Dossier où Vita3K range ses données (pref-path de son config.yml) ; le firmware y crée `vs0`. */
async function vitaPrefPath(emuDir: string): Promise<string | null> {
  try {
    const m = /^pref-path:\s*(.+?)\s*$/m.exec(await readFile(join(emuDir, 'config.yml'), 'utf8'))
    return m ? m[1].replace(/^["']|["']$/g, '') : null
  } catch { return null }
}

const edenKeys = (dir: string): string => join(dir, 'user', 'keys', 'prod.keys')
const edenRegistered = (dir: string): string => join(dir, 'user', 'nand', 'system', 'Contents', 'registered')

const cemuKeys = (dir: string): string => join(dir, 'keys.txt')
const azaharKeys = (dir: string): string => join(dir, 'user', 'sysdata', 'aes_keys.txt')
const azaharSeeddb = (dir: string): string => join(dir, 'user', 'sysdata', 'seeddb.bin')

// Cemu fournit un fichier keys.txt d'exemple avec cette clé factice (« # example key, can be deleted ») : elle ne déchiffre jamais rien.
const CEMU_PLACEHOLDER_KEY = '541b9889519b27d363cd21604b97c67a'
const HEX32 = /^[0-9a-f]{32}$/i
// Clés minimales pour déchiffrer un jeu 3DS de vente au détail (hors New 3DS exclusif) — https://citra.azahar-emu.org/wiki/aes-keys/
const AZAHAR_REQUIRED_KEYS = ['slot0x25keyx', 'slot0x2ckeyx']
const AZAHAR_KEY_LINE = /^\s*(slot0x[0-9a-f]+key[xyn])\s*=\s*([0-9a-f]{32})\s*$/i

/** Lignes de clé valides d'un keys.txt façon Cemu (un hex 128 bits par ligne, commentaire après `#`), sans la clé d'exemple. */
function parseCemuKeys(text: string): string[] {
  return text.split(/\r?\n/)
    .map((l) => l.split('#')[0].trim().toLowerCase())
    .filter((l) => HEX32.test(l) && l !== CEMU_PLACEHOLDER_KEY)
}

/** Emplacements de clé (slot0x..Key[XYN]) valides d'un aes_keys.txt façon Citra/Azahar. */
function parseAzaharKeys(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = AZAHAR_KEY_LINE.exec(line)
    if (m) found.set(m[1].toLowerCase(), line.trim())
  }
  return found
}

/** Fusionne des lignes « clé » nouvelles dans un fichier existant : remplace celles de même identité, garde le reste (en-têtes, commentaires). */
function mergeKeyLines(existing: string, newLines: string[], identityOf: (line: string) => string | null): string {
  const newIds = new Set(newLines.map(identityOf).filter((k): k is string => k !== null))
  const kept = existing.split(/\r?\n/).filter((l) => { const id = identityOf(l); return id === null || !newIds.has(id) })
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  return [...kept, ...newLines].join('\n') + '\n'
}

interface Ctx { db: DatabaseSync; paths: AppPaths }

/** Présence de chaque fichier attendu. Les emplacements liés au dossier de l'émulateur restent « indisponibles » tant qu'il n'est pas installé. */
export async function biosStatus(ctx: Ctx): Promise<BiosSlotStatus[]> {
  const out: BiosSlotStatus[] = []
  for (const slot of BIOS_SLOTS) {
    const base = { id: slot.id, emulator: slot.emulator, kind: slot.kind, required: slot.required }
    const row = getRow(ctx.db, slot.emulator)
    const dir = row?.dir ?? null
    if (slot.kind === 'bios') {
      const mine = await findBiosFile([join(ctx.paths.bios, slot.emulator)], slot)
      // Sinon : BIOS configuré directement dans l'émulateur, hors du dossier de RomVault.
      const found = mine ?? (row ? await findInEmulator(slot, row.dir, row.custom === 1) : null)
      out.push(found ? { ...base, state: 'ok', unverified: !found.verified, detail: found.label ?? found.name, source: mine ? 'romvault' : 'emulator' } : { ...base, state: 'missing' })
      continue
    }
    if (!dir) { out.push({ ...base, state: 'unavailable' }); continue }
    let ok = false
    if (slot.id === 'ps3') ok = existsSync(join(dir, 'dev_flash', 'sys', 'external', 'liblv2.sprx'))
    else if (slot.id === 'vita') { const p = await vitaPrefPath(dir); ok = !!p && await nonEmptyDir(join(p, 'vs0')) }
    else if (slot.id === 'switch-keys') ok = existsSync(edenKeys(dir))
    else if (slot.id === 'switch-firmware') ok = await nonEmptyDir(edenRegistered(dir), (n) => n.toLowerCase().endsWith('.nca'))
    else if (slot.id === 'wiiu-keys') ok = parseCemuKeys(await readOpt(cemuKeys(dir))).length > 0
    else if (slot.id === '3ds-keys') { const k = parseAzaharKeys(await readOpt(azaharKeys(dir))); ok = AZAHAR_REQUIRED_KEYS.every((id) => k.has(id)) }
    else if (slot.id === '3ds-seeddb') ok = existsSync(azaharSeeddb(dir))
    out.push({ ...base, state: ok ? 'ok' : 'missing' })
  }
  return out
}

interface Found { name: string; path: string; verified: boolean; label?: string }

/** Fichier convenant à l'emplacement (le nom d'origine est conservé : les émulateurs reconnaissent par la somme). */
async function checkFile(path: string, slot: BiosSlot): Promise<Found | null> {
  const name = basename(path)
  const size = (await stat(path).catch(() => null))?.size
  if (size === undefined || !fitsSlot(slot, { name, size })) return null
  if (!slot.md5) return { name, path, verified: true }
  const label = slot.md5[await md5File(path)]
  // Somme inconnue : accepté, mais signalé « non vérifié » (une autre révision du même BIOS, ou un fichier abîmé).
  return label ? { name, path, verified: true, label } : { name, path, verified: false }
}

async function findBiosFile(dirs: string[], slot: BiosSlot): Promise<Found | null> {
  for (const dir of dirs) {
    let names: string[]
    try { names = await readdir(dir) } catch { continue }
    for (const name of names) {
      const r = await checkFile(join(dir, name), slot)
      if (r) return r
    }
  }
  return null
}

/** Valeur d'une clé d'un fichier INI/TOML, sans guillemets ; undefined si absente. */
export function readIniValue(text: string, section: string, key: string): string | undefined {
  let cur = ''
  for (const line of text.split(/\r?\n/)) {
    const h = /^\s*\[(.+?)\]\s*$/.exec(line)
    if (h) { cur = h[1]; continue }
    const kv = /^\s*([^=#;]+?)\s*=\s*(.*?)\s*$/.exec(line)
    if (cur === section && kv && kv[1] === key) return kv[2].replace(/^["']|["']$/g, '')
  }
  return undefined
}

const readOpt = (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '')

/** Cherche un BIOS là où l'émulateur lui-même est configuré (dossier de ses réglages, dossier « bios » par défaut, installation classique). */
async function findInEmulator(slot: BiosSlot, dir: string, custom: boolean): Promise<Found | null> {
  const rel = (p: string): string => (isAbsolute(p) ? p : resolve(dir, p))
  const docs = join(homedir(), 'Documents')
  const dirs: string[] = []
  if (slot.emulator === 'duckstation') {
    const c = readIniValue(await readOpt(join(dir, 'settings.ini')), 'BIOS', 'SearchDirectory')
    dirs.push(...(c ? [rel(c)] : []), join(dir, 'bios'), ...(custom ? [join(docs, 'DuckStation', 'bios')] : []))
  } else if (slot.emulator === 'pcsx2') {
    const c = readIniValue(await readOpt(join(dir, 'inis', 'PCSX2.ini')), 'Folders', 'Bios')
    dirs.push(...(c ? [rel(c)] : []), join(dir, 'bios'), ...(custom ? [join(docs, 'PCSX2', 'bios')] : []))
  } else if (slot.emulator === 'melonds') {
    const key = ({ nds7: 'BIOS7Path', nds9: 'BIOS9Path', ndsfw: 'FirmwarePath' } as Record<string, string>)[slot.id]
    const c = key && readIniValue(await readOpt(join(dir, 'melonDS.toml')), 'DS', key)
    // Le fichier indiqué compte quel que soit son nom.
    return c ? checkFile(rel(c), { ...slot, names: undefined }) : null
  }
  return findBiosFile(dirs, slot)
}

/** Retire un BIOS / firmware installé par RomVault (ou par l'émulateur, pour le firmware) ; un BIOS que l'utilisateur a rangé lui-même n'est jamais supprimé. */
export async function removeBios(ctx: Ctx, slotId: string): Promise<boolean> {
  const slot = BIOS_SLOTS.find((s) => s.id === slotId)
  if (!slot) return false
  const row = getRow(ctx.db, slot.emulator)
  try {
    if (slot.kind === 'bios') {
      const f = await findBiosFile([join(ctx.paths.bios, slot.emulator)], slot)
      if (!f) return false
      await rm(f.path, { force: true })
      return true
    }
    if (!row) return false
    if (slot.id === 'ps3') await rm(join(row.dir, 'dev_flash'), { recursive: true, force: true })
    else if (slot.id === 'vita') { const p = await vitaPrefPath(row.dir); if (!p) return false; await rm(join(p, 'vs0'), { recursive: true, force: true }) }
    else if (slot.id === 'switch-keys') await rm(edenKeys(row.dir), { force: true })
    else if (slot.id === 'switch-firmware') await rm(edenRegistered(row.dir), { recursive: true, force: true })
    else if (slot.id === 'wiiu-keys') await rm(cemuKeys(row.dir), { force: true })
    else if (slot.id === '3ds-keys') await rm(azaharKeys(row.dir), { force: true })
    else if (slot.id === '3ds-seeddb') await rm(azaharSeeddb(row.dir), { force: true })
    return true
  } catch { return false }
}

const readHead = async (path: string, n: number): Promise<Buffer> => {
  const fh = await open(path, 'r')
  try {
    const b = Buffer.alloc(n)
    const { bytesRead } = await fh.read(b, 0, n, 0)
    return b.subarray(0, bytesRead)
  } finally { await fh.close() }
}

/** Lance l'émulateur avec un argument d'installation et attend la fin (ou que `done` soit vrai : certains restent ouverts ensuite). */
async function runInstall(exe: string, args: string[], cwd: string, done: () => Promise<boolean>): Promise<void> {
  const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: true })
  let exited = false
  child.on('error', () => { exited = true })
  child.on('exit', () => { exited = true })
  const deadline = Date.now() + 15 * 60 * 1000
  while (!exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await done()) break
  }
  if (!exited) { child.kill(); await new Promise((r) => setTimeout(r, 500)) }
}

const KEYS_HEADER = /^header_key\s*=\s*[0-9a-f]{32}\s*$/im
const KEYS_MASTER = /^master_key_00\s*=\s*[0-9a-f]{32}\s*$/im

/** Importe un fichier fourni par l'utilisateur : le reconnaît, le valide, puis le place (ou l'installe) pour l'émulateur. */
export async function importBiosFile(ctx: Ctx, emulator: string, path: string): Promise<BiosImportResult> {
  const def = emulatorById(emulator)
  if (!def) return { path, ok: false, error: 'unknown' }
  const name = basename(path)
  let size: number
  try { size = (await stat(path)).size } catch { return { path, ok: false, error: 'failed', detail: 'unreadable' } }
  const info = { name, size }
  let md5: string | undefined
  if (needsMd5(emulator, info)) md5 = await md5File(path)
  const m = matchBios(emulator, { ...info, md5 })
  if (!m) return { path, ok: false, error: 'unknown' }
  const { slot } = m
  const result = (extra: Partial<BiosImportResult> = {}): BiosImportResult => ({ path, ok: true, slot: slot.id, verified: m.verified, label: m.label, ...extra })
  const row = getRow(ctx.db, emulator)
  try {
    if (slot.kind === 'bios') {
      const dir = join(ctx.paths.bios, emulator)
      await mkdir(dir, { recursive: true })
      await copyFile(path, join(dir, name))
      if (emulator === 'melonds' && row) await patchMelonDs(row.dir, dir)
      return result()
    }
    if (!row) return { path, ok: false, slot: slot.id, error: 'notInstalled' }
    if (slot.id === 'switch-keys') {
      const text = await readFile(path, 'utf8')
      if (!KEYS_HEADER.test(text) || !KEYS_MASTER.test(text)) return { path, ok: false, slot: slot.id, error: 'unknown' }
      await mkdir(join(row.dir, 'user', 'keys'), { recursive: true })
      await copyFile(path, edenKeys(row.dir))
      return result()
    }
    // Cemu/Azahar : le fichier déposé peut être une clé seule ou un keys.txt/aes_keys.txt complet — on n'y garde que les lignes reconnues,
    // fusionnées dans le fichier de l'émulateur (jamais un remplacement complet : on ne touche pas à ses en-têtes ni aux autres clés déjà là).
    if (slot.id === 'wiiu-keys') {
      const text = await readFile(path, 'utf8').catch(() => '')
      const newLines = parseCemuKeys(text)
      if (!newLines.length) return { path, ok: false, slot: slot.id, error: 'unknown' }
      const dest = cemuKeys(row.dir)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, mergeKeyLines(await readOpt(dest), newLines, (l) => { const v = l.split('#')[0].trim().toLowerCase(); return HEX32.test(v) ? v : null }))
      return result()
    }
    if (slot.id === '3ds-keys') {
      const text = await readFile(path, 'utf8').catch(() => '')
      const found = parseAzaharKeys(text)
      if (!found.size) return { path, ok: false, slot: slot.id, error: 'unknown' }
      const dest = azaharKeys(row.dir)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, mergeKeyLines(await readOpt(dest), [...found.values()], (l) => { const m = AZAHAR_KEY_LINE.exec(l); return m ? m[1].toLowerCase() : null }))
      return result()
    }
    if (slot.id === '3ds-seeddb') {
      // Format binaire opaque (agrégat de graines par titre) : aucune structure à valider, juste une taille non nulle.
      if (size < 16) return { path, ok: false, slot: slot.id, error: 'unknown' }
      const dest = azaharSeeddb(row.dir)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(path, dest)
      return result()
    }
    if (slot.id === 'switch-firmware') {
      const entries = await readZip(path)
      if (!entries || entries.filter((e) => e.name.toLowerCase().endsWith('.nca')).length < 10) return { path, ok: false, slot: slot.id, error: 'unknown' }
      const tmp = await mkdtemp(join(tmpdir(), 'rv-fw-'))
      try {
        await extract(path, tmp)
        const dest = edenRegistered(row.dir)
        await rm(dest, { recursive: true, force: true })
        await mkdir(dest, { recursive: true })
        let n = 0
        for (const f of await readdir(tmp, { recursive: true })) {
          if (!f.toLowerCase().endsWith('.nca')) continue
          await copyFile(join(tmp, f), join(dest, basename(f)))
          n++
        }
        if (n === 0) return { path, ok: false, slot: slot.id, error: 'failed', detail: 'no nca' }
      } finally { await rm(tmp, { recursive: true, force: true }) }
      return result()
    }
    // PS3 / Vita : le firmware .PUP (en-tête « SCEUF ») est installé par l'émulateur lui-même, en ligne de commande.
    if ((await readHead(path, 5)).toString('latin1') !== 'SCEUF') return { path, ok: false, slot: slot.id, error: 'unknown' }
    const args = slot.id === 'ps3' ? ['--installfw', path] : ['--firmware', path]
    await runInstall(row.exe, args, row.dir, async () => (await biosStatus(ctx)).some((s) => s.id === slot.id && s.state === 'ok'))
    const installed = (await biosStatus(ctx)).some((s) => s.id === slot.id && s.state === 'ok')
    return installed ? result() : { path, ok: false, slot: slot.id, error: 'failed', detail: 'install' }
  } catch (e) {
    return { path, ok: false, slot: slot.id, error: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

async function patchMelonDs(emuDir: string, biosDir: string): Promise<void> {
  const file = join(emuDir, 'melonDS.toml')
  const at = (n: string): string => join(biosDir, n).replace(/\\/g, '/')
  const has = (n: string): boolean => existsSync(join(biosDir, n))
  const values: Record<string, string | boolean> = {}
  if (has('bios7.bin')) values['BIOS7Path'] = at('bios7.bin')
  if (has('bios9.bin')) values['BIOS9Path'] = at('bios9.bin')
  if (has('firmware.bin')) values['FirmwarePath'] = at('firmware.bin')
  // Le BIOS externe n'est utilisé que si les deux fichiers ARM sont là (sinon melonDS garde son BIOS libre).
  if (has('bios7.bin') && has('bios9.bin')) values['ExternalBIOSEnable'] = true
  if (!Object.keys(values).length) return
  const text = existsSync(file) ? await readFile(file, 'utf8') : ''
  await writeFile(file, setTomlKeys(text, 'DS', values))
}
