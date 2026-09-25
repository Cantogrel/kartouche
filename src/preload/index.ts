import { contextBridge, ipcRenderer } from 'electron'
import type { RomVaultApi } from '@shared/ipc'

const api: RomVaultApi = {
  ping: () => ipcRenderer.invoke('ping'),
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  }
}
contextBridge.exposeInMainWorld('api', api)
