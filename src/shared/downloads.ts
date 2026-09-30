export interface DownloadProgress {
  sourceId: number
  phase: 'downloading' | 'done' | 'error' | 'canceled'
  done: number
  total: number
  message?: string
}
