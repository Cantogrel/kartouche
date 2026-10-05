import { useEffect, useState } from 'react'
import { Button } from '@/ui'
import { t } from '@/i18n'
import { youtubeEmbedUrl, type GameMedia as Media } from '@shared/media'

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

/** Médias d'un jeu (bandes-annonces ici ; captures dans la galerie de la fiche) : section absente tant qu'il n'y a rien à montrer, jamais une zone vide. */
export function GameMediaSection({ gameId }: { gameId: number }) {
  const [media, setMedia] = useState<Media | null>(null)
  useEffect(() => {
    let off = false
    setMedia(null)
    void window.api.invoke('catalog:media', { id: gameId }).then((m) => { if (!off) setMedia(m) }).catch(() => undefined)
    return () => { off = true }
  }, [gameId])
  if (!media || media.trailers.length === 0) return null
  return (
    <section className="media-section">
      <h3>{t('media.title')}</h3>
      <TrailerPlayer trailers={media.trailers} />
    </section>
  )
}
