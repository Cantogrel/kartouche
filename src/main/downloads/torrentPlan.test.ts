import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nspWithXml } from '../library/content/content.testutil'
import { cueTrackIndexes, parseSelectOnly, planTorrent, type TorrentFileInfo } from './torrentPlan'

const f = (path: string, length = 1000): TorrentFileInfo => ({ name: path.split('/').pop()!, path, length })
const names = (files: TorrentFileInfo[], idx: number[]): string[] => idx.map((i) => files[i].path!).sort()

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-plan-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const write = (name: string, data: Buffer | string): string => { const p = join(dir, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); return p }

describe('planTorrent — disque PS1 (.cue + pistes)', () => {
  const files = [
    f('Pack/Game (USA)/Game (USA).cue', 200), f('Pack/Game (USA)/Game (USA) (Track 1).bin', 5e8), f('Pack/Game (USA)/Game (USA) (Track 2).bin', 4e7), f('Pack/Game (USA)/Game (USA).sbi', 60),
    f('Pack/Other (USA)/Other (USA).cue', 200), f('Pack/Other (USA)/Other (USA).bin', 6e8), f('Pack/cover.jpg'), f('Pack/readme.nfo')
  ]
  it('retient le .cue du bon jeu et son .sbi ; les pistes sont lues dans la feuille ; rien d’autre', async () => {
    const plan = planTorrent(files, 'Game (USA)', null, 'ps1')!
    expect(files[plan.primary].path).toBe('Pack/Game (USA)/Game (USA).cue')
    expect(names(files, plan.extras)).toEqual(['Pack/Game (USA)/Game (USA).sbi'])
    const cue = write('Game (USA).cue', 'FILE "Game (USA) (Track 1).bin" BINARY\n  TRACK 01 MODE2/2352\nFILE "Game (USA) (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n')
    expect(names(files, await plan.followUp!(cue))).toEqual(['Pack/Game (USA)/Game (USA) (Track 1).bin', 'Pack/Game (USA)/Game (USA) (Track 2).bin'])
  })
  it('deux disques dans le même dossier : seules les pistes du disque demandé', async () => {
    const two = [f('FF7/FF7 (Disc 1).cue', 100), f('FF7/FF7 (Disc 1).bin', 7e8), f('FF7/FF7 (Disc 2).cue', 100), f('FF7/FF7 (Disc 2).bin', 7e8)]
    const plan = planTorrent(two, 'FF7 (Disc 2)', null, 'ps1')!
    expect(two[plan.primary].path).toBe('FF7/FF7 (Disc 2).cue')
    const cue = write('d2.cue', 'FILE "FF7 (Disc 2).bin" BINARY\n')
    expect(names(two, await plan.followUp!(cue))).toEqual(['FF7/FF7 (Disc 2).bin'])
  })
  it('la casse du nom de piste ne compte pas', () => {
    expect(cueTrackIndexes('FILE "TRACK 01.BIN" BINARY', 'A/x.cue', [f('A/x.cue'), f('A/track 01.bin')])).toEqual([1])
  })
  it('ambigu (deux jeux, aucun ne correspond) : null plutôt que de deviner', () => {
    expect(planTorrent(files, 'Rien à voir', null, 'ps1')).toBeNull()
  })
})

describe('planTorrent — Switch (jeu + mises à jour + DLC)', () => {
  const files = [
    f('Pack/Game [0100000000010000][v0].nsp', 6e9), f('Pack/Game [0100000000010800][v65536].nsp', 1e9), f('Pack/Game DLC [0100000000011001][v0].nsp', 5e8),
    f('Pack/Other [0100000000020000][v0].nsp', 4e9), f('Pack/Other [0100000000020800][v131072].nsp', 1e9), f('Pack/readme.txt', 10)
  ]
  it('le jeu d’abord ; puis ses seuls contenus, désignés par l’identifiant natif lu dans le fichier (jamais ceux de l’autre jeu)', async () => {
    const plan = planTorrent(files, 'Game', null, 'switch')!
    expect(files[plan.primary].name).toBe('Game [0100000000010000][v0].nsp')
    expect(plan.extras).toEqual([])
    const primary = write('Game.nsp', nspWithXml('base', '0100000000010000'))
    expect(names(files, await plan.followUp!(primary))).toEqual(['Pack/Game DLC [0100000000011001][v0].nsp', 'Pack/Game [0100000000010800][v65536].nsp'])
  })
  it('noms sans identifiant : repli prudent sur le titre (la mise à jour de l’autre jeu est écartée)', async () => {
    const plain = [f('Game.nsp'), f('Game Update v1.nsp'), f('Other Game Update.nsp'), f('Other.nsp')]
    const plan = planTorrent(plain, 'Game', null, 'switch')!
    expect(plain[plan.primary].name).toBe('Game.nsp')
    const primary = write('Game2.nsp', nspWithXml('base', '0100000000010000'))
    expect(names(plain, await plan.followUp!(primary))).toEqual(['Game Update v1.nsp'])
  })
  it('un torrent d’un seul fichier : lui, sans suite', () => {
    expect(planTorrent([f('Game.nsp')], 'Autre', null, 'switch')).toEqual({ primary: 0, extras: [] })
  })
})

describe('planTorrent — torrent réel d’Animal Crossing: New Horizons (33 fichiers)', () => {
  const R = 'Animal Crossing New Horizons [NSP]/'
  const files = [
    f(`${R}Animal Crossing New Horizons [01006F8002326000][v0].nsp`, 6.6e9),
    f(`${R}Animal Crossing New Horizons [01006F8002326800][v1966080].nsp`, 4.2e9),
    f(`${R}Animal Crossing New Horizons [DLC Happy Home Paradise] [01006F80023273E8][v0].nsp`, 6e8),
    f(`${R}2 DLCs + Alt/Animal Crossing New Horizons [Nook Inc Silk Rug] [01006F800232712D][v0].nsp`, 1.2e5),
    f(`${R}2 DLCs + Alt/Animal Crossing New Horizons [DLC Special Order Ticket Pocket Camp tie-in campaign] [01006F800232712C][v0].nsp`, 1.2e5),
    f(`${R}2 DLCs + Alt/Alternate DLC (without tickets)/Animal Crossing New Horizons [DLC Nook Inc silk rug] [01006F800232712D][v0].nsp`, 1.2e5),
    f(`${R}Official Transfer Tool/Animal Crossing New Horizons Island Transfer Tool [0100F38011CFE000][v0].nsp`, 4.3e7),
    f(`${R}Amiibo JSON for Emuiibo/emuiibo-v0.6.3.zip`, 3e5), f(`${R}Amiibo JSON for Emuiibo/emutool-v0.6.3.zip`, 2e6), f(`${R}Amiibo JSON for Emuiibo/ALL amiibo (flag_json).7z`, 5e5),
    f(`${R}Book (Rus)/Animal Crossing New Horizons Artbook (Rus).pdf`, 9e7),
    f(`${R}Events Unlock (1.11.1a)/switch/DBI.nro`, 4e6), f(`${R}Events Unlock (1.11.1a)/directories/EventDeli/files/BCAT_EventFlag_000.US`, 1e3)
  ]
  it('le titre « Animal Crossing - New Horizons » désigne le jeu, pas l’Island Transfer Tool (autre application au nom plus long) ni les outils', () => {
    const plan = planTorrent(files, 'Animal Crossing - New Horizons', null, 'switch')!
    expect(plan).not.toBeNull()
    expect(files[plan.primary].name).toBe('Animal Crossing New Horizons [01006F8002326000][v0].nsp')
  })
  it('ses mises à jour et DLC sont ensuite retenus d’après l’identifiant natif du jeu (l’autre application et les outils non)', async () => {
    const plan = planTorrent(files, 'Animal Crossing - New Horizons', null, 'switch')!
    const primary = write('AC.nsp', nspWithXml('base', '01006F8002326000'))
    const picked = names(files, await plan.followUp!(primary))
    expect(picked).toEqual([
      `${R}2 DLCs + Alt/Alternate DLC (without tickets)/Animal Crossing New Horizons [DLC Nook Inc silk rug] [01006F800232712D][v0].nsp`,
      `${R}2 DLCs + Alt/Animal Crossing New Horizons [DLC Special Order Ticket Pocket Camp tie-in campaign] [01006F800232712C][v0].nsp`,
      `${R}2 DLCs + Alt/Animal Crossing New Horizons [Nook Inc Silk Rug] [01006F800232712D][v0].nsp`,
      `${R}Animal Crossing New Horizons [01006F8002326800][v1966080].nsp`,
      `${R}Animal Crossing New Horizons [DLC Happy Home Paradise] [01006F80023273E8][v0].nsp`
    ].sort())
  })
  it('l’Island Transfer Tool, demandé sous son propre titre, est bien lui', () => {
    const plan = planTorrent(files, 'Animal Crossing: New Horizons Island Transfer Tool', null, 'switch')!
    expect(files[plan.primary].name).toBe('Animal Crossing New Horizons Island Transfer Tool [0100F38011CFE000][v0].nsp')
  })
})

describe('planTorrent — Switch en .nsz (Link’s Awakening, 2 fichiers)', () => {
  const files = [
    f('The Legend of Zelda Links Awakening [NSZ]/The Legend of Zelda Links Awakening [01006BB00C6F0000][v0] (5.84 GB).nsz', 2035710123),
    f('The Legend of Zelda Links Awakening [NSZ]/The Legend of Zelda Links Awakening [01006BB00C6F0800][v131072] (0.04 GB).nsz', 28715035)
  ]
  it('le .nsz au Title ID de jeu est le fichier principal, la mise à jour .nsz (…800) le suit', async () => {
    const plan = planTorrent(files, 'The Legend of Zelda Links Awakening [NSZ]', null, 'switch')!
    expect(plan).not.toBeNull()
    expect(files[plan.primary].name).toContain('[01006BB00C6F0000]')
    const primary = write('zelda.nsz', 'compressé : illisible sans décompression')
    expect(names(files, await plan.followUp!(primary))).toEqual([files[1].path])
  })
})

describe('planTorrent — Vita (archives)', () => {
  it('le jeu, puis seulement ses mises à jour/DLC reconnus par leur nom et couvrant le titre', async () => {
    const files = [f('Pack/Game.zip', 2e9), f('Pack/Game Update 1.05.zip', 1e8), f('Pack/Game DLC 1.zip', 5e7), f('Pack/Other Update.zip', 1e8), f('Pack/Other.zip', 1e9)]
    const plan = planTorrent(files, 'Game', null, 'vita')!
    expect(files[plan.primary].name).toBe('Game.zip')
    const primary = write('Game.zip', 'x')
    expect(names(files, await plan.followUp!(primary))).toEqual(['Pack/Game DLC 1.zip', 'Pack/Game Update 1.05.zip'])
  })
})

describe('planTorrent — autres cas', () => {
  it('archive en plusieurs volumes : tous les volumes de CETTE archive', () => {
    const vols = [f('a/Game.part1.rar'), f('a/Game.part2.rar'), f('a/Other.part1.rar'), f('a/Other.part2.rar')]
    const plan = planTorrent(vols, 'Game', null, 'ps2')!
    expect(vols[plan.primary].name).toBe('Game.part1.rar')
    expect(names(vols, plan.extras)).toEqual(['a/Game.part2.rar'])
  })
  it('PS3 : le jeu (.iso) puis le seul .pkg portant son numéro de série ou son titre', async () => {
    const ps3 = [f('Game (EU).iso', 8e9), f('Game Update 1.05 BLES01179.pkg', 1e8), f('Autre Jeu Update BLES99999.pkg', 1e8)]
    const plan = planTorrent(ps3, 'Game (EU)', null, 'ps3')!
    expect(ps3[plan.primary].name).toBe('Game (EU).iso')
    expect(plan.followUp).toBeDefined()
  })
  it('console inconnue : comportement d’avant (un seul fichier, par titre ou taille)', () => {
    expect(planTorrent([f('a.bin', 10), f('b.bin', 20)], 'x', 20, null)).toEqual({ primary: 1, extras: [] })
  })
  it('que des notices et images : rien à prendre', () => {
    expect(planTorrent([f('a.nfo'), f('b.jpg'), f('c.txt')], 'x', null, 'ps1')).toBeNull()
  })
})

describe('so= du magnet', () => {
  it('parseSelectOnly : indices, plages, absent', () => {
    expect(parseSelectOnly('magnet:?xt=urn:btih:abc&so=0,2,4-6')).toEqual([0, 2, 4, 5, 6])
    expect(parseSelectOnly('magnet:?xt=urn:btih:abc')).toBeNull()
    expect(parseSelectOnly('https://x/a.torrent?so=1')).toBeNull()
  })
  it('départage deux candidats ambigus, sans en ajouter hors du plan', () => {
    const files: TorrentFileInfo[] = [{ name: 'Alpha.nes', length: 10 }, { name: 'Beta.nes', length: 20 }, { name: 'notes.txt', length: 1 }]
    expect(planTorrent(files, 'Gamma', null, 'nes')).toBeNull()
    expect(planTorrent(files, 'Gamma', null, 'nes', [1])?.primary).toBe(1)
    expect(planTorrent(files, 'Gamma', null, 'nes', [2])).toBeNull() // so= vers un fichier hors plan : ignoré
  })
})
