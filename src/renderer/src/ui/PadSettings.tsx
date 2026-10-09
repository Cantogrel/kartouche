import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { useSettings } from '@/store/settings'
import { hasJoyconChoice, padTags, padTitle, usePads } from '@/store/pads'
import { PadIcon } from '@/ui/PadIcon'
import { isJoyconPair, joyconHalvesPressed } from '@/bigpicture/nav'

/** Nom de la manette vue par Chromium : la Switch Pro se présente sous « Wireless Gamepad » ; le reste garde son nom sans la fin technique. */
function liveName(id: string): string {
  if (/vendor: 057e product: 2009/i.test(id)) return t('pad.switchPro')
  if (/vendor: 057e product: 200e/i.test(id)) return t('pad.joyconPair')
  return id.replace(/\s*\(.*$/, '')
}

/** Choix « Assemblés / Séparés » quand un Joy-Con gauche et un droit sont allumés. */
function JoyconChoice() {
  const { settings, update } = useSettings()
  const options = [
    { split: false, title: t('settings.padJoyconPair'), hint: t('settings.padJoyconPairHint') },
    { split: true, title: t('settings.padJoyconSplit'), hint: t('settings.padJoyconSplitHint') }
  ]
  return (
    <div className="pad-card pad-choice" role="radiogroup" aria-label={t('settings.padJoyconTitle')}>
      <div className="pad-choice-head">
        <strong>{t('settings.padJoyconTitle')}</strong>
        <span className="muted">{t('settings.padJoyconHint')}</span>
      </div>
      <div className="pad-seg">
        {options.map((o) => (
          <button key={String(o.split)} type="button" role="radio" aria-checked={settings.joyconSplit === o.split} className={settings.joyconSplit === o.split ? 'on' : ''} onClick={() => void update({ joyconSplit: o.split })}>
            <PadIcon kind="joycon-pair" apart={o.split} size={44} />
            <strong>{o.title}</strong>
            <span className="muted">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** Manette : manettes détectées (cartes), choix des Joy-Con, réglages du Big Picture et test des boutons en direct (API Gamepad, profil standard). */
export function PadSettings() {
  const { settings } = useSettings()
  const [live, setLive] = useState<{ id: string; pressed: string[] }[]>([])
  const detected = usePads()
  useEffect(() => {
    const names = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'L3', 'R3', '↑', '↓', '←', '→']
    const timer = window.setInterval(() => {
      // Joy-Con séparés : la manette « Joy-Con L+R » de Chromium est montrée en deux, chaque Joy-Con avec ses boutons gravés.
      const pads = [...navigator.getGamepads()].filter((p): p is Gamepad => !!p)
      const pairs = pads.filter(isJoyconPair)
      const list = pads.flatMap((p) => settings.joyconSplit && isJoyconPair(p)
        ? joyconHalvesPressed(p, pairs.length > 1 ? pairs.indexOf(p) + 1 : undefined).map((h) => ({ id: h.title, pressed: h.pressed }))
        : [{ id: liveName(p.id), pressed: [...p.buttons].flatMap((b, i) => (b.pressed ? [names[i] ?? String(i)] : [])) }])
      setLive((old) => (JSON.stringify(old) === JSON.stringify(list) ? old : list))
    }, 150)
    return () => window.clearInterval(timer)
  }, [settings.joyconSplit])
  return (
    <div className="pad-settings">
      <h3>{t('settings.padDetected')}</h3>
      {!detected.ready ? <p className="muted">{t('settings.padChecking')}</p>
        : !detected.ok ? <p className="muted">{t('settings.padUnavailable')}</p>
        : detected.pads.length === 0 ? <div className="pad-card pad-empty"><PadIcon kind="other" size={44} /><span className="muted">{t('settings.padNone')}</span></div>
        : (
          <div className="pad-grid">
            {detected.pads.map((p) => (
              <div key={p.id} className={`pad-card${p.lastUsed ? ' used' : ''}`}>
                <PadIcon kind={p.kind} />
                <div className="pad-info">
                  <strong>{padTitle(p)}</strong>
                  <div className="pad-tags">{padTags(p).map((x) => <span key={x} className="pad-tag">{x}</span>)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      {hasJoyconChoice(detected.pads) && <JoyconChoice />}

      {live.length > 0 && <h3>{t('settings.padTest')}</h3>}
      {live.map((p) => (
        <div key={p.id} className="pad-card pad-test">
          <strong>{p.id}</strong>
          <div className="pad-pressed">
            {p.pressed.length ? p.pressed.map((b) => <kbd key={b}>{b}</kbd>) : <span className="muted">{t('settings.padIdle')}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
