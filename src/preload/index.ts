import { contextBridge, ipcRenderer } from 'electron'
import type { RomVaultApi } from '@shared/ipc'

const api: RomVaultApi = {
  invoke: (channel, req) => ipcRenderer.invoke(channel, req),
  on: (event, cb) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l = (_e: unknown, payload: any): void => cb(payload)
    ipcRenderer.on(event, l)
    return () => { ipcRenderer.removeListener(event, l) }
  },
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  }
}
contextBridge.exposeInMainWorld('api', api)
