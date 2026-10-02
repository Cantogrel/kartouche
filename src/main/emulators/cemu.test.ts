import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addGraphicPackEntries, applyCemuControls, cemuProfileXml, cemuSettingsXml, maxRenderHeight, needsGamePad, parseRules, pickResolutionPreset, resolutionPackEntries, writeCemuProfiles } from './cemu'
import { configureEmulator } from './configure'
import { classifyGpu } from './gpu'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rv-cemu-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const GB = 1024 ** 3

describe('GPU', () => {
  it('RTX dédiée : Vulkan, niveau haut', () => {
    expect(classifyGpu([{ name: 'Intel(R) UHD Graphics 770', ramBytes: GB }, { name: 'NVIDIA GeForce RTX 3070', ramBytes: 4 * GB - 1 }], true)).toMatchObject({ vulkan: true, tier: 'high', name: 'NVIDIA GeForce RTX 3070' })
  })
  it('iGPU : niveau igpu, plafond 720p (aucune mise à l’échelle)', () => {
    const gpu = classifyGpu([{ name: 'AMD Radeon(TM) Graphics', ramBytes: 512 * 1024 ** 2 }], true)
    expect(gpu.tier).toBe('igpu')
    expect(maxRenderHeight(gpu, 2160)).toBe(720)
  })
  it('petite carte dédiée : niveau bas, plafond 1080p même sur écran 4K', () => {
    const gpu = classifyGpu([{ name: 'NVIDIA GeForce GTX 750', ramBytes: 2 * GB }], true)
    expect(gpu.tier).toBe('low')
    expect(maxRenderHeight(gpu, 2160)).toBe(1080)
  })
  it('pas de pilote Vulkan, ou Intel HD ancien : OpenGL', () => {
    expect(classifyGpu([{ name: 'NVIDIA GeForce RTX 3070', ramBytes: 4 * GB }], false).vulkan).toBe(false)
    expect(classifyGpu([{ name: 'Intel(R) HD Graphics 4600', ramBytes: GB }], true).vulkan).toBe(false)
    expect(classifyGpu([{ name: 'Intel(R) HD Graphics 630', ramBytes: GB }], true).vulkan).toBe(true)
  })
  it('ignore les adaptateurs virtuels', () => {
    expect(classifyGpu([{ name: 'Microsoft Basic Display Adapter', ramBytes: 0 }, { name: 'NVIDIA GeForce RTX 4060', ramBytes: 4 * GB }], true).tier).toBe('high')
  })
  it('écran plus petit que le plafond : on suit l’écran', () => {
    expect(maxRenderHeight({ vulkan: true, tier: 'high' }, 1080)).toBe(1080)
  })
})

const CATEGORY_PACK = `[Definition]
titleIds = 00050000101C9300
name = Graphics
path = "Zelda/Graphics"
version = 7

[Preset]
name = 16:9 (Default)
category = Aspect Ratio

[Preset]
name = 1280x720 (HD, Default)
category = Resolution
default = 1

[Preset]
name = 1920x1080 (Full HD)
category = Resolution

[Preset]
name = 2560x1440 (2K)
category = Resolution

[Preset]
name = 3840x2160 (4K)
category = Resolution
`
const FLAT_PACK = `[Definition]
titleIds = 000500001014DB00,0005000010157E00
name = Resolution
path = "Bayonetta/Graphics/Resolution"

[Preset]
name = 1280x720 (Default)
$width = 1280

[Preset]
name = 1920x1080
$width = 1920
`

describe('graphic packs de résolution', () => {
  it('pack à catégorie : plus grand 16:9 sous le plafond', () => {
    expect(pickResolutionPreset(parseRules(CATEGORY_PACK), 1440)).toEqual({ category: 'Resolution', preset: '2560x1440 (2K)' })
    expect(pickResolutionPreset(parseRules(CATEGORY_PACK), 1080)).toEqual({ category: 'Resolution', preset: '1920x1080 (Full HD)' })
  })
  it('pack plat nommé Resolution : preset sans catégorie', () => {
    expect(pickResolutionPreset(parseRules(FLAT_PACK), 2160)).toEqual({ category: '', preset: '1920x1080' })
  })
  it('catégorie « TV Resolution » (Mario Kart 8, Splatoon) ; la résolution du GamePad est ignorée', () => {
    const info = parseRules('[Definition]\ntitleIds = 1\nname = Graphic Options\n[Preset]\nname = 1920x1080 (Full HD)\ncategory = TV Resolution\n[Preset]\nname = 1920x1080\ncategory = Gamepad Resolution\n')
    expect(pickResolutionPreset(info, 2160)).toEqual({ category: 'TV Resolution', preset: '1920x1080 (Full HD)' })
  })
  it('rien à choisir à 720p, ni pour un pack qui n’est pas de résolution', () => {
    expect(pickResolutionPreset(parseRules(CATEGORY_PACK), 720)).toBeNull()
    expect(pickResolutionPreset(parseRules('[Definition]\ntitleIds = 1\nname = Cheat\n[Preset]\nname = 1920x1080\n'), 2160)).toBeNull()
  })
  it('entrées écrites dans settings.xml, un seul pack par jeu, choix existant jamais écrasé', async () => {
    const packs = join(dir, 'packs')
    await mkdir(join(packs, 'Zelda', 'Graphics'), { recursive: true })
    await mkdir(join(packs, 'Bayo_Resolution'), { recursive: true })
    await mkdir(join(packs, 'Bayo_Performance_Resolution'), { recursive: true })
    await writeFile(join(packs, 'Zelda', 'Graphics', 'rules.txt'), CATEGORY_PACK)
    await writeFile(join(packs, 'Bayo_Resolution', 'rules.txt'), FLAT_PACK)
    await writeFile(join(packs, 'Bayo_Performance_Resolution', 'rules.txt'), FLAT_PACK)
    const entries = await resolutionPackEntries(packs, 1080)
    expect(entries.map((e) => e.rules).sort()).toEqual(['Bayo_Resolution/rules.txt', 'Zelda/Graphics/rules.txt'])
    const xml = addGraphicPackEntries(cemuSettingsXml(false, { vulkan: true, tier: 'mid' }), entries)
    expect(xml).toContain('<Entry filename="graphicPacks/downloadedGraphicPacks/Zelda/Graphics/rules.txt"><Preset><category>Resolution</category><preset>1920x1080 (Full HD)</preset></Preset></Entry>')
    expect(xml).toContain('<Entry filename="graphicPacks/downloadedGraphicPacks/Bayo_Resolution/rules.txt"><Preset><preset>1920x1080</preset></Preset></Entry>')
    expect(addGraphicPackEntries(xml, entries)).toBe(xml)
  })
})

describe('installation propre de Cemu', () => {
  const ctx = { lang: 'fr' as const, displayHeight: 1080, biosDir: '' }
  it('Vulkan + shaders asynchrones + langue + Pro Controller par défaut + profils nommés', async () => {
    await configureEmulator('cemu', dir, { ...ctx, gpu: { vulkan: true, tier: 'mid' } })
    const settings = readFileSync(join(dir, 'settings.xml'), 'utf8')
    expect(settings).toContain('<api>1</api>')
    expect(settings).toContain('<AsyncCompile>true</AsyncCompile>')
    expect(settings).toContain('<console_language>2</console_language>')
    const profile = readFileSync(join(dir, 'controllerProfiles', 'controller0.xml'), 'utf8')
    expect(profile).toContain('<type>Wii U Pro Controller</type>')
    expect(profile).toContain('<api>XInput</api>')
    expect(profile).toContain('<api>Keyboard</api>')
    // Pro : A=1 -> touche L ; Home=11 -> Échap ; croix Haut = 12
    expect(profile).toContain('<entry><mapping>1</mapping><button>76</button></entry>')
    expect(profile).toContain('<entry><mapping>11</mapping><button>27</button></entry>')
    expect(profile).toContain('<entry><mapping>12</mapping><button>0</button></entry>')
    expect(existsSync(join(dir, 'controllerProfiles', 'RomVault GamePad.xml'))).toBe(true)
    expect(existsSync(join(dir, 'controllerProfiles', 'RomVault Pro Controller.xml'))).toBe(true)
  })
  it('sans Vulkan : OpenGL', async () => {
    await configureEmulator('cemu', dir, { ...ctx, lang: 'en', gpu: { vulkan: false, tier: 'igpu' } })
    const settings = readFileSync(join(dir, 'settings.xml'), 'utf8')
    expect(settings).toContain('<api>0</api>')
    expect(settings).toContain('<console_language>1</console_language>')
  })
  it('ne réécrit pas les réglages existants', async () => {
    await writeFile(join(dir, 'settings.xml'), '<content><fullscreen>false</fullscreen></content>')
    await configureEmulator('cemu', dir, ctx)
    expect(readFileSync(join(dir, 'settings.xml'), 'utf8')).toBe('<content><fullscreen>false</fullscreen></content>')
  })
})

describe('manettes par jeu', () => {
  const read = (): string => readFileSync(join(dir, 'controllerProfiles', 'controller0.xml'), 'utf8')
  it('reconnaît les jeux qui exigent le GamePad', () => {
    expect(needsGamePad('Nintendo Land (USA)')).toBe(true)
    expect(needsGamePad('ZombiU (Europe)')).toBe(true)
    expect(needsGamePad('Super Mario Maker')).toBe(true)
    expect(needsGamePad('Mario Kart 8', 'mk8.wua')).toBe(false)
    expect(needsGamePad('The Legend of Zelda: Breath of the Wild')).toBe(false)
  })
  it('classique -> Pro ; GamePad requis -> GamePad ; retour au Pro ensuite', async () => {
    await applyCemuControls(dir, 'Mario Kart 8')
    expect(read()).toContain('<type>Wii U Pro Controller</type>')
    await applyCemuControls(dir, 'Nintendo Land')
    expect(read()).toContain('<type>Wii U GamePad</type>')
    expect(read()).toContain('<toggle_display>0</toggle_display>')
    // GamePad : A=1 clavier L, Home=27
    expect(read()).toContain('<entry><mapping>27</mapping><button>27</button></entry>')
    await applyCemuControls(dir, 'Splatoon')
    expect(read()).toContain('<type>Wii U Pro Controller</type>')
  })
  it('un profil modifié par l’utilisateur (marqueur disparu) n’est jamais écrasé', async () => {
    await mkdir(join(dir, 'controllerProfiles'), { recursive: true })
    const custom = '<?xml version="1.0"?><emulated_controller><type>Wii U Classic Controller</type></emulated_controller>'
    await writeFile(join(dir, 'controllerProfiles', 'controller0.xml'), custom)
    await applyCemuControls(dir, 'Nintendo Land')
    expect(read()).toBe(custom)
  })
  it('profils nommés non écrasés', async () => {
    await writeCemuProfiles(dir)
    await writeFile(join(dir, 'controllerProfiles', 'RomVault GamePad.xml'), 'perso')
    await writeCemuProfiles(dir)
    expect(readFileSync(join(dir, 'controllerProfiles', 'RomVault GamePad.xml'), 'utf8')).toBe('perso')
  })
  it('les deux profils ont chacun leur marqueur', () => {
    expect(cemuProfileXml('pro')).toContain('romvault:cemu-profile=pro')
    expect(cemuProfileXml('gamepad')).toContain('romvault:cemu-profile=gamepad')
  })
})
