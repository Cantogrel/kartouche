import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { pushLayer } from './layers'
import { focusEl, navItems } from './useNav'
import { igdbImageUrl, youtubeEmbedUrl, type GameMedia } from '@shared/media'

/** Bande-annonce en plein écran, à la manette : lecture automatique, A met en pause / reprend, LB/RB changent de vidéo, B ferme. */
export function BpTrailer({ trailers, onClose }: { trailers: GameMedia['trailers']; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const trailer = trailers[index]
  const command = (func: 'playVideo' | 'pauseVideo'): void => {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), 'https://www.youtube-nocookie.com')
  }
  const step = (d: number): void => { setIndex((i) => (i + d + trailers.length) % trailers.length); setPaused(false) }
  useEffect(() => pushLayer((a) => {
    if (a === 'back') { onClose(); return true }
    if (a === 'prev' && trailers.length > 1) { step(-1); return true }
    if (a === 'next' && trailers.length > 1) { step(1); return true }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [trailers.length])
  useEffect(() => { focusEl(navItems()[0]) }, [])
  if (!trailer) return null
  return (
    <div className="bp-overlay bp-media-overlay">
      <div className="bp-media" data-focus-root>
        <iframe ref={frame} key={trailer.id} className="bp-media-frame" title={trailer.name || t('media.trailer')} src={youtubeEmbedUrl(trailer.id, { autoplay: true })}
          allow="autoplay; encrypted-media; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" />
        <div className="bp-media-bar">
          <button data-nav className="bp-btn primary" onClick={() => { command(paused ? 'playVideo' : 'pauseVideo'); setPaused(!paused) }}>{paused ? `▶ ${t('media.play')}` : `❚❚ ${t('media.pause')}`}</button>
          {trailers.length > 1 && <button data-nav className="bp-btn" onClick={() => step(1)}>{`${index + 1} / ${trailers.length} · ${t('media.next')}`}</button>}
          <button data-nav className="bp-btn" onClick={onClose}>{t('media.close')}</button>
          <span className="muted bp-media-name">{trailer.name}</span>
        </div>
      </div>
    </div>
  )
}

/** Captures en plein écran : ← → (ou LB/RB) changent d'image, B ferme. */
export function BpGallery({ images, onClose }: { images: string[]; onClose: () => void }) {
  const [i, setI] = useState(0)
  const go = (d: number): void => setI((n) => (n + d + images.length) % images.length)
  useEffect(() => pushLayer((a) => {
    if (a === 'back') { onClose(); return true }
    if (a === 'left' || a === 'prev') { go(-1); return true }
    if (a === 'right' || a === 'next') { go(1); return true }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [images.length])
  useEffect(() => { focusEl(navItems()[0]) }, [])
  if (images.length === 0) return null
  return (
    <div className="bp-overlay bp-media-overlay">
      <div className="bp-media" data-focus-root>
        <img className="bp-media-image" src={igdbImageUrl(images[i], 't_1080p')} alt={t('media.screenshot', { n: i + 1, total: images.length })} />
        <div className="bp-media-bar">
          <button data-nav className="bp-btn" onClick={() => go(-1)}>◀ {t('media.prev')}</button>
          <span className="muted" aria-live="polite">{t('media.screenshot', { n: i + 1, total: images.length })}</span>
          <button data-nav className="bp-btn" onClick={() => go(1)}>{t('media.next')} ▶</button>
          <button data-nav className="bp-btn" onClick={onClose}>{t('media.close')}</button>
        </div>
      </div>
    </div>
  )
}
