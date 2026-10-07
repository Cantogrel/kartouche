import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/i18n'
import { pushLayer } from './layers'
import { focusEl, navItems } from './useNav'
import { igdbImageUrl, youtubeEmbedUrl, type GameMedia } from '@shared/media'

type Item = { kind: 'trailer'; id: string; name: string } | { kind: 'image'; id: string }

/**
 * « Médias » en plein écran, à la manette : bandes-annonces puis captures dans un seul visionneur. Le stick droit (gauche/droite) ou LB/RB passent d'un média au
 * suivant ; le stick gauche et la croix restent réservés au focus des boutons. A met une vidéo en pause / la reprend, B ferme. Une vidéo se lance toute seule.
 */
export function BpMediaViewer({ media, onClose }: { media: Pick<GameMedia, 'trailers' | 'screenshots' | 'artworks'>; onClose: () => void }) {
  const items = useMemo<Item[]>(() => [
    ...media.trailers.map((v): Item => ({ kind: 'trailer', id: v.id, name: v.name })),
    ...[...media.screenshots, ...media.artworks].map((id): Item => ({ kind: 'image', id }))
  ], [media])
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const item = items[index]
  const imageNumber = items.slice(0, index + 1).filter((i) => i.kind === 'image').length
  const imageTotal = items.filter((i) => i.kind === 'image').length
  const command = (func: 'playVideo' | 'pauseVideo'): void => {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), 'https://www.youtube-nocookie.com')
  }
  const step = (d: number): void => { setIndex((i) => (i + d + items.length) % items.length); setPaused(false) }
  useEffect(() => pushLayer((a) => {
    if (a === 'back') { onClose(); return true }
    if (a === 'prev' && items.length > 1) { step(-1); return true }
    if (a === 'next' && items.length > 1) { step(1); return true }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items.length])
  useEffect(() => { focusEl(navItems()[0]) }, [])
  // Stick droit (axe 2, horizontal) : un média par poussée, comme un appui sur LB/RB ; il ne sert pas au focus.
  useEffect(() => {
    if (items.length < 2) return
    let held = 0
    const id = window.setInterval(() => {
      let x = 0
      for (const pad of navigator.getGamepads()) { const v = pad?.axes[2] ?? 0; if (Math.abs(v) > Math.abs(x)) x = v }
      const dir = x > 0.6 ? 1 : x < -0.6 ? -1 : 0
      if (dir !== held) { held = dir; if (dir) step(dir) }
    }, 50)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])
  if (!item) return null
  const label = item.kind === 'trailer' ? item.name || t('media.trailer') : t('media.screenshot', { n: imageNumber, total: imageTotal })
  return (
    <div className="bp-overlay bp-media-overlay">
      <div className="bp-media" data-focus-root>
        {item.kind === 'trailer'
          ? <iframe ref={frame} key={item.id} className="bp-media-frame" title={label} src={youtubeEmbedUrl(item.id, { autoplay: true })}
              allow="autoplay; encrypted-media; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" />
          : <img key={item.id} className="bp-media-image" src={igdbImageUrl(item.id, 't_1080p')} alt={label} />}
        <div className="bp-media-bar">
          {item.kind === 'trailer' && <button data-nav className="bp-btn primary" onClick={() => { command(paused ? 'playVideo' : 'pauseVideo'); setPaused(!paused) }}>{paused ? `▶ ${t('media.play')}` : `❚❚ ${t('media.pause')}`}</button>}
          {items.length > 1 && <button data-nav className="bp-btn" onClick={() => step(-1)}>◀ {t('media.prev')}</button>}
          {items.length > 1 && <button data-nav className="bp-btn" onClick={() => step(1)}>{t('media.next')} ▶</button>}
          <button data-nav className="bp-btn" onClick={onClose}>{t('media.close')}</button>
          <span className="muted bp-media-name" aria-live="polite">{index + 1} / {items.length} · {label}</span>
        </div>
      </div>
    </div>
  )
}
