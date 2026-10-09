import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Joy-Con seul, tenu à l'horizontale, dans RetroArch (NES, SNES, Game Boy, Game Boy Color, Game Boy Advance). Numéros relevés avec SDL2 2.32 (pilote HIDAPI, un Joy-Con non réuni) en appuyant
// sur chaque bouton : les quatre boutons de face sont rangés par position (bas 0, droite 1, gauche 2, haut 3), SL/SR = 9/10, Plus ou Moins 6, Home ou Capture 5, clic du stick 7, stick sur
// les axes 0/1. Les deux Joy-Con ont les mêmes numéros. RetroPad est positionnel : B en bas, A à droite, Y à gauche, X en haut. Gauche : Start = Moins, Select = Capture, menu RetroArch = SL (L). Droit : Start = Home, Select = Plus, menu RetroArch = SR (R). Le clic du stick reste libre (le stick sert déjà de croix). A et B sont inversés par rapport à la position (A en bas, B à droite). Les profils officiels de RetroArch n'en ont pas : ils sont écrits dans `autoconfig/sdl2`.
const PROFILES = [
  { side: 'L', name: 'Nintendo Switch Joy-Con (L)', pid: 8198, start: 6, startLabel: 'Minus', select: 5, selectLabel: 'Capture', menu: 17, menuLabel: 'L' },
  { side: 'R', name: 'Nintendo Switch Joy-Con (R)', pid: 8199, start: 5, startLabel: 'Home', select: 6, selectLabel: 'Plus', menu: 16, menuLabel: 'R' }
] as const

export const RETRO_JOYCON_MARK = '# Kartouche : Joy-Con seul à l\'horizontale'

export function retroJoyconProfile(p: (typeof PROFILES)[number]): string {
  return [
    RETRO_JOYCON_MARK, 'input_driver = "sdl2"', `input_device = "${p.name}"`, 'input_vendor_id = "1406"', `input_product_id = "${p.pid}"`,
    'input_a_btn = "0"', 'input_b_btn = "1"', 'input_y_btn = "2"', 'input_x_btn = "3"',
    'input_l_btn = "9"', 'input_r_btn = "10"', `input_start_btn = "${p.start}"`, `input_select_btn = "${p.select}"`, `input_menu_toggle_btn = "${p.menu}"`,
    'input_l_x_plus_axis = "+0"', 'input_l_x_minus_axis = "-0"', 'input_l_y_plus_axis = "+1"', 'input_l_y_minus_axis = "-1"',
    `input_start_btn_label = "${p.startLabel}"`, `input_select_btn_label = "${p.selectLabel}"`, `input_menu_toggle_btn_label = "${p.menuLabel}"`, ''
  ].join('\n')
}

/** Écrit (ou met à jour, si c'est le nôtre) les deux profils dans `autoconfig/sdl2` de l'installation RetroArch `dir`. Un fichier du même nom écrit par un autre n'est pas touché. */
export async function ensureRetroJoyconProfiles(dir: string): Promise<void> {
  const folder = join(dir, 'autoconfig', 'sdl2')
  await mkdir(folder, { recursive: true })
  for (const p of PROFILES) {
    const file = join(folder, `${p.name}.cfg`)
    const wanted = retroJoyconProfile(p)
    const current = await readFile(file, 'utf8').catch(() => null)
    if (current === wanted) continue
    if (current !== null && !current.startsWith(RETRO_JOYCON_MARK)) continue
    await writeFile(file, wanted)
  }
}
