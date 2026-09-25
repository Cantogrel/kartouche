import { contextBridge, ipcRenderer } from 'electron'
import type { RomVaultApi } from '@shared/ipc'

const api: RomVaultApi = {
  invoke: (channel, req) => ipcRenderer.invoke(channel, req),
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  }
}
contextBridge.exposeInMainWorld('api', api)
