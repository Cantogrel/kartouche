import { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/i18n'
import { pushLayer } from './layers'
import { focusEl, navItems } from './useNav'
import { igdbImageUrl, youtubeEmbedUrl, type GameMedia } from '@shared/media'

type Item = { kind: 'trailer'; id: string; name: string } | { kind: 'image'; id: string }

/**
 * « Médias » en plein écran, à la manette : bandes-annonces puis captures dans un seul visionneur. ◀ ▶ (ou LB/RB) passent d'un média au suivant,
 * A met une vidéo en pause / la reprend, B ferme. Une vidéo se lance toute seule.
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
    if ((a === 'prev' || a === 'left') && items.length > 1) { step(-1); return true }
    if ((a === 'next' || a === 'right') && items.length > 1) { step(1); return true }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [items.length])
  useEffect(() => { focusEl(navItems()[0]) }, [])
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
