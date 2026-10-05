import { useEffect, useState } from 'react'
import { consoleById } from '@shared/consoles'

/** Pastille de console : sigle court sur la couleur de la marque (Nintendo en rouge/violet selon la famille, Sony en bleu). */
const TILES: Record<string, { s: string; c: string }> = {
  nes: { s: 'NES', c: '#b3262d' }, snes: { s: 'SNES', c: '#6b5b95' }, n64: { s: 'N64', c: '#2e7d4f' },
  gb: { s: 'GB', c: '#6f7f3a' }, gbc: { s: 'GBC', c: '#7b3fa0' }, gba: { s: 'GBA', c: '#3f4a9e' }, nds: { s: 'DS', c: '#5b6470' }, n3ds: { s: '3DS', c: '#c0392b' },
  gc: { s: 'GC', c: '#5b4b9a' }, wii: { s: 'Wii', c: '#2f8fb8' }, wiiu: { s: 'WiiU', c: '#1f8fc9' }, switch: { s: 'NSW', c: '#e60012' },
  ps1: { s: 'PS1', c: '#1f4e9c' }, ps2: { s: 'PS2', c: '#1a3f8f' }, ps3: { s: 'PS3', c: '#2a2f3a' }, psp: { s: 'PSP', c: '#2b3a55' }, vita: { s: 'Vita', c: '#0f6fc6' }
}

export function ConsoleTile({ id }: { id: string }) {
  const tile = TILES[id]
  return <span className="console-tile" style={{ background: tile?.c ?? '#444' }} title={consoleById(id)?.label ?? id}>{tile?.s ?? id.slice(0, 3).toUpperCase()}</span>
}

/**
 * Icône d'un jeu (carrée, entière, sans rognage) comme dans Hydra : icône SteamGridDB mise en cache par le processus principal ;
 * pastille de la console tant qu'elle charge ou si le jeu n'en a pas.
 */
export function GameIcon({ gameId, console: cons }: { gameId: number | null; console: string }) {
  const [state, setState] = useState<{ id: number; ok: boolean } | null>(null)
  const ok = gameId !== null && state?.id === gameId && state.ok
  // cf. Cover dans ui/index.tsx : annule côté principal une icône abandonnée avant sa résolution.
  useEffect(() => () => { if (gameId !== null) void window.api.invoke('images:cancel', { kind: 'icon', gameId }) }, [gameId])
  return (
    <span className="game-icon">
      {!ok && <ConsoleTile id={cons} />}
      {gameId !== null && (!state || state.id !== gameId || state.ok) && (
        <img key={gameId} className="game-icon-img" alt="" loading="lazy" src={`kimg://icon/${gameId}`} style={{ opacity: ok ? 1 : 0 }}
          onLoad={() => setState({ id: gameId, ok: true })} onError={() => setState({ id: gameId, ok: false })} />
      )}
    </span>
  )
}
