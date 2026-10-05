import { useEffect, useRef, useState } from 'react'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { igdbImageUrl, youtubeEmbedUrl, type GameMedia as Media } from '@shared/media'
import { Section } from './Section'

/**
 * Lecteur de bande-annonce intégré. Rien n'est chargé depuis YouTube tant que l'utilisateur n'a pas cliqué sur « Lire » (confidentialité, rapidité) :
 * avant, un simple cadre avec le nom de la vidéo. Domaine sans cookies (youtube-nocookie.com) ; le lecteur disparaît (et s'arrête) quand on ferme
 * le cadre ou qu'on quitte la fiche. Si la lecture est impossible (hors ligne, vidéo retirée), « Ouvrir sur YouTube » reste disponible.
 */
export function TrailerPlayer({ trailers, autoPlay = false }: { trailers: Media['trailers']; autoPlay?: boolean }) {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(autoPlay)
  const trailer = trailers[index]
  useEffect(() => { setIndex(0); setPlaying(autoPlay) }, [trailers, autoPlay])
  if (!trailer) return null
  return (
    <div className="trailer">
      <div className="trailer-frame">
        {playing
          ? <iframe key={trailer.id} title={trailer.name || t('media.trailer')} src={youtubeEmbedUrl(trailer.id, { autoplay: true })} allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" />
          : (
            <button className="trailer-poster" onClick={() => setPlaying(true)} aria-label={`${t('media.play')} — ${trailer.name || t('media.trailer')}`}>
              <span className="trailer-play" aria-hidden>▶</span>
              <span className="trailer-name">{trailer.name || t('media.trailer')}</span>
            </button>
          )}
      </div>
      <div className="row trailer-bar">
        {playing && <Button onClick={() => setPlaying(false)}>{t('media.stop')}</Button>}
        <Button onClick={() => void window.api.invoke('media:openTrailer', trailer.id)}>{t('media.openYoutube')}</Button>
        {trailers.length > 1 && trailers.map((v, i) => (
          <button key={v.id} className={`trailer-pick${i === index ? ' on' : ''}`} onClick={() => { setIndex(i); setPlaying(false) }} aria-pressed={i === index}>{v.name || `${t('media.trailer')} ${i + 1}`}</button>
        ))}
      </div>
    </div>
  )
}

/** Visionneuse plein cadre : ← → pour naviguer, Échap pour fermer ; le focus y entre et revient à la miniature d'origine à la fermeture. */
function Lightbox({ images, start, onClose }: { images: string[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start)
  const close = useRef<HTMLButtonElement>(null)
  const go = (d: number): void => setI((n) => (n + d + images.length) % images.length)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    close.current?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('keydown', key); before?.focus?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('media.gallery')} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <img className="lightbox-img" src={igdbImageUrl(images[i], 't_1080p')} alt={t('media.screenshot', { n: i + 1, total: images.length })} />
      <div className="lightbox-bar">
        <button className="lightbox-btn" onClick={() => go(-1)} aria-label={t('media.prev')}>◀</button>
        <span className="lightbox-count" aria-live="polite">{t('media.screenshot', { n: i + 1, total: images.length })}</span>
        <button className="lightbox-btn" onClick={() => go(1)} aria-label={t('media.next')}>▶</button>
        <button className="lightbox-btn" ref={close} onClick={onClose} aria-label={t('media.close')}>✕</button>
      </div>
    </div>
  )
}

const SHOWN = 8

/** Captures d'écran puis artworks : miniatures cliquables (clavier compris) qui ouvrent la visionneuse. Au-delà de 8, la dernière vignette indique le reste. */
export function Gallery({ media }: { media: Media }) {
  const images = [...media.screenshots, ...media.artworks]
  const [open, setOpen] = useState<number | null>(null)
  if (images.length === 0) return null
  const shown = images.slice(0, SHOWN)
  return (
    <>
      <div className="gallery" role="list" aria-label={t('media.gallery')}>
        {shown.map((id, n) => {
          const rest = n === SHOWN - 1 && images.length > SHOWN ? images.length - SHOWN + 1 : 0
          return (
            <button key={id} role="listitem" className="gallery-thumb" onClick={() => setOpen(n)} aria-label={t('media.screenshot', { n: n + 1, total: images.length })}>
              <img src={igdbImageUrl(id, 't_screenshot_med')} alt="" loading="lazy" />
              {rest > 0 && <span className="gallery-more">{t('media.more', { n: rest })}</span>}
            </button>
          )
        })}
      </div>
      {open !== null && <Lightbox images={images} start={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** Médias d'un jeu (IGDB), `null` tant qu'ils arrivent ou quand il n'y en a pas. Rechargé quand le jeu change. */
export function useGameMedia(gameId: number | null): Media | null {
  const [media, setMedia] = useState<Media | null>(null)
  useEffect(() => {
    let off = false
    setMedia(null)
    if (gameId === null) return
    void window.api.invoke('catalog:media', { id: gameId }).then((m) => { if (!off) setMedia(m) }).catch(() => undefined)
    return () => { off = true }
  }, [gameId])
  return media
}

/** Sections « Bande-annonce » et « Captures » : chacune n'existe que s'il y a quelque chose à montrer, jamais une zone vide. */
export function MediaSections({ media }: { media: Media | null }) {
  if (!media) return null
  return (
    <>
      {media.trailers.length > 0 && <Section id="trailer" title={t('media.title')}><TrailerPlayer trailers={media.trailers} /></Section>}
      {media.screenshots.length + media.artworks.length > 0 && <Section id="gallery" title={t('media.gallery')}><Gallery media={media} /></Section>}
    </>
  )
}
