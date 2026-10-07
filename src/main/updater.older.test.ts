import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.3.1' } }))
vi.mock('electron-updater', () => ({ autoUpdater: { on: () => {}, autoDownload: false } }))

describe('changelogs précédents', () => {
  it('remonte de la version en cours jusqu\'à x.y.0, rien au-delà', async () => {
    const { olderChangelogs } = await import('./updater')
    expect(olderChangelogs('0.3.1').map((c) => c.version)).toEqual(['0.3.0'])
    expect(olderChangelogs('0.3.0')).toEqual([])
    expect(olderChangelogs('0.2.5').map((c) => c.version)).toEqual(['0.2.4', '0.2.3', '0.2.2', '0.2.1', '0.2.0'])
    expect(olderChangelogs('0.3.1')[0].notes).toContain('RomVault devient Kartouche')
  })
})
