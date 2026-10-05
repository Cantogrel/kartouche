import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../db/migrations'
import { saveSettings } from '../db/settingsStore'
import { isLaunchUri, sanitizeDetected } from '@shared/connectors'
import { listLibrary } from '../library/libraryStore'
import { setOverride } from '../library/overrides'
import { getLaunchSpec, upsertExternalEntry } from '../library/external'
import { listConnectors, scanConnectors } from './index'
import { launcherEntryIds, scanConnector, type Connector } from './core'
import { removeEntry } from '../library/libraryStore'

let db: DatabaseSync
beforeEach(() => { db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); migrate(db) })
afterEach(() => db.close())

const fake = (games: unknown[], over: Partial<Connector> = {}): Connector => ({ id: 'steam', name: 'Fake', detect: async () => true, scan: async () => games, ...over })
const game = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ nativeId: String(n), title: `Jeu ${n}`, installDir: `C:\\fake\\jeu${n}`, uri: `steam://rungameid/${n}`, ...extra })

describe('sanitizeDetected', () => {
  it('refuse sans identifiant, titre ou moyen de lancement', () => {
    expect(sanitizeDetected({ title: 'x', exe: 'a.exe' })).toBeNull()
    expect(sanitizeDetected({ nativeId: '1', exe: 'a.exe' })).toBeNull()
    expect(sanitizeDetected({ nativeId: '1', title: 'x' })).toBeNull()
    expect(sanitizeDetected(null)).toBeNull()
  })
  it('ne garde que les adresses de launchers connus', () => {
    expect(isLaunchUri('steam://rungameid/1')).toBe(true)
    expect(isLaunchUri('com.epicgames.launcher://apps/x?action=launch')).toBe(true)
    for (const bad of ['http://evil', 'file:///c:/x.exe', 'javascript:alert(1)', 'ms-settings:', 'C:\\x.exe']) expect(isLaunchUri(bad)).toBe(false)
    expect(sanitizeDetected({ nativeId: '1', title: 'x', uri: 'http://evil' })).toBeNull()
    expect(sanitizeDetected({ nativeId: '1', title: 'x', uri: 'http://evil', exe: 'a.exe' })).toEqual({ nativeId: '1', title: 'x', exe: 'a.exe' })
  })
})

describe('scanConnector', () => {
  it('ajoute les jeux détectés comme entrées de launcher', async () => {
    const r = await scanConnector(db, fake([game(1), game(2)]))
    expect(r).toMatchObject({ ok: true, found: 2, added: 2, updated: 0, duplicates: 0, gone: 0 })
    const entries = listLibrary(db)
    expect(entries.map((e) => [e.title, e.kind, e.source, e.console])).toEqual([['Jeu 1', 'launcher', 'steam', 'pc'], ['Jeu 2', 'launcher', 'steam', 'pc']])
    expect(getLaunchSpec(db, entries[0].id)).toEqual({ type: 'uri', uri: 'steam://rungameid/1', installDir: 'C:\\fake\\jeu1' })
  })
  it('ne duplique pas à la relecture et garde titre, surcharges et temps de jeu', async () => {
    await scanConnector(db, fake([game(1)]))
    const id = listLibrary(db)[0].id
    setOverride(db, id, 'title', 'Mon titre')
    db.prepare('UPDATE library SET play_minutes = 42 WHERE id = ?').run(id)
    const r = await scanConnector(db, fake([game(1, { installDir: 'C:\\fake\\nouveau' })]))
    expect(r).toMatchObject({ added: 0, updated: 1 })
    const e = listLibrary(db)
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ id, title: 'Jeu 1', shownTitle: 'Mon titre', playMinutes: 42 })
    expect(getLaunchSpec(db, id)?.installDir).toBe('C:\\fake\\nouveau')
  })
  it('déduplique un jeu déjà présent par le même dossier (autre launcher ou ajout manuel)', async () => {
    upsertExternalEntry(db, { kind: 'exe', source: 'manual', title: 'Déjà là', launch: { type: 'exe', exe: 'C:\\fake\\jeu1' } })
    const r = await scanConnector(db, fake([game(1), game(2)]))
    expect(r).toMatchObject({ found: 2, added: 1, duplicates: 1 })
    expect(listLibrary(db)).toHaveLength(2)
  })
  it('ignore les doublons de la sortie et les jeux invalides', async () => {
    const r = await scanConnector(db, fake([game(1), game(1), { title: 'sans id' }, 'nimporte quoi']))
    expect(r).toMatchObject({ found: 1, added: 1 })
  })
  it('un jeu qui disparaît est conservé, marqué sans fichier, et revient tel quel', async () => {
    await scanConnector(db, fake([game(1), game(2)]))
    const [a] = listLibrary(db)
    db.prepare('UPDATE library SET play_minutes = 5 WHERE id = ?').run(a.id)
    const r = await scanConnector(db, fake([game(2)]))
    expect(r.gone).toBe(1)
    expect(db.prepare('SELECT missing FROM library WHERE id = ?').get(a.id)).toEqual({ missing: 1 })
    await scanConnector(db, fake([game(1), game(2)]))
    expect(db.prepare('SELECT play_minutes FROM library WHERE id = ?').get(a.id)).toEqual({ play_minutes: 5 })
    expect(listLibrary(db)).toHaveLength(2)
  })
  it('signale un launcher absent ou illisible sans rien changer', async () => {
    await scanConnector(db, fake([game(1)]))
    expect(await scanConnector(db, fake([], { detect: async () => false }))).toMatchObject({ ok: false, error: 'absent' })
    expect(await scanConnector(db, fake([], { scan: async () => { throw new Error('manifeste illisible') } }))).toMatchObject({ ok: false, error: 'manifeste illisible' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM library WHERE missing = 0").get()).toEqual({ n: 1 })
  })
})

describe('activation par launcher', () => {
  it('rien n’est lu tant que le launcher n’est pas activé', async () => {
    let scans = 0
    const c = fake([game(1)], { scan: async () => { scans++; return [game(1)] } })
    expect(await scanConnectors(db, undefined, [c])).toEqual([])
    expect(scans).toBe(0)
    expect((await listConnectors(db, [c]))[0]).toMatchObject({ id: 'steam', detected: true, enabled: false, games: 0 })
    saveSettings(db, { connectors: { steam: true } })
    expect(await scanConnectors(db, undefined, [c])).toHaveLength(1)
    expect((await listConnectors(db, [c]))[0]).toMatchObject({ enabled: true, games: 1 })
  })
})

describe("désactivation d'un launcher", () => {
  it('retire seulement les jeux de ce launcher', async () => {
    await scanConnector(db, fake([game(1), game(2)]))
    await scanConnector(db, fake([game(3)], { id: 'epic' }))
    expect(launcherEntryIds(db, 'steam')).toHaveLength(2)
    for (const id of launcherEntryIds(db, 'steam')) await removeEntry(db, id, 'entry', 'saves-inexistant')
    expect(listLibrary(db).map((e) => e.source)).toEqual(['epic'])
    expect(launcherEntryIds(db, 'steam')).toEqual([])
  })
})

describe('listConnectors : détection différée', () => {
  it('sans détection, répond tout de suite avec la dernière détection connue (null au départ)', async () => {
    let detections = 0
    const c = fake([], { id: 'gog', detect: async () => { detections++; return true } })
    expect((await listConnectors(db, [c], false))[0]).toMatchObject({ id: 'gog', detected: null })
    expect(detections).toBe(0)
    expect((await listConnectors(db, [c], true))[0].detected).toBe(true)
    expect((await listConnectors(db, [c], false))[0].detected).toBe(true)
    expect(detections).toBe(1)
  })
  it('un launcher dont la détection plante est simplement absent', async () => {
    const c = fake([], { id: 'ea', detect: async () => { throw new Error('reg') } })
    expect((await listConnectors(db, [c], true))[0].detected).toBe(false)
  })
})
