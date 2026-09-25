export interface RomVaultApi {
  ping(): Promise<{ ok: true; sqlite: string; locale: string }>
  window: { minimize(): void; maximize(): void; close(): void }
}
